import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { args, choose, harness } from './harness.js'
import { digest, parseInput } from '../src/model.js'
import { Journal } from '../src/store.js'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close() })
async function boot(fallback: 'ask' | 'skip' = 'skip') {
  const h = await harness(); cleanup.push(h.close)
  await h.ctx.settings.update('advisor', { approvalMode: 'self', autoAdvisorEndpoint: 'https://advisor.invalid/v1', reviewFallback: fallback })
  return h
}
const ordinary = { ...args, requires_human_approval: false }
describe('main-model tag approval without a reviewer request', () => {
  it('sends only the advisor, binds the label in the snapshot, and reuses the result', async () => {
    const h = await boot(); const prepare = vi.spyOn(h.ctx.llm, 'prepareCall')
    let prompts = 0
    h.ctx.on('user-questions/request', async request => { prompts++; return choose('拒绝')(request) })
    const first = await h.invoke(ordinary)
    expect(first.value).toMatchObject({ status: 'ok', approval: { mode: 'self', reviewer: '' } })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(h.adapter.requests.map(r => r.model)).toEqual(['test-model'])
    expect(prompts).toBe(0)
    const dir = join(h.root, digest(h.agent.session.id), digest('help-1'))
    const saved = JSON.parse(await readFile(join(dir, 'snapshot-1.json'), 'utf8'))
    expect(saved.draft.requires_human_approval).toBe(false)
    expect(saved.prompt).not.toContain('requires_human_approval')
    expect((await readdir(dir)).some(name => name.startsWith('review-send'))).toBe(false)
    expect((await h.invoke(ordinary)).value).toEqual(first.value)
    expect(h.adapter.requests).toHaveLength(1)
    expect((await h.invoke({ ...ordinary, requires_human_approval: true })).value).toMatchObject({ status: 'conflict' })
    expect(renderPrompt(await h.ctx.systemPrompt.assemble({ scope: h.agent }))).toContain('In the SAME ask_advisor call')
  })
  it.each([true, undefined])('skips flagged or absent labels without any model call (%s)', async label => {
    const h = await boot()
    expect((await h.invoke({ ...args, ...(label === undefined ? {} : { requires_human_approval: label }) })).value).toMatchObject({ status: 'review_required', approval: { mode: 'self' } })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('lets a human approve a flagged request with no independent reviewer', async () => {
    const h = await boot('ask'); let prompts = 0
    h.ctx.on('user-questions/request', async request => { prompts++; expect(request.questions[0]!.detail).toContain('需要人工审批'); return choose('批准并发送')(request) })
    expect((await h.invoke({ ...args, requires_human_approval: true })).value).toMatchObject({ status: 'ok', approval: { mode: 'manual' } })
    expect(prompts).toBe(1); expect(h.adapter.requests).toHaveLength(1)
  })
  it('never treats a false label as consent in manual mode', async () => {
    const h = await boot()
    await h.ctx.settings.update('advisor', { approvalMode: 'manual' })
    h.ctx.on('user-questions/request', choose('拒绝'))
    expect((await h.invoke(ordinary)).value).toMatchObject({ status: 'denied' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it.each(['false', 0, null])('rejects non-boolean labels rather than coercing them (%s)', label => {
    expect(() => parseInput({ ...args, requires_human_approval: label })).toThrow()
  })
  it('keeps sensitive-content and endpoint checks even when the label is false', async () => {
    const h = await boot()
    expect((await h.invoke({ ...ordinary, question: 'Check api_key=synthetic-not-a-real-secret' })).value).toMatchObject({ status: 'review_required' })
    await h.ctx.settings.update('advisor-test', { baseURL: 'https://new.invalid' })
    expect((await h.invoke(ordinary, 'new-address')).value).toMatchObject({ status: 'review_required' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('ignores stale reviewer settings in self mode and preserves them for later switching', async () => {
    const h = await boot()
    await h.ctx.settings.update('advisor', { reviewerProvider: 'unavailable-provider', reviewerModel: 'unavailable-model' })
    expect((await h.invoke(ordinary)).value).toMatchObject({ status: 'ok' })
    expect(h.adapter.requests).toHaveLength(1)
    expect(h.ctx.settings.describe().find(s => s.ns === 'advisor')?.value).toMatchObject({ reviewerProvider: 'unavailable-provider' })
  })
  it('respects host never and disabling the mode after the send marker', async () => {
    const h = await boot()
    h.agent.session.append('approval/policy', { policy: 'never' })
    expect((await h.invoke(ordinary)).value).toMatchObject({ status: 'denied' })
    expect(h.adapter.requests).toHaveLength(0)
    h.agent.session.append('approval/policy', { policy: 'ask' })
    const claim = Journal.prototype.claimSend
    vi.spyOn(Journal.prototype, 'claimSend').mockImplementation(async function (this: Journal, request) { await claim.call(this, request); await h.ctx.settings.update('advisor', { approvalMode: 'manual' }) })
    expect((await h.invoke(ordinary, 'disabled-in-flight')).value).toMatchObject({ status: 'cancelled' })
    expect(h.adapter.requests).toHaveLength(0)
  })
})
