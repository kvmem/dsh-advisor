import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import LlmRuntime, { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService, { type AskUserQuestionRequest, type AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as advisor from '../src/index.js'

class MemorySettings extends SettingsProvider {
  constructor(ctx: Context) { super(ctx) }
  get writable() { return true }
  protected async load() { return {} }
  protected async persist(_ns: SettingsNamespace, _section: Record<string, unknown>) {}
}
export class ScriptedAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  response: (request: GenerateOptions) => AsyncIterable<StreamChunk> = async function* () {
    yield { type: 'text-delta', index: 0, text: '建议检查边界条件，并补充验证。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  async *stream(request: GenerateOptions) { this.requests.push(request); yield* this.response(request) }
}
export const args = { question: '失败原因是什么？', goal: '修复解析器', constraints: '保留公开接口', attempts: '已运行测试，空输入用例失败。', evidence: [] }
export const choose = (label: string) => async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => ({ answers: request.questions.map(q => ({ id: q.id, selected: [label] })) })
export async function harness(config: Partial<advisor.Config> = {}, openTurn = true) {
  const root = await mkdtemp(join(import.meta.dirname, '.audit-'))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MemorySettings)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(UserQuestionService)
  ctx.settings.register('advisor-test', z.object({ baseURL: z.string(), marker: z.string() }), { base: { baseURL: 'https://advisor.invalid/v1', marker: 'initial' } })
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['advisor-test'], adapter)
  ctx.llm.registerConfigurableProviders([{ provider: 'advisor-test', displayName: 'Test', settingsNs: 'advisor-test', settingsPath: [] }])
  const settings = { provider: 'advisor-test', model: 'test-model', storageDir: root, ...config }
  const fiber = ctx.plugin(advisor, settings)
  await fiber
  const agent = await ctx.agentLoop.create(SessionId('advisor-test-session'), { provider: 'advisor-test', model: 'main-model' })
  if (openTurn) agent.session.append('turn/start', { turn: 1 })
  const invoke = (input: unknown = args, call = 'help-1', signal = new AbortController().signal) => ctx.tools.execute({ name: 'ask_advisor', callId: ToolCallId(call), agent, signal, arguments: input })
  return { ctx, adapter, agent, invoke, root, fiber, settings, async close() { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
}
