import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { requests, previews } from './loader-fixture.mjs'

const root = await mkdtemp(join(import.meta.dirname, '.loader-'))
const ctx = new Context()
try {
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const packages = ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop', 'user-approval', 'user-questions']
  const rows = packages.map(id => ({ id, name: `@deepseek-ai/dsh-${id}`, ...(id === 'agent-loop' ? { config: { agents: [] } } : {}) }))
  rows.push({ id: 'external-test-fixtures', name: '../loader-fixture.mjs' })
  rows.push({ id: 'advisor', name: process.env.ADVISOR_SMOKE_MODULE ?? '../../dist/index.js', config: { storageDir: join(root, 'audit') } })
  // JSON is a YAML subset; Include reads a genuine on-disk cordis.yml, with real Node resolution.
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(rows, null, 2))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  assert(ctx.tools.schemas().some(tool => tool.name === 'ask_advisor'))
  assert.equal(ctx.settings.describe().find(item => item.ns === 'advisor')?.value.provider, '')
  assert.equal(ctx.settings.describe().find(item => item.ns === 'advisor')?.value.maxOutputTokens, 0)
  assert.equal(ctx.settings.describe().find(item => item.ns === 'advisor')?.value.maxOutputBytes, 0)
  await ctx.settings.update('advisor', { provider: 'loader-test', model: 'test-model' })
  assert.equal(requests.length, 0)
  const agent = await ctx.agentLoop.create(SessionId('built-loader-task'), { provider: 'loader-test', model: 'main-model' })
  agent.session.append('turn/start', { turn: 1 })
  const call = { name: 'ask_advisor', callId: ToolCallId('built-call'), agent, signal: new AbortController().signal, arguments: { question: 'Review this isolated request.', goal: 'Verify installation', constraints: 'No network', attempts: 'Loaded through cordis.yml.', evidence: [] } }
  const outcome = await ctx.tools.execute(call)
  assert.equal(outcome.isError, false)
  assert.equal(outcome.value.status, 'ok')
  assert.equal(requests.length, 1)
  assert.equal(previews.length, 1)
  assert.equal(requests[0].maxTokens, undefined)
  assert(previews[0].includes('插件接收文本不设上限'))
  assert(previews[0].includes(requests[0].messages[0].content[0].text))
  assert.deepEqual((await ctx.tools.execute(call)).value, outcome.value)
  assert.equal(requests.length, 1)
  console.log('PASS: built ESM package loaded without a model through cordis.yml; saved model settings; reviewed request sent once; cached result reused.')
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
