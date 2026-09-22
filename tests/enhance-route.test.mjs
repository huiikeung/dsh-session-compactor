/**
 * /dsh-session-compactor/enhance 路由注册回归测试。
 *
 * 修的 bug：老代码在 apply() 里用 `ctx.get('webServer')` 拿服务，而本插件 apply 时
 * webServer 往往还没激活 → 拿到 undefined → 静默 return → 路由从未注册。前端点
 * 「提示增强」只能拿到 SPA fallback 的 404（GET）/ 405（POST），而且是空 body，
 * 完全看不出原因。现在改成 ctx.inject(['webServer'], …) 等它就绪再注册。
 *
 * 本测试用假 ctx 复刻「apply 时 webServer 未就绪」这一时序，断言：
 *   1. apply 阶段不会直接注册（也不会崩）；
 *   2. webServer 就绪后路由被注册成 exact /dsh-session-compactor/enhance；
 *   3. handler 的 405 / 400 / 404 / 200 分支都按 JSON 契约回。
 */
import { apply } from '../lib/index.js'

let failures = 0
const check = (name, cond, extra) => {
  if (cond) console.log('PASS', name)
  else { failures += 1; console.log('FAIL', name, extra === undefined ? '' : '→ ' + extra) }
}

const PATH = '/dsh-session-compactor/enhance'

/** 记录 webServer.register 的假 webServer；就绪前 get('webServer') 返回 undefined。 */
function makeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      if (routes.some((r) => r.kind === route.kind && r.path === route.path)) {
        throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      }
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at !== -1) routes.splice(at, 1)
      }
    },
  }
}

/** 最小假 res：记录 writeHead/end。 */
function makeRes() {
  const res = { status: undefined, body: '', headers: undefined }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (body) => { res.body = body ?? '' }
  return res
}

const cfg = {
  enabled: true, auto: true,
  pruneToolResults: false, registerCommands: false,
  scheduledReflection: false, liveSettings: false,
  compressPrompt: '',
}

/** 跑 apply，返回 { webServer, injects, runInject }。injects 按依赖名记回调。 */
function boot({ webServerReady = false } = {}) {
  const webServer = makeWebServer()
  const injects = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    // apply 时 webServer 未就绪 → undefined（这正是出 bug 的时序）
    get: (name) => (name === 'webServer' && webServerReady ? webServer : undefined),
    inject: (deps, cb) => { injects.set(deps.join(','), cb) },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
    plugin: () => Promise.resolve(),
  }
  apply(ctx, cfg)
  return { ctx, webServer, injects }
}

// —— 1) apply 阶段：webServer 没就绪 → 不注册也不崩，且确实在等 webServer ——
{
  const { webServer, injects } = boot({ webServerReady: false })
  check('apply 阶段没有直接注册路由（等 webServer 就绪）', webServer.routes.length === 0)
  check('确实 inject 了 webServer', injects.has('webServer'), [...injects.keys()].join('|'))
  check('没有崩，apply 正常返回', true)
}

// —— 2) webServer 就绪后：路由注册成功 ——
{
  const { webServer, injects } = boot({ webServerReady: true })
  check('webServer 就绪时 inject 回调被 cordis 触发', injects.has('webServer'))
  // 真实 cordis 会在服务就绪时调用回调；这里手动触发一次
  const cb = injects.get('webServer')
  // 注册时点的 ctx：webServer 已就绪，agents 返回「查无此会话」
  const wctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => (name === 'webServer' ? webServer
      : (name === 'agents' ? { get: () => undefined } : undefined)),
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  cb(wctx)
  const route = webServer.routes.find((r) => r.path === PATH)
  check('路由已注册', route !== undefined)
  check('路由是 exact 匹配', route?.kind === 'exact')
  check('路由带 handler', typeof route?.handler === 'function')

  if (route) {
    // —— 3) GET → 405 JSON（老行为是空 body，说明根本没进 handler）——
    {
      const res = makeRes()
      await route.handler({ method: 'GET', url: PATH }, res)
      check('GET 回 405', res.status === 405, String(res.status))
      check('GET 的 405 带 JSON body（证明进了我们的 handler）', res.body.includes('method not allowed'), res.body)
    }
    // —— 4) POST 非法 JSON → 400 ——
    {
      const res = makeRes()
      const req = { method: 'POST', url: PATH, [Symbol.asyncIterator]: async function* () { yield 'not-json' } }
      await route.handler(req, res)
      check('非法 JSON 回 400', res.status === 400, String(res.status))
      check('400 带 JSON body', res.body.includes('invalid json'), res.body)
    }
    // —— 5) POST 缺字段 → 400 ——
    {
      const res = makeRes()
      const req = { method: 'POST', url: PATH, [Symbol.asyncIterator]: async function* () { yield '{"sessionId":"s"}' } }
      await route.handler(req, res)
      check('缺 text 回 400', res.status === 400, String(res.status))
      check('400 提示字段要求', res.body.includes('sessionId and non-empty text'), res.body)
    }
    // —— 6) 会话不存在 → 404 JSON（用完整 ctx 驱动已注册的 handler）——
    {
      const res = makeRes()
      const req = { method: 'POST', url: PATH, [Symbol.asyncIterator]: async function* () { yield '{"sessionId":"no-such-session","text":"hi"}' } }
      await route.handler(req, res)
      check('会话不存在回 404', res.status === 404, String(res.status))
      check('404 带 JSON body', res.body.includes('session not found'), res.body)
    }
  }
}

// —— 7) 完整 200 路径：注册时 ctx 已能拿到 agents + llm ——
{
  const webServer = makeWebServer()
  const agent = {
    session: {
      id: 'sess-1',
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    },
    options: {},
  }
  const llm = {
    stream: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '增强后的提示词' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const injects = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => {
      if (name === 'webServer') return webServer
      if (name === 'agents') return { get: (id) => (id === 'sess-1' ? agent : undefined) }
      if (name === 'llm') return llm
      return undefined
    },
    inject: (deps, cb) => { injects.set(deps.join(','), cb) },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
    plugin: () => Promise.resolve(),
  }
  apply(ctx, cfg)
  const wctx = {
    logger: ctx.logger,
    get: ctx.get,
    effect: ctx.effect,
  }
  injects.get('webServer')(wctx)
  const route = webServer.routes.find((r) => r.path === PATH)
  check('完整场景下路由已注册', route !== undefined)
  if (route) {
    const res = makeRes()
    const req = { method: 'POST', url: PATH, [Symbol.asyncIterator]: async function* () { yield '{"sessionId":"sess-1","text":"帮我写个测试"}' } }
    await route.handler(req, res)
    check('正常请求回 200', res.status === 200, `${res.status} ${res.body}`)
    check('200 带回增强文本', res.body.includes('增强后的提示词'), res.body)
  }
}

console.log('')
if (failures > 0) { console.log(failures + ' FAILED'); process.exit(1) }
console.log('ALL PASS')
