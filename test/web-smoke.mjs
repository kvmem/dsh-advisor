// Check the complete host, since a minimal Loader can miss CLI and persistence APIs.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const expected = process.argv[2]
const cli = join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))), 'lib/bin.js')
const root = await mkdtemp(join(import.meta.dirname, '.loader-web-'))
const home = join(root, 'home')
const guard = join(root, 'block-network.mjs')
await mkdir(home)
await writeFile(guard, `const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('External network disabled in Web smoke test');
  return original(input, init);
};
`)
const env = { ...process.env, DSH_HOME: home, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), NODE_OPTIONS: `--import=${guard}` }
let child
let exited
let output = ''
try {
  const version = spawnSync(process.execPath, [cli, '--version'], { env, cwd: root, encoding: 'utf8', timeout: 15000 })
  assert.equal(version.status, 0, 'DSH --version must succeed')
  // Older Node can exit zero without running the CLI when import.meta.main is absent.
  assert.equal(version.stdout.trim(), expected, 'DSH CLI must actually run and print the expected version')
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const patch = join(root, 'test.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'session-telemetry-otel', disabled: true },
    { insert: [{ id: 'advisor', name: fileURLToPath(new URL('../dist/index.js', import.meta.url)), config: { storageDir: join(root, 'audit') } }] },
  ]))
  child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--port', String(port), '--no-open'], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(child, 'exit')
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { output += chunk.toString() })
  const ready = new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=\\S+`)
  for (let attempt = 0; !ready.test(output); attempt++) {
    assert.equal(child.exitCode, null, 'Full DSH Web profile exited before becoming ready')
    assert.equal(child.signalCode, null, 'Full DSH Web profile was terminated before becoming ready')
    assert(attempt < 300, 'Full DSH Web profile did not become ready within 30 seconds')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  let response = await fetch(output.match(ready)[0], { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  if ([302, 303].includes(response.status)) {
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    assert(cookie, 'DSH login should issue a session cookie')
    response = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie }, signal: AbortSignal.timeout(5000) })
  }
  assert.equal(response.status, 200)
  assert.match(await response.text(), /<html/i)
  console.log(`PASS: DSH ${expected} CLI runs; complete Web profile and plugin load; HTTP responds.`)
} catch (error) {
  // Login links belong only to this short-lived fixture and should not enter CI output.
  console.error(output.replace(/\?token=\S+/g, '?token=[redacted]').slice(-8000))
  throw error
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timer)
  }
  await rm(root, { recursive: true, force: true })
}
