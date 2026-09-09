// Only external model responses, settings persistence and human answers are controlled here.
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
export const requests = []
export const previews = []
class MemorySettings extends SettingsProvider {
  constructor(ctx) { super(ctx) }
  get writable() { return true }
  async load() { return {} }
  async persist() {}
}
class TestAdapter extends LlmAdapter {
  async *stream(request) {
    requests.push(request)
    yield { type: 'text-delta', index: 0, text: 'built package advisor response' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export const inject = ['llm', 'userQuestions']
export async function apply(ctx) {
  await ctx.plugin(MemorySettings)
  await ctx.inject(['settings'], inner => {
    inner.settings.register('loader-test', z.object({ baseURL: z.string() }), { base: { baseURL: 'https://loader-test.invalid/v1' } })
  })
  ctx.llm.registerAdapter(['loader-test'], new TestAdapter())
  ctx.llm.registerConfigurableProviders([{ provider: 'loader-test', displayName: 'Loader Test', settingsNs: 'loader-test', settingsPath: [] }])
  ctx.on('user-questions/request', async request => {
    previews.push(request.questions[0].detail)
    return { answers: request.questions.map(q => ({ id: q.id, selected: ['批准并发送'] })) }
  })
}
