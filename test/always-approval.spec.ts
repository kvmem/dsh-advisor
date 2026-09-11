import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { args, choose, harness } from './harness.js'
import { digest } from '../src/model.js'
import { Journal } from '../src/store.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close() })
async function boot(openTurn = true) {
  const h = await harness({}, openTurn); cleanup.push(h.close)
  await h.ctx.settings.update('advisor', { approvalMode: 'always', autoAdvisorEndpoint: 'https://advisor.invalid/v1' })
  return h
}
describe('explicit approve-all policy', () => {
  it.each([true, false, undefined])('sends once without a reviewer or human regardless of label %s', async label => {
    const h = await boot(); const prepare = vi.spyOn(h.ctx.llm, 'prepareCall')
    let prompts = 0
    h.ctx.on('user-questions/request', async request => { prompts++; return choose('拒绝')(request) })
    const input = { ...args, ...(label === undefined ? {} : { requires_human_approval: label }) }
    const first = await h.invoke(input)
    expect(first.value).toMatchObject({ status: 'ok', approval: { mode: 'always', reviewer: '' } })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(h.adapter.requests.map(r => r.model)).toEqual(['test-model'])
    expect(prompts).toBe(0)
    expect((await h.invoke(input)).value).toEqual(first.value)
    expect(h.adapter.requests).toHaveLength(1)
    const dir = join(h.root, digest(h.agent.session.id), digest('help-1'))
    expect((await readdir(dir)).some(name => name.startsWith('review-send'))).toBe(false)
    expect(JSON.parse(await readFile(join(dir, 'snapshot-1.json'), 'utf8')).draft.requires_human_approval).toBe(label)
    expect(renderPrompt(await h.ctx.systemPrompt.assemble({ scope: h.agent }))).toContain('does not block sending even when true')
  })
  it('keeps redaction but does not escalate sensitive-content warnings', async () => {
    const h = await boot()
    const secret = 'synthetic-not-a-real-secret'
    expect((await h.invoke({ ...args, question: `Check api_key=${secret}`, requires_human_approval: true })).value).toMatchObject({ status: 'ok', approval: { mode: 'always' } })
    expect(h.adapter.requests).toHaveLength(1)
    expect(JSON.stringify(h.adapter.requests)).not.toContain(secret)
    const saved = JSON.parse(await readFile(join(h.root, digest(h.agent.session.id), digest('help-1'), 'snapshot-1.json'), 'utf8'))
    expect(saved.warnings.length).toBeGreaterThan(0)
  })
  it('skips changed destinations without a prompt until settings are saved again', async () => {
    const h = await boot(); let prompts = 0
    h.ctx.on('user-questions/request', async request => { prompts++; return choose('批准并发送')(request) })
    await h.ctx.settings.update('advisor-test', { baseURL: 'https://new.invalid' })
    expect((await h.invoke(args)).value).toMatchObject({ status: 'review_required', approval: { mode: 'always' } })
    expect(h.adapter.requests).toHaveLength(0); expect(prompts).toBe(0)
    await h.ctx.settings.update('advisor', { autoAdvisorEndpoint: 'https://new.invalid' })
    expect((await h.invoke(args, 'new-consultation')).value).toMatchObject({ status: 'ok' })
  })
  it('preserves other modes and requires manual approval after switching back', async () => {
    const h = await boot()
    await h.ctx.settings.update('advisor', { approvalMode: 'manual' })
    h.ctx.on('user-questions/request', choose('拒绝'))
    expect((await h.invoke(args)).value).toMatchObject({ status: 'denied' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('does not use stale reviewer settings and saving itself sends nothing', async () => {
    const h = await boot()
    await h.ctx.settings.update('advisor', { reviewerProvider: 'missing', reviewerModel: 'missing', autoReviewerEndpoint: '' })
    expect(h.adapter.requests).toHaveLength(0)
    expect((await h.invoke(args)).value).toMatchObject({ status: 'ok' })
    expect(h.adapter.requests.map(r => r.model)).toEqual(['test-model'])
  })
  it('respects host never and requires a running turn', async () => {
    const h = await boot(false)
    expect((await h.invoke(args)).value).toMatchObject({ status: 'unavailable' })
    h.agent.session.append('turn/start', { turn: 1 })
    h.agent.session.append('approval/policy', { policy: 'never' })
    expect((await h.invoke(args, 'forbidden')).value).toMatchObject({ status: 'denied' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it.each(['mode', 'cancel', 'host', 'round-trip'])('does not send when %s changes during the durable send claim', async change => {
    const h = await boot(); const controller = new AbortController()
    const claim = Journal.prototype.claimSend
    vi.spyOn(Journal.prototype, 'claimSend').mockImplementation(async function (this: Journal, request) {
      await claim.call(this, request)
      if (change === 'cancel') controller.abort()
      else if (change === 'host') h.agent.session.append('approval/policy', { policy: 'never' })
      else {
        await h.ctx.settings.update('advisor', { approvalMode: 'manual' })
        if (change === 'round-trip') await h.ctx.settings.update('advisor', { approvalMode: 'always' })
      }
    })
    await h.invoke(args, 'help-1', controller.signal)
    expect((await h.invoke(args)).value).toMatchObject({ status: 'cancelled' })
    expect(h.adapter.requests).toHaveLength(0)
  })
  it('does not send when audit storage fails', async () => {
    const h = await boot()
    vi.spyOn(Journal.prototype, 'decision').mockRejectedValue(new Error('storage unavailable'))
    expect((await h.invoke(args)).value).toMatchObject({ status: 'unavailable' })
    expect(h.adapter.requests).toHaveLength(0)
  })
})
