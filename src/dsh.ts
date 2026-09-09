import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, type PreparedLlmCall, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { PtcDispatchEventData } from '@deepseek-ai/dsh-tools/types'
import type {} from '@deepseek-ai/dsh-settings'
import { AdvisorError, digest, freeze, record, text, type Input, type Draft, type Target, type Snapshot, type Result, result, redact } from './model.js'

export interface RouteConfig { provider: string; model: string; maxTokens?: number; maxOutputBytes?: number }
export interface PreparedTarget { target: Target; prepared: PreparedLlmCall; current(): boolean }

// DSH 0.1.5 renamed the durable Code Mode event; both payloads share this type.
// Keep legacy events readable when a saved session is opened by a newer host.
function isNestedResult(event: { type: string; data: unknown }): event is { type: 'tool/code-dispatch' | 'tool/ptc-dispatch'; data: PtcDispatchEventData } {
  return event.type === 'tool/code-dispatch' || event.type === 'tool/ptc-dispatch'
}
export async function prepareTarget(ctx: Context, config: RouteConfig, generation: () => unknown, signal: AbortSignal): Promise<PreparedTarget> {
  const capture = () => {
    const route = ctx.llm.listConfigurableProviders().find(entry => entry.provider === config.provider)
    if (!route) throw new AdvisorError('target_unavailable', '顾问 provider 必须注册 DSH 可配置模型接入信息。')
    const descriptor = ctx.settings.describe().find(item => item.ns === route.settingsNs)
    if (!descriptor) throw new AdvisorError('target_unavailable', '找不到顾问 provider 的有效配置。')
    let value: unknown = descriptor.value
    for (const key of route.settingsPath) value = record(value)[key]
    const profile = record(value)
    if (typeof profile.baseURL !== 'string' || !profile.baseURL) throw new AdvisorError('endpoint_required', '请在 DSH provider 配置中显式设置 baseURL，以便审批准确显示接收地址。')
    let url: URL
    try { url = new URL(profile.baseURL) } catch { throw new AdvisorError('invalid_endpoint', '顾问接收地址无效。') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || redact(profile.baseURL).changed) {
      throw new AdvisorError('invalid_endpoint', 'baseURL 只允许无凭证、无查询参数的 HTTP(S) 地址；认证由 DSH adapter 处理。')
    }
    text(config.provider, 200); text(config.model, 200); text(profile.baseURL, 2048)
    if (redact(config.provider).changed || redact(config.model).changed) throw new AdvisorError('invalid_route', '模型路由名称中不能包含凭证。')
    return { endpoint: profile.baseURL, fingerprint: digest({ route, profile, revision: descriptor.revision, generation: generation(), config }) }
  }
  const captured = capture()
  let prepared: PreparedLlmCall
  try {
    prepared = await ctx.llm.prepareCall({ provider: config.provider, model: config.model, ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }) }, signal)
  } catch (error) {
    // Host adapters can load a different copy of dsh-llm, so use the stable error code.
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'UNKNOWN_MODEL') throw new AdvisorError('model_unavailable', 'DSH 尚未接入所选模型。请先在“设置 → 模型”中为该服务添加模型，再返回“顾问模型”刷新列表并选择；没有发送。')
    throw error
  }
  if (capture().fingerprint !== captured.fingerprint) throw new AdvisorError('configuration_changed', '模型配置正在变化，请重新求助。')
  const target: Target = freeze({ provider: config.provider, model: config.model, ...captured, maxTokens: prepared.config.maxTokens, maxOutputBytes: config.maxOutputBytes ?? 0, callConfig: structuredClone(prepared.config) })
  return { target, prepared, current: () => { try { return capture().fingerprint === captured.fingerprint } catch { return false } } }
}

export async function collectEvidence(ctx: Context, input: Input, exec: ToolRunContext, maxBytes: number): Promise<Draft> {
  if (!exec.agent) throw new AdvisorError('unavailable', '顾问求助需要一个正在运行的 DSH 任务。')
  const evidence: Draft['evidence'] = []
  for (const [index, ref] of input.evidence.entries()) {
    exec.signal.throwIfAborted()
    let content: string
    let source: string
    const count = ref.end_line - ref.start_line + 1
    if (ref.kind === 'file') {
      // Dispatch the existing tool so read restrictions/approvals and filesystem policy still apply.
      const read = await ctx.tools.execute({ name: 'read', callId: ToolCallId(`${exec.callId}:advisor-read:${index}`), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal, arguments: { file_path: ref.source, offset: ref.start_line, limit: count } })
      if (read.isError) throw new AdvisorError('evidence_unavailable', '证据文件读取被拒绝或失败；不会发送顾问请求。')
      const value = record(read.value)
      if (!Array.isArray(value.lines) || value.lines.length !== count || value.offset !== ref.start_line) throw new AdvisorError('evidence_incomplete', '文件返回的范围不完整，请缩小到实际存在的行范围。')
      const lines = value.lines.map((line, offset) => {
        const item = record(line)
        if (item.number !== ref.start_line + offset || typeof item.text !== 'string' || /\.\.\. \(line truncated to \d+ chars\)/.test(item.text)) throw new AdvisorError('evidence_incomplete', '证据被读取工具截断，请选择更小的证据。')
        return item.text
      })
      content = lines.join('\n')
      source = `file:${text(value.path, 2048)}:${ref.start_line}-${ref.end_line}`
    } else {
      const matches = exec.agent.session.snapshotEvents().filter(event =>
        (event.type === 'tool/result' && event.data.message.source.callId === ref.source) ||
        (isNestedResult(event) && event.data.subCallId === ref.source))
      if (matches.length !== 1) throw new AdvisorError('evidence_unavailable', '证据必须引用当前任务中唯一的、已经完成的工具结果。')
      const event = matches[0]!
      const blocks = event.type === 'tool/result' ? event.data.message.content[0].content : isNestedResult(event) ? event.data.content : []
      if (blocks.some(block => block.type !== 'text')) throw new AdvisorError('text_only', '首版只接受纯文本工具结果。')
      const all = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (Buffer.byteLength(all) > 1000000) throw new AdvisorError('evidence_too_large', '源工具结果过大，请先生成更小的独立结果。')
      const lines = all.split('\n')
      if (ref.end_line > lines.length) throw new AdvisorError('evidence_incomplete', '所选工具结果行范围不存在。')
      content = lines.slice(ref.start_line - 1, ref.end_line).join('\n')
      source = `tool_result:${ref.source}:${ref.start_line}-${ref.end_line}`
    }
    evidence.push({ id: `E${index + 1}`, source, text: text(content, maxBytes), edited: false })
  }
  return { question: input.question, goal: input.goal, constraints: input.constraints, attempts: input.attempts, evidence }
}

export async function send(prepared: PreparedLlmCall, snapshot: Snapshot, signal: AbortSignal, maxOutputBytes: number): Promise<Result> {
  const options: GenerateOptions = freeze({ ...prepared.config, system: snapshot.system, messages: [createUserMessage({ content: [{ type: 'text', text: snapshot.prompt }], source: { kind: 'user' } })] })
  // AbortSignal itself must stay unfrozen. No tools, history, attachments, retries, or credentials in this envelope.
  const request: GenerateOptions = Object.freeze({ ...options, signal })
  const parts: string[] = []
  let answerBytes = 0
  let lastCodeUnit = 0
  let finish: string | undefined
  for await (const chunk of prepared.stream(request)) {
    signal.throwIfAborted()
    if (chunk.type === 'text-delta') {
      if (!chunk.text.length) continue
      answerBytes += Buffer.byteLength(chunk.text)
      const firstCodeUnit = chunk.text.charCodeAt(0)
      // A surrogate pair split between deltas occupies four bytes, not two replacements (six).
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff && firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) answerBytes -= 2
      if (maxOutputBytes > 0 && answerBytes > maxOutputBytes) throw new AdvisorError('unknown', '顾问输出超过接收上限，已中止；不会重发。')
      parts.push(chunk.text)
      lastCodeUnit = chunk.text.charCodeAt(chunk.text.length - 1)
    }
    if (chunk.type === 'finish') finish = chunk.reason.kind
  }
  const answer = parts.join('')
  if (finish !== 'stop' && finish !== 'max-tokens') return result('unknown', '顾问请求已发起，但没有收到完整的文字结果。远端状态未知，不会自动重试。', snapshot.hash)
  if (!answer.trim()) return result('error', '顾问未返回文字建议。', snapshot.hash)
  return result('ok', redact(answer).value, snapshot.hash, finish === 'max-tokens')
}
