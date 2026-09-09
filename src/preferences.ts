import z from '@deepseek-ai/schemastery'
import { OutputBytesSchema, OutputTokensSchema } from './limits.js'
import { AdvisorError, text } from './model.js'

// Stable across the DSH SuperAdvisor rename so existing saved settings survive.
export const PREFERENCES_NS = 'advisor'
export interface AdvisorPreferences {
  enabled: boolean
  provider: string
  model: string
  maxOutputTokens: number
  maxOutputBytes: number
}
export const PreferencesSchema: z<AdvisorPreferences> = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().default(''),
  model: z.string().default(''),
  maxOutputTokens: OutputTokensSchema,
  maxOutputBytes: OutputBytesSchema,
})
export function validatePreferences(value: AdvisorPreferences): void {
  // Empty routes are an ordinary first-install state. Availability is checked
  // at use time so removing an adapter cannot prevent the settings UI loading.
  if (value.provider) text(value.provider, 200)
  if (value.model) text(value.model, 200)
}
export function advisorRoute(value: AdvisorPreferences) {
  if (!value.enabled) throw new AdvisorError('disabled', '顾问已停用。可在“设置 → 插件 → DSH SuperAdvisor”中启用；没有发送。')
  if (!value.provider.trim() || !value.model.trim()) throw new AdvisorError('not_configured', '请先在“设置 → 插件 → DSH SuperAdvisor”中选择模型服务和顾问模型并保存；没有发送。')
  return { provider: value.provider.trim(), model: value.model.trim(), ...(value.maxOutputTokens ? { maxTokens: value.maxOutputTokens } : {}), maxOutputBytes: value.maxOutputBytes }
}
