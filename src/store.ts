import { constants } from 'node:fs'
import { mkdir, open, lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { AdvisorError, canonical, digest, result, type Result, type Snapshot } from './model.js'
import { MAX_RESULT_FILE_BYTES } from './limits.js'

async function syncDir(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await fd.sync() } finally { await fd.close() }
}
/** User-owned local POSIX filesystem; reject symlink components, never repair permissions silently. */
async function directory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new AdvisorError('storage_unavailable', '审计目录必须是规范的绝对路径。')
  const root = parse(path).root
  let current = root
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part)
    try { await mkdir(current, { mode: 0o700 }); await syncDir(dirname(current)) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AdvisorError('storage_unavailable', '审计目录不能经过符号链接。')
  }
  const info = await lstat(path)
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new AdvisorError('storage_unavailable', '审计目录必须由当前用户所有且权限为 0700。')
  if (await realpath(path) !== path) throw new AdvisorError('storage_unavailable', '审计目录路径不稳定。')
}
async function writeOnce(path: string, value: unknown): Promise<boolean> {
  let fd
  try { fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e }
  try { await fd.writeFile(canonical(value) + '\n'); await fd.sync() } finally { await fd.close() }
  await syncDir(dirname(path))
  return true
}
async function read(path: string, maxBytes = 2000000): Promise<unknown | undefined> {
  let fd
  try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
  try {
    const info = await fd.stat()
    if (!info.isFile() || info.size > maxBytes || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('invalid audit file')
    return JSON.parse(await fd.readFile('utf8')) as unknown
  } finally { await fd.close() }
}
export class AuditStore {
  constructor(private root: string, private maxCalls: number) {}
  async begin(session: string, call: string, inputHash: string): Promise<Journal | Result> {
    await directory(this.root)
    const taskDir = join(this.root, digest(session))
    const callDir = join(taskDir, digest(call))
    await directory(taskDir); await directory(callDir)
    const journal = new Journal(taskDir, callDir, this.maxCalls)
    if (await writeOnce(join(callDir, 'claim.json'), { inputHash })) return journal
    try {
      const claim = await read(join(callDir, 'claim.json')) as { inputHash?: string } | undefined
      if (claim?.inputHash !== inputHash) return result('conflict', '这个调用标识已用于另一份请求。不会发送。')
      const cached = await read(join(callDir, 'result.json'), MAX_RESULT_FILE_BYTES) as Result | undefined
      if (cached && typeof cached.status === 'string' && typeof cached.text === 'string' && typeof cached.request_id === 'string' && typeof cached.truncated === 'boolean') return cached
      const sent = await read(join(callDir, 'send.json'))
      return sent
        ? result('unknown', '这个调用已保留发送记录，远端结果未知。不会自动重发；如需再次求助，请用新的调用重新审批。')
        : result('unavailable', '这个调用正在处理或上次在发送前中断。不会恢复旧授权；请等待原调用或用新的调用重新审批。')
    } catch {
      return result('unknown', '这个调用的恢复记录不完整，无法确认远端状态。不会发送或重用旧授权。')
    }
  }
}
export class Journal {
  constructor(private taskDir: string, private callDir: string, private maxCalls: number) {}
  async preview(snapshot: Snapshot): Promise<void> {
    if (!await writeOnce(join(this.callDir, `snapshot-${snapshot.revision}.json`), snapshot)) throw new Error('duplicate snapshot revision')
  }
  async decision(snapshot: Snapshot, outcome: string): Promise<void> {
    await writeOnce(join(this.callDir, `decision-${snapshot.revision}.json`), { hash: snapshot.hash, outcome, time: new Date().toISOString() })
  }
  async claimSend(snapshot: Snapshot): Promise<void> {
    // Persistent slot files enforce a task cap across concurrent processes. A crash may consume a slot.
    let ticket = false
    for (let index = 0; index < this.maxCalls; index++) {
      if (await writeOnce(join(this.taskDir, `dispatch-${index}.json`), { hash: snapshot.hash })) { ticket = true; break }
    }
    if (!ticket) throw new AdvisorError('budget_exhausted', '当前任务的顾问调用次数已达上限。')
    if (!await writeOnce(join(this.callDir, 'send.json'), { hash: snapshot.hash, time: new Date().toISOString() })) throw new AdvisorError('unknown', '调用已有发送记录，不会重复发送。')
  }
  async finish(outcome: Result): Promise<Result> {
    if (!await writeOnce(join(this.callDir, 'result.json'), outcome)) throw new Error('duplicate result')
    return outcome
  }
}
