import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, symlink, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { AuditStore, Journal } from '../src/store.js'
import { digest, snapshot, type Draft, type Target, fenced, parseInput } from '../src/model.js'

const roots: string[] = []
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })
const draft: Draft = { question: 'question', goal: 'goal', attempts: 'attempts', constraints: 'constraints', evidence: [] }
const target: Target = { provider: 'test', model: 'model', endpoint: 'https://example.invalid', fingerprint: 'revision', maxTokens: 128, callConfig: {} }
const request = snapshot(draft, target, 'task', 'call', 1, 4096)
async function dir() { const path = await mkdtemp(join(import.meta.dirname, '.audit-')); roots.push(path); return path }
describe('durable single-send boundary', () => {
  it('claims each call only once under concurrent independent store instances', async () => {
    const path = await dir()
    const claimed = await Promise.all(Array.from({ length: 12 }, () => new AuditStore(path, 2).begin('task', 'call', 'input')))
    expect(claimed.filter(r => r instanceof Journal)).toHaveLength(1)
  })
  it('treats a persisted send without a result as unknown after restart', async () => {
    const path = await dir()
    const first = await new AuditStore(path, 2).begin('task', 'call', 'input')
    expect(first).toBeInstanceOf(Journal)
    await (first as Journal).preview(request)
    await (first as Journal).claimSend(request)
    expect(await new AuditStore(path, 2).begin('task', 'call', 'input')).toMatchObject({ status: 'unknown' })
  })
  it('never interprets a truncated result after a crash as a fresh unsent call', async () => {
    const path = await dir()
    const first = await new AuditStore(path, 2).begin('task', 'call', 'input') as Journal
    await first.claimSend(request)
    await writeFile(join(path, digest('task'), digest('call'), 'result.json'), '{"status":', { mode: 0o600 })
    expect(await new AuditStore(path, 2).begin('task', 'call', 'input')).toMatchObject({ status: 'unknown' })
  })
  it('enforces task limits across independent simultaneous callers', async () => {
    const path = await dir()
    const stores = await Promise.all(['a', 'b', 'c'].map(call => new AuditStore(path, 1).begin('task', call, 'input')))
    const claims = await Promise.allSettled(stores.map(store => (store as Journal).claimSend(request)))
    expect(claims.filter(c => c.status === 'fulfilled')).toHaveLength(1)
  })
  it('rejects symlinked and publicly readable storage', async () => {
    const path = await dir()
    await symlink(path, join(path, 'alias'))
    await expect(new AuditStore(join(path, 'alias'), 1).begin('task', 'call', 'input')).rejects.toMatchObject({ code: 'storage_unavailable' })
    await chmod(path, 0o755)
    await expect(new AuditStore(path, 1).begin('task', 'call', 'input')).rejects.toMatchObject({ code: 'storage_unavailable' })
  })
})
describe('review envelope boundaries', () => {
  it('uses stable hashes while binding the task, route, content and output limit', () => {
    const values = [request.hash,
      snapshot(draft, { ...target, maxTokens: 256 }, 'task', 'call', 1, 4096).hash,
      snapshot(draft, { ...target, endpoint: 'https://other.invalid' }, 'task', 'call', 1, 4096).hash,
      snapshot({ ...draft, question: 'changed' }, target, 'task', 'call', 1, 4096).hash,
      snapshot(draft, target, 'other-task', 'call', 1, 4096).hash,
    ]
    expect(new Set(values).size).toBe(values.length)
    expect(digest({ b: 1, a: 2 })).toBe(digest({ a: 2, b: 1 }))
    expect(Object.isFrozen(request.draft.evidence)).toBe(true)
  })
  it('keeps adversarial markdown and remote images inside a code fence', () => {
    const untrusted = '```\n![tracking](https://example.invalid/track)\n````\n'
    expect(fenced(untrusted)).toBe('`````text\n' + untrusted + '\n`````')
  })
  it('rejects forged approval fields and cross-session reference fields', () => {
    expect(() => parseInput({ ...draft, approved: true })).toThrow()
    expect(() => parseInput({ ...draft, evidence: [{ kind: 'tool_result', source: 'call', session: 'another', start_line: 1, end_line: 1 }] })).toThrow()
  })
})
