import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { args, choose, harness } from './harness.js'
import { digest } from '../src/model.js'
import { Journal } from '../src/store.js'
import { REVIEW_SYSTEM } from '../src/auto-approval.js'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as advisor from '../src/index.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close() })
async function boot(fallback: 'ask' | 'skip' = 'skip') {
  const h = await harness(); cleanup.push(h.close)
  await h.ctx.settings.update('advisor', { approvalMode: 'auto', reviewerProvider: 'advisor-test', reviewerModel: 'reviewer', autoAdvisorEndpoint: 'https://advisor.invalid/v1', autoReviewerEndpoint: 'https://advisor.invalid/v1', reviewFallback: fallback })
  h.adapter.response = async function* (request) {
    yield { type: 'text-delta', index: 0, text: request.model === 'reviewer' ? JSON.stringify({ decision: 'allow', reason: '普通代码咨询。' }) : '建议检查空输入。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return h
}
describe('AI auto-approval through real DSH services', () => {
  it('automatically sends exact approved content once, audits review, and restores cached metadata', async () => {
    const h = await boot()
    let questions = 0
    h.ctx.on('user-questions/request', async request => { questions++; return choose('拒绝')(request) })
    const first = await h.invoke()
    expect(first.value).toMatchObject({ status: 'ok', approval: { mode: 'auto', reviewer: 'advisor-test / reviewer' } })
    expect(h.adapter.requests.map(r => r.model)).toEqual(['reviewer', 'test-model'])
    expect(questions).toBe(0)
    expect(h.agent.session.snapshotEvents().filter(e => e.type === 'approval/decided').map(e => e.data.outcome)).toEqual(['allowed-once'])
    expect(h.adapter.requests[0]!.system).toBe(REVIEW_SYSTEM)
    for (const r of h.adapter.requests) { expect(r.tools).toBeUndefined(); expect(r.messages).toHaveLength(1) }
    const dir = join(h.root, digest(h.agent.session.id), digest('help-1'))
    const snapshot = JSON.parse(await readFile(join(dir, 'snapshot-1.json'), 'utf8'))
    expect(h.adapter.requests[1]!.system).toBe(snapshot.system)
    expect(JSON.stringify(h.adapter.requests[1]!.messages)).toContain(JSON.stringify(snapshot.prompt).slice(1, -1))
    expect(JSON.parse(await readFile(join(dir, 'decision-1.json'), 'utf8'))).toMatchObject({ hash: snapshot.hash, detail: { mode: 'auto' } })
    expect(JSON.parse(await readFile(join(dir, 'review-result-1.json'), 'utf8')).detail.decision).toBe('allow')
    expect((await h.invoke()).value).toEqual(first.value)
    expect(h.adapter.requests).toHaveLength(2)
    expect(renderPrompt(await h.ctx.systemPrompt.assemble({ scope: h.agent }))).toContain('do not ask the user for redundant approval')
    await h.fiber.dispose(); await h.ctx.plugin(advisor, h.settings)
    expect(h.ctx.settings.describe().find(s => s.ns === 'advisor')?.value).toMatchObject({ approvalMode: 'auto', reviewerModel: 'reviewer' })
    expect((await h.invoke()).value).toEqual(first.value)
    expect(h.adapter.requests).toHaveLength(2)
  })
  it('escalates a model risk judgment with its reason and respects human denial', async () => {
    const h = await boot('ask')
    h.adapter.response = async function* () { yield { type: 'text-delta', index: 0, text: '{"decision":"ask","reason":"包含客户私人资料。"}' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    let reviews = 0
    h.ctx.on('user-questions/request', async request => { reviews++; expect(request.questions[0]!.detail).toContain('包含客户私人资料'); return choose('拒绝')(request) })
    expect((await h.invoke()).value).toMatchObject({ status: 'denied' })
    expect(reviews).toBe(1); expect(h.adapter.requests.map(r => r.model)).toEqual(['reviewer'])
  })
  it('does not disclose flagged credentials to either reviewer or advisor in skip mode', async () => {
    const h = await boot()
    expect((await h.invoke({ ...args, question: 'Inspect api_key=synthetic-not-a-real-secret' })).value).toMatchObject({ status: 'review_required' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it.each(['garbage', '{"decision":"allow"}', '{"decision":"allow","reason":"yes","extra":true}', '{"decision":"allow","reason":""}'])('never treats malformed review as approval: %s', async content => {
    const h = await boot()
    h.adapter.response = async function* () { yield { type: 'text-delta', index: 0, text: content }; yield { type: 'finish', reason: { kind: 'stop' } } }
    expect((await h.invoke()).value).toMatchObject({ status: 'review_required' })
    expect(h.adapter.requests).toHaveLength(1)
  })
  it('never accepts a truncated decision or retries a failed review', async () => {
    const h = await boot()
    h.adapter.response = async function* () { yield { type: 'text-delta', index: 0, text: '{"decision":"allow","reason":"ok"}' }; yield { type: 'finish', reason: { kind: 'max-tokens' } } }
    expect((await h.invoke()).value).toMatchObject({ status: 'review_required' })
    h.adapter.response = async function* () { throw new Error('private network failure') }
    const second = await h.invoke(args, 'failed')
    expect(second.value).toMatchObject({ status: 'review_required' })
    expect(JSON.stringify(second.value)).not.toContain('private network failure')
    expect((await h.invoke(args, 'failed')).value).toEqual(second.value)
    expect(h.adapter.requests).toHaveLength(2)
  })
  it('bounds a reviewer that ignores cancellation without granting or retrying', async () => {
    const h = await boot(); const timeout = new AbortController(); const started = Promise.withResolvers<void>()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    h.adapter.response = async function* () { started.resolve(); await new Promise(() => {}); yield { type: 'finish', reason: { kind: 'stop' } } }
    const pending = h.invoke(); await started.promise; timeout.abort()
    expect((await pending).value).toMatchObject({ status: 'review_required' })
    expect(h.adapter.requests).toHaveLength(1)
  })
  it('invalidates approval after switching mode away and back while reviewing', async () => {
    const h = await boot(); const original = h.adapter.response
    let reviews = 0
    h.adapter.response = async function* (request) {
      if (request.model === 'reviewer' && ++reviews === 1) {
        await h.ctx.settings.update('advisor', { approvalMode: 'manual' })
        await h.ctx.settings.update('advisor', { approvalMode: 'auto' })
      }
      yield* original(request)
    }
    expect((await h.invoke()).value).toMatchObject({ status: 'ok' })
    expect(h.adapter.requests.map(r => r.model)).toEqual(['reviewer', 'reviewer', 'test-model'])
  })
  it('requires renewed consent for changed endpoints without sending to the new destination', async () => {
    const h = await boot()
    await h.ctx.settings.update('advisor-test', { baseURL: 'https://changed.invalid/v1' })
    expect((await h.invoke()).value).toMatchObject({ status: 'review_required' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('honors host never policy before any model call', async () => {
    const h = await boot()
    h.agent.session.append('approval/policy', { policy: 'never' })
    expect((await h.invoke()).value).toMatchObject({ status: 'denied' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('honors a host policy change during review and records no advisor send', async () => {
    const h = await boot(); const original = h.adapter.response
    h.adapter.response = async function* (request) { h.agent.session.append('approval/policy', { policy: 'never' }); yield* original(request) }
    expect((await h.invoke()).value).toMatchObject({ status: 'denied' })
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.agent.session.snapshotEvents().filter(e => e.type === 'approval/decided').map(e => e.data.outcome)).not.toContain('allowed-once')
  })
  it('stops when host approval is revoked while persisting the reviewer send marker', async () => {
    const h = await boot(); const record = Journal.prototype.reviewRecord
    vi.spyOn(Journal.prototype, 'reviewRecord').mockImplementation(async function (this: Journal, request, stage, detail) {
      await record.call(this, request, stage, detail)
      if (stage === 'send') h.agent.session.append('approval/policy', { policy: 'never' })
    })
    expect((await h.invoke()).value).toMatchObject({ status: 'denied' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('does not send review data outside an open turn', async () => {
    const h = await boot()
    h.agent.session.append('turn/end', { turn: 1, finish: 'stop' } as never)
    await h.invoke()
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('cancels the advisor when the task is cancelled during model review', async () => {
    const h = await boot(); const controller = new AbortController()
    h.adapter.response = async function* () { controller.abort(); yield { type: 'text-delta', index: 0, text: '{"decision":"allow","reason":"ok"}' } }
    await h.invoke(args, 'cancel', controller.signal)
    await vi.waitFor(async () => expect((await h.invoke(args, 'cancel')).value).toMatchObject({ status: 'cancelled' }))
    expect(h.adapter.requests).toHaveLength(1)
  })
  it('rechecks mode after the durable advisor send marker', async () => {
    const h = await boot(); const claim = Journal.prototype.claimSend
    vi.spyOn(Journal.prototype, 'claimSend').mockImplementation(async function (this: Journal, request) { await claim.call(this, request); await h.ctx.settings.update('advisor', { approvalMode: 'manual' }) })
    expect((await h.invoke()).value).toMatchObject({ status: 'cancelled' })
    expect(h.adapter.requests).toHaveLength(1)
  })
  it('stops on review audit failure even when a human responder would approve', async () => {
    const h = await boot('ask')
    vi.spyOn(Journal.prototype, 'reviewRecord').mockRejectedValueOnce(new Error('disk full'))
    h.ctx.on('user-questions/request', choose('批准并发送'))
    expect((await h.invoke()).value).toMatchObject({ status: 'unavailable' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('keeps human editing in the manual flow instead of auto-approving the edited draft', async () => {
    const h = await boot('ask'); const original = h.adapter.response
    h.adapter.response = async function* (request) {
      if (request.model !== 'reviewer') { yield* original(request); return }
      yield { type: 'text-delta', index: 0, text: '{"decision":"ask","reason":"请核对范围。"}' }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
    let reviews = 0
    h.ctx.on('user-questions/request', async request => {
      const q = request.questions[0]!
      if (q.id === 'advisor-field') return choose('求助问题')(request)
      if (q.id === 'advisor-edit') return { answers: [{ id: q.id, selected: [], custom: '只分析公开的空输入行为。' }] }
      return choose(++reviews === 1 ? '编辑内容' : '批准并发送')(request)
    })
    expect((await h.invoke()).value).toMatchObject({ status: 'ok', approval: { mode: 'manual' } })
    expect(reviews).toBe(2)
    expect(h.adapter.requests.map(r => r.model)).toEqual(['reviewer', 'test-model'])
    expect(JSON.stringify(h.adapter.requests[1]!.messages)).toContain('只分析公开的空输入行为')
  })
})
