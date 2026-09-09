// Browser companion for the pinned DSH module loader; React is provided by the host.
window.__ModuleLoader__.load({
  id: 'dsh-tool-advisor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const styles = {
      card: { border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 12, padding: '14px 18px', margin: '8px 0', color: 'var(--dsw-alias-label-primary, inherit)' },
      meta: { color: 'var(--dsw-alias-label-tertiary, #777)', fontSize: 12, margin: '6px 0' },
      text: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65, margin: '8px 0' },
      code: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 12, borderRadius: 8, background: 'var(--dsw-alias-markdown-code-block, #f4f4f4)', overflow: 'auto', fontSize: 13 },
      body: { maxHeight: 580, overflowY: 'auto', paddingRight: 8 },
      button: { cursor: 'pointer', marginTop: 10, padding: '7px 12px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2, #ddd)', color: 'inherit', background: 'transparent' },
    }
    const statuses = { ok: '已返回建议', denied: '已拒绝，未发送', cancelled: '已取消', unavailable: '暂不可用', not_configured: '请先配置顾问模型', model_unavailable: '所选模型尚未接入', disabled: '顾问已停用', unknown: '结果未知，不会重发', budget_exhausted: '已达到本任务调用次数上限', conflict: '请求标识冲突', error: '未收到文字建议' }
    function inline(text) {
      return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, i) => part.startsWith('**') && part.endsWith('**')
        ? h('strong', { key: i }, part.slice(2, -2)) : part.startsWith('`') && part.endsWith('`')
          ? h('code', { key: i }, part.slice(1, -1)) : part)
    }
    // Render only text, headings, emphasis, lists and code. HTML, images and URLs
    // remain literal text: viewing an advisor result never initiates remote loads.
    function adviceNodes(text) {
      const nodes = [], lines = text.split('\n')
      let paragraph = [], code = null, fence = null
      const flush = () => { if (paragraph.length) { nodes.push(h('p', { key: nodes.length, style: styles.text }, ...inline(paragraph.join('\n')))); paragraph = [] } }
      for (const line of lines) {
        const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
        if (code !== null) {
          if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.slice(marker[0].length).trim() === '') {
            nodes.push(h('pre', { key: nodes.length, style: styles.code }, h('code', null, code.join('\n')))); code = null; fence = null
          } else code.push(line)
          continue
        }
        if (marker) { flush(); code = []; fence = marker[1]; continue }
        const heading = /^(#{1,6})\s+(.+)$/.exec(line)
        if (heading) { flush(); nodes.push(h('h' + Math.min(heading[1].length + 1, 6), { key: nodes.length, style: { margin: '16px 0 6px' } }, ...inline(heading[2]))); continue }
        if (/^\s*([-*_])\1\1[\s*_\-]*$/.test(line)) { flush(); nodes.push(h('hr', { key: nodes.length })); continue }
        const bullet = /^\s*(?:[-*+] |\d+[.)] )(.+)$/.exec(line)
        if (bullet) { flush(); nodes.push(h('div', { key: nodes.length, style: { ...styles.text, paddingLeft: 12 } }, ...inline(line.trim()))); continue }
        if (!line.trim()) flush(); else paragraph.push(line)
      }
      flush()
      if (code !== null) nodes.push(h('pre', { key: nodes.length, style: styles.code }, h('code', null, code.join('\n'))))
      return nodes
    }
    function readResult(block) {
      if (!('kind' in block)) return null
      const raw = (block.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
      try { const value = JSON.parse(raw); if (typeof value.status === 'string' && typeof value.text === 'string') return value } catch {}
      return { status: block.isError ? 'unavailable' : 'ok', text: raw || '没有可显示的结果。', request_id: '', truncated: false }
    }
    function AdvisorCard({ block, inspect }) {
      const result = React.useMemo(() => readResult(block), [block])
      const [expanded, setExpanded] = React.useState(false)
      const [source, setSource] = React.useState(false)
      const first = result?.text.split(/\n\s*\n/).find(p => p.trim() && !/^#{1,6}\s+[^\n]+$/.test(p.trim()) && !/^[-*_]{3,}$/.test(p.trim())) ?? ''
      const excerpt = first.length > 420 ? first.slice(0, 420) + '…' : first
      return h('section', { style: styles.card, 'aria-label': '顾问建议', 'data-advisor-card': true },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 16 } }, h('strong', null, '顾问建议'), h('span', { style: styles.meta }, result ? statuses[result.status] ?? result.status : '准备上下文 / 等待审批')),
        !result ? h('p', { style: styles.text }, '完整求助内容会在审批卡中展示，由你决定是否发送。') : h(React.Fragment, null,
          result.truncated && h('p', { style: styles.text }, '顾问达到单次输出上限，以下内容可能不完整。'),
          expanded ? h('div', { style: styles.body, 'data-advisor-full': true }, ...adviceNodes(result.text)) : h('div', { style: styles.text, 'data-advisor-summary': true }, ...inline(excerpt)),
          h('button', { type: 'button', style: styles.button, 'aria-expanded': expanded, onClick: () => setExpanded(!expanded) }, expanded ? '收起完整建议' : `展开完整建议（${result.text.length.toLocaleString('en-US')} 字符）`),
          expanded && h('details', { style: { marginTop: 12 } }, h('summary', { style: { cursor: 'pointer' }, onClick: () => setSource(!source) }, '原文与核对信息'),
            h('p', { style: styles.meta }, '状态：' + result.status + (result.request_id ? '\n请求编号：' + result.request_id : '')),
            source && h('pre', { style: styles.code }, result.text)),
          result.status === 'ok' && h('p', { style: styles.meta }, '顾问建议由主模型验证后继续执行。'),
          inspect && h('button', { type: 'button', style: { ...styles.button, marginLeft: 8 }, onClick: inspect }, '查看调用记录')))
    }
    function AdvisorSettingsCard({ scope, describe, remote }) {
      const snapshot = React.useSyncExternalStore(React.useCallback(fn => scope.subscribe(fn), [scope]), React.useCallback(() => scope.getSnapshot(), [scope]))
      const mirror = React.useSyncExternalStore(React.useCallback(fn => describe.subscribe(fn), [describe]), React.useCallback(() => describe.getSnapshot(), [describe]))
      const [draft, setDraft] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [manual, setManual] = React.useState(false)
      const [reload, setReload] = React.useState(0)
      const [catalog, setCatalog] = React.useState({ status: 'loading', providers: [], groups: [], partial: false })
      React.useEffect(() => {
        let active = true, generation = 0
        const load = async () => {
          const run = ++generation
          setCatalog(old => ({ ...old, status: 'loading' }))
          try {
            const [models, directory] = await Promise.all([remote.session.modelCatalog(), remote.llm.listConfigurableProviders()])
            if (!active || run !== generation) return
            if (!models.ok || !directory.ok) throw new Error('catalog unavailable')
            const routable = new Set(models.value.routableProviders)
            setCatalog({ status: 'ready', providers: directory.value.filter(p => routable.has(p.provider)), groups: models.value.groups, partial: models.value.failures.length > 0 })
          } catch {
            if (active && run === generation) setCatalog(old => ({ ...old, status: 'error' }))
          }
        }
        void load()
        const off = [remote.$on('llm/adapters-updated', () => { void load() }), remote.$on('settings/document-updated', () => { void load() })]
        return () => { active = false; off.forEach(dispose => dispose()) }
      }, [remote, reload])
      // Drafts retain the revision at the first edit. Another tab's save must
      // never be silently overwritten by this form's whole-route mutation.
      const value = draft?.value ?? snapshot.value
      if (!value) return h('li', { style: styles.card, 'data-advisor-settings': true }, '正在读取顾问配置…')
      const edit = (field, next) => {
        setNotice('')
        setDraft(old => ({ revision: old?.revision ?? snapshot.revision, value: { ...(old?.value ?? snapshot.value), [field]: next } }))
      }
      const provider = catalog.providers.find(p => p.provider === value.provider)
      const models = catalog.groups.find(g => g.id === value.provider)?.models ?? []
      const knownModel = models.some(m => m.id === value.model)
      const custom = manual || (!!value.model && !knownModel)
      let profile = mirror.view?.namespaces.find(n => n.ns === provider?.settingsNs)?.value
      for (const key of provider?.settingsPath ?? []) profile = profile?.[key]
      const endpoint = typeof profile?.baseURL === 'string' ? profile.baseURL : ''
      let validEndpoint = false
      try { const url = new URL(endpoint); validEndpoint = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash } catch {}
      const conflicted = draft !== null && draft.revision !== snapshot.revision
      const dirty = draft !== null && JSON.stringify(value) !== JSON.stringify(snapshot.value)
      const validBudget = Number.isInteger(value.maxOutputTokens) && value.maxOutputTokens >= 128 && value.maxOutputTokens <= 1000000
      const valid = validBudget && (!value.enabled || (!!provider && !!value.model.trim() && value.model.length <= 200 && validEndpoint))
      const disabled = !snapshot.writable || saving
      const save = async () => {
        if (!dirty || !valid || disabled || conflicted) return
        const desired = { ...value, provider: value.provider.trim(), model: value.model.trim() }
        const revision = draft.revision
        setSaving(true); setNotice('')
        try {
          await scope.mutate(Object.entries(desired).map(([field, entry]) => ({ op: 'set', path: [field], value: entry })), revision)
          const accepted = scope.getSnapshot().value
          if (!accepted || Object.keys(desired).some(key => accepted[key] !== desired[key])) throw new Error('save not accepted')
          setDraft(null); setNotice('已保存。后续求助使用这项配置；保存不会调用模型。')
        } catch { setNotice('保存未成功。请重新载入已保存设置后再试，当前输入已保留。') }
        finally { setSaving(false) }
      }
      const control = { width: '100%', padding: '9px 10px', marginTop: 6, borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2, #ddd)', color: 'inherit', background: 'var(--dsw-alias-background-l1, #fff)', font: 'inherit', boxSizing: 'border-box' }
      const field = (label, input, hint) => h('div', { style: { margin: '16px 0' } }, h('label', { style: { display: 'block' } }, label, input), hint && h('p', { style: styles.meta }, hint))
      return h('li', { style: { ...styles.card, listStyle: 'none' }, 'data-advisor-settings': true },
        h('h3', { style: { margin: '2px 0 8px' } }, '顾问模型'),
        h('p', { style: styles.text }, '选择遇到难题时求助的模型。主模型继续执行任务，顾问只在你批准本次内容后收到请求。'),
        h('p', { style: styles.meta }, '首次接入 GLM、Qwen 或其他模型：先到左侧“模型 / Models”添加服务、访问地址和密钥，再回到这里选择。'),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 } }, h('input', { type: 'checkbox', checked: value.enabled, disabled, onChange: e => edit('enabled', e.target.checked) }), '启用顾问'),
        field('模型服务', h('select', { 'aria-label': '模型服务', style: control, value: value.provider, disabled, onChange: e => { setManual(false); setNotice(''); setDraft(old => ({ revision: old?.revision ?? snapshot.revision, value: { ...(old?.value ?? snapshot.value), provider: e.target.value, model: '' } })) } },
          h('option', { value: '' }, '请选择已接入的模型服务'),
          value.provider && !provider && h('option', { value: value.provider, disabled: true }, value.provider + '（当前不可用）'),
          ...catalog.providers.map(p => h('option', { key: p.provider, value: p.provider }, p.displayName + ' · ' + p.provider)))),
        field('顾问模型', h('select', { 'aria-label': '顾问模型', style: control, value: custom ? '__custom__' : value.model, disabled: disabled || !provider, onChange: e => { setManual(e.target.value === '__custom__'); edit('model', e.target.value === '__custom__' ? '' : e.target.value) } },
          h('option', { value: '' }, '请选择模型'), ...models.map(m => h('option', { key: m.id, value: m.id }, m.name + (m.name === m.id ? '' : ' · ' + m.id))), h('option', { value: '__custom__' }, '手动填写模型 ID…'))),
        custom && field('模型 ID', h('input', { 'aria-label': '模型 ID', type: 'text', style: control, value: value.model, maxLength: 200, disabled, onChange: e => edit('model', e.target.value) }), '名称需与服务端一致。部分适配器要求先在“模型 / Models”中登记该模型，再刷新这里的列表。'),
        provider && h('p', { style: styles.meta }, endpoint ? '接收地址：' + endpoint : '此服务尚未设置访问地址，请在“模型 / Models”中补充。'),
        h('button', { type: 'button', style: styles.button, disabled: catalog.status === 'loading', onClick: () => setReload(n => n + 1) }, catalog.status === 'loading' ? '正在读取模型列表…' : '刷新模型列表'),
        catalog.status === 'error' && h('p', { role: 'status', style: styles.text }, '模型列表读取失败，可刷新重试。'),
        catalog.partial && h('p', { style: styles.meta }, '部分服务的模型列表暂不可用，可手动填写模型 ID。'),
        catalog.status === 'ready' && !catalog.providers.length && h('p', { style: styles.text }, '还没有可用服务。请先在“模型 / Models”中添加。'),
        h('details', { style: { marginTop: 18 } }, h('summary', { style: { cursor: 'pointer' } }, '输出设置'),
          field('单次输出上限（tokens）', h('input', { 'aria-label': '单次输出上限（tokens）', type: 'number', min: 128, max: 1000000, step: 1, style: control, value: value.maxOutputTokens, disabled, onChange: e => edit('maxOutputTokens', Number(e.target.value)) }), '更换服务时请确认它支持这个上限；实际输出也受模型与上下文限制。')),
        !snapshot.writable && h('p', { role: 'status', style: styles.text }, '当前连接不允许修改设置，请在本机可写的 DSH 界面中配置。'),
        conflicted && h('p', { role: 'alert', style: styles.text }, '配置已在其他页面更新。请重新载入已保存设置，再提交修改。'),
        !validBudget && h('p', { role: 'alert', style: styles.text }, '输出上限必须是 128–1,000,000 之间的整数。'),
        notice && h('p', { role: 'status', style: styles.text }, notice),
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 } },
          h('button', { type: 'button', style: styles.button, disabled: !dirty || !valid || disabled || conflicted, onClick: () => { void save() } }, saving ? '正在保存…' : '保存顾问配置'),
          h('button', { type: 'button', style: styles.button, disabled: saving || (!draft && !notice), onClick: () => { setDraft(null); setManual(false); setNotice('') } }, conflicted ? '重新载入已保存设置' : '放弃修改')))
    }
    return {
      name: 'advisor-readable-view', inject: ['slots', 'settingsScope', 'remote', 'remote.session', 'remote.llm'],
      apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'ask_advisor' }, AdvisorCard))
        const scope = ctx.settingsScope.bind({ namespace: 'advisor' })
        const describe = ctx.settingsScope.describe()
        ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name: 'settings.plugin.item', key: 'advisor' }, () => h(AdvisorSettingsCard, { scope, describe, remote: ctx.remote })))
      },
    }
  },
})
