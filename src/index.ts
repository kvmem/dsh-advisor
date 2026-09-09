import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-credentials'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ApprovalWizard } from './approval.js'
import { collectEvidence, prepareTarget, send } from './dsh.js'
import { AdvisorError, digest, integer, parseInput, result, snapshot, type Result } from './model.js'
import { AuditStore, Journal } from './store.js'
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_TOKENS, OutputBytesSchema, OutputTokensSchema, outputLimit } from './limits.js'
import { ADVISOR_DESCRIPTION, ADVISOR_GUIDANCE } from './policy.js'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { advisorRoute, PREFERENCES_NS, PreferencesSchema, validatePreferences } from './preferences.js'

export const name = 'super-advisor'
export const inject = ['tools', 'llm', 'settings', 'approval', 'userQuestions', 'agents', 'systemPrompt']
export interface Config {
  provider?: string
  model?: string
  storageDir?: string
  maxInputBytes?: number
  maxOutputTokens?: number
  maxOutputBytes?: number
  maxCallsPerTask?: number
  timeoutMs?: number
}
export const Config: z<Config> = z.object({
  provider: z.string().default(''), model: z.string().default(''), storageDir: z.string(),
  maxInputBytes: z.number().step(1).min(1024).max(65536).default(32768),
  maxOutputTokens: OutputTokensSchema,
  maxOutputBytes: OutputBytesSchema,
  maxCallsPerTask: z.number().step(1).min(1).max(100).default(8),
  timeoutMs: z.number().step(1).min(10).max(600000).default(120000),
})
/** Standalone Cordis plugin; model connection and deployment belong to DSH adapters. */
export function apply(ctx: Context, input: Config): void {
  const config = Object.freeze({
    provider: input.provider?.trim() ?? '', model: input.model?.trim() ?? '',
    storageDir: input.storageDir ?? join(resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')), 'advisor-audit'),
    maxInputBytes: integer(input.maxInputBytes ?? 32768, 1024, 65536),
    maxTokens: outputLimit(input.maxOutputTokens, 128, MAX_OUTPUT_TOKENS),
    maxOutputBytes: outputLimit(input.maxOutputBytes, 1024, MAX_OUTPUT_BYTES),
    maxCallsPerTask: integer(input.maxCallsPerTask ?? 8, 1, 100),
    timeoutMs: integer(input.timeoutMs ?? 120000, 10, 600000),
  })
  const store = new AuditStore(config.storageDir, config.maxCallsPerTask)
  const approvals = new ApprovalWizard(ctx)
  const disposed = new AbortController()
  const preferences = ctx.settings.register(PREFERENCES_NS, PreferencesSchema, {
    base: { enabled: true, provider: config.provider, model: config.model, maxOutputTokens: config.maxTokens, maxOutputBytes: config.maxOutputBytes },
    validate: validatePreferences,
  })
  ctx.systemPrompt.section({
    name: 'advisor-assistance', order: 2850,
    text: ({ scope }) => {
      const agent = ctx.agents.roots().find(root => root === scope)
      if (!agent || !ctx.tools.get('ask_advisor', agent)) return ''
      const value = preferences.get()
      return value.enabled && value.provider.trim() && value.model.trim() ? ADVISOR_GUIDANCE
        : '## Advisor assistance\nThe advisor is disabled or not configured. Do not call ask_advisor until the user configures it in Settings → Plugins → DSH SuperAdvisor. Continue with the available evidence; if independent review is needed, explain how to enable the advisor.'
    },
  })
  let generation = 0
  ctx.on('llm/adapters-updated', () => { generation++ })
  // Credential events contain references only. Never read credential values into this plugin.
  ctx.on('credentials/reference-updated', () => { generation++ })
  ctx.on('credentials/record-updated', () => { generation++ })
  ctx.effect(() => () => disposed.abort())
  async function run(raw: unknown, exec: ToolRunContext): Promise<Result> {
    let journal: Journal | undefined
    let sent = false
    let requestId = ''
    try {
      const args = parseInput(raw)
      if (!exec.agent || !ctx.agents.roots().includes(exec.agent)) return result('unavailable', '首版顾问工具只能由当前主任务调用，需要可交互审批界面。')
      const signal = AbortSignal.any([exec.signal, disposed.signal])
      signal.throwIfAborted()
      const execution = { ...exec, signal }
      const begun = await store.begin(exec.agent.session.id, exec.callId, digest(args))
      if (!(begun instanceof Journal)) return begun
      journal = begun
      advisorRoute(preferences.get())
      let draft = await collectEvidence(ctx, args, execution, config.maxInputBytes)
      for (let revision = 1; revision <= 20; revision++) {
        signal.throwIfAborted()
        const route = await prepareTarget(ctx, advisorRoute(preferences.get()), () => ({
          adapters: generation,
          // Read the committed revision synchronously, including A→B→A changes,
          // rather than relying on a deferred settings watcher callback.
          preferences: ctx.settings.describe().find(item => item.ns === PREFERENCES_NS)?.revision,
        }), signal)
        const request = snapshot(draft, route.target, exec.agent.session.id, exec.callId, revision, config.maxInputBytes)
        requestId = request.hash
        await journal.preview(request)
        const decision = await approvals.review(request, execution)
        await journal.decision(request, decision.outcome)
        signal.throwIfAborted()
        if (decision.edit && decision.outcome === 'cancelled') { draft = decision.edit; continue }
        if (decision.outcome !== 'allowed-once' || decision.grant !== request.hash) {
          const status = decision.outcome === 'rejected' ? 'denied' : decision.outcome === 'cancelled' ? 'cancelled' : 'unavailable'
          return await journal.finish(result(status, '本次求助未获得有效的逐次审批，没有发送。请继续本地处理；不要自动重复请求审批。', request.hash))
        }
        if (!route.current()) { draft = request.draft; continue }
        await journal.claimSend(request)
        // Recheck after durable writes. Once the send marker exists, recovery always errs toward no duplicate.
        if (signal.aborted || !route.current()) return await journal.finish(result('cancelled', '发送前任务取消或模型配置变化；没有发送。需要新的调用和审批。', request.hash))
        sent = true
        const networkSignal = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
        const operation = send(route.prepared, request, networkSignal, route.target.maxOutputBytes ?? 0)
        // The deadline also bounds adapters that do not settle on abort; their promise stays observed.
        const outcome = await abortable(operation, networkSignal)
        return await journal.finish(outcome)
      }
      return await journal.finish(result('unavailable', '本次预览修改或配置变化次数过多，已停止且未发送。', requestId))
    } catch (error) {
      const outcome = sent
        ? result('unknown', '请求可能已到达顾问，但未能保存完整结果。不会自动重发；如需再次求助，请重新审批。', requestId)
        : exec.signal.aborted || disposed.signal.aborted
          ? result('cancelled', '任务已取消，没有发送顾问请求。', requestId)
          : error instanceof AdvisorError ? result(error.code, error.message, requestId)
            : result('unavailable', '顾问准备、审批或审计存储不可用，没有发送。', requestId)
      if (journal) { try { return await journal.finish(outcome) } catch { /* Never send again after a storage failure. */ } }
      return outcome
    }
  }
  ctx.tools.register(defineTool({
    name: 'ask_advisor',
    description: ADVISOR_DESCRIPTION,
    parameters: {
      question: { type: 'string', required: true }, goal: { type: 'string', required: true }, constraints: { type: 'string', required: true }, attempts: { type: 'string', required: true },
      evidence: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, enum: ['file', 'tool_result'] }, source: { type: 'string', required: true }, start_line: { type: 'integer', required: true }, end_line: { type: 'integer', required: true } } } },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', required: true }, text: { type: 'string', required: true }, request_id: { type: 'string', required: true }, truncated: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) { return { ...await run(args, exec) } },
  }))
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('advisor request cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener('abort', onAbort) }
}
