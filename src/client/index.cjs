/**
 * dsh-session-compactor 浏览器半边（client bundle 源码，CJS 形态）。
 * 构建时被 scripts/build-client.mjs 包进 __ModuleLoader__.load 工厂。
 *
 * 两个入口：
 *  1. 输入框下方 dock 行里，官方「上下文用量」圆环（ContextMeter）的右侧：
 *     点击圆环展开「压缩总结 / 提示增强」两个按钮，默认收起不占位；
 *     点击圆环 = 官方 breakdown 弹窗照常弹出 + 右侧展开我们的两个按钮，一起出/一起收。
 *  2. 设置侧栏独立分页「上下文压缩」（settings.section，和其它插件一样）：
 *     直接读写服务端注册的 settings namespace `dsh-session-compactor`
 *     （压缩阈值 / 保留量 / 压缩指令），保存后热更新生效，无需重启。
 */

const React = require('react')
const { IconEnhanceOutline16, IconSparkle16, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives')

const name = 'dsh-session-compactor'
const inject = ['slots', 'remote', 'remote.commands', 'settingsScope']

const CC_NS = 'dsh-session-compactor'

const STYLES = `
/* 排到官方上下文圆环右侧：dock 行是 flex，我们的条目 DOM 在圆环之前，用 order 换序；
   收起时 display:none，不占位也不产生 flex gap。 */
[data-dsh-session-compactor-dock] {
  order: 1;
  flex: none;
  display: flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}
[data-dsh-session-compactor-dock].cc-collapsed {
  display: none;
}
/* 展开态与行内 pill/圆环同几何（line-height 20px + padding 1px，无边框无底色外框），
   展开不撑高 dock 行；hover 才出底色，和官方 pill 的视觉语言一致。 */
[data-dsh-session-compactor-dock] .cc-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}
[data-dsh-session-compactor-dock] .cc-feedback {
  min-width: 0;
  flex: 0 1 auto;
  max-width: 200px;
  color: var(--dsw-alias-label-secondary);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  font-size: 12px;
  line-height: 20px;
}
[data-dsh-session-compactor-dock] .cc-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
  background: transparent;
  border: none;
  border-radius: 24px;
  padding: 1px 8px;
  cursor: pointer;
  white-space: nowrap;
}
[data-dsh-session-compactor-dock] .cc-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-session-compactor-dock] .cc-button:disabled {
  opacity: 0.4;
  cursor: default;
}
/* 设置页配置卡片 */
[data-dsh-session-compactor-settings] {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 560px;
}
[data-dsh-session-compactor-settings] .ccs-intro {
  margin: 0 0 4px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.6;
}
[data-dsh-session-compactor-settings] .ccs-status {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
[data-dsh-session-compactor-settings] .ccs-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
[data-dsh-session-compactor-settings] .ccs-label {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}
[data-dsh-session-compactor-settings] .ccs-hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
[data-dsh-session-compactor-settings] .ccs-input {
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
[data-dsh-session-compactor-settings] textarea.ccs-input {
  height: auto;
  min-height: 132px;
  padding: 8px 12px;
  resize: vertical;
  /* 占位符（内置默认模板）按原样换行显示，不然灰色文字会糊成一团 */
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  line-height: 1.6;
}
[data-dsh-session-compactor-settings] textarea.ccs-input::placeholder {
  color: var(--dsw-alias-label-tertiary);
  opacity: 1;
}
/* 同一字段的多个动作按钮（填入默认模板 / 恢复默认）横排 */
[data-dsh-session-compactor-settings] .ccs-fieldActions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 2px;
}
[data-dsh-session-compactor-settings] .ccs-input:focus-visible {
  border-color: var(--dsw-alias-brand-primary);
  outline: none;
}
[data-dsh-session-compactor-settings] .ccs-input[aria-invalid="true"] {
  border-color: var(--dsw-alias-state-error-primary);
}
[data-dsh-session-compactor-settings] .ccs-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
}
[data-dsh-session-compactor-settings] .ccs-failed {
  min-width: 0;
  flex: 1;
  color: var(--dsw-alias-label-error);
  font-size: 12px;
  line-height: 1.5;
}
[data-dsh-session-compactor-settings] .ccs-save {
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
[data-dsh-session-compactor-settings] .ccs-save:disabled {
  opacity: 0.4;
  cursor: default;
}
[data-dsh-session-compactor-settings] .ccs-reset {
  font: inherit;
  cursor: pointer;
  background: transparent;
  border: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  padding: 0;
}
[data-dsh-session-compactor-settings] .ccs-reset:hover {
  color: var(--dsw-alias-label-primary);
}
`

function installStyles() {
  if (typeof document === 'undefined') return
  const tagId = 'dsh-session-compactor/dock.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-session-compactor'
  tag.dataset.pluginCss = tagId
  tag.textContent = STYLES
  document.head.appendChild(tag)
}

/**
 * 官方 ContextMeter 圆环按钮。注意：dsh-client-ui-chat 的 StatsPills
 * （第一个「x 轮 x 步」/用量 pill）按钮带着一模一样的
 * aria-haspopup="dialog"[aria-expanded] 模式，且 DOM 顺序更靠前 —— 只按 aria
 * 选会把 pill 误认成圆环（点圆环没反应、点 pill 反而触发）。圆环的填充环
 * 带 stroke-dasharray，pill 图标是 path / 无 dasharray 的 circle，以此区分。
 */
const METER_TRIGGER_SELECTOR = 'button[aria-haspopup="dialog"][aria-expanded]'

function isMeterButton(btn) {
  if (!btn || typeof btn.querySelector !== 'function') return false
  if (typeof btn.getAttribute === 'function' && btn.getAttribute('aria-haspopup') !== 'dialog') return false
  return btn.querySelector('circle[stroke-dasharray]') !== null
}

/**
 * 向上遍历祖先，找到 root 所在 dock 行里的官方上下文圆环按钮。
 * 不假设 slot 条目是否被包 wrapper、也不假设圆环 button 的嵌套深度
 * （ContextMeter 的 button 嵌在 span 里）：从 root 逐级上溯，第一个
 * 「包含圆环且圆环不在 root 子树内」的祖先即所在行。纯函数，便于测试。
 */
function findMeterTrigger(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return undefined
  let el = root
  let depth = 0
  while (el && depth < 8) {
    if (typeof el.querySelectorAll === 'function') {
      const candidates = el.querySelectorAll(METER_TRIGGER_SELECTOR)
      for (const btn of candidates) {
        if (isMeterButton(btn) && !root.contains(btn)) return btn
      }
    }
    el = el.parentElement
    depth += 1
  }
  return undefined
}

/** 从一次 DOM 事件里解析「是否点在了本行官方上下文圆环上」。纯函数，便于测试。 */
function meterTriggerFrom(event, root) {
  const target = event && event.target
  if (!target || typeof target.closest !== 'function') return undefined
  const hit = target.closest(METER_TRIGGER_SELECTOR)
  if (!hit || !isMeterButton(hit)) return undefined
  const meter = findMeterTrigger(root)
  return meter !== undefined && hit === meter ? hit : undefined
}

/**
 * 进行中的手动压缩：key = sessionId。
 * 组件实例会因「一次压缩掉几百条历史」这类会话表面巨变、或切去设置页再回来而整体
 * 重挂载；重挂载会丢掉 pendingRef，用户再点一次就真的再发一次 `/compact`，被服务端
 * 以 busy 打回："this process has an active compaction, or the agent is not idle"。
 * 用模块级在途表按会话去重，整个页面生命周期（含重挂载）都有效。
 */
const compactInFlight = new Map()
const COMPACT_INFLIGHT_TIMEOUT = 10 * 60 * 1000

/**
 * 最近一次手动压缩的结果：key = sessionId。
 * 压缩动辄几分钟，期间组件很可能被重挂载（一次压缩掉几百条历史会剧烈改变会话表面，
 * 用户也可能切去设置页再回来）。结果只存在组件 state 里的话，重挂载即丢 ——
 * 用户看到的就是「点了压缩总结，什么结果都没有」。所以按会话记一份，重挂载后补显。
 */
const compactOutcome = new Map()
const COMPACT_OUTCOME_TTL = 2 * 60 * 1000

/** 输入框下方 dock：默认收起；点击官方上下文圆环后在它右侧展开操作条。 */
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
  const rootRef = React.useRef(null)
  const pendingRef = React.useRef(false)
  const enhancingRef = React.useRef(false)
  const timerRef = React.useRef(null)

  // 官方圆环即触发器：捕获阶段接住点击、切换我们的展开态，但**不**拦事件 ——
  // 官方自带的 breakdown 弹窗照常弹出，两个一起出（点圆环 = 弹窗 + 右侧按钮）。
  // 点在别处则收起；圆环/自身按钮上的 pointerdown 不收起（交给 click 切换）。
  React.useEffect(() => {
    if (typeof document === 'undefined') return
    const onCaptureClick = (event) => {
      const root = rootRef.current
      if (!root) return
      if (meterTriggerFrom(event, root) === undefined) return
      setOpen((v) => !v)
    }
    const onCapturePointerDown = (event) => {
      const root = rootRef.current
      if (!root) return
      const target = event && event.target
      if (!target || typeof target.closest !== 'function') return
      if (root.contains(target)) return
      if (meterTriggerFrom(event, root) !== undefined) return
      setOpen(false)
    }
    document.addEventListener('click', onCaptureClick, true)
    document.addEventListener('pointerdown', onCapturePointerDown, true)
    return () => {
      document.removeEventListener('click', onCaptureClick, true)
      document.removeEventListener('pointerdown', onCapturePointerDown, true)
    }
  }, [])

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

  // 挂载时把「正在进行中 / 刚出的结果」补显出来：压缩期间组件被重挂载是常态
  // （会话表面巨变、切设置页再回来），否则用户点完半天看不到任何结果。
  React.useEffect(() => {
    const sessionId = props.sessionId
    if (sessionId === undefined) return
    const outcome = compactOutcome.get(sessionId)
    if (outcome !== undefined && Date.now() - outcome.at < COMPACT_OUTCOME_TTL) {
      showFeedback(outcome.text, 12000)
      return
    }
    if (compactInFlight.has(sessionId)) {
      showFeedback('压缩已在进行中，请等当前这次结束', 6000)
    }
  }, [props.sessionId, showFeedback])

  const run = React.useCallback(async () => {
    if (pendingRef.current || running) return
    const sessionId = props.sessionId
    if (sessionId !== undefined && compactInFlight.has(sessionId)) {
      // 已经在压缩了（多为组件重挂载后的重复点击）：别再打一次服务端。
      showFeedback('压缩已在进行中，请等当前这次结束', 6000)
      return
    }
    // 先给即时反馈：大会话的一次 /compact 要几分钟，没有任何提示用户会以为没反应。
    setFeedback('已开始压缩…大会话可能需要几分钟')
    const task = props.compact()
    if (sessionId !== undefined) {
      compactInFlight.set(sessionId, task)
      const timer = setTimeout(() => { compactInFlight.delete(sessionId) }, COMPACT_INFLIGHT_TIMEOUT)
      const forget = () => clearTimeout(timer)
      task.then(forget, forget)
    }
    pendingRef.current = true
    setPending(true)
    try {
      const text = await task
      if (sessionId !== undefined) compactOutcome.set(sessionId, { text, at: Date.now() })
      showFeedback(text, 12000)
    } finally {
      pendingRef.current = false
      setPending(false)
      if (sessionId !== undefined) compactInFlight.delete(sessionId)
    }
  }, [props.compact, props.sessionId, running, showFeedback])

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

  // 全新空白会话不显示。收起态保留一个 display:none 的挂载点，
  // 让点击监听能通过 parentElement 找到官方圆环所在的 dock 行。
  if (session === undefined || session.blank) return null

  return React.createElement(
    'div',
    {
      ref: rootRef,
      className: 'cc-dock' + (open ? '' : ' cc-collapsed'),
      'data-dsh-session-compactor-dock': '',
    },
    open
      ? React.createElement(
          'div',
          { className: 'cc-actions' },
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

const PROMPT_FIELD = { field: 'compressPrompt', label: '压缩指令（compressPrompt）', hint: '自定义发给模型的总结指令；灰色文字是内置默认模板（留空即用它）。清空并保存即恢复默认。' }

/**
 * 内置默认压缩指令全文：构建时由 scripts/build-client.mjs 从 src/index.js 的
 * DETAIL_SUMMARY_INSTRUCTION 注入（单一事实来源，不会两份漂移）。
 * 裸源码/测试里没有这个常量时退化成 null，调用方各自兜底。
 */
function builtinCompressPrompt() {
  return typeof DEFAULT_COMPRESS_PROMPT === 'string' && DEFAULT_COMPRESS_PROMPT.length > 0
    ? DEFAULT_COMPRESS_PROMPT
    : null
}

function fieldText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'number') return String(value)
  return String(value)
}

function CompactSettingsCard(props) {
  const scope = props.scope
  // ⚠️ React 是以「裸函数」调用这两个访问器的（react: `nextSnapshot = getSnapshot()`、
  // `subscribe(handleStoreChange)`），this 会丢。而 `settingsScope.bind()` 返回的
  // SettingsScopeController 是 class 实例，`getSnapshot()/subscribe()` 内部读 `this.store` ——
  // 直接把 `scope.subscribe`/`scope.getSnapshot` 传进去，渲染期就抛
  // `TypeError: Cannot read properties of undefined (reading 'store')`，宿主把这条 slot
  // 条目判为崩溃并静默退场（abdicate），用户看到的就是「设置页一片空白」。
  // 所以必须包一层绑定后的访问器（getSnapshot 本身返回稳定引用，不会触发缓存告警）；
  // 同时容忍宿主没给 scope 的情况，走「不可用」文案而不是崩成空白。
  const subscribe = React.useCallback(
    (listener) => (scope && typeof scope.subscribe === 'function' ? scope.subscribe(listener) : () => {}),
    [scope],
  )
  const getSnapshot = React.useCallback(
    () => (scope && typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : undefined),
    [scope],
  )
  // 第三个参数（getServerSnapshot）让同构渲染/水合场景也不会告警。
  const snap = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const section = snap && snap.value ? snap.value : {}
  const base = snap && snap.base ? snap.base : {}
  const [draft, setDraft] = React.useState(undefined)
  const [saving, setSaving] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  // 快照刷新（保存落盘 / 其他入口改动）后重新同步草稿。
  React.useEffect(() => { setDraft(undefined) }, [snap])

  // 宿主没给 scope（老版本 / 插件被停用）时直接说不可用，别显示成「正在读取」。
  if (!scope || typeof scope.getSnapshot !== 'function') {
    return React.createElement('p', { className: 'ccs-status', role: 'status' },
      '当前不可用：宿主未提供 dsh-session-compactor 设置命名空间（服务端未加载或内存模式）。')
  }

  // loading/idle 只是还没读到宿主文档，别立刻宣称「不可用」。
  if (!snap || snap.status === 'loading' || snap.status === 'idle') {
    return React.createElement('p', { className: 'ccs-status', role: 'status' }, '正在读取设置…')
  }

  if (snap.status !== 'ready') {
    return React.createElement('p', { className: 'ccs-status', role: 'status' },
      '当前不可用：宿主未提供 dsh-session-compactor 设置命名空间（服务端未加载或内存模式）。')
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
    { 'data-dsh-session-compactor-settings': '' },
    React.createElement('p', { className: 'ccs-intro' },
      '上下文自动压缩的阈值、保留量与压缩指令。保存后写入用户层并热更新生效（下一次压缩检查即采用新值）；某项留空等同「恢复默认」，回落到 cordis 配置或内置模板。'),
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
        // 灰色占位 = 该项的 cordis 配置默认值（用户层留空时回落到它）
        placeholder: base[f.field] === undefined || base[f.field] === null ? '' : String(base[f.field]),
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
        // 灰色占位 = 内置默认模板全文：用户层没填时，一眼能看到"默认到底长什么样"
        placeholder: builtinCompressPrompt() ?? '（内置默认模板不可用：宿主未加载本插件服务端）',
        disabled: !writable || saving,
        onChange: (event) => edit(PROMPT_FIELD.field, event.target.value),
      }),
      React.createElement('p', { className: 'ccs-hint' }, PROMPT_FIELD.hint),
      React.createElement(
        'div',
        { className: 'ccs-fieldActions' },
        React.createElement('button', {
          type: 'button',
          className: 'ccs-reset',
          disabled: !writable || saving || builtinCompressPrompt() === null,
          onClick: () => { setFailed(false); setDraft({ ...current, [PROMPT_FIELD.field]: builtinCompressPrompt() ?? '' }) },
        }, '填入默认模板'),
        React.createElement('button', {
          type: 'button', className: 'ccs-reset', disabled: !writable || saving,
          onClick: () => resetField(PROMPT_FIELD.field),
        }, '恢复默认'),
      ),
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

/**
 * 把官方 `/compact` 的结果文案翻成人话：成功给中文摘要，忙等/失败给可操作提示。
 * 服务端的 busy 原文是 "Compaction is unavailable because this process has an
 * active compaction, or the agent is not idle." —— 用户看到英文不知道该怎么办。
 */
function compactResultText(result) {
  const kind = result && result.kind
  const text = result && typeof result.text === 'string' ? result.text : ''
  if (kind === 'error') {
    if (/active compaction|not idle|already has active work|already in progress/i.test(text)) {
      return '上一次压缩还在进行中，请等它结束再点（大会话可能要几分钟）'
    }
    if (/^No compactable history/.test(text)) return '当前没有可压缩的历史'
    return '压缩未成功：' + text
  }
  const matched = /^Compacted (\d+) history items \(~(\d+) tokens\)\.$/.exec(text)
  if (matched !== null) return '已压缩 ' + matched[1] + ' 条历史（约 ' + matched[2] + ' tokens）'
  if (/^No compactable history/.test(text)) return '当前没有可压缩的历史'
  return text !== '' ? text : '压缩完成'
}

/**
 * 设置侧栏图标的自 Pin（替代给核心打补丁）。
 *
 * `settings.section` 契约没有 icon 字段：核心只读 id/label/order，navIcon(id)
 * 是硬编码映射，未知 id 一律落齿轮，市场插件也全是齿轮。给核心 bundle 打补丁
 * 不可靠——DSH runtime 重新解包、或别的插件装卸自己的补丁，都会把它冲掉。
 *
 * 所以这里在运行时按「导航格标签文本」找到自己的 cell，原地改写那个 <svg>：
 * 保留外壳给的元素/类名/尺寸，只换几何；不依赖外壳的哈希类名，DSH 升级也不怕。
 * MutationObserver 应对外壳重渲染导航时把齿轮换回来的情况。
 */
function pinNavGlyph(labels, mark, glyph) {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
  const applyGlyph = () => {
    // 便宜的前置判断：导航只在设置面板打开时才存在。
    if (document.querySelector('[role="dialog"]') === null) return
    const cells = Array.from(document.querySelectorAll('[role="dialog"] nav button'))
    for (const cell of cells) {
      // svg 不贡献文本，所以 textContent 就是导航标签。
      if (labels.indexOf(cell.textContent.trim()) < 0) continue
      const svg = cell.querySelector('svg')
      if (svg === null || svg.getAttribute(mark) === '1') continue
      // glyph() 是纯函数、返回标记：它在任何 DOM 变动之前跑完，所以抛错时
      // 外壳自己的图标原封不动，不会把导航格清空。
      let spec
      try {
        spec = glyph()
      } catch (error) {
        console.warn('[dsh-session-compactor] nav glyph failed; keeping the shell icon', error)
        continue
      }
      svg.setAttribute('viewBox', spec.viewBox)
      svg.setAttribute('fill', 'none')
      if (spec.stroke) {
        svg.setAttribute('stroke', spec.stroke)
        svg.setAttribute('stroke-width', spec.strokeWidth || '1.6')
        svg.setAttribute('stroke-linecap', 'round')
        svg.setAttribute('stroke-linejoin', 'round')
      }
      svg.innerHTML = spec.markup
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute(mark, '1')
    }
  }
  applyGlyph()
  new MutationObserver(applyGlyph).observe(document.body, { childList: true, subtree: true })
}

function apply(ctx) {
  installStyles()
  // 设置侧栏图标：契约没有 icon 字段，不 Pin 就是齿轮。从这里 Pin，升级/装卸都不丢。
  pinNavGlyph(['上下文压缩'], 'data-session-compactor-nav-icon', () => ({
    viewBox: '0 0 16 16',
    markup: '<circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.6" opacity="0.35"></circle>'
      + '<path d="M8 1.6A6.4 6.4 0 0 1 14.4 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>',
  }))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'context-compact',
    order: 5,
    inject: (sessionId) => ({
      // 传给组件用于在途去重（模块级表按 sessionId 记，见 compactInFlight）。
      sessionId,
      /** 执行 /compact，返回用户可见的结果文案（不抛错）。 */
      compact: async () => {
        try {
          // commands/execute 的 client 契约需要 3 个业务参数(agentId, line, images)，
          // 纯命令调用传空 images 数组。
          const result = await ctx.remote.commands.execute(sessionId, '/compact', [])
          if (!result.ok) return '压缩未成功：' + result.error.message
          if (result.value === undefined) return '未知命令：/compact'
          return compactResultText(result.value)
        } catch (error) {
          return '压缩未成功：' + (error instanceof Error ? error.message : String(error))
        }
      },
      /** 用 DSH 当前模型增强提示词；走专用 HTTP 接口，不写会话日志/对话。返回 {ok,text|error}。 */
      enhance: async (text) => {
        try {
          const response = await fetch('/dsh-session-compactor/enhance', {
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

  // 设置侧栏独立分页「上下文压缩」（和其它插件一样的 settings.section 页面，
  // 而不是塞在「插件」页的 tab 里）；宿主没有该 slot（老版本）时静默跳过。
  try {
    const scope = ctx.settingsScope.bind({ namespace: CC_NS })
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'session-compactor',
      order: 20,
      label: () => '上下文压缩',
      inject: () => ({ scope }),
    }, CompactSettingsCard))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('settings page unavailable: %s', message)
    else console.warn('[dsh-session-compactor] settings page unavailable:', message)
  }
}

module.exports = { name, inject, apply }
