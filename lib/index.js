/**
 * dsh-context-compactor
 *
 * 开箱即用的「上下文压缩 / 上下文总结」插件，默认策略：
 *   - 上下文用量达到模型窗口 80% → 自动触发压缩；
 *   - 总结最优先：先把较早历史用 LLM 做成【详细】checkpoint 总结，
 *     绝不靠粗暴截断代替总结；
 *   - 总结双份保存：会话日志里持久化 compaction/* 事件 + checkpoint 节点，
 *     同时写一份 Markdown 到 ~/.dsh/storages/dsh-context-compactor/summaries/；
 *   - context-overflow 时同样先总结压缩，再自动重试本轮请求。
 *
 * 挂载方式：监听 `agent/created` 并补扫已存活 agent，在 agent scope 内用独立
 * isolate 挂载 DetailedCompactionEngine + ToolResultPruner；引擎监听器用
 * prepend 注册，保证本引擎的详细总结优先于 preset 自带的默认总结。
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { ManualCompactionError, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import {
  BlockAssembler,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  contentHasImage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-context-compactor'

/** 本模块挂载成功的引擎实例表：/compact 的兜底（引擎是 agent 无关的，可服务任意会话）。 */
const LIVE_ENGINES = []

/**
 * 动态配置（借鉴 dsh-auxiliary 的 syncEngineConfig 模式）：
 * settings namespace `dsh-context-compactor` 的运行时可调项。watch 到变化后
 * 写入这里并置 dirty；引擎在每次压力检查（compactIfNeeded）前合并进 this.config，
 * summarize 取压缩指令时也优先读这里。settings 服务 / schemastery 不可用时
 * 保持空表，插件整体降级为 cordis.patch.yml 的静态配置，行为与旧版一致。
 */
const LIVE_KNOBS = {
  dirty: false,
  thresholdRatio: undefined,
  retainRatio: undefined,
  retainTokens: undefined,
  maxTokens: undefined,
  compressPrompt: undefined,
}

/** 把一份（不可信的）settings 快照合并进 LIVE_KNOBS；非法字段一律忽略。 */
function applyLiveKnobs(value) {
  if (value === undefined || typeof value !== 'object') return
  for (const key of ['thresholdRatio', 'retainRatio', 'retainTokens', 'maxTokens']) {
    const v = value[key]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) LIVE_KNOBS[key] = v
    else if (v === undefined || v === null) LIVE_KNOBS[key] = undefined
  }
  LIVE_KNOBS.compressPrompt = typeof value.compressPrompt === 'string' && value.compressPrompt.length > 0
    ? value.compressPrompt
    : undefined
  LIVE_KNOBS.dirty = true
}

const CONFIG_KEYS = new Set([
  'enabled',
  'auto',
  'thresholdRatio',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'pruneToolResults',
  'pruneThresholdChars',
  'pruneHeadChars',
  'pruneTailChars',
  'registerCommands',
  'saveSummaryFile',
  'compressPrompt',
  'liveSettings',
  // —— 补丁特性开关 ——
  'preserveLargeToolResults',
  'offloadThresholdChars',
  'offloadChunkChars',
  'scheduledReflection',
  'scheduleIntervalHours',
  'scheduleCheckMinutes',
  'scheduleMinNewTokens',
  'pressureAwareCompaction',
  'trackToolTruncations',
])

const DEFAULTS = Object.freeze({
  enabled: true,
  auto: true,
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  summarizationProvider: '',
  summarizationModel: '',
  maxTokens: 12288,
  compactionRetries: 1,
  maxOverflowRetries: 2,
  pruneToolResults: true,
  pruneThresholdChars: 8192,
  pruneHeadChars: 4096,
  pruneTailChars: 1024,
  registerCommands: true,
  saveSummaryFile: true,
  // 自定义压缩指令：留空使用内置中文 checkpoint 模板（DETAIL_SUMMARY_INSTRUCTION）
  compressPrompt: '',
  // 注册 settings namespace 提供热更新（threshold/retain/maxTokens/compressPrompt）
  liveSettings: true,
  // 补丁 1：超大工具结果压缩前落盘防丢
  preserveLargeToolResults: true,
  offloadThresholdChars: 200 * 1024, // 超过 200KB 视为“长文本”
  offloadChunkChars: 128 * 1024,     // 每块 128KB
  // 补丁 3：每日定时反思
  scheduledReflection: true,
  scheduleIntervalHours: 24,         // 反思冷却期 24h
  scheduleCheckMinutes: 30,          // 定时器节拍
  scheduleMinNewTokens: 20000,       // 自上次反思起新增 ≥20k tokens 才触发
  // 补丁 2：压力感知压缩深度
  pressureAwareCompaction: true,
  // 补丁 4：工具截断追踪
  trackToolTruncations: true,
})

/**
 * 内置默认压缩指令（settings 用户层 / 静态配置 compressPrompt 都留空时用它）。
 * 保留/删除策略沿用需求原话的 4 节结构；在最早一版模板之上补齐四条纪律：
 *  ① 不编造（防幻觉写进 checkpoint）；
 *  ② 事实与推测分开，不确定的标「待确认」；
 *  ③ 凭据只写引用名，绝不把密钥值写进总结；
 *  ④ 简洁度/压缩幅度约束（服务插件的「压缩后验」：总结必须真的把 tokens 压小）。
 * 完整说明与「设置页粘贴版」见 docs/compressPrompt.default.md。
 */
const DETAIL_SUMMARY_INSTRUCTION = [
  '你是「全局上下文总结压缩引擎」。请把上方【全部较早历史对话】浓缩成一份中文 checkpoint，让另一个模型不回看原文就能直接接手后续工作。',
  '',
  '只输出 checkpoint 正文：不要调用任何工具，不要解释，不要复述本指令，也不要提“上下文被压缩”这件事。',
  '',
  '必须严格按下面的 Markdown 结构输出，4 个部分一节都不能省略；确实没有内容就写「（无）」。',
  '',
  '# 核心任务与当前进度',
  '- [用户最终目标与最新追加的要求；当前进行到哪一步、正在做什么；还差什么才算完成]',
  '',
  '# 关键决策及理由',
  '- [做过的重要决策、方案取舍与选择理由；影响后续工作的约束与偏好：目录约定、命名规范、工具链、禁止事项]',
  '',
  '# 待解决问题',
  '- [尚未解决的问题、阻塞点、待验证的假设、还缺的信息；逐条列清，不要遗漏]',
  '',
  '# 重要文件或代码位置',
  '- [精确路径 + 文件/函数/类/行号 + 为什么重要；关键命令、配置项、环境与版本、标识符、报错关键字原样保留（凭据只写引用名，绝不写密钥值）]',
  '',
  '以下内容必须删掉，不要写进总结：',
  '- 详细调试过程（只保留最终结论）；',
  '- 已经解决的错误（不要保留报错原文和排查过程；若“为什么这样修”本身是重要决策，则并入“关键决策及理由”）；',
  '- 客套话、寒暄与所有重复内容。',
  '',
  '写作规则：',
  '- 总结必须覆盖整个较早历史，而不是只总结最后几轮或某一段。',
  '- 事实与推测分开：不确定的标注「待确认」，不要把猜测写成结论。',
  '- 用户原话影响判断时逐字引用；文件路径、命令、标识符、数值、函数签名在“重要文件或代码位置”一节中原样保留，不要改写或“顺手优化”。',
  '- 不要编造上方历史里没有的信息。',
  '- 简洁：每条一到两句话，能合并的合并；压缩幅度以“不丢决策与待办”为底线，其余一律压缩。',
  '- 如果上方已经存在 <compacted-summary> 块，它是旧 checkpoint：不要逐字复制；对整段历史做全局合并——仍然成立的事实保留，已解决/已过时的删除，相同内容只保留一份。',
].join('\n')

const SUMMARY_OPEN_TAG = '<compacted-summary>'

/** 提示词增强指令：把用户草稿重写为更清晰、更完整、更适合 LLM 的提示词。 */
const ENHANCE_PROMPT_INSTRUCTION = [
  'You are a prompt engineering expert. Rewrite and improve the user\'s draft into a clear, well-structured, effective prompt for an AI assistant.',
  'Rules:',
  '- Keep the user\'s original intent and all concrete details; do not invent requirements.',
  '- If the draft is already excellent, only lightly polish it.',
  '- Output ONLY the enhanced prompt text, with no explanations, no quotes, no preamble.',
  '- Use the same language as the user\'s draft.',
].join('\n')

/** 用 DSH 当前模型增强提示词（供命令与专用 HTTP 接口共用，不写会话日志）。 */
async function enhanceText(ctx, session, agentOptions, text, signal) {
  const routed = typeof session.requestHeader === 'function' ? session.requestHeader()?.config : undefined
  let target
  if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
    target = { provider: routed.provider, model: routed.model }
  } else if (
    typeof agentOptions?.provider === 'string' && agentOptions.provider.length > 0
    && typeof agentOptions?.model === 'string' && agentOptions.model.length > 0
  ) {
    target = { provider: agentOptions.provider, model: agentOptions.model }
  }
  if (target === undefined) {
    throw new Error('无法确定当前模型，无法增强提示词。')
  }
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('LLM 服务不可用。')

  const assembler = new BlockAssembler()
  const messages = [
    createUserMessage({
      content: [{ type: 'text', text: ENHANCE_PROMPT_INSTRUCTION + '\n\nUser draft:\n' + text }],
      source: { kind: 'plugin', plugin: 'dsh-context-compactor' },
    }),
  ]
  for await (const chunk of llm.stream({
    provider: target.provider,
    model: target.model,
    messages,
    maxTokens: 4096,
    sessionId: session.id,
    purpose: 'prompt-enhance',
    ...signal === undefined ? {} : { signal },
  })) assembler.push(chunk)

  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
  if (finish.kind === 'max-tokens') throw new Error('增强结果超出长度限制，请缩短草稿后重试。')
  const output = assembler.blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (output.length === 0) throw new Error('模型没有返回增强结果。')
  return output
}

/** 注册一个不写会话日志的专用接口：POST /dsh-context-compactor/enhance。 */
function registerEnhanceRoute(ctx) {
  // ⚠️ 本插件 apply 时 webServer 可能还没激活，主 fiber 上 ctx.get('webServer') 会拿到
  // undefined —— 老代码在这里静默 return，路由从未注册，前端「提示增强」只能拿到
  // SPA fallback 的 404/405（空 body，看不出原因）。改成 ctx.inject 等它就绪再注册，
  // 与 settings / commands / dsh-vision-assistant 同一套写法。
  // agents / llm 不写在 inject 里：cordis 的 ctx.get 本来就不要求 inject，请求来了再取，
  // 免得为了等 llm 就绪把路由注册也一起拖住。
  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return
    try {
      wctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-context-compactor/enhance',
        handler: async (req, res) => {
          const json = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
          }
          if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' })
          let raw = ''
          for await (const chunk of req) raw += chunk
          let payload
          try {
            payload = JSON.parse(raw)
          } catch {
            return json(400, { ok: false, error: 'invalid json' })
          }
          const { sessionId, text } = payload ?? {}
          if (typeof sessionId !== 'string' || sessionId.length === 0
            || typeof text !== 'string' || text.trim().length === 0) {
            return json(400, { ok: false, error: 'sessionId and non-empty text are required' })
          }
          const agents = wctx.get('agents')
          const agent = agents !== undefined && typeof agents.get === 'function'
            ? agents.get(sessionId)
            : undefined
          if (agent === undefined) return json(404, { ok: false, error: 'session not found' })
          try {
            const output = await enhanceText(wctx, agent.session, agent.options, text, undefined)
            return json(200, { ok: true, text: output })
          } catch (error) {
            return json(500, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        },
      }), 'dsh-context-compactor enhance route')
    } catch (error) {
      // 热激活/重复装载时路由可能已注册，幂等跳过。
      wctx.logger.info(
        'dsh-context-compactor: enhance route already registered or unavailable: '
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  })
}

function fail(message) {
  throw new Error(`dsh-context-compactor: ${message}`)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertBoolean(value, key) {
  if (typeof value !== 'boolean') fail(`config "${key}" must be a boolean`)
  return value
}

function assertRatio(value, key) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    fail(`config "${key}" must be a number in (0, 1]`)
  }
  return value
}

function assertNonNegativeInteger(value, key) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(`config "${key}" must be a non-negative integer`)
  }
  return value
}

function assertPositiveInteger(value, key) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`config "${key}" must be a positive integer`)
  }
  return value
}

function assertOptionalString(value, key) {
  if (value === undefined) return ''
  if (typeof value !== 'string') fail(`config "${key}" must be a string`)
  return value
}

function resolveModelPolicies(raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) fail('config "modelPolicies" must be an array')
  return raw.map((entry, index) => {
    if (!isPlainObject(entry)) fail(`config "modelPolicies[${index}]" must be an object`)
    if (typeof entry.provider !== 'string' || entry.provider.length === 0) {
      fail(`config "modelPolicies[${index}].provider" must be a non-empty string`)
    }
    if (typeof entry.model !== 'string' || entry.model.length === 0) {
      fail(`config "modelPolicies[${index}].model" must be a non-empty string`)
    }
    if (entry.contextWindow !== undefined) {
      assertPositiveInteger(entry.contextWindow, `modelPolicies[${index}].contextWindow`)
    }
    return { ...entry }
  })
}

/** 校验并补默认值；未识别键直接报错，避免拼写错误被静默吞掉。 */
function resolveConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (!isPlainObject(raw)) fail('config must be an object')
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) fail(`unknown config key "${key}"`)
  }

  const enabled = raw.enabled === undefined ? DEFAULTS.enabled : assertBoolean(raw.enabled, 'enabled')
  const auto = raw.auto === undefined ? DEFAULTS.auto : assertBoolean(raw.auto, 'auto')
  const thresholdRatio = raw.thresholdRatio === undefined
    ? DEFAULTS.thresholdRatio
    : assertRatio(raw.thresholdRatio, 'thresholdRatio')
  const retainRatio = raw.retainRatio === undefined
    ? DEFAULTS.retainRatio
    : assertRatio(raw.retainRatio, 'retainRatio')
  const retainTokens = raw.retainTokens === undefined
    ? undefined
    : assertNonNegativeInteger(raw.retainTokens, 'retainTokens')
  if (raw.retainRatio !== undefined && retainTokens !== undefined) {
    fail('config "retainRatio" and "retainTokens" are mutually exclusive')
  }
  if (retainRatio >= thresholdRatio) {
    fail(`config "retainRatio" (${retainRatio}) must be less than "thresholdRatio" (${thresholdRatio})`)
  }

  const summarizationProvider = assertOptionalString(raw.summarizationProvider, 'summarizationProvider')
  const summarizationModel = assertOptionalString(raw.summarizationModel, 'summarizationModel')
  if ((summarizationProvider.length === 0) !== (summarizationModel.length === 0)) {
    fail('config "summarizationProvider" and "summarizationModel" must be set together as an empty or non-empty pair')
  }

  const resolved = {
    enabled,
    auto,
    thresholdRatio,
    retainRatio,
    retainTokens,
    summarizationProvider,
    summarizationModel,
    maxTokens: raw.maxTokens === undefined
      ? DEFAULTS.maxTokens
      : assertPositiveInteger(raw.maxTokens, 'maxTokens'),
    compactionRetries: raw.compactionRetries === undefined
      ? DEFAULTS.compactionRetries
      : assertNonNegativeInteger(raw.compactionRetries, 'compactionRetries'),
    maxOverflowRetries: raw.maxOverflowRetries === undefined
      ? DEFAULTS.maxOverflowRetries
      : assertNonNegativeInteger(raw.maxOverflowRetries, 'maxOverflowRetries'),
    modelPolicies: Object.freeze(resolveModelPolicies(raw.modelPolicies)),
    pruneToolResults: raw.pruneToolResults === undefined
      ? DEFAULTS.pruneToolResults
      : assertBoolean(raw.pruneToolResults, 'pruneToolResults'),
    pruneThresholdChars: raw.pruneThresholdChars === undefined
      ? DEFAULTS.pruneThresholdChars
      : assertPositiveInteger(raw.pruneThresholdChars, 'pruneThresholdChars'),
    pruneHeadChars: raw.pruneHeadChars === undefined
      ? DEFAULTS.pruneHeadChars
      : assertNonNegativeInteger(raw.pruneHeadChars, 'pruneHeadChars'),
    pruneTailChars: raw.pruneTailChars === undefined
      ? DEFAULTS.pruneTailChars
      : assertNonNegativeInteger(raw.pruneTailChars, 'pruneTailChars'),
    registerCommands: raw.registerCommands === undefined
      ? DEFAULTS.registerCommands
      : assertBoolean(raw.registerCommands, 'registerCommands'),
    saveSummaryFile: raw.saveSummaryFile === undefined
      ? DEFAULTS.saveSummaryFile
      : assertBoolean(raw.saveSummaryFile, 'saveSummaryFile'),
    compressPrompt: assertOptionalString(raw.compressPrompt, 'compressPrompt'),
    liveSettings: raw.liveSettings === undefined
      ? DEFAULTS.liveSettings
      : assertBoolean(raw.liveSettings, 'liveSettings'),

    // 补丁 1：长文本防丢
    preserveLargeToolResults: raw.preserveLargeToolResults === undefined
      ? DEFAULTS.preserveLargeToolResults
      : assertBoolean(raw.preserveLargeToolResults, 'preserveLargeToolResults'),
    offloadThresholdChars: raw.offloadThresholdChars === undefined
      ? DEFAULTS.offloadThresholdChars
      : assertPositiveInteger(raw.offloadThresholdChars, 'offloadThresholdChars'),
    offloadChunkChars: raw.offloadChunkChars === undefined
      ? DEFAULTS.offloadChunkChars
      : assertPositiveInteger(raw.offloadChunkChars, 'offloadChunkChars'),
    scheduledReflection: raw.scheduledReflection === undefined
      ? DEFAULTS.scheduledReflection
      : assertBoolean(raw.scheduledReflection, 'scheduledReflection'),
    scheduleIntervalHours: raw.scheduleIntervalHours === undefined
      ? DEFAULTS.scheduleIntervalHours
      : assertPositiveNumber(raw.scheduleIntervalHours, 'scheduleIntervalHours'),
    scheduleCheckMinutes: raw.scheduleCheckMinutes === undefined
      ? DEFAULTS.scheduleCheckMinutes
      : assertPositiveInteger(raw.scheduleCheckMinutes, 'scheduleCheckMinutes'),
    scheduleMinNewTokens: raw.scheduleMinNewTokens === undefined
      ? DEFAULTS.scheduleMinNewTokens
      : assertNonNegativeInteger(raw.scheduleMinNewTokens, 'scheduleMinNewTokens'),
    pressureAwareCompaction: raw.pressureAwareCompaction === undefined
      ? DEFAULTS.pressureAwareCompaction
      : assertBoolean(raw.pressureAwareCompaction, 'pressureAwareCompaction'),
    trackToolTruncations: raw.trackToolTruncations === undefined
      ? DEFAULTS.trackToolTruncations
      : assertBoolean(raw.trackToolTruncations, 'trackToolTruncations'),
  }

  if (resolved.offloadThresholdChars <= resolved.offloadChunkChars) {
    fail('config "offloadThresholdChars" must be greater than "offloadChunkChars"')
  }

  return Object.freeze(resolved)
}

/** 校验正数（用于时间跨度/窗口类配置）。 */
function assertPositiveNumber(value, key) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`config "${key}" must be a positive number`)
  }
  return value
}

/** 交给上游引擎的那份配置。 */
function engineConfig(cfg) {
  return {
    auto: cfg.auto,
    thresholdRatio: cfg.thresholdRatio,
    ...cfg.retainTokens === undefined
      ? { retainRatio: cfg.retainRatio }
      : { retainTokens: cfg.retainTokens },
    summarizationProvider: cfg.summarizationProvider,
    summarizationModel: cfg.summarizationModel,
    maxTokens: cfg.maxTokens,
    compactionRetries: cfg.compactionRetries,
    maxOverflowRetries: cfg.maxOverflowRetries,
    modelPolicies: cfg.modelPolicies.map((entry) => ({ ...entry })),
    saveSummaryFile: cfg.saveSummaryFile,
    compressPrompt: cfg.compressPrompt,
    // 补丁特性的引擎侧开关（宿主侧定时反思配置由 apply() 直接读取）
    reflectionsEnabled: cfg.scheduledReflection,
    pressureAware: cfg.pressureAwareCompaction,
    trackTruncations: cfg.trackToolTruncations,
    preserveLarge: cfg.preserveLargeToolResults,
    offloadThresholdChars: cfg.offloadThresholdChars,
    offloadChunkChars: cfg.offloadChunkChars,
  }
}

function summaryFilePath(sessionId) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')
  return join(home, 'storages', 'dsh-context-compactor', 'summaries', `${safe}.md`)
}

/* ========================================================================= *
 * 补丁 1 / 3 / 4 的底层工具：长文本防丢落盘、工具截断追踪、定时反思状态   *
 * ========================================================================= */

/** 插件持久化根目录：~/.dsh/storages/dsh-context-compactor/ */
function pluginStorageDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-context-compactor')
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_')
}

/** 取某条当前 surface 位序上的工具结果内容块；非 tool/result 事件返回 null。 */
function toolResultBlocks(session, seq) {
  const event = session.events[seq]
  if (event?.type !== 'tool/result' || !event.data?.message) return null
  const result = event.data.message.content[0]
  if (!result || !Array.isArray(result.content)) return null
  return result.content
}

/** 统计内容块里的文本字符数（按 Unicode 码点，与官方 pruner 口径一致）。 */
function measureContentChars(blocks) {
  let total = 0
  for (const block of blocks) {
    if (block.type === 'text') total += Array.from(block.text).length
  }
  return total
}

/** 内容块 → 纯文本（用于落盘）。 */
function blocksToText(blocks) {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
}

/**
 * 补丁 1：Compaction 联动防丢。
 * 把「超过 offloadThresholdChars 的超大工具结果」在压缩/裁剪前原样落盘保存，
 * 并按 offloadChunkChars 分块；磁盘上保留索引文件，完整原文因此绝不会在
 * compaction 或裁剪后丢失。幂等：同一 (seq, callId) 已保存则跳过。
 * @returns 本次新保存的记录（空数组表示无超大结果或全部已保存）。
 */
function preserveLargeToolResults(session, thresholdChars, chunkChars) {
  if (typeof thresholdChars !== 'number' || thresholdChars <= 0) return []
  const preserved = []
  for (const seq of [...session.surface.nodes]) {
    const blocks = toolResultBlocks(session, seq)
    if (blocks === null) continue
    const size = measureContentChars(blocks)
    if (size <= thresholdChars) continue
    const event = session.events[seq]
    const callId = String(event.data.message.source?.callId ?? seq)
    const partName = `${seq}.${safeSegment(callId)}`
    const base = join(pluginStorageDir(), 'preserved', safeSegment(session.id))
    const indexFile = join(base, `${partName}.md`)
    if (existsSync(indexFile)) continue // 已保存过，避免重复写盘
    const text = blocksToText(blocks)
    const parts = []
    mkdirSync(base, { recursive: true })
    for (let offset = 0; offset < text.length; offset += chunkChars) {
      const partFile = join(base, `${partName}.part-${parts.length + 1}.md`)
      writeFileSync(partFile, text.slice(offset, offset + chunkChars), 'utf8')
      parts.push(partFile)
    }
    writeFileSync(indexFile, [
      '# 超大工具结果已单独保存（防压缩丢失）',
      `- 会话：${session.id}`,
      `- surface seq：${seq}`,
      `- callId：${callId}`,
      `- 文本字符数：${size}（按 ${chunkChars} 分块，共 ${parts.length} 块）`,
      `- 保存时间：${new Date().toISOString()}`,
      '',
      '分块文件：',
      ...parts.map((part) => `- ${part}`),
      '',
    ].join('\n'), 'utf8')
    preserved.push({ seq, callId, size, parts: parts.length })
  }
  return preserved
}

/** 工具截断追踪日志路径（一行一条 JSON）。 */
function truncationLogFile() {
  return join(pluginStorageDir(), 'truncations.jsonl')
}

/**
 * 补丁 4：工具截断追踪。
 * 把被裁剪（truncated）的工具结果追加到持久化日志；后续需要重新读取同一
 * 工具结果时，先查这张表——若上次 result_size 比原始输出小，说明这次的
 * 是不全的截断版，应改用分块方式重新读取，而不是继续用截断版。
 * 字段对齐文中的 memory_tool_results 表：tool_name / args_summary /
 * result_size / was_truncated / created_at。
 */
function appendTruncationRecords(records) {
  if (!Array.isArray(records) || records.length === 0) return
  try {
    const file = truncationLogFile()
    mkdirSync(dirname(file), { recursive: true })
    const now = Date.now() / 1000
    const lines = records.map((record) => JSON.stringify({
      tool_name: record.tool_name ?? 'tool-result',
      args_summary: '',
      result_size: record.result_size,
      pruned_size: record.pruned_size,
      was_truncated: 1,
      session_id: record.session_id,
      call_id: record.call_id,
      seq: record.seq,
      created_at: now,
    }))
    writeFileSync(file, lines.join('\n') + '\n', { flag: 'a', encoding: 'utf8' })
  } catch {
    // 记录失败不影响主流程
  }
}

function reflectStateFile() {
  return join(pluginStorageDir(), 'reflect-state.json')
}

function loadReflectState() {
  try {
    return JSON.parse(readFileSync(reflectStateFile(), 'utf8'))
  } catch {
    return {}
  }
}

function saveReflectState(state) {
  try {
    writeFileSync(reflectStateFile(), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // 忽略：状态丢失只影响反思节流的跨重启连续性
  }
}

function routedTarget(session) {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}

/** 合并 modelPolicies 覆盖后的阈值、保留策略与真实上下文窗口。 */
function targetPolicy(config, target) {
  const override = config.modelPolicies.find(
    (entry) => entry.provider === target.provider && entry.model === target.model,
  )
  return {
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    retainRatio: override?.retainRatio ?? config.retainRatio,
    retainTokens: override?.retainTokens ?? config.retainTokens,
    contextWindow: override?.contextWindow,
  }
}

/** 头部里的 maxTokens 是输出上限，不是上下文窗口，绝不能当作窗口用。
 *  仅在适配器完全不报窗口时做最后兜底（且仍可能不准确，宁可不压）。 */
function headerWindowHint(session) {
  try {
    const config = session.requestHeader()?.config
    if (config !== undefined && typeof config.maxTokens === 'number' && config.maxTokens >= 100000) {
      return config.maxTokens
    }
  } catch {}
  return undefined
}

/**
 * 选择「全部较早历史」的压缩范围（head-anchored），保留最近 retainTokens 的
 * 原样尾巴；与上游 selectCompactableRange 语义一致，用于保证压缩后的减量。
 */
function selectGlobalRange(session, measurement, retainTokens) {
  const pricedNodes = measurement.nodes
  if (!Array.isArray(pricedNodes) || pricedNodes.length === 0) return null
  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }

  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index].tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx === 0) return null

  while (keepFromIdx > 0) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break
    keepFromIdx -= 1
  }
  if (keepFromIdx === 0) return null

  return { start: surfaceNodes[0], end: surfaceNodes[keepFromIdx - 1] }
}

/**
 * 详细总结版压缩引擎：
 * - 监听器用 prepend 注册 → 在任何 preset 默认引擎之前先执行，保证“总结优先”
 *   且用的是详细总结；
 * - summarize() 覆盖为详细中文 checkpoint 指令，并把总结落盘保存；
 * - 压力/overflow 触发逻辑（80% 阈值、保留尾巴、重试预算）继承官方实现。
 */
class DetailedCompactionEngine extends BasicCompactionEngine {
  // 挂载方式：compCtx.plugin(DetailedCompactionEngine, config)。
  // 这样会创建带 inject 的子 fiber（继承父类 static inject =
  // ['llm', 'tokenMeter', 'sessions']），引擎内部访问 this.ctx.tokenMeter /
  // this.ctx.llm 才有正确的服务解析路径。
  // Config 显式置空：跳过父类 schema 校验，把包含 saveSummaryFile 的完整
  // 配置原样交给构造函数（父类 resolveConfig 会自行校验上游字段）。
  static Config = undefined

  constructor(ctx, config = {}) {
    const {
      saveSummaryFile,
      compressPrompt,
      reflectionsEnabled = true,
      pressureAware = true,
      trackTruncations = true,
      preserveLarge = true,
      offloadThresholdChars,
      offloadChunkChars,
      modelPolicies = [],
      ...engineFields
    } = config ?? {}
    // 摘出 contextWindow 覆盖（modlens 等 provider 会上报错误的 1M 窗口，
    // 需要按真实窗口覆盖），并把不含该字段的 modelPolicies 交给父类。
    // 注意：这里只能先算局部变量，super() 之后才能写 this。
    const contextWindowOverrides = new Map()
    const sanitizedPolicies = (Array.isArray(modelPolicies) ? modelPolicies : []).map((entry) => {
      if (entry && typeof entry === 'object' && typeof entry.contextWindow === 'number') {
        contextWindowOverrides.set(`${entry.provider}/${entry.model}`, entry.contextWindow)
      }
      if (entry && typeof entry === 'object' && 'contextWindow' in entry) {
        const { contextWindow: _drop, ...rest } = entry
        return rest
      }
      return entry
    })
    // 关闭父类的自动监听，改由本类以 prepend 方式注册。
    super(ctx, { ...engineFields, modelPolicies: sanitizedPolicies, auto: false })
    this._contextWindowOverrides = contextWindowOverrides
    this._lastAutoCompactAt = new WeakMap()
    this._saveSummaryFile = saveSummaryFile ?? true
    this._compressPrompt = compressPrompt ?? ''
    this._auto = engineFields.auto ?? true
    this._summaryCapOverride = null
    // 补丁特性开关
    this._reflectionsEnabled = reflectionsEnabled ?? true
    this._pressureAware = pressureAware ?? true
    this._trackTruncations = trackTruncations ?? true
    this._preserveLarge = preserveLarge ?? true
    this._offloadThresholdChars = offloadThresholdChars ?? 200 * 1024
    this._offloadChunkChars = offloadChunkChars ?? 128 * 1024
    this._lastPressure = undefined
    if (this._auto) this._registerPrependAuto()
  }

  /**
   * 热更新入口（借鉴 dsh-auxiliary 的 syncEngineConfig）：每次压力检查前把
   * settings namespace 里的最新值合并进引擎配置，设置页改阈值/预算立即生效，
   * 无需重启或重挂引擎。
   */
  compactIfNeeded(agent, trigger, signal) {
    this._syncLiveKnobs()
    return super.compactIfNeeded(agent, trigger, signal)
  }

  _syncLiveKnobs() {
    if (!LIVE_KNOBS.dirty) return
    LIVE_KNOBS.dirty = false
    const next = { ...this.config }
    if (LIVE_KNOBS.thresholdRatio !== undefined) next.thresholdRatio = LIVE_KNOBS.thresholdRatio
    if (LIVE_KNOBS.retainTokens !== undefined) {
      next.retainTokens = LIVE_KNOBS.retainTokens
      delete next.retainRatio
    } else if (LIVE_KNOBS.retainRatio !== undefined) {
      if (LIVE_KNOBS.retainRatio < next.thresholdRatio) {
        next.retainRatio = LIVE_KNOBS.retainRatio
        delete next.retainTokens
      } else {
        this.ctx.logger.warn(
          `live retainRatio (${LIVE_KNOBS.retainRatio}) must stay below thresholdRatio `
          + `(${next.thresholdRatio}); keeping previous retain policy`,
        )
      }
    }
    if (LIVE_KNOBS.maxTokens !== undefined) next.maxTokens = LIVE_KNOBS.maxTokens
    this.config = next
    this.ctx.logger.info(
      'dsh-context-compactor: live settings applied '
      + `(thresholdRatio=${next.thresholdRatio}, maxTokens=${next.maxTokens})`,
    )
  }

  /** 压缩指令：settings 热更新 > 静态配置 compressPrompt > 内置中文模板。 */
  _summaryInstruction() {
    return LIVE_KNOBS.compressPrompt || this._compressPrompt || DETAIL_SUMMARY_INSTRUCTION
  }

  _registerPrependAuto() {
    const { ctx } = this
    const logResult = (result, trigger) => {
      ctx.logger.info(
        `detailed compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }
    const overflowRetries = new WeakMap()
    const overflowAgents = new WeakMap()

    // prepend：先于其他压缩引擎执行 → 80% 时先用详细总结压缩。
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`detailed step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    }, { prepend: true })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') overflowRetries.delete(agent)
    }, { prepend: true })

    // 成功产出 assistant 回复即重置本回合的 overflow 恢复序列。
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = overflowAgents.get(session)
      if (agent !== undefined) overflowRetries.delete(agent)
    }, { prepend: true })

    // prepend：provider 明确报 context length 超限时，先详细总结压缩，再 retry。
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const retries = overflowRetries.get(agent) ?? 0
      if (retries >= this.config.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result = null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `detailed context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          `detailed context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    }, { prepend: true })
  }

  /**
   * 真正的压缩：不满足「压缩后 totalTokens 必须下降」就不算成功。
   *
   * 自动压力/overflow 路径：先裁剪工具结果，然后从配置保留尾巴开始，
   * 逐级「减保留尾巴 + 减总结预算」重复压缩全部较早历史，直到
   *   - pressure：压缩后 totalTokens < 阈值（默认 80%）；
   *   - context-overflow：压缩后 totalTokens < 压缩前。
   * 全部尝试后仍未下降 → 抛错（绝不以“没变化”冒充成功）。
   */
  async compactIfNeeded(agent, trigger, signal) {
    const meter = this.ctx.tokenMeter
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = targetPolicy(this.config, target)

    let thresholdTokens = 0
    let contextWindow
    if (trigger === 'pressure') {
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
      const adapterWindow = info.context?.contextWindow
      const override = this._contextWindowOverrides.get(`${target.provider}/${target.model}`)
      // 优先级：显式覆盖 > 适配器上报的真实上下文窗口 > （最后兜底）头部输出上限。
      // 注意 maxTokens 只是输出上限，不能优先于适配器窗口，否则会把 1M 真实窗口
      // 误判成 256k，导致远未到 80% 就频繁自动压缩。
      contextWindow = override ?? adapterWindow ?? headerWindowHint(agent.session)
      if (contextWindow === undefined) {
        throw new Error(
          `no context capacity for ${target.provider}/${target.model}; `
          + 'configure contextWindow in modelPolicies or on that adapter model',
        )
      }
      thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio)
    }

    const before = meter.measure(agent.session)
    if (trigger === 'pressure' && before.totalTokens < thresholdTokens) return null
    const beforeTotal = before.totalTokens
    // 补丁 2：Token Meter 压力感知 —— 算出当前上下文压力（0–1）供日志与压缩深度使用。
    const contextPressure = contextWindow !== undefined && contextWindow > 0
      ? beforeTotal / contextWindow
      : undefined
    this._lastPressure = contextPressure
    this.ctx.logger.info(
      `detailed compaction trigger: ${trigger} total=${beforeTotal} `
      + `window=${contextWindow ?? '?'} threshold=${thresholdTokens ?? '?'} `
      + `pressure=${contextPressure === undefined ? '?' : contextPressure.toFixed(3)}`,
    )

    // 自动压缩冷却：同一会话短时间内不重复自动压，避免任务中“动不动就压”。
    // 但若确实超出真实上下文窗口（provider 会报错），冷却不拦截。
    if (trigger === 'pressure' || trigger === 'context-overflow') {
      const lastAt = this._lastAutoCompactAt.get(agent.session)
      const realOver = contextWindow !== undefined && beforeTotal > contextWindow
      if (lastAt !== undefined && !realOver && Date.now() - lastAt < 5 * 60 * 1000) {
        return null
      }
    }

    // 补丁 1：先落盘保存超大工具结果，再裁剪/压缩 —— 长文本绝不因压缩而丢。
    if (this._preserveLarge) {
      try {
        const preserved = preserveLargeToolResults(
          agent.session,
          this._offloadThresholdChars,
          this._offloadChunkChars,
        )
        if (preserved.length > 0) {
          this.ctx.logger.info(
            `detailed compaction: preserved ${preserved.length} large tool result(s) to disk `
            + '(see ~/.dsh/storages/dsh-context-compactor/preserved/) before pruning',
          )
        }
      } catch (error) {
        this.ctx.logger.warn(
          'detailed compaction: failed to preserve large tool results: '
          + (error instanceof Error ? error.message : String(error)),
        )
      }
    }

    this._pruneAndTrack(agent.session)
    let measurement = meter.measure(agent.session)

    const baseRetain = policy.retainTokens !== undefined
      ? policy.retainTokens
      : Math.floor((contextWindow ?? beforeTotal) * policy.retainRatio)
    const retainLevels = trigger === 'context-overflow'
      ? [0]
      : [...new Set([
          baseRetain,
          Math.floor(baseRetain / 2),
          Math.floor(baseRetain / 4),
          0,
        ])].sort((a, b) => b - a)
    // 补丁 2：压力 >0.9 时直接跳过最宽松的总结预算，从减半预算开始压缩得更狠。
    const capLevels = this._pressureAware && contextPressure !== undefined && contextPressure > 0.9
      ? [...new Set([
          Math.floor(this.config.maxTokens / 2),
          Math.floor(this.config.maxTokens / 4),
          1024,
        ])]
      : [...new Set([
          this.config.maxTokens,
          Math.floor(this.config.maxTokens / 2),
          Math.floor(this.config.maxTokens / 4),
          1024,
        ])]

    let lastResult = null
    for (const retain of retainLevels) {
      for (const cap of capLevels) {
        const range = selectGlobalRange(agent.session, measurement, retain)
        if (range === null) break
        this._summaryCapOverride = cap
        let result
        try {
          result = await this.compactRegion(range.start, range.end, agent, signal)
        } catch (error) {
          // 活跃会话在总结期间写入新节点会触发 surface changed；重新测量后重试一次。
          const message = error instanceof Error ? error.message : String(error)
          if (signal.aborted || !message.includes('surface changed')) throw error
          measurement = meter.measure(agent.session)
          continue
        }
        lastResult = result
        measurement = meter.measure(agent.session)

        this._pruneAndTrack(agent.session)
        measurement = meter.measure(agent.session)

        if (trigger === 'context-overflow') {
          if (measurement.totalTokens < beforeTotal) {
            this.ctx.logger.info(
              `detailed compaction verified: ${beforeTotal} -> ${measurement.totalTokens} tokens `
              + `(${Math.max(0, Math.round((1 - measurement.totalTokens / beforeTotal) * 100))}% reduced)`,
            )
            this._lastAutoCompactAt.set(agent.session, Date.now())
            return result
          }
        } else if (measurement.totalTokens < thresholdTokens) {
          this.ctx.logger.info(
            `detailed compaction verified: ${beforeTotal} -> ${measurement.totalTokens} tokens `
            + `(threshold ${thresholdTokens}; ${Math.max(0, Math.round((1 - measurement.totalTokens / beforeTotal) * 100))}% reduced)`,
          )
          this._lastAutoCompactAt.set(agent.session, Date.now())
          return result
        }
      }
    }

    const after = measurement.totalTokens
    // 若裁剪工具结果本身已把压力压回阈值内，也算成功（真实减量）。
    if (trigger === 'pressure' && after < thresholdTokens) {
      if (lastResult !== null) {
        this.ctx.logger.info(
          `detailed compaction verified: ${beforeTotal} -> ${after} tokens (threshold ${thresholdTokens}; pruned+compacted)`,
        )
        return lastResult
      }
      this.ctx.logger.info(
        `detailed compaction verified (prune-only): ${beforeTotal} -> ${after} tokens (threshold ${thresholdTokens})`,
      )
      this._lastAutoCompactAt.set(agent.session, Date.now())
      return null
    }
    throw new Error(
      `compaction did NOT actually shrink context: before ${beforeTotal} tokens, after ${after} tokens `
      + (trigger === 'pressure' ? `(threshold ${thresholdTokens})` : ''),
    )
  }

  /**
   * 手动 /compact 同样必须真实减量：super.compactNow 已经压到 retain=0，
   * 这里做 before/after 校验；若总结反而变大，就降低总结预算重试，最多 4 次。
   */
  async compactNow(agent, signal, sourceCommandId) {
    const before = this.ctx.tokenMeter.measure(agent.session).totalTokens
    let cap = this.config.maxTokens
    let lastAfter = before
    for (let attempt = 0; attempt < 4; attempt += 1) {
      this._summaryCapOverride = cap
      const result = await super.compactNow(
        agent,
        signal,
        attempt === 0 ? sourceCommandId : undefined,
      )
      if (result === null) return null
      const after = this.ctx.tokenMeter.measure(agent.session).totalTokens
      lastAfter = after
      if (after < before) {
        this.ctx.logger.info(
          `manual compaction verified: ${before} -> ${after} tokens `
          + `(${Math.max(0, Math.round((1 - after / before) * 100))}% reduced)`,
        )
        return result
      }
      cap = Math.max(1024, Math.floor(cap / 2))
    }
    throw new Error(
      `compaction did NOT actually shrink context: before ${before} tokens, after ${lastAfter} tokens`,
    )
  }

  /**
   * 详细总结覆盖点：缓存友好的 prefix-replay 调用 + 详细中文 checkpoint 指令，
   * 并把总结正文额外写入 Markdown 文件。
   */
  async summarize(input, agent, signal) {
    const config = this.config
    const latest = agent.session.requestHeader()?.config
    const configured = config.summarizationProvider.length === 0
      ? undefined
      : { provider: config.summarizationProvider, model: config.summarizationModel }
    const agentTarget = agent.options.provider !== undefined && agent.options.provider.length > 0
      && agent.options.model !== undefined && agent.options.model.length > 0
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined
    const target = configured ?? latest ?? agentTarget
    if (target === undefined) {
      throw new Error(
        'no provider/model available for summarization: set summarizationProvider/summarizationModel, route one request, or set AgentOptions',
      )
    }

    const assembler = new BlockAssembler()
    const messages = [
      ...input.messages,
      createUserMessage({
        content: [{ type: 'text', text: this._summaryInstruction() }],
        source: { kind: 'plugin', plugin: 'dsh-context-compactor' },
      }),
    ]
    const effectiveMaxTokens = this._summaryCapOverride ?? config.maxTokens
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      ...input.system === undefined ? {} : { system: input.system },
      ...input.tools === undefined ? {} : { tools: [...input.tools] },
      maxTokens: effectiveMaxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)

    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const error = new Error(finish.failure.message)
      error.code = finish.failure.code
      throw error
    }
    if (finish.kind === 'max-tokens') {
      const error = new Error('detailed summarization truncated at the token cap (incomplete checkpoint)')
      error.code = 'MAX_TOKENS'
      throw error
    }

    const rawOutput = assembler.blocks()
    const summary = summaryText(rawOutput)
    this._writeSummaryFile(agent, summary)
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens: effectiveMaxTokens,
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    }
  }

  _writeSummaryFile(agent, summary) {
    if (!this._saveSummaryFile) return
    try {
      const text = summary.map((block) => block.text).join('\n')
      const file = summaryFilePath(agent.session.id)
      mkdirSync(dirname(file), { recursive: true })
      const pressureLine = this._lastPressure === undefined
        ? ''
        : `- 上下文压力：${Math.round(this._lastPressure * 100)}%\n`
      const header = [
        '# 上下文总结 checkpoint（dsh-context-compactor）',
        '',
        `- 时间：${new Date().toISOString()}`,
        `- 会话：${agent.session.id}`,
        pressureLine.trim().length > 0 ? pressureLine.trim() : '',
        '',
        '该文件与会话日志中的 compaction/summary 事件及 checkpoint 节点内容一致；',
        '完整可回放记录仍保存在会话日志里。',
        '',
        '---',
        '',
      ].join('\n')
      writeFileSync(file, header + text + '\n', 'utf8')
      this.ctx.logger.info(`detailed compaction summary saved: ${file}`)
    } catch (error) {
      this.ctx.logger.warn(
        `failed to save detailed compaction summary file: `
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }

  /**
   * 补丁 4：裁剪工具结果 + 截断追踪。
   * 复用宿主 ToolResultPruner，并把每次被裁剪的结果记为截断记录。
   * @param session - 待裁剪会话。
   * @returns 原始 PruneResult（可为 undefined）。
   */
  _pruneAndTrack(session) {
    const prune = this.ctx.get('toolResultPruner')
    if (prune === undefined || typeof prune.pruneSession !== 'function') return undefined
    const result = prune.pruneSession(session)
    if (this._trackTruncations && result?.pruned && result.pruned.length > 0) {
      appendTruncationRecords(result.pruned.map((entry) => ({
        session_id: session.id,
        call_id: entry.callId,
        seq: entry.originalSeq,
        result_size: entry.charsBefore,
        pruned_size: entry.charsAfter,
      })))
    }
    return result
  }

  /**
   * 补丁 3：每日定时反思（scheduled_daily_reflection 的 DSH 形态）。
   * 非破坏性：对当前全部 surface 消息跑一遍「全局详细总结」，把提炼出的
   * 规律性认知【追加】写到 reflections/<session>.md，不改动对话历史。
   * 冷却期 / 最小新增 token 由宿主调度器（startReflectionScheduler）控制。
   * @param agent - 目标 agent（其 session 被总结）。
   * @param signal - 取消信号。
   * @returns summarize 结果，无消息时返回 null。
   */
  async reflect(agent, signal) {
    const session = agent.session
    const nodes = session.surface?.nodes
    if (!Array.isArray(nodes) || nodes.length === 0) return null
    const messages = nodes
      .map((seq) => session.deriveEventMessage(session.events[seq]))
      .filter((message) => message !== null)
    if (messages.length === 0) return null
    const header = session.requestHeader()
    const result = await this.summarize({
      ...header?.system === undefined ? {} : { system: header.system },
      ...header?.tools === undefined ? {} : { tools: header.tools },
      messages,
    }, agent, signal)
    const totalTokens = this.ctx.tokenMeter.measure(session).totalTokens
    this._writeReflectionFile(agent, result.summary, totalTokens)
    return result
  }

  _writeReflectionFile(agent, summary, totalTokens) {
    if (!this._reflectionsEnabled) return
    try {
      const text = summary.map((block) => block.text).join('\n')
      const base = join(pluginStorageDir(), 'reflections')
      mkdirSync(base, { recursive: true })
      const file = join(base, `${safeSegment(agent.session.id)}.md`)
      const block = [
        '',
        '---',
        `## 每日反思 ${new Date().toISOString()}`,
        '',
        `> 会话 ${agent.session.id} · 上下文约 ${totalTokens} tokens · 非破坏性全局摘要`,
        '',
        text,
        '',
      ].join('\n')
      writeFileSync(file, block, { flag: 'a', encoding: 'utf8' })
      this.ctx.logger.info(`scheduled reflection saved: ${file}`)
    } catch (error) {
      this.ctx.logger.warn(
        'failed to save reflection file: '
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }
}

/** 拒绝图像输出，只保留文本块；空总结直接失败（绝不拿空内容替换历史）。 */
function summaryText(blocks) {
  if (contentHasImage(blocks)) {
    const error = new Error('detailed compaction summary cannot contain image output')
    error.code = 'UNSUPPORTED_CONTENT'
    throw error
  }
  const text = blocks.filter((block) => block.type === 'text')
  if (!text.some((block) => block.text.trim().length > 0)) {
    throw new Error('detailed summarization produced no text summary content')
  }
  return text
}

function compactErrorText(error) {
  switch (error.code) {
    case 'busy': return '压缩暂时不可用：已有一个压缩在进行，或 agent 当前不空闲。稍后再试。'
    case 'cancelled': return '压缩已取消。'
    case 'changed': return '待压缩的历史在提交前发生了变化；对话未改动，本次尝试已记录在会话日志中，可重试。'
    case 'summary': return '没能生成有效总结；对话未改动，本次尝试已记录在会话日志中。'
    case 'commit': return '压缩提交未完整完成，部分历史可能已变化；请检查当前会话状态后再重试。'
    case 'persistence': return '压缩完成，但会话保存失败。'
    default: return `压缩失败：${error.message}`
  }
}

function registerCommands(ctx, cfg) {
  const active = new Set()

  const track = (handler) => (invocation) => {
    const operation = Promise.resolve().then(() => handler(invocation))
    active.add(operation)
    const retire = () => { active.delete(operation) }
    operation.then(retire, retire)
    return operation
  }

  // 进程内重复热激活时，同一命令可能已注册；幂等跳过。
  const safeRegister = (definition) => {
    try {
      return ctx.commands.register(definition)
    } catch (error) {
      if (String(error).includes('already registered')) {
        ctx.logger.info(`dsh-context-compactor: command "/${definition.name}" already registered, skipping`)
        return () => {}
      }
      throw error
    }
  }

  const compactHandler = async (invocation) => {
    if (invocation.rawInput.trim().length > 0) {
      return { kind: 'error', text: '用法：/compact（不带参数）' }
    }
    // 优先宿主级引擎（apply 时挂载，服务所有会话）；再回退可见的压缩服务。
    const engine = LIVE_ENGINES[0]
      ?? ctx.get('compaction')
      ?? invocation.agent?.ctx?.get?.('compaction')
    if (engine === undefined) {
      return { kind: 'error', text: '当前会话没有可用的压缩引擎。' }
    }
    try {
      const result = await engine.compactNow(
        invocation.agent,
        invocation.signal,
        invocation.commandId,
      )
      if (result === null) return { kind: 'success', text: '当前没有可压缩的历史。' }
      return {
        kind: 'success',
        text: `已【全局详细总结】并压缩 ${result.shadowedSeqs.length} 条历史（约 ${result.shadowedTokenCount} tokens）：`
          + '全部较早消息已被一个全局 checkpoint 节点替换，最近的对话尾巴保持不变。',
        sourceEventSeq: result.summarySeq,
      }
    } catch (error) {
      if (invocation.signal.aborted) return { kind: 'error', text: '压缩已取消。' }
      if (error instanceof ManualCompactionError) {
        return { kind: 'error', text: compactErrorText(error) }
      }
      throw error
    }
  }

  /** 提示词增强：把输入框草稿用 DSH 当前模型改写为更有效的提示词。 */
  const enhancePromptHandler = async (invocation) => {
    const trimmed = invocation.rawInput.trim()
    if (trimmed.length === 0) {
      return { kind: 'error', text: '用法：/enhance-prompt <草稿文本或 JSON {"text":"..."}>' }
    }
    let text = trimmed
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string') {
        text = parsed.text
      }
    } catch {}
    if (text.trim().length === 0) {
      return { kind: 'error', text: '请输入要增强的提示词。' }
    }

    try {
      const output = await enhanceText(ctx, invocation.agent.session, invocation.agent.options, text, invocation.signal)
      return { kind: 'success', text: output }
    } catch (error) {
      if (invocation.signal.aborted) return { kind: 'error', text: '增强已取消。' }
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  const statusHandler = async (invocation) => {
    const { agent, signal } = invocation
    const session = agent.session
    const routed = typeof session.requestHeader === 'function' ? session.requestHeader()?.config : undefined
    let target
    if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
      target = { provider: routed.provider, model: routed.model }
    } else if (
      typeof agent.options?.provider === 'string' && agent.options.provider.length > 0
      && typeof agent.options?.model === 'string' && agent.options.model.length > 0
    ) {
      target = { provider: agent.options.provider, model: agent.options.model }
    }

    const lines = []
    if (target === undefined) {
      lines.push('当前会话还没有可识别的路由模型。')
    } else {
      lines.push(`路由模型：${target.provider}/${target.model}`)
    }

    const meter = ctx.get('tokenMeter')
    if (meter === undefined) {
      return { kind: 'error', text: 'token 计量服务不可用。' }
    }
    const measurement = meter.measure(session)
    lines.push(`上下文估算：~${measurement.totalTokens} tokens（历史表面 ~${measurement.surfaceTokens} tokens）`)

    let contextWindow
    const llm = ctx.get('llm')
    if (target !== undefined && llm !== undefined) {
      try {
        const info = await llm.resolveModelInfo(target.provider, target.model, signal)
        const override = cfg.modelPolicies.find(
          (entry) => entry.provider === target.provider && entry.model === target.model,
        )?.contextWindow
        contextWindow = override ?? headerWindowHint(session) ?? info.context?.contextWindow
      } catch (error) {
        lines.push(`模型信息读取失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (contextWindow !== undefined) {
      // 阈值口径：per-model 策略 > settings 热更新 > 静态配置。
      const policyOverride = target === undefined
        ? undefined
        : cfg.modelPolicies.find(
          (entry) => entry.provider === target.provider && entry.model === target.model,
        )
      const ratio = policyOverride?.thresholdRatio ?? LIVE_KNOBS.thresholdRatio ?? cfg.thresholdRatio
      const thresholdTokens = Math.floor(contextWindow * ratio)
      const percent = Math.round((measurement.totalTokens / contextWindow) * 100)
      lines.push(`模型窗口：${contextWindow} tokens；自动压缩阈值：${thresholdTokens} tokens（${Math.round(ratio * 100)}%）`)
      lines.push(`当前用量：${percent}%`)
      if (measurement.totalTokens >= thresholdTokens) {
        lines.push('⚠️ 已达到 80% 压缩阈值：下一次 step 前会先对【全部较早历史】做全局详细总结，再压缩替换。')
      } else {
        lines.push(`距压缩阈值还有约 ${thresholdTokens - measurement.totalTokens} tokens。`)
      }
      if (measurement.totalTokens >= contextWindow) {
        lines.push('⚠️ 已超过模型窗口：若模型报 context length 错误，会先做全局详细总结压缩，再自动重试本轮请求。')
      }
    } else {
      lines.push('当前 provider 未报告上下文窗口大小，压力阈值不可计算；context-overflow 自动恢复仍然生效。')
    }
    lines.push('压缩保证：每次压缩后都会校验 token 必须实际下降；未下降会自动降低保留尾巴/总结预算继续压缩。')
    if (LIVE_KNOBS.compressPrompt !== undefined || cfg.compressPrompt.length > 0) {
      const source = LIVE_KNOBS.compressPrompt !== undefined ? 'settings 热更新版' : '静态配置'
      lines.push(`压缩指令：使用自定义 compressPrompt（${source}，长度 ${(LIVE_KNOBS.compressPrompt ?? cfg.compressPrompt).length} 字符）`)
    }
    if (cfg.liveSettings) {
      lines.push('热更新：thresholdRatio/retain/maxTokens/compressPrompt 已接入 settings namespace dsh-context-compactor，改动在下一次压缩前生效。')
    }
    if (cfg.saveSummaryFile) {
      lines.push(`总结保存：${summaryFilePath(agent.session.id)}`)
    }
    if (cfg.preserveLargeToolResults) {
      lines.push(`超大工具防丢：${join(pluginStorageDir(), 'preserved', safeSegment(agent.session.id))}`)
    }
    if (cfg.trackToolTruncations) {
      lines.push(`工具截断追踪：${truncationLogFile()}`)
    }
    if (cfg.scheduledReflection) {
      lines.push(
        `每日反思：每 ${cfg.scheduleIntervalHours}h 且新增 ≥${cfg.scheduleMinNewTokens} tokens 自动追加到 `
        + join(pluginStorageDir(), 'reflections', `${safeSegment(agent.session.id)}.md`),
      )
    }
    lines.push('手动压缩请输入：/compact')
    return { kind: 'success', text: lines.join('\n') }
  }

  /** 手动触发一次非破坏性每日反思摘要。 */
  const reflectHandler = async (invocation) => {
    if (invocation.rawInput.trim().length > 0) {
      return { kind: 'error', text: '用法：/reflect（不带参数）' }
    }
    const engine = LIVE_ENGINES[0]
      ?? ctx.get('compaction')
      ?? invocation.agent?.ctx?.get?.('compaction')
    if (engine === undefined || typeof engine.reflect !== 'function') {
      return { kind: 'error', text: '当前没有可用的反思引擎。' }
    }
    try {
      const result = await engine.reflect(invocation.agent, invocation.signal)
      if (result === null) return { kind: 'error', text: '当前会话还没有可总结的消息。' }
      return { kind: 'success', text: '已生成今日反思摘要并追加到 reflections/ 目录（不改动对话历史）。' }
    } catch (error) {
      if (invocation.signal.aborted) return { kind: 'error', text: '反思已取消。' }
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 查看最近被裁剪（截断）的工具结果记录。可选 <sessionId> 过滤。 */
  const truncationsHandler = async (invocation) => {
    const filter = invocation.rawInput.trim()
    const file = truncationLogFile()
    let lines
    try {
      if (!existsSync(file)) return { kind: 'success', text: '还没有工具截断记录。' }
      const raw = readFileSync(file, 'utf8').trim()
      if (raw.length === 0) return { kind: 'success', text: '还没有工具截断记录。' }
      const rows = raw.split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line) } catch { return null } })
        .filter((row) => row !== null)
        .filter((row) => filter.length === 0 || row.session_id === filter)
        .slice(-10)
      if (rows.length === 0) {
        return { kind: 'success', text: '没有匹配的工具截断记录。' }
      }
      lines = rows.map((row) =>
        `- ${row.tool_name} · seq ${row.seq} · call ${row.call_id} · ${row.result_size}→${row.pruned_size} chars · ${new Date(row.created_at * 1000).toISOString()}`)
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
    return {
      kind: 'success',
      text: '最近被截断的工具结果：\n' + lines.join('\n')
        + `\n\n完整日志：${file}\n提示：截断版本不完整，需要完整内容时请让 agent 用分块方式重新读取原工具输出。`,
    }
  }

  // 生成器 effect：先排空在途命令，再注册；随 owning fiber 卸载自动清理。
  ctx.effect(function* () {
    yield async () => { await Promise.allSettled(active) }
    yield safeRegister({
      name: 'compact',
      description: '全局总结并压缩较早的对话历史',
      handler: track(compactHandler),
    })
    yield safeRegister({
      name: 'enhance-prompt',
      description: '用当前模型增强输入框提示词',
      handler: track(enhancePromptHandler),
    })
    yield safeRegister({
      name: 'reflect',
      description: '手动生成一次非破坏性每日反思摘要并追加到 reflections/',
      handler: track(reflectHandler),
    })
    yield safeRegister({
      name: 'truncations',
      description: '查看最近被截断的工具结果记录（可带 <sessionId> 过滤）',
      handler: track(truncationsHandler),
    })
    yield safeRegister({
      name: 'context-status',
      description: '查看上下文 token 用量、压缩阈值与风险提示',
      handler: track(statusHandler),
    })
  }, 'dsh-context-compactor commands')
}

/**
 * 补丁 3：每日定时反思调度器。
 * 每 scheduleCheckMinutes 扫一次所有活跃 agent；对满足「冷却期 ≥
 * scheduleIntervalHours 且 自上次反思以来新增 tokens ≥ scheduleMinNewTokens」
 * 的空闲会话，在 agent.runMaintenance 内非破坏性地跑一次全局反思摘要。
 * 反思状态持久化到 reflect-state.json，重建重启后节流不重置。
 */
function startReflectionScheduler(ctx, cfg) {
  const state = loadReflectState()
  let running = false
  const cooldownMs = cfg.scheduleIntervalHours * 3600 * 1000
  const tick = async () => {
    if (running) return
    running = true
    try {
      const engine = ctx.get('compaction')
      if (engine === undefined || typeof engine.reflect !== 'function') return
      const agentsSvc = ctx.get('agents')
      const agents = agentsSvc !== undefined && typeof agentsSvc.list === 'function'
        ? agentsSvc.list()
        : []
      const now = Date.now()
      const touched = []
      for (const agent of agents) {
        const session = agent?.session
        if (session === undefined) continue
        const record = state[session.id]
        if (now - (record?.at ?? 0) < cooldownMs) continue
        let total = 0
        try {
          total = ctx.get('tokenMeter')?.measure(session)?.totalTokens ?? 0
        } catch { /* session may be mid-evolution */ }
        if (total - (record?.tokens ?? 0) < cfg.scheduleMinNewTokens) continue
        try {
          if (typeof agent.runMaintenance === 'function') {
            await agent.runMaintenance(async (signal) => {
              await engine.reflect(agent, signal)
            })
          } else {
            await engine.reflect(agent, undefined)
          }
          state[session.id] = { at: Date.now(), tokens: total }
          touched.push(session.id)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // busy = agent 正忙，下个节拍再试；aborted 说明任务被取消。
          if (!message.includes('busy') && !(agent.signal?.aborted ?? false)) {
            ctx.logger.warn(
              `dsh-context-compactor: scheduled reflection skipped (${session.id}): ${message}`,
            )
          }
        }
      }
      if (touched.length > 0) saveReflectState(state)
    } finally {
      running = false
    }
  }
  ctx.effect(() => {
    const interval = setInterval(() => { void tick() }, cfg.scheduleCheckMinutes * 60 * 1000)
    const initial = setTimeout(() => { void tick() }, 15 * 1000)
    return () => { clearInterval(interval); clearTimeout(initial) }
  }, 'dsh-context-compactor scheduled reflection')
}

/**
 * 热更新设置（借鉴 dsh-search 的 settings.register + watch 模式）：
 * 注册 settings namespace `dsh-context-compactor`，暴露 thresholdRatio /
 * retainRatio / retainTokens / maxTokens / compressPrompt 五个运行时可调项。
 * watch 到变化只写 LIVE_KNOBS 并置 dirty，真正生效在引擎下一次压力检查前
 * （_syncLiveKnobs），因此改完设置立刻对下一次压缩生效，无需重启。
 * settings 服务或 schemastery 不可用时静默降级：仅打日志，静态配置照常工作。
 */
function installLiveSettings(ctx, cfg) {
  ctx.inject(['settings'], (sctx) => {
    void Promise.resolve().then(async () => {
      try {
        const settings = sctx?.settings ?? sctx
        if (settings === undefined || typeof settings.register !== 'function') {
          ctx.logger.info('dsh-context-compactor: settings service unavailable; live settings disabled')
          return
        }
        const mod = await import('@deepseek-ai/schemastery').catch(() => undefined)
        const z = mod?.default ?? mod
        if (z === undefined || typeof z.object !== 'function') {
          ctx.logger.info('dsh-context-compactor: schemastery unavailable; live settings disabled (static config still effective)')
          return
        }
        const LiveConfig = z.object({
          thresholdRatio: z.number().min(0.01).max(0.99)
            .description('自动压缩阈值（上下文用量占比 0-1）'),
          retainRatio: z.number().min(0.01).max(0.99)
            .description('压缩后保留尾部历史比例；retainTokens 大于 0 时被忽略'),
          retainTokens: z.number().min(0)
            .description('压缩后保留尾部 tokens；大于 0 时优先于 retainRatio'),
          maxTokens: z.number().min(256)
            .description('总结输出 token 预算'),
          compressPrompt: z.string()
            .description('自定义压缩指令；留空使用内置中文 checkpoint 模板'),
        })
        const registered = settings.register('dsh-context-compactor', LiveConfig, {
          base: {
            thresholdRatio: cfg.thresholdRatio,
            retainRatio: cfg.retainRatio,
            retainTokens: cfg.retainTokens,
            maxTokens: cfg.maxTokens,
            compressPrompt: cfg.compressPrompt,
          },
        })
        registered.watch(() => {
          try {
            const value = registered.get()
            if (value !== undefined) applyLiveKnobs(value)
          } catch (error) {
            ctx.logger.warn(
              'dsh-context-compactor: failed to read live settings: '
              + (error instanceof Error ? error.message : String(error)),
            )
          }
        })
        ctx.logger.info(
          'dsh-context-compactor: live settings namespace registered (dsh-context-compactor) '
          + '— threshold/retain/maxTokens/compressPrompt hot-reload before each pressure check',
        )
      } catch (error) {
        ctx.logger.warn(
          'dsh-context-compactor: live settings unavailable: '
          + (error instanceof Error ? error.message : String(error)),
        )
      }
    })
  })
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) {
    ctx.logger.info('dsh-context-compactor: disabled by config')
    return
  }

  // 宿主级单引擎：在 apply 时挂载（不依赖 agent/created 事件，也不做 per-agent
  // isolate）。引擎本身是 agent 无关的，一个引擎即可服务所有会话的自动压缩与
  // 手动 /compact。监听器在宿主 root 注册（无 scope tag → 全局接收所有 agent 事件）。
  // 若宿主已经有 toolResultPruner / compaction 服务（例如 dsh-base 装配了），
  // 直接复用，避免“服务已注册”冲突。
  let prunerReady = Promise.resolve()
  if (cfg.pruneToolResults && ctx.get('toolResultPruner') === undefined) {
    try {
      prunerReady = Promise.resolve(ctx.plugin(ToolResultPruner, {
        thresholdChars: cfg.pruneThresholdChars,
        headChars: cfg.pruneHeadChars,
        tailChars: cfg.pruneTailChars,
      })).catch((error) => {
        ctx.logger.warn(
          'dsh-context-compactor: failed to mount tool-result pruner: '
          + (error instanceof Error ? error.message : String(error)),
        )
      })
    } catch (error) {
      ctx.logger.warn(
        'dsh-context-compactor: failed to mount tool-result pruner: '
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }

  if (cfg.auto) {
    // 宿主已有 compaction 服务则直接复用（例如某个 preset/宿主装配了引擎）。
    const existing = ctx.get('compaction')
    if (existing !== undefined) {
      if (!LIVE_ENGINES.includes(existing)) LIVE_ENGINES.push(existing)
      ctx.logger.info('dsh-context-compactor: reusing existing host compaction engine')
    } else {
      void prunerReady.then(() => {
        try {
          const engineFiber = ctx.plugin(DetailedCompactionEngine, engineConfig(cfg))
          void Promise.resolve(engineFiber).then(() => {
            const engine = ctx.get('compaction')
            if (engine !== undefined && !LIVE_ENGINES.includes(engine)) {
              LIVE_ENGINES.push(engine)
            }
            ctx.logger.info(
              'dsh-context-compactor: host-level detailed compaction engine ready '
              + `(threshold ${cfg.thresholdRatio}, overflow retries ${cfg.maxOverflowRetries})`,
            )
          }).catch((error) => {
            ctx.logger.warn(
              'dsh-context-compactor: host-level engine failed to load: '
              + (error instanceof Error ? error.message : String(error)),
            )
          })
        } catch (error) {
          ctx.logger.warn(
            'dsh-context-compactor: failed to start host-level engine: '
            + (error instanceof Error ? error.message : String(error)),
          )
        }
      })
    }
  }

  if (cfg.registerCommands) {
    // commands 服务可用时立即注册；还没起来就等它注入。
    ctx.inject(['commands'], (cmdCtx) => {
      registerCommands(cmdCtx, cfg)
    })
  }

  // 补丁 3：每日定时反思调度器（需要 auto 引擎提供 reflect）。
  if (cfg.scheduledReflection && cfg.auto) {
    startReflectionScheduler(ctx, cfg)
  }

  // 专用 HTTP 接口：提示增强结果只回给前端，不写入会话日志/对话。
  registerEnhanceRoute(ctx)

  // 热更新设置：settings namespace 可调 threshold/retain/maxTokens/compressPrompt。
  if (cfg.liveSettings) {
    installLiveSettings(ctx, cfg)
  }

  ctx.logger.info(
    'dsh-context-compactor: enabled '
    + `(auto=${cfg.auto}, thresholdRatio=${cfg.thresholdRatio}, maxTokens=${cfg.maxTokens}, `
    + `saveSummaryFile=${cfg.saveSummaryFile}, pruneToolResults=${cfg.pruneToolResults}, `
    + `preserveLarge=${cfg.preserveLargeToolResults}, reflect=${cfg.scheduledReflection}@${cfg.scheduleIntervalHours}h, `
    + `truncationTrack=${cfg.trackToolTruncations}, pressureAware=${cfg.pressureAwareCompaction})`,
  )
}
