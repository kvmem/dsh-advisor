import z from '@deepseek-ai/schemastery'
import { MAX_OUTPUT_TOKENS } from './limits.js'
import { AdvisorError, text } from './model.js'

export const PREFERENCES_NS = 'advisor'
export interface AdvisorPreferences {
  enabled: boolean
  provider: string
  model: string
  maxOutputTokens: number
}
export const PreferencesSchema: z<AdvisorPreferences> = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().default(''),
  model: z.string().default(''),
  maxOutputTokens: z.number().step(1).min(128).max(MAX_OUTPUT_TOKENS).default(4096),
})
export function validatePreferences(value: AdvisorPreferences): void {
  // Empty routes are an ordinary first-install state. Availability is checked
  // at use time so removing an adapter cannot prevent the settings UI loading.
  if (value.provider) text(value.provider, 200)
  if (value.model) text(value.model, 200)
}
export function advisorRoute(value: AdvisorPreferences) {
  if (!value.enabled) throw new AdvisorError('disabled', '顾问已停用。可在“设置 → 插件 → 顾问模型”中启用；没有发送。')
  if (!value.provider.trim() || !value.model.trim()) throw new AdvisorError('not_configured', '请先在“设置 → 插件 → 顾问模型”中选择模型服务和顾问模型并保存；没有发送。')
  return { provider: value.provider.trim(), model: value.model.trim(), maxTokens: value.maxOutputTokens }
}
