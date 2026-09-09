import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { AdvisorError, fenced, text, type Draft, type Snapshot } from './model.js'

type Pending = { exec: ToolRunContext; snapshot: Snapshot; grant?: string; edit?: Draft }
export class ApprovalWizard {
  private pending = new Map<symbol, Pending>()
  constructor(private ctx: Context) {
    ctx.on('approval/request', async (request, next) => {
      const pending = [...this.pending.values()].find(p => p.exec.agent === request.agent && p.exec.callId === request.callId && request.toolName === 'ask_advisor' && request.reason === this.reason(p.snapshot))
      if (!pending) return next()
      try { return await this.answer(pending) }
      catch (error) {
        // Browser dismissal arrives as a transported UserQuestionError, not an aborted tool signal.
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (pending.exec.signal.aborted || code === 'ASK_CANCELLED' || code === 'ASK_ABORTED') return 'cancelled'
        return 'unavailable'
      }
    }, { prepend: true })
  }
  private reason(snapshot: Snapshot): string { return `advisor snapshot ${snapshot.hash}; one send only` }
  async review(snapshot: Snapshot, exec: ToolRunContext): Promise<{ outcome: ApprovalOutcome; grant?: string; edit?: Draft }> {
    if (!exec.agent) return { outcome: 'unavailable' }
    const pending: Pending = { exec, snapshot }
    this.pending.set(exec.token, pending)
    try {
      const outcome = await this.ctx.approval.request({ agent: exec.agent, callId: exec.callId, toolName: 'ask_advisor', reason: this.reason(snapshot), signal: exec.signal })
      if (exec.signal.aborted) return { outcome: 'cancelled' }
      return { outcome, grant: pending.grant, edit: pending.edit }
    } finally { this.pending.delete(exec.token) }
  }
  private async ask(pending: Pending, question: AskUserQuestionItem): Promise<AskUserQuestionAnswerItem> {
    const reply = await this.ctx.userQuestions.ask({ agent: pending.exec.agent, signal: pending.exec.signal, questions: [question] })
    pending.exec.signal.throwIfAborted()
    if (reply.answers.length !== 1 || reply.answers[0]?.id !== question.id) throw new AdvisorError('invalid_answer', '审批回答无效。')
    return reply.answers[0]
  }
  private selected(answer: AskUserQuestionAnswerItem): string | undefined {
    return answer.selected.length === 1 && !answer.custom ? answer.selected[0] : undefined
  }
  private async answer(pending: Pending): Promise<ApprovalOutcome> {
    const { snapshot } = pending
    const detail = [
      `**顾问模型**：${inline(snapshot.target.model)}　·　**服务**：${inline(snapshot.target.provider)}`,
      `**接收地址**：${inline(snapshot.target.endpoint)}`,
      `**本次发送**：${snapshot.bytes.toLocaleString('en-US')} 字节，只发送一次。`,
      `**输出设置**：${snapshot.target.maxTokens === undefined ? '沿用模型服务设置（adapter 未提供具体 token 上限）' : `最多输出 ${snapshot.target.maxTokens.toLocaleString('en-US')} tokens（本次有效配置）`}；${snapshot.target.maxOutputBytes ? `接收文本最多 ${snapshot.target.maxOutputBytes.toLocaleString('en-US')} 字节` : '插件接收文本不设上限'}。实际输出仍受模型与服务限制。`,
      '下面逐项展示全部求助正文。你可以编辑或删除证据；选择“批准并发送”并提交后才会发送。',
      ...snapshot.warnings.map(warning => `> ${warning}`),
      snapshot.prompt, '---', '### 顾问收到的固定指令', snapshot.system,
      '费用由所选模型服务结算。完整配置和请求编号可在“查看调用详情”中核对。',
    ].join('\n\n')
    let choice: string | undefined
    do {
      choice = this.selected(await this.ask(pending, { id: 'advisor-review', question: '是否批准这一次顾问求助？', detail, options: ['批准并发送', '编辑内容', '删除证据', '拒绝', '查看调用详情'].map(label => ({ label })) }))
      if (choice === '查看调用详情') {
        const back = await this.ask(pending, { id: 'advisor-details', question: '调用详情（尚未发送）', detail: fenced(JSON.stringify({ provider: snapshot.target.provider, model: snapshot.target.model, endpoint: snapshot.target.endpoint, config: snapshot.target.callConfig, inputBytes: snapshot.bytes, maxOutputTokens: snapshot.target.maxTokens ?? null, maxOutputBytes: snapshot.target.maxOutputBytes ?? 0, request: snapshot.hash, sends: 1 }, null, 2)), options: [{ label: '返回审批' }] })
        if (this.selected(back) !== '返回审批') return 'rejected'
      }
    } while (choice === '查看调用详情')
    if (choice === '批准并发送') { pending.grant = snapshot.hash; return 'allowed-once' }
    if (choice === '拒绝') return 'rejected'
    const draft = structuredClone(snapshot.draft)
    if (choice === '删除证据') {
      if (!draft.evidence.length) return 'rejected'
      const labels = draft.evidence.map(e => e.id)
      const remove = await this.ask(pending, { id: 'advisor-remove', question: '选择要删除的证据；随后会显示新的完整预览。', options: labels.map(label => ({ label })), multiSelect: true })
      if (remove.custom || !remove.selected.length || remove.selected.some(id => !labels.includes(id))) return 'rejected'
      draft.evidence = draft.evidence.filter(e => !remove.selected.includes(e.id))
      pending.edit = draft
      return 'cancelled'
    }
    if (choice === '编辑内容') {
      const fields = { '求助问题': 'question', '任务目标': 'goal', '约束': 'constraints', '尝试记录': 'attempts' } as const
      const labels = [...Object.keys(fields), ...draft.evidence.map(e => e.id)]
      const field = this.selected(await this.ask(pending, { id: 'advisor-field', question: '选择要替换的内容。', options: labels.map(label => ({ label })) }))
      if (!field || !labels.includes(field)) return 'rejected'
      const key = fields[field as keyof typeof fields]
      const evidence = draft.evidence.find(e => e.id === field)
      const prior = key ? draft[key] : evidence!.text
      const replacement = await this.ask(pending, { id: 'advisor-edit', question: '输入完整替换文本；随后会再次显示预览。', detail: fenced(prior) })
      if (replacement.selected.length || !replacement.custom) return 'rejected'
      const value = text(replacement.custom, 65536)
      if (key) draft[key] = value
      else { evidence!.text = value; evidence!.edited = true }
      pending.edit = draft
      return 'cancelled'
    }
    return 'rejected'
  }
}
function inline(value: string): string { return value.replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&') }
