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
  approvalMode: 'manual' | 'auto' | 'self' | 'always'
  reviewerProvider: string
  reviewerModel: string
  autoAdvisorEndpoint: string
  autoReviewerEndpoint: string
  reviewFallback: 'ask' | 'skip'
}
export const PreferencesSchema: z<AdvisorPreferences> = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().default(''),
  model: z.string().default(''),
  maxOutputTokens: OutputTokensSchema,
  maxOutputBytes: OutputBytesSchema,
  approvalMode: z.union(['manual', 'auto', 'self', 'always']).default('manual'),
  reviewerProvider: z.string().default(''),
  reviewerModel: z.string().default(''),
  autoAdvisorEndpoint: z.string().default(''),
  autoReviewerEndpoint: z.string().default(''),
  reviewFallback: z.union(['ask', 'skip']).default('ask'),
})
export function validatePreferences(value: AdvisorPreferences): void {
  // Empty routes are an ordinary first-install state. Availability is checked
  // at use time so removing an adapter cannot prevent the settings UI loading.
  if (value.provider) text(value.provider, 200)
  if (value.model) text(value.model, 200)
  if (value.reviewerProvider) text(value.reviewerProvider, 200)
  if (value.reviewerModel) text(value.reviewerModel, 200)
  if (value.enabled && value.approvalMode !== 'manual') {
    if (value.approvalMode === 'auto' && (!value.reviewerProvider.trim() || !value.reviewerModel.trim())) throw new AdvisorError('reviewer_required', '请先选择审批模型。')
    for (const endpoint of value.approvalMode === 'auto' ? [value.autoAdvisorEndpoint, value.autoReviewerEndpoint] : [value.autoAdvisorEndpoint]) {
      let url: URL
      try { url = new URL(endpoint) } catch { throw new AdvisorError('endpoint_required', '请在界面确认顾问与审批模型的接收地址后保存。') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AdvisorError('invalid_endpoint', '自动审批接收地址无效。')
    }
  }
}
export function advisorRoute(value: AdvisorPreferences) {
  if (!value.enabled) throw new AdvisorError('disabled', '顾问已停用。可在“设置 → 插件 → DSH SuperAdvisor”中启用；没有发送。')
  if (!value.provider.trim() || !value.model.trim()) throw new AdvisorError('not_configured', '请先在“设置 → 插件 → DSH SuperAdvisor”中选择模型服务和顾问模型并保存；没有发送。')
  return { provider: value.provider.trim(), model: value.model.trim(), ...(value.maxOutputTokens ? { maxTokens: value.maxOutputTokens } : {}), maxOutputBytes: value.maxOutputBytes }
}
