import { afterEach, describe, expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, createToolResultMessage, ToolCallId, LlmError } from '@deepseek-ai/dsh-llm'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsTools from '@deepseek-ai/dsh-tool-fs'
import WorkerThreadCodeRuntime from '@deepseek-ai/dsh-code-runtime-worker-thread'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import * as advisor from '../src/index.js'
import { digest } from '../src/model.js'
import { AuditStore } from '../src/store.js'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ADVISOR_GUIDANCE } from '../src/policy.js'
import z from '@deepseek-ai/schemastery'
import { args, choose, harness, ScriptedAdapter } from './harness.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function boot(config: Parameters<typeof harness>[0] = {}, open = true) {
  const h = await harness(config, open); cleanup.push(h.close); return h
}
describe('real DSH tool / approval / model services', () => {
  it('loads without a configured route and becomes usable after saving settings', async () => {
    const h = await boot({ provider: '', model: '' })
    expect(h.ctx.settings.describe().find(s => s.ns === 'advisor')?.value).toMatchObject({ provider: '', model: '', enabled: true })
    expect(renderPrompt(await h.ctx.systemPrompt.assemble({ scope: h.agent }))).toContain('not configured')
    expect((await h.invoke()).value).toMatchObject({ status: 'not_configured' })
    expect(h.adapter.requests).toHaveLength(0)
    await h.ctx.settings.update('advisor', { provider: 'advisor-test', model: 'saved-advisor', maxOutputTokens: 8192 })
    expect(h.adapter.requests).toHaveLength(0)
    expect(renderPrompt(await h.ctx.systemPrompt.assemble({ scope: h.agent }))).toContain(ADVISOR_GUIDANCE)
    h.ctx.on('user-questions/request', choose('批准并发送'))
    expect((await h.invoke(args, 'configured-call')).value).toMatchObject({ status: 'ok' })
    expect(h.adapter.requests[0]).toMatchObject({ provider: 'advisor-test', model: 'saved-advisor', maxTokens: 8192 })
  })
  it('uses arbitrary registered providers and nested settings without a vendor-specific request path', async () => {
    const h = await boot()
    const alternate = new ScriptedAdapter()
    h.ctx.settings.register('alternate-models', z.object({ providers: z.dict(z.object({ baseURL: z.string() })) }), {
      base: { providers: { 'glm-fixture': { baseURL: 'https://glm.invalid/v1' }, 'qwen-fixture': { baseURL: 'https://qwen.invalid/v1' } } },
    })
    h.ctx.llm.registerAdapter(['glm-fixture', 'qwen-fixture'], alternate)
    h.ctx.llm.registerConfigurableProviders(['glm-fixture', 'qwen-fixture'].map(provider => ({ provider, displayName: provider, settingsNs: 'alternate-models', settingsPath: ['providers', provider] })))
    h.ctx.on('user-questions/request', choose('批准并发送'))
    for (const provider of ['glm-fixture', 'qwen-fixture']) {
      const prior = alternate.requests.length
      await h.ctx.settings.update('advisor', { provider, model: 'custom-model-id', maxOutputTokens: 8192 })
      expect(alternate.requests).toHaveLength(prior)
      expect((await h.invoke(args, provider)).value).toMatchObject({ status: 'ok' })
      expect(alternate.requests.at(-1)).toMatchObject({ provider, model: 'custom-model-id', maxTokens: 8192 })
    }
    expect(h.adapter.requests).toHaveLength(0)
    expect(alternate.requests).toHaveLength(2)
  })
  it.each([false, true])('explains how to register an unknown model without exposing adapter error details (host copy: %s)', async hostCopy => {
    const h = await boot()
    h.adapter.prepareCall = async () => {
      throw hostCopy ? Object.assign(new Error('private adapter diagnostic'), { code: 'UNKNOWN_MODEL' }) : new LlmError('private adapter diagnostic', 'UNKNOWN_MODEL')
    }
    const response = (await h.invoke()).value
    expect(response).toMatchObject({ status: 'model_unavailable', text: expect.stringContaining('设置 → 模型') })
    expect(JSON.stringify(response)).not.toContain('private adapter diagnostic')
    expect(h.adapter.requests).toHaveLength(0)
  })
  it.each([false, true])('requires a fresh approval after advisor route edits (away-and-back: %s)', async restore => {
    const h = await boot()
    const previews: string[] = []
    h.ctx.on('user-questions/request', async request => {
      previews.push(request.questions[0]!.detail!)
      if (previews.length === 1) {
        await h.ctx.settings.update('advisor', { model: 'changed-model' })
        if (restore) await h.ctx.settings.update('advisor', { model: 'test-model' })
        return choose('批准并发送')(request)
      }
      expect(h.adapter.requests).toHaveLength(0)
      return choose('拒绝')(request)
    })
    expect((await h.invoke()).value).toMatchObject({ status: 'denied' })
    expect(previews).toHaveLength(2)
    expect(previews[1]).toContain(restore ? 'test-model' : 'changed-model')
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('does not send an already reviewed request after the advisor is disabled', async () => {
    const h = await boot()
    h.ctx.on('user-questions/request', async request => {
      await h.ctx.settings.update('advisor', { enabled: false })
      return choose('批准并发送')(request)
    })
    expect((await h.invoke()).value).toMatchObject({ status: 'disabled' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('keeps saved choices after plugin reload and preserves cached results when disabled', async () => {
    const h = await boot()
    await h.ctx.settings.update('advisor', { provider: 'advisor-test', model: 'persisted-choice' })
    await h.fiber.dispose()
    await h.ctx.plugin(advisor, h.settings)
    h.ctx.on('user-questions/request', choose('批准并发送'))
    const first = await h.invoke()
    expect(h.adapter.requests[0]?.model).toBe('persisted-choice')
    await h.ctx.settings.update('advisor', { enabled: false })
    expect((await h.invoke()).value).toEqual(first.value)
    expect((await h.invoke(args, 'disabled-call')).value).toMatchObject({ status: 'disabled' })
    expect(h.adapter.requests).toHaveLength(1)
  })
  it('injects advisor guidance into visible root-agent context and disposes it with the tool', async () => {
    const h = await boot()
    expect(renderPrompt(await h.ctx.systemPrompt.assemble({ scope: h.agent }))).toContain(ADVISOR_GUIDANCE)
    expect(renderPrompt(await h.ctx.systemPrompt.assemble())).not.toContain(ADVISOR_GUIDANCE)
    expect(h.ctx.tools.schemas(h.agent).find(t => t.name === 'ask_advisor')?.description).toContain('independent advisor review')
    await h.fiber.dispose()
    expect(renderPrompt(await h.ctx.systemPrompt.assemble({ scope: h.agent }))).not.toContain(ADVISOR_GUIDANCE)
  })
  it('shows readable exact fields and allows inspecting configuration without granting approval', async () => {
    const h = await boot()
    let reviews = 0
    h.ctx.on('user-questions/request', async request => {
      const q = request.questions[0]!
      expect(h.adapter.requests).toHaveLength(0)
      if (q.id === 'advisor-details') {
        expect(q.detail).toContain('"sends": 1')
        expect(q.detail).toContain('"request":')
        return choose('返回审批')(request)
      }
      expect(q.detail).toContain('### 求助问题')
      expect(q.detail).toContain('中文第一行\n中文第二行')
      return choose(++reviews === 1 ? '查看调用详情' : '拒绝')(request)
    })
    expect((await h.invoke({ ...args, question: '中文第一行\n中文第二行' })).value).toMatchObject({ status: 'denied' })
    expect(reviews).toBe(2)
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('reviews a 384K budget and restores a multi-megabyte answer without sending again', async () => {
    const h = await boot({ maxOutputTokens: 384000, maxOutputBytes: 16 * 1024 * 1024 })
    const chunk = 'Analysis with Chinese 中文, quotes " and a newline.\n'.repeat(1000)
    const answer = chunk.repeat(50)
    expect(Buffer.byteLength(answer)).toBeGreaterThan(2000000)
    h.adapter.response = async function* () {
      for (let i = 0; i < 50; i++) yield { type: 'text-delta', index: 0, text: chunk }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    h.ctx.on('user-questions/request', async request => {
      expect(request.questions[0]!.detail).toContain('384,000 tokens')
      return choose('批准并发送')(request)
    })
    const first = await h.invoke()
    expect(first.value).toMatchObject({ status: 'ok', text: answer, truncated: false })
    expect(h.adapter.requests[0]!.maxTokens).toBe(384000)
    expect(await new AuditStore(h.root, 8).begin(h.agent.session.id, 'help-1', digest(args))).toEqual(first.value)
    expect((await h.invoke()).value).toEqual(first.value)
    expect(h.adapter.requests).toHaveLength(1)
  })
  it.each([
    { text: '汉'.repeat(341) + 'a', status: 'ok' },
    { text: '汉'.repeat(342), status: 'unknown' },
  ])('enforces UTF-8 output byte limits: $status', async ({ text, status }) => {
    const h = await boot({ maxOutputBytes: 1024 })
    h.ctx.on('user-questions/request', choose('批准并发送'))
    h.adapter.response = async function* () {
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    expect((await h.invoke()).value).toMatchObject({ status })
    expect((await h.invoke()).value).toMatchObject({ status })
    expect(h.adapter.requests).toHaveLength(1)
  })
  it('counts a surrogate pair spanning stream deltas as one UTF-8 character', async () => {
    const h = await boot({ maxOutputBytes: 1024 })
    h.ctx.on('user-questions/request', choose('批准并发送'))
    h.adapter.response = async function* () {
      for (const text of ['a'.repeat(1020), '\ud83d', '', '\ude00']) yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    expect((await h.invoke()).value).toMatchObject({ status: 'ok', text: 'a'.repeat(1020) + '😀' })
  })
  it('holds all request text until the human explicitly approves; sends only the reviewed snapshot', async () => {
    const h = await boot()
    const gate = Promise.withResolvers<void>()
    const shown = Promise.withResolvers<string>()
    h.ctx.on('user-questions/request', async request => {
      shown.resolve(request.questions[0]!.detail!)
      await gate.promise
      return choose('批准并发送')(request)
    })
    const pending = h.invoke({ ...args, question: 'key sk-abcdefghijklmnopqrstuvwxyz；如何修复？' })
    const preview = await shown.promise
    expect(h.adapter.requests).toHaveLength(0)
    expect(preview).toContain('https://advisor.invalid/v1')
    expect(preview).toContain('[REDACTED TOKEN]')
    expect(preview).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    gate.resolve()
    const result = await pending
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ status: 'ok' })
    expect(h.adapter.requests).toHaveLength(1)
    const actual = h.adapter.requests[0]!
    expect(actual.tools).toBeUndefined()
    expect(actual.messages).toHaveLength(1)
    expect(actual.maxTokens).toBe(4096)
    const prompt = actual.messages[0]!.content[0]!
    expect(prompt.type).toBe('text')
    if (prompt.type === 'text') expect(preview).toContain(prompt.text)
    expect(preview).toContain(actual.system!)
    const taskDir = join(h.root, digest(h.agent.session.id))
    const callDir = join(taskDir, digest('help-1'))
    const saved = await readFile(join(callDir, 'snapshot-1.json'), 'utf8')
    expect(saved).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect((await stat(callDir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(callDir, 'send.json'))).mode & 0o777).toBe(0o600)
  })
  it.each(['拒绝', 'arbitrary free-form answer'])('does not send after %s', async label => {
    const h = await boot()
    h.ctx.on('user-questions/request', choose(label))
    expect((await h.invoke()).value).toMatchObject({ status: 'denied' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('fails closed without a human question provider', async () => {
    const h = await boot()
    expect((await h.invoke()).value).toMatchObject({ status: 'unavailable' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('records browser dismissal as cancellation without dispatching', async () => {
    const h = await boot()
    h.ctx.on('user-questions/request', async () => { throw new UserQuestionError('user dismissed the question', 'ASK_CANCELLED') })
    expect((await h.invoke()).value).toMatchObject({ status: 'cancelled' })
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.agent.session.snapshotEvents().filter(e => e.type === 'approval/decided').map(e => e.data.outcome)).toEqual(['cancelled'])
  })
  it('does not accept a generic auto-allow approval answer without exact preview proof', async () => {
    const h = await boot()
    h.ctx.on('approval/request', async () => 'allowed-once', { prepend: true })
    expect((await h.invoke()).value).toMatchObject({ status: 'unavailable' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('honors never-ask policy before showing a preview', async () => {
    const h = await boot()
    h.agent.session.append('approval/policy', { policy: 'never' })
    let shown = false
    h.ctx.on('user-questions/request', async request => { shown = true; return choose('批准并发送')(request) })
    expect((await h.invoke()).value).toMatchObject({ status: 'denied' })
    expect(shown).toBe(false); expect(h.adapter.requests).toHaveLength(0)
  })
  it('rebuilds and reapproves edited text, redacting the human replacement too', async () => {
    const h = await boot()
    let reviews = 0
    const previews: string[] = []
    h.ctx.on('user-questions/request', async request => {
      const q = request.questions[0]!
      if (q.id === 'advisor-review') { previews.push(q.detail!); return choose(++reviews === 1 ? '编辑内容' : '批准并发送')(request) }
      if (q.id === 'advisor-field') return choose('求助问题')(request)
      return { answers: [{ id: q.id, selected: [], custom: '只分析空输入，凭证 sk-zyxwvutsrqponmlkjihgfedcba' }] }
    })
    expect((await h.invoke()).value).toMatchObject({ status: 'ok' })
    expect(reviews).toBe(2)
    expect(previews[1]).toContain('只分析空输入')
    expect(previews[1]).not.toContain('sk-zyxwvutsrqponmlkjihgfedcba')
    expect(JSON.stringify(h.adapter.requests)).toContain('只分析空输入')
    expect(JSON.stringify(h.adapter.requests)).not.toContain(args.question)
    const decisions = h.agent.session.snapshotEvents().filter(e => e.type === 'approval/decided').map(e => e.data.outcome)
    expect(decisions).toEqual(['cancelled', 'allowed-once'])
  })
  it('invalidates approval on provider setting changes, including an away-and-back edit', async () => {
    const h = await boot()
    let reviews = 0
    h.ctx.on('user-questions/request', async request => {
      if (++reviews === 1) {
        await h.ctx.settings.update('advisor-test', { marker: 'changed' })
        await h.ctx.settings.update('advisor-test', { marker: 'initial' })
      }
      return choose(reviews === 1 ? '批准并发送' : '拒绝')(request)
    })
    expect((await h.invoke()).value).toMatchObject({ status: 'denied' })
    expect(reviews).toBe(2); expect(h.adapter.requests).toHaveLength(0)
  })
  it('returns a saved result after plugin reload without asking or sending again', async () => {
    const h = await boot()
    let questions = 0
    h.ctx.on('user-questions/request', async request => { questions++; return choose('批准并发送')(request) })
    const first = await h.invoke()
    await h.fiber.dispose()
    await h.ctx.plugin(advisor, h.settings)
    expect((await h.invoke()).value).toEqual(first.value)
    expect(questions).toBe(1); expect(h.adapter.requests).toHaveLength(1)
    expect((await h.invoke({ ...args, question: 'another question' })).value).toMatchObject({ status: 'conflict' })
  })
  it('does not retry a timed-out request and limits task-wide dispatches', async () => {
    const h = await boot({ timeoutMs: 20, maxCallsPerTask: 1 })
    h.adapter.response = async function* (request) {
      await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('test adapter cancelled')
    }
    h.ctx.on('user-questions/request', choose('批准并发送'))
    expect((await h.invoke()).value).toMatchObject({ status: 'unknown' })
    expect((await h.invoke()).value).toMatchObject({ status: 'unknown' })
    expect((await h.invoke(args, 'help-2')).value).toMatchObject({ status: 'budget_exhausted' })
    expect(h.adapter.requests).toHaveLength(1)
  })
  it('rejects oversized input without prompting or sending', async () => {
    const h = await boot({ maxInputBytes: 1024 })
    expect((await h.invoke({ ...args, question: 'a'.repeat(1400) })).value).toMatchObject({ status: 'invalid_text' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('dispatches file evidence through the existing read tool and respects a denial', async () => {
    const h = await boot()
    let reads = 0
    h.ctx.tools.register(defineTool({ name: 'read', description: 'test read seam', parameters: { file_path: { type: 'string', required: true }, offset: { type: 'integer' }, limit: { type: 'integer' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { reads++; return 'unreachable' } }))
    h.ctx.tools.guard((exec) => exec.name === 'read' ? 'test read denial' : undefined)
    const input = { ...args, evidence: [{ kind: 'file', source: '/outside/private', start_line: 1, end_line: 1 }] }
    expect((await h.invoke(input)).value).toMatchObject({ status: 'evidence_unavailable' })
    expect(reads).toBe(0); expect(h.adapter.requests).toHaveLength(0)
  })
  it('runs from a real main-agent loop and returns advisor advice to the main model', async () => {
    const h = await boot({}, false)
    h.ctx.on('user-questions/request', choose('批准并发送'))
    let mainCalls = 0
    h.adapter.response = async function* (request) {
      if (request.model === 'test-model') {
        yield { type: 'text-delta', index: 0, text: '请检查 empty 分支。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else if (++mainCalls === 1) {
        const call = { type: 'tool-call' as const, id: ToolCallId('loop-help'), name: 'ask_advisor', arguments: JSON.stringify(args) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: call }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '收到建议，继续验证。' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '收到建议，继续验证。' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const idle = new Promise<void>(resolve => { const dispose = h.ctx.on('agent/status', ({ agent, status }) => { if (agent === h.agent && status === 'idle') { dispose(); resolve() } }) })
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: '求助后继续处理。' }], source: { kind: 'user' } }))
    await idle
    expect(h.adapter.requests.filter(r => r.model === 'test-model')).toHaveLength(1)
    expect(mainCalls).toBe(2)
    expect(JSON.stringify(h.adapter.requests.at(-1)!.messages)).toContain('请检查 empty 分支')
  })
  it('reads exact file lines, allows evidence removal, and preserves the captured text across file edits', async () => {
    const h = await boot()
    await h.ctx.plugin(LocalFileSystem)
    await h.ctx.plugin(FsTools)
    const file = join(h.root, 'source.txt')
    await writeFile(file, 'unrelated first line\nselected evidence\nunrelated last line\n')
    let reviews = 0
    h.ctx.on('user-questions/request', async request => {
      const q = request.questions[0]!
      if (q.id === 'advisor-remove') return choose('E2')(request)
      if (++reviews === 1) {
        expect(q.detail).toContain('selected evidence')
        expect(q.detail).not.toContain('unrelated first line')
        await writeFile(file, 'changed file\nchanged selected evidence\n')
        return choose('删除证据')(request)
      }
      return choose('批准并发送')(request)
    })
    const input = { ...args, evidence: [
      { kind: 'file', source: file, start_line: 2, end_line: 2 },
      { kind: 'file', source: file, start_line: 3, end_line: 3 },
    ] }
    expect((await h.invoke(input)).value).toMatchObject({ status: 'ok' })
    const sent = JSON.stringify(h.adapter.requests)
    expect(sent).toContain('selected evidence')
    expect(sent).not.toContain('changed selected evidence')
    expect(sent).not.toContain('unrelated last line')
    expect(reviews).toBe(2)
  })
  it('rejects read-tool truncation and missing ranges', async () => {
    const h = await boot()
    await h.ctx.plugin(LocalFileSystem)
    await h.ctx.plugin(FsTools, { readMaxLineLength: 12 })
    const file = join(h.root, 'long.txt')
    await writeFile(file, 'x'.repeat(100))
    expect((await h.invoke({ ...args, evidence: [{ kind: 'file', source: file, start_line: 1, end_line: 1 }] })).value).toMatchObject({ status: 'evidence_incomplete' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('requires the same approval when called through the real Code Mode worker', async () => {
    const h = await boot()
    await h.ctx.plugin(WorkerThreadCodeRuntime)
    h.agent.ctx.tools.presentAs('both')
    h.ctx.on('user-questions/request', choose('拒绝'))
    const output = await h.ctx.tools.execute({ name: 'run_code', callId: ToolCallId('code-help'), agent: h.agent, signal: new AbortController().signal, arguments: { code: `return await tools.ask_advisor(${JSON.stringify(args)})`, description: 'Ask advisor through the tool SDK' } })
    expect(JSON.stringify(output)).toContain('denied')
    expect(h.adapter.requests).toHaveLength(0)
    const approvals = h.agent.session.snapshotEvents().filter(e => e.type === 'approval/decided')
    expect(approvals).toHaveLength(1)
  })
  it('ignores a late approval after tool cancellation', async () => {
    const h = await boot()
    const shown = Promise.withResolvers<void>()
    const late = Promise.withResolvers<void>()
    h.ctx.on('user-questions/request', async request => { shown.resolve(); await late.promise; return choose('批准并发送')(request) })
    const controller = new AbortController()
    const pending = h.invoke(args, 'cancel-me', controller.signal)
    await shown.promise
    controller.abort()
    await pending
    late.resolve()
    expect(h.adapter.requests).toHaveLength(0)
    const cached = await h.invoke(args, 'cancel-me')
    expect(cached.value).toMatchObject({ status: 'cancelled' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('selects a completed tool-result range from this session without copying other history', async () => {
    const h = await boot()
    h.agent.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('observed-call'), isError: false, content: [{ type: 'text', text: 'unrelated output\nimportant failure\nmore output' }] }) }, { surfaceOp: 'append' })
    h.ctx.on('user-questions/request', choose('批准并发送'))
    expect((await h.invoke({ ...args, evidence: [{ kind: 'tool_result', source: 'observed-call', start_line: 2, end_line: 2 }] })).value).toMatchObject({ status: 'ok' })
    const sent = JSON.stringify(h.adapter.requests)
    expect(sent).toContain('important failure')
    expect(sent).not.toContain('unrelated output')
    expect(sent).not.toContain('more output')
    expect((await h.invoke({ ...args, evidence: [{ kind: 'tool_result', source: 'another-task-call', start_line: 1, end_line: 1 }] }, 'help-other')).value).toMatchObject({ status: 'evidence_unavailable' })
    expect(h.adapter.requests).toHaveLength(1)
  })
  it('allows an approved file-backed request nested under Code Mode', async () => {
    const h = await boot()
    await h.ctx.plugin(LocalFileSystem)
    await h.ctx.plugin(FsTools)
    await h.ctx.plugin(WorkerThreadCodeRuntime)
    h.agent.ctx.tools.presentAs('both')
    h.ctx.on('user-questions/request', choose('批准并发送'))
    const file = join(h.root, 'nested.txt')
    await writeFile(file, 'nested file evidence\n')
    const input = { ...args, evidence: [{ kind: 'file', source: file, start_line: 1, end_line: 1 }] }
    const outcome = await h.ctx.tools.execute({ name: 'run_code', callId: ToolCallId('code-with-file'), agent: h.agent, signal: new AbortController().signal, arguments: { code: `return await tools.ask_advisor(${JSON.stringify(input)})`, description: 'Ask advisor about a specific file excerpt' } })
    expect(outcome.isError).toBe(false)
    expect(JSON.stringify(outcome)).toContain('ok')
    expect(h.adapter.requests).toHaveLength(1)
    expect(JSON.stringify(h.adapter.requests)).toContain('nested file evidence')
  })
  it('requires a visible endpoint and reapproves an endpoint change', async () => {
    const h = await boot()
    await h.ctx.settings.update('advisor-test', { baseURL: '' })
    expect((await h.invoke()).value).toMatchObject({ status: 'endpoint_required' })
    await h.ctx.settings.update('advisor-test', { baseURL: 'https://advisor.invalid/v1' })
    let reviews = 0
    h.ctx.on('user-questions/request', async request => {
      if (++reviews === 1) await h.ctx.settings.update('advisor-test', { baseURL: 'https://different.invalid/v1' })
      else expect(request.questions[0]!.detail).toContain('https://different.invalid/v1')
      return choose(reviews === 1 ? '批准并发送' : '拒绝')(request)
    })
    expect((await h.invoke(args, 'help-with-new-endpoint')).value).toMatchObject({ status: 'denied' })
    expect(reviews).toBe(2); expect(h.adapter.requests).toHaveLength(0)
  })
  it('invalidates a pending approval when the credential service reports a change', async () => {
    const h = await boot()
    let reviews = 0
    h.ctx.on('user-questions/request', async request => {
      if (++reviews === 1) h.ctx.emit('credentials/reference-updated', credentialRef('ADVISOR_TEST_KEY'))
      return choose(reviews === 1 ? '批准并发送' : '拒绝')(request)
    })
    expect((await h.invoke()).value).toMatchObject({ status: 'denied' })
    expect(reviews).toBe(2); expect(h.adapter.requests).toHaveLength(0)
  })
})
