/**
 * 浏览器半边回归测试（不依赖浏览器，全部在 Node 里跑）：
 *  1. 设置页空白根因回归：settingsScope.bind() 返回的是 class 实例，React 以裸函数
 *     调用 getSnapshot/subscribe 会丢 this。这里用「类实例」形态的假 scope 复刻真实
 *     控制器，确认卡片能正常渲染而不是抛 TypeError（宿主会因此静默退场成空白页）。
 *  2. 加载中/不可用/缺 scope 三种降级文案。
 *  3. dock 展开态几何与两个按钮。
 *  4. 压缩在途去重：组件重挂载后重复点击不得再发一次 /compact（服务端会回 busy）。
 *  5. /compact 结果文案的中文映射。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire('/vol1/@appdata/deepseek.harness/dsh-data/profiles/web/node_modules/')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(root, 'lib', 'client.js')

const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined && !ok ? '  → ' + extra : ''))
}

/* ------------------------------------------------------------------ *
 * mini React：只实现本插件用到的钩子，用来「渲染 → 点按钮 → 再渲染」。
 * 真实 React 的 renderToStaticMarkup 点不了按钮，交互必须自己驱动。
 * ------------------------------------------------------------------ */
function createMiniReact() {
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const p = Object.assign({}, props)
      if (children.length === 1) p.children = children[0]
      else if (children.length > 1) p.children = children
      return { __el: true, type, props: p }
    },
  }
  let hooks = []
  let idx = 0
  // __mount = 换个组件实例（清空 hooks）；__render = 同一实例再渲染一次（索引归零）
  React.__mount = () => { hooks = []; idx = 0 }
  React.__render = () => { idx = 0 }
  React.useState = (init) => {
    const i = idx++
    if (!(i in hooks)) {
      // forceOpen：把第一个 hook（open）置真，其余保持真实初值
      hooks[i] = { value: React.forceOpen && i === 0 ? true : (typeof init === 'function' ? init() : init) }
    }
    const hook = hooks[i]
    return [hook.value, (v) => { hook.value = typeof v === 'function' ? v(hook.value) : v }]
  }
  React.useRef = (init) => {
    const i = idx++
    if (!(i in hooks)) hooks[i] = { current: init }
    return hooks[i]
  }
  React.useCallback = (fn, deps) => {
    const i = idx++
    const prev = hooks[i]
    if (prev && prev.deps && deps && prev.deps.length === deps.length && prev.deps.every((d, k) => d === deps[k])) return prev.value
    hooks[i] = { value: fn, deps }
    return fn
  }
  let pending = []
  React.useEffect = (fn, deps) => {
    const i = idx++
    const prev = hooks[i]
    const changed = !prev || !prev.deps || !deps || prev.deps.length !== deps.length || prev.deps.some((d, k) => d !== deps[k])
    hooks[i] = { deps, cleanup: prev ? prev.cleanup : undefined }
    if (changed) pending.push({ i, fn })
  }
  React.useMemo = (fn) => fn()
  // 渲染结束后执行本帧排队的 effect（含上一个 effect 的 cleanup）
  React.__flush = () => {
    const queue = pending
    pending = []
    for (const { i, fn } of queue) {
      const hook = hooks[i]
      if (hook && typeof hook.cleanup === 'function') hook.cleanup()
      const cleanup = fn()
      if (hook) hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }
  return React
}

/** 深度遍历元素树。 */
function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  if (typeof node !== 'object' || node.__el !== true) return
  visit(node)
  walk(node.props && node.props.children, visit)
}
/** 收集元素树里的纯文本。 */
function textOf(node) {
  let out = ''
  walk(node, (el) => {
    const c = el.props && el.props.children
    if (typeof c === 'string') out += c
  })
  return out
}
/** 按 aria-label 找按钮。 */
function findButton(tree, label) {
  let found
  walk(tree, (el) => { if (el.props && el.props['aria-label'] === label) found = el })
  return found
}

/* ------------------------------------------------------------------ *
 * 载入 bundle
 * ------------------------------------------------------------------ */
function loadBundle(React) {
  const loaded = []
  globalThis.__ModuleLoader__ = { load: (entry) => loaded.push(entry) }
  const src = readFileSync(bundlePath, 'utf8')
  new Function('window', 'document', src)(globalThis, undefined)
  const captured = {}
  const mod = loaded[0].factory((id) => {
    if (id === 'react') return React
    if (id === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      const stub = (tag) => (props) => React.createElement(tag, props, props.children)
      return { IconEnhanceOutline16: stub('svg'), IconSparkle16: stub('svg'), Tooltip: stub('span') }
    }
    throw new Error('unexpected require: ' + id)
  })
  mod.apply({
    slots: {
      inject(slot, factory) { factory(); return () => {} },
      register(spec, comp) { captured[spec.name] = comp; return spec },
    },
    remote: { commands: { execute: async () => ({ ok: true, value: { text: 'Compacted 3 history items (~120 tokens).' } }) } },
    settingsScope: {
      bind: () => new FakeSettingsScope(),
    },
    logger: { warn: () => {} },
  })
  return { mod, captured }
}

/**
 * 复刻 SettingsScopeController 的真实形态：class 实例 + 原型方法读 this.store。
 * 老代码把 scope.subscribe / scope.getSnapshot 直接传给 useSyncExternalStore，
 * React 裸调用时 this 丢失 → TypeError → 设置页空白。
 */
class FakeSettingsScope {
  constructor() {
    this.store = {
      getSnapshot: () => this.snapshot,
      subscribe: (listener) => { this.listener = listener; return () => { this.listener = undefined } },
    }
    this.snapshot = {
      status: 'ready',
      value: { thresholdRatio: 0.8, compressPrompt: '总结一下' },
      base: { thresholdRatio: 0.8, retainRatio: 0.3, retainTokens: 0, maxTokens: 4096 },
      user: { thresholdRatio: 0.8, compressPrompt: '总结一下' },
      revision: 3,
      writable: true,
      mode: 'host',
    }
  }
  getSnapshot() { return this.store.getSnapshot() }
  subscribe(listener) { return this.store.subscribe(listener) }
  async set(field, value) { this.snapshot = { ...this.snapshot, value: { ...this.snapshot.value, [field]: value } } }
  async unset(field) { const value = { ...this.snapshot.value }; delete value[field]; this.snapshot = { ...this.snapshot, value } }
}

/* ------------------------------------------------------------------ *
 * 0) 先证明测试有牙：老写法（传未绑定方法）在真实 React 下必须抛错
 * ------------------------------------------------------------------ */
{
  const React = require('react')
  const ReactDOMServer = require('react-dom/server')
  const scope = new FakeSettingsScope()
  const OldStyleCard = () => {
    // 0.6.8 及之前的写法
    const snap = React.useSyncExternalStore(scope.subscribe, scope.getSnapshot, scope.getSnapshot)
    return React.createElement('p', null, String(snap && snap.status))
  }
  let threw = ''
  try { ReactDOMServer.renderToStaticMarkup(React.createElement(OldStyleCard)) } catch (e) { threw = e.message }
  check('老写法（未绑定方法）确实抛 TypeError', /Cannot read properties of undefined/.test(threw), threw)
}

/* ------------------------------------------------------------------ *
 * 1) 设置页：类实例 scope 下正常渲染出字段
 * ------------------------------------------------------------------ */
{
  const React = require('react')
  const ReactDOMServer = require('react-dom/server')
  const { captured } = loadBundle(React)
  const Card = captured['settings.section']
  check('settings.section 已注册', typeof Card === 'function')
  const scope = new FakeSettingsScope()
  let html = ''
  let threw = ''
  try { html = ReactDOMServer.renderToStaticMarkup(React.createElement(Card, { scope })) } catch (e) { threw = e.message }
  check('设置卡片在类实例 scope 下不抛错', threw === '', threw)
  check('设置卡片渲染出五个字段', ['压缩触发阈值', '保留比例', '保留 Token 数', '摘要最大 Token 数', '压缩指令（compressPrompt）'].every((t) => html.includes(t)))
  check('设置卡片预填用户层取值', html.includes('value="0.8"') && html.includes('总结一下'))
  check('设置卡片有保存按钮', html.includes('保存'))
  check('设置卡片有说明行', html.includes('热更新生效'))
  check('设置卡片有恢复默认', html.includes('恢复默认'))

  // 2) 降级文案
  const loadingScope = new FakeSettingsScope()
  loadingScope.snapshot = { status: 'loading', writable: true }
  const loadingHtml = ReactDOMServer.renderToStaticMarkup(React.createElement(Card, { scope: loadingScope }))
  check('loading 显示「正在读取设置…」而非不可用', loadingHtml.includes('正在读取设置') && !loadingHtml.includes('当前不可用'))

  const unavailScope = new FakeSettingsScope()
  unavailScope.snapshot = { status: 'unavailable', writable: false }
  const unavailHtml = ReactDOMServer.renderToStaticMarkup(React.createElement(Card, { scope: unavailScope }))
  check('unavailable 显示降级文案', unavailHtml.includes('当前不可用'))

  const noScopeHtml = ReactDOMServer.renderToStaticMarkup(React.createElement(Card, { scope: undefined }))
  check('缺 scope 不崩、走降级文案', noScopeHtml.includes('当前不可用'))
}

/* ------------------------------------------------------------------ *
 * 3) dock 展开态：两个按钮 + aria-label + pill 几何
 *    注意：patch 必须在载入 bundle 之前生效（组件闭包里捕获的是工厂收到的 React）。
 * ------------------------------------------------------------------ */
{
  const RealReact = require('react')
  const ReactDOMServer = require('react-dom/server')
  const OpenReact = Object.create(RealReact)
  Object.assign(OpenReact, RealReact)
  // 布尔初值全置真 → open=true；副作用是 pending/enhancing 也为真（按钮 disabled、文案变「中…」）
  OpenReact.useState = (init) => [typeof init === 'boolean' ? true : (typeof init === 'function' ? init() : init), () => {}]
  const { captured } = loadBundle(OpenReact)
  const Dock = captured['conversation.composer.dock']
  check('composer.dock 已注册', typeof Dock === 'function')

  const props = {
    sessionId: 'sess-open',
    useSession: (sel) => sel({ blank: false, running: false }),
    useInput: (sel) => sel({ draft: 'hi' }),
    useProjection: () => ({ contextWindow: 200000, projectedTokens: 40000 }),
    compact: async () => 'ok',
    enhance: async () => ({ ok: true, text: 'x' }),
    inputActions: { setDraft: () => {} },
  }
  const html = ReactDOMServer.renderToStaticMarkup(OpenReact.createElement(Dock, props))
  // 布尔初值全置真时按钮文案变成「压缩总结中…/增强中…」，所以按进行中文案断言
  check('展开态渲染出两个操作', html.includes('压缩总结中') && html.includes('增强中'))
  check('展开态有 aria-label', html.includes('aria-label="压缩总结上下文"') && html.includes('aria-label="增强提示词"'))
  check('展开态无外框 cc-bar', !html.includes('cc-bar'))
  check('展开态有 cc-actions 行内容器', html.includes('cc-actions'))
  check('展开态 wrapper 不带 cc-collapsed', !html.includes('cc-collapsed'))

  // 收起态：display:none、不渲染按钮（用未 patch 的真实 React 再载入一次）
  const { captured: captured2 } = loadBundle(RealReact)
  const Dock2 = captured2['conversation.composer.dock']
  const collapsed = ReactDOMServer.renderToStaticMarkup(RealReact.createElement(Dock2, props))
  check('收起态隐藏且不渲染按钮', collapsed.includes('cc-collapsed') && !collapsed.includes('压缩总结'))

  // 空白会话 → null
  const blank = ReactDOMServer.renderToStaticMarkup(RealReact.createElement(Dock2, {
    ...props,
    useSession: (sel) => sel({ blank: true, running: false }),
  }))
  check('空白会话渲染 null', blank === '')
}

/* ------------------------------------------------------------------ *
 * 4) 压缩在途去重（mini React 驱动点击）
 * ------------------------------------------------------------------ */
{
  const React = createMiniReact()
  const { captured } = loadBundle(React)
  const Dock = captured['conversation.composer.dock']
  const props = {
    sessionId: 'sess-inflight',
    useSession: (sel) => sel({ blank: false, running: false }),
    useInput: (sel) => sel({ draft: 'hi' }),
    useProjection: () => ({}),
    inputActions: { setDraft: () => {} },
  }
  let compactCalls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  props.compact = async () => { compactCalls += 1; await gate; return '已压缩 3 条历史（约 120 tokens）' }

  const stdProps = () => ({ ...props, compact: props.compact })
  const render = () => { React.__render(); const tree = Dock(stdProps()); React.__flush(); return tree }
  // 把微任务队列排空（await 链可能有好几跳）
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  // 第一次：实例 A（open=true）点击「压缩总结」
  React.forceOpen = true
  React.__mount()
  const treeA = render()
  const btnA = findButton(treeA, '压缩总结上下文')
  check('能拿到压缩总结按钮', btnA !== undefined)
  if (btnA) {
    void btnA.props.onClick()
    await settle()
    check('第一次点击发出了一次压缩', compactCalls === 1, 'calls=' + compactCalls)

    // 模拟组件重挂载（一次压缩掉几百条历史 / 切去设置页再回来都会重挂载，
    // 重挂载会丢掉 pendingRef，老代码此时再点就真的再发一次 /compact）
    React.__mount()
    const treeB = render()
    const btnB = findButton(treeB, '压缩总结上下文')
    check('重挂载后按钮恢复可点', btnB !== undefined && btnB.props.disabled !== true)
    if (btnB) {
      void btnB.props.onClick()
      await settle()
      check('重挂载后重复点击不会再次请求服务端', compactCalls === 1, 'calls=' + compactCalls)
      // 读反馈必须在同一实例上再渲染一次（__mount 会重置 hooks = 换个组件实例）
      check('重复点击给出「已在进行中」提示', textOf(render()).includes('压缩已在进行中'), textOf(render()).slice(0, 160))
    }
    release()
    await settle()
    check('压缩结束后在途记录被清掉', compactCalls === 1)
    // 压缩完成的瞬间组件被重挂载（会话表面巨变）——结果必须还能显示出来。
    // 注意真实 React 里 effect 中的 setState 会自动触发重渲染；mini React 不会，
    // 所以这里挂载（执行 effect）之后再渲染一次才能读到反馈。
    React.__mount()
    render()
    const afterRemount = textOf(render())
    check('重挂载后仍能看到中文结果', afterRemount.includes('已压缩 3 条历史'), afterRemount.slice(0, 160))
  }
  React.forceOpen = false
}

/* ------------------------------------------------------------------ *
 * 5) /compact 结果文案映射
 * ------------------------------------------------------------------ */
{
  const src = readFileSync(join(root, 'src', 'client', 'index.cjs'), 'utf8')
  check('结果映射函数存在', src.includes('function compactResultText(result)'))
  check('busy 英文被识别并中文化', /active compaction\|not idle\|already has active work/.test(src))
  check('Compacted N history items 被中文化', /已压缩/.test(src))
  check('在途表存在', src.includes('const compactInFlight = new Map()'))
  check('useSyncExternalStore 用绑定后的访问器', src.includes('React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)'))
  check('不再把未绑定方法直接传给 React', !src.includes('React.useSyncExternalStore(scope.subscribe'))
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
if (failed.length > 0) process.exit(1)
