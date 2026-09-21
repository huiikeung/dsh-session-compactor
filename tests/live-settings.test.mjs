/**
 * dsh-context-compactor 0.6.2 热更新链路冒烟测试：
 * apply() → installLiveSettings → settings.register(schema).watch → LIVE_KNOBS
 * → DetailedCompactionEngine.prototype._syncLiveKnobs / _summaryInstruction
 */
import { apply } from '../lib/index.js'

const log = []
const logger = {
  info: (...a) => log.push(['info', a.join(' ')]),
  warn: (...a) => log.push(['warn', a.join(' ')]),
  error: (...a) => log.push(['error', a.join(' ')]),
}

/** 契约对齐 dsh-settings.register：返回 { get, watch, update }；记录 reg 供测试驱动。 */
function makeSettings() {
  const store = { reg: undefined }
  const service = {
    get reg() { return store.reg },
    register(ns, schema, options) {
      if (store.reg !== undefined) throw new Error(`settings namespace "${ns}" is already registered`)
      let resolved = schema(options.base)
      const watchers = new Set()
      const reg = {
        get: () => resolved,
        watch: (cb) => { watchers.add(cb); return () => watchers.delete(cb) },
        update: (patch) => {
          resolved = schema({ ...resolved, ...patch })
          for (const cb of [...watchers]) cb()
        },
      }
      store.reg = reg
      return reg
    },
  }
  return service
}

const tick = () => new Promise((r) => setTimeout(r, 50))

/** 跑一遍 apply + settings 注入，返回引擎原型 fake 实例与 settings service。 */
async function boot(staticCfg) {
  let injectCb
  let captured
  const ctx = {
    logger,
    get: () => undefined,
    inject: (deps, cb) => { if (deps.includes('settings')) injectCb = cb },
    effect: () => {},
    on: () => () => {},
    plugin: (cls, config) => { captured = { cls, config }; return Promise.resolve() },
  }
  apply(ctx, {
    enabled: true, auto: true,
    pruneToolResults: false, registerCommands: false,
    scheduledReflection: false, liveSettings: true,
    compressPrompt: '',
    ...staticCfg,
  })
  const service = makeSettings()
  injectCb({ settings: service })
  await tick()
  return { captured, service }
}

function fakeEngine(proto, config, compressPrompt = '') {
  const e = Object.create(proto)
  e.config = config
  e.ctx = { logger }
  e._compressPrompt = compressPrompt // 构造函数在真实路径会设置；fake 需手动带上
  return e
}

let failures = 0
function check(name, cond) {
  if (cond) console.log('PASS', name)
  else { failures += 1; console.log('FAIL', name) }
}

// —— 0) 结构检查 ——
{
  const { captured } = await boot({})
  check('settings inject registered', true)
  check('engine class captured', captured?.cls !== undefined)
  check('compressPrompt passed to engineConfig (empty static)', captured.config.compressPrompt === '')
}

// —— 1) 合法热更新生效 ——
{
  const { captured, service } = await boot({})
  const engine = fakeEngine(captured.cls.prototype, {
    thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 12288,
  })
  service.reg.update({ thresholdRatio: 0.7, retainRatio: 0.2, maxTokens: 4096, compressPrompt: 'CUSTOM PROMPT' })
  engine._syncLiveKnobs()
  check('thresholdRatio hot-applied (0.8→0.7)', engine.config.thresholdRatio === 0.7)
  check('retainRatio hot-applied (0.16→0.2)', engine.config.retainRatio === 0.2)
  check('maxTokens hot-applied (12288→4096)', engine.config.maxTokens === 4096)
  check('custom compressPrompt wins', engine._summaryInstruction() === 'CUSTOM PROMPT')
  check('live-applied logged', log.some(([, m]) => m.includes('live settings applied')))
}

// —— 2) 非法 retainRatio ≥ thresholdRatio 被拒绝 ——
{
  const { captured, service } = await boot({})
  const engine = fakeEngine(captured.cls.prototype, {
    thresholdRatio: 0.7, retainRatio: 0.2, maxTokens: 12288,
  })
  service.reg.update({ thresholdRatio: 0.8, retainRatio: 0.9 })
  engine._syncLiveKnobs()
  check('thresholdRatio applied (0.7→0.8)', engine.config.thresholdRatio === 0.8)
  check('invalid retainRatio rejected (kept 0.2)', engine.config.retainRatio === 0.2)
  check('rejection warned', log.some(([lv, m]) => lv === 'warn' && m.includes('must stay below thresholdRatio')))
}

// —— 3) retainTokens 优先于 retainRatio ——
{
  const { captured, service } = await boot({})
  const engine = fakeEngine(captured.cls.prototype, {
    thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 12288,
  })
  service.reg.update({ retainTokens: 5000 })
  engine._syncLiveKnobs()
  check('retainTokens applied', engine.config.retainTokens === 5000)
  check('retainRatio dropped when retainTokens set', engine.config.retainRatio === undefined)
}

// —— 4) compressPrompt 优先级：live > static > builtin ——
{
  const { captured, service } = await boot({ compressPrompt: 'STATIC PROMPT' })
  const engine = fakeEngine(captured.cls.prototype, { thresholdRatio: 0.8, retainRatio: 0.16 }, 'STATIC PROMPT')
  check('static compressPrompt used when no live value', engine._summaryInstruction() === 'STATIC PROMPT')
  service.reg.update({ compressPrompt: 'LIVE PROMPT' })
  engine._syncLiveKnobs()
  check('live compressPrompt overrides static', engine._summaryInstruction() === 'LIVE PROMPT')
  service.reg.update({ compressPrompt: '' })
  engine._syncLiveKnobs()
  check('clearing live prompt falls back to static', engine._summaryInstruction() === 'STATIC PROMPT')
}

// —— 5) liveSettings: false 时不注册 ——
{
  log.length = 0
  let injectCb
  const ctx = {
    logger,
    get: () => undefined,
    inject: (deps, cb) => { if (deps.includes('settings')) injectCb = cb },
    effect: () => {}, on: () => () => {}, plugin: () => Promise.resolve(),
  }
  apply(ctx, {
    enabled: true, auto: true,
    pruneToolResults: false, registerCommands: false,
    scheduledReflection: false, liveSettings: false,
  })
  check('liveSettings:false → no settings inject', injectCb === undefined)
}

// —— 6) 重复注册（namespace 已存在）优雅降级 ——
{
  const shared = makeSettings() // 同一个 service 注入两次 → 第二次 register 撞已注册
  const bootOnce = async () => {
    let injectCb
    const ctx = {
      logger,
      get: () => undefined,
      inject: (deps, cb) => { if (deps.includes('settings')) injectCb = cb },
      effect: () => {}, on: () => () => {}, plugin: () => Promise.resolve(),
    }
    apply(ctx, {
      enabled: true, auto: true,
      pruneToolResults: false, registerCommands: false,
      scheduledReflection: false, liveSettings: true,
    })
    injectCb({ settings: shared })
    await tick()
  }
  log.length = 0
  await bootOnce() // 第一次：注册成功
  await bootOnce() // 第二次：already registered
  check('duplicate namespace degrades to warn', log.some(([lv, m]) => lv === 'warn' && m.includes('already registered')))
}

// —— 7) schemasty 缺失：register 抛错/缺失时降级 ——
{
  log.length = 0
  let injectCb
  const ctx = {
    logger,
    get: () => undefined,
    inject: (deps, cb) => { if (deps.includes('settings')) injectCb = cb },
    effect: () => {}, on: () => () => {}, plugin: () => Promise.resolve(),
  }
  apply(ctx, {
    enabled: true, auto: true,
    pruneToolResults: false, registerCommands: false,
    scheduledReflection: false, liveSettings: true,
  })
  injectCb({ settings: { /* no register fn */ } })
  await tick()
  check('missing register fn → info + degrade', log.some(([, m]) => m.includes('settings service unavailable')))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
