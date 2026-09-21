/**
 * dsh-context-compactor 浏览器半边（client bundle 源码，CJS 形态）。
 * 构建时被 scripts/build-client.mjs 包进 __ModuleLoader__.load 工厂。
 *
 * 两个入口：
 *  1. 输入框下方（conversation.composer.dock）默认只显示一个「上下文 X%」小胶囊，
 *     点击展开「压缩总结 / 提示增强」操作条；展开状态仅本次渲染会话内记忆。
 *  2. 设置 → 插件（plugins.item）里的配置卡片：直接读写服务端注册的
 *     settings namespace `dsh-context-compactor`（压缩阈值 / 保留量 / 压缩指令），
 *     保存后服务端热更新生效，无需重启。
 */

const React = require('react')
const { IconEnhanceOutline16, IconSparkle16, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives')

const name = 'dsh-context-compactor'
const inject = ['slots', 'remote', 'remote.commands', 'settingsScope']

const CC_NS = 'dsh-context-compactor'

const STYLES = `
[data-dsh-context-compactor-dock] {
  box-sizing: border-box;
  width: calc(100% - 2 * var(--dsh-composer-side-clearance) - 2 * var(--dsh-composer-dock-inset));
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
[data-dsh-context-compactor-dock] .cc-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-specific-tip);
  color: var(--dsw-alias-label-tertiary);
  border-radius: 999px;
  cursor: pointer;
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}
[data-dsh-context-compactor-dock] .cc-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-context-compactor-dock] .cc-meter.cc-warn {
  color: var(--dsw-alias-state-warning, #d97706);
  font-weight: 600;
}
[data-dsh-context-compactor-dock] .cc-caret {
  font-size: 10px;
  line-height: 1;
  transform: translateY(-1px);
}
[data-dsh-context-compactor-dock] .cc-caret.cc-open {
  transform: translateY(1px);
}
[data-dsh-context-compactor-dock] .cc-bar {
  box-sizing: border-box;
  width: 100%;
  max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-specific-tip);
  border-radius: 12px;
  align-items: center;
  gap: 10px;
  height: 36px;
  margin: 0 auto;
  padding: 4px 5px 4px 12px;
  display: flex;
  /* 窄屏（手机）下内容超出时横向滑动，避免溢出输入框；滚动条隐藏，可触摸滑动 */
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  overscroll-behavior-inline: contain;
}
[data-dsh-context-compactor-dock] .cc-bar::-webkit-scrollbar {
  display: none;
}
[data-dsh-context-compactor-dock] .cc-feedback {
  min-width: 0;
  flex: 1;
  color: var(--dsw-alias-label-secondary);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  font-size: 12px;
  line-height: 20px;
}
[data-dsh-context-compactor-dock] .cc-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  line-height: 20px;
}
[data-dsh-context-compactor-dock] .cc-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
[data-dsh-context-compactor-dock] .cc-button:disabled {
  opacity: 0.4;
  cursor: default;
}
/* 设置页配置卡片 */
[data-dsh-context-compactor-settings] {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 560px;
}
[data-dsh-context-compactor-settings] .ccs-status {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
[data-dsh-context-compactor-settings] .ccs-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
[data-dsh-context-compactor-settings] .ccs-label {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}
[data-dsh-context-compactor-settings] .ccs-hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
[data-dsh-context-compactor-settings] .ccs-input {
  border: 0.5px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-3);
  height: 34px;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 0 12px;
  font-size: 13px;
  line-height: 1.5;
}
[data-dsh-context-compactor-settings] textarea.ccs-input {
  height: auto;
  min-height: 72px;
  padding: 8px 12px;
  resize: vertical;
}
[data-dsh-context-compactor-settings] .ccs-input:focus-visible {
  border-color: var(--dsw-alias-brand-primary);
  outline: none;
}
[data-dsh-context-compactor-settings] .ccs-input[aria-invalid="true"] {
  border-color: var(--dsw-alias-state-error-primary);
}
[data-dsh-context-compactor-settings] .ccs-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
}
[data-dsh-context-compactor-settings] .ccs-failed {
  min-width: 0;
  flex: 1;
  color: var(--dsw-alias-label-error);
  font-size: 12px;
  line-height: 1.5;
}
[data-dsh-context-compactor-settings] .ccs-save {
  appearance: none;
  font: inherit;
  cursor: pointer;
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font-size: 13px;
  line-height: 1.5;
}
[data-dsh-context-compactor-settings] .ccs-save:disabled {
  opacity: 0.4;
  cursor: default;
}
[data-dsh-context-compactor-settings] .ccs-reset {
  font: inherit;
  cursor: pointer;
  background: transparent;
  border: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  padding: 0;
}
[data-dsh-context-compactor-settings] .ccs-reset:hover {
  color: var(--dsw-alias-label-primary);
}
`

function installStyles() {
  if (typeof document === 'undefined') return
  const tagId = '@dsh-external/dsh-context-compactor/dock.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dsh-external/dsh-context-compactor'
  tag.dataset.pluginCss = tagId
  tag.textContent = STYLES
  document.head.appendChild(tag)
}

/** 输入框下方的 dock：默认收起为用量胶囊，展开后是压缩总结 / 提示增强操作条。 */
function CompactDock(props) {
  // composer.dock 没有 owner props：session/input 必须走 session 作用域标准钩子
  // （useSession / useInput / useProjection / inputActions），读 props.session 会
  // 直接拿到 undefined 并在 session.blank 处抛错、整个条目渲染崩溃。
  const { useSession, useInput, useProjection } = props
  const session = typeof useSession === 'function' ? useSession((s) => s) : undefined
  const input = typeof useInput === 'function' ? useInput((i) => i) : undefined
  const running = Boolean(session && session.running)
  const pressure = typeof useProjection === 'function' ? useProjection('contextPressure') : undefined
  const [open, setOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [enhancing, setEnhancing] = React.useState(false)
  const [feedback, setFeedback] = React.useState(null)
  const pendingRef = React.useRef(false)
  const enhancingRef = React.useRef(false)
  const timerRef = React.useRef(null)

  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [])

  const showFeedback = React.useCallback((text, ms) => {
    setFeedback(text)
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { setFeedback(null) }, ms)
  }, [])

  const run = React.useCallback(async () => {
    if (pendingRef.current || running) return
    pendingRef.current = true
    setPending(true)
    setFeedback(null)
    try {
      const text = await props.compact()
      showFeedback(text, 8000)
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }, [props.compact, running, showFeedback])

  const runEnhance = React.useCallback(async () => {
    const draft = input && typeof input.draft === 'string' ? input.draft : ''
    if (!draft.trim()) {
      showFeedback('输入为空：先写点内容再增强', 5000)
      return
    }
    if (enhancingRef.current) return
    enhancingRef.current = true
    setEnhancing(true)
    setFeedback(null)
    try {
      const res = await props.enhance(draft)
      let msg
      if (res && res.ok) {
        if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
          props.inputActions.setDraft(res.text)
          msg = '已增强并写入输入框'
        } else {
          msg = res.text
        }
      } else {
        msg = (res && res.error) || '增强失败'
      }
      showFeedback(msg, 10000)
    } finally {
      enhancingRef.current = false
      setEnhancing(false)
    }
  }, [props.enhance, input, props.inputActions, showFeedback])

  // 全新空白会话不显示工具条。
  if (session === undefined || session.blank) return null

  const windowTokens = pressure && typeof pressure.contextWindow === 'number'
    ? pressure.contextWindow
    : undefined
  const usedTokens = pressure
    ? (typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens
      : typeof pressure.pressureTokens === 'number' ? pressure.pressureTokens : 0)
    : 0
  const percent = windowTokens !== undefined && windowTokens > 0
    ? Math.min(999, Math.round((usedTokens / windowTokens) * 100))
    : null
  const warn = percent !== null && percent >= 80
  const meterText = percent === null ? '上下文用量未知' : '上下文 ' + percent + '%'

  return React.createElement(
    'div',
    { className: 'cc-dock', 'data-dsh-context-compactor-dock': '' },
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'cc-toggle',
        onClick: () => { setOpen((v) => !v) },
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': open ? '收起上下文操作' : '展开上下文操作',
      },
      React.createElement('span', { className: 'cc-meter' + (warn ? ' cc-warn' : '') }, meterText),
      React.createElement('span', { className: 'cc-caret' + (open ? ' cc-open' : '') }, open ? '▴' : '▾'),
    ),
    open
      ? React.createElement(
          'div',
          { className: 'cc-bar' },
          feedback !== null
            ? React.createElement('span', { className: 'cc-feedback', title: feedback }, feedback)
            : null,
          React.createElement(
            Tooltip,
            {
              label: '对全部较早历史做全局详细总结并压缩（达到 80% 自动触发）',
              side: 'top',
              delayMs: 500,
            },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'cc-button',
                disabled: pending || running,
                onClick: () => { void run() },
                'aria-label': '压缩总结上下文',
                title: running ? 'agent 运行中，稍后再试' : undefined,
              },
              pending
                ? React.createElement('span', null, '压缩总结中…')
                : React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(IconSparkle16, { size: 14 }),
                    React.createElement('span', null, '压缩总结'),
                  ),
            ),
          ),
          React.createElement(
            Tooltip,
            {
              label: '用当前模型增强输入框提示词（Prompt Enhancer 合并功能）',
              side: 'top',
              delayMs: 500,
            },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'cc-button',
                disabled: enhancing || running,
                onClick: () => { void runEnhance() },
                'aria-label': '增强提示词',
                title: running ? 'agent 运行中，稍后再试' : undefined,
              },
              enhancing
                ? React.createElement('span', null, '增强中…')
                : React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(IconEnhanceOutline16, { size: 14 }),
                    React.createElement('span', null, '提示增强'),
                  ),
            ),
          ),
        )
      : null,
  )
}

/** 设置页一个数字字段的草稿规格：空串 = 恢复继承默认；非法数字拦截保存。 */
const NUMBER_FIELDS = [
  { field: 'thresholdRatio', label: '压缩触发阈值', hint: '上下文占用达到该比例（0.01–0.99）时自动压缩；留空恢复 cordis 配置默认。', min: 0.01, max: 0.99 },
  { field: 'retainRatio', label: '保留比例', hint: '压缩后保留最近内容的比例（0.01–0.99）；设置保留 Token 数后此项失效。', min: 0.01, max: 0.99 },
  { field: 'retainTokens', label: '保留 Token 数', hint: '压缩后保留的最近内容 Token 数；大于 0 时优先于保留比例，0 表示不启用。', min: 0 },
  { field: 'maxTokens', label: '摘要最大 Token 数', hint: '单次总结输出的 Token 上限（≥256）。', min: 256 },
]

const PROMPT_FIELD = { field: 'compressPrompt', label: '压缩指令（compressPrompt）', hint: '自定义发给模型的总结指令；留空使用插件内置中文模板。清空并保存即恢复默认。' }

function fieldText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number') return String(value)
  return String(value)
}

function CompactSettingsCard(props) {
  if (props.view === 'summary') {
    return React.createElement('span', null, '上下文自动压缩阈值、保留量与自定义压缩指令。')
  }
  const scope = props.scope
  // 第三个参数（getServerSnapshot）让同构渲染/水合场景也不会告警。
  const snap = React.useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot)
  const section = snap && snap.value ? snap.value : {}
  const base = snap && snap.base ? snap.base : {}
  const [draft, setDraft] = React.useState(undefined)
  const [saving, setSaving] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  // 快照刷新（保存落盘 / 其他入口改动）后重新同步草稿。
  React.useEffect(() => { setDraft(undefined) }, [snap])

  if (!snap || snap.status !== 'ready') {
    return React.createElement('p', { className: 'ccs-status', role: 'status' },
      '当前不可用：宿主未提供 dsh-context-compactor 设置命名空间（服务端未加载或内存模式）。')
  }

  const current = draft === undefined
    ? NUMBER_FIELDS.reduce((acc, f) => {
        acc[f.field] = fieldText(section[f.field] !== undefined ? section[f.field] : base[f.field])
        return acc
      }, { [PROMPT_FIELD.field]: fieldText(section[PROMPT_FIELD.field] !== undefined ? section[PROMPT_FIELD.field] : base[PROMPT_FIELD.field]) })
    : draft

  const invalid = NUMBER_FIELDS.some((f) => {
    const text = current[f.field]
    if (text === '') return false
    const n = Number(text)
    return !Number.isFinite(n) || n < f.min || (f.max !== undefined && n > f.max)
  })

  const edit = (field, text) => { setFailed(false); setDraft({ ...current, [field]: text }) }
  const resetField = (field) => { setFailed(false); setDraft({ ...current, [field]: '' }) }

  const save = async () => {
    setSaving(true)
    setFailed(false)
    try {
      for (const f of NUMBER_FIELDS) {
        const text = current[f.field]
        if (text === '') { await scope.unset(f.field); continue }
        const n = Number(text)
        if (!Number.isFinite(n)) continue
        await scope.set(f.field, n)
      }
      const prompt = current[PROMPT_FIELD.field]
      if (prompt === '') await scope.unset(PROMPT_FIELD.field)
      else await scope.set(PROMPT_FIELD.field, prompt)
      setDraft(undefined)
    } catch (error) {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const writable = snap.writable !== false
  const blocked = draft === undefined || invalid || saving

  return React.createElement(
    'div',
    { 'data-dsh-context-compactor-settings': '' },
    !writable
      ? React.createElement('p', { className: 'ccs-status', role: 'status' }, '当前部署的设置为只读，改动不会被保存。')
      : null,
    NUMBER_FIELDS.map((f) => React.createElement(
      'div',
      { className: 'ccs-field', key: f.field },
      React.createElement('span', { className: 'ccs-label' }, f.label),
      React.createElement('input', {
        className: 'ccs-input',
        type: 'text',
        inputMode: 'decimal',
        value: current[f.field],
        disabled: !writable || saving,
        'aria-invalid': (() => {
          const text = current[f.field]
          if (text === '') return undefined
          const n = Number(text)
          return Number.isFinite(n) && n >= f.min && (f.max === undefined || n <= f.max) ? undefined : 'true'
        })(),
        onChange: (event) => edit(f.field, event.target.value),
      }),
      React.createElement('p', { className: 'ccs-hint' }, f.hint),
      React.createElement('button', {
        type: 'button', className: 'ccs-reset', disabled: !writable || saving,
        onClick: () => resetField(f.field),
      }, '恢复默认'),
    )),
    React.createElement(
      'div',
      { className: 'ccs-field', key: PROMPT_FIELD.field },
      React.createElement('span', { className: 'ccs-label' }, PROMPT_FIELD.label),
      React.createElement('textarea', {
        className: 'ccs-input',
        value: current[PROMPT_FIELD.field],
        disabled: !writable || saving,
        onChange: (event) => edit(PROMPT_FIELD.field, event.target.value),
      }),
      React.createElement('p', { className: 'ccs-hint' }, PROMPT_FIELD.hint),
      React.createElement('button', {
        type: 'button', className: 'ccs-reset', disabled: !writable || saving,
        onClick: () => resetField(PROMPT_FIELD.field),
      }, '恢复默认'),
    ),
    React.createElement(
      'div',
      { className: 'ccs-footer' },
      failed
        ? React.createElement('p', { className: 'ccs-failed', role: 'status' }, '保存失败：写入被宿主拒绝，请检查取值后重试。')
        : null,
      React.createElement('button', {
        type: 'button', className: 'ccs-save', disabled: blocked,
        onClick: () => { void save() },
      }, saving ? '保存中…' : '保存'),
    ),
  )
}

function apply(ctx) {
  installStyles()
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'context-compact',
    order: 5,
    inject: (sessionId) => ({
      /** 执行 /compact，返回用户可见的结果文案（不抛错）。 */
      compact: async () => {
        try {
          // commands/execute 的 client 契约需要 3 个业务参数(agentId, line, images)，
          // 纯命令调用传空 images 数组。
          const result = await ctx.remote.commands.execute(sessionId, '/compact', [])
          if (!result.ok) return result.error.message + ' (' + result.error.code + ')'
          if (result.value === undefined) return '未知命令：/compact'
          return result.value.text
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      /** 用 DSH 当前模型增强提示词；走专用 HTTP 接口，不写会话日志/对话。返回 {ok,text|error}。 */
      enhance: async (text) => {
        try {
          const response = await fetch('/dsh-context-compactor/enhance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, text }),
          })
          const data = await response.json()
          if (!response.ok || !data || data.ok !== true) {
            return { ok: false, error: (data && data.error) || ('HTTP ' + response.status) }
          }
          return { ok: true, text: data.text }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
  }, CompactDock))

  // 设置 → 插件 页里的配置卡片；宿主没有该 slot（老版本）时静默跳过。
  try {
    const scope = ctx.settingsScope.bind({ namespace: CC_NS })
    ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item',
      id: 'context-compactor',
      order: 90,
      label: () => '上下文压缩',
      inject: () => ({ scope }),
    }, CompactSettingsCard))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('settings page unavailable: %s', message)
    else console.warn('[dsh-context-compactor] settings page unavailable:', message)
  }
}

module.exports = { name, inject, apply }
