# dsh-context-compactor

开箱即用的 **上下文压缩 / 上下文总结** 插件。它把 DSH 官方 `dsh-compaction-basic`
压缩引擎 + 工具结果裁剪器一次性装配进 profile，解决「对话满了不会自动压缩、模型
直接报 `maximum context length` 导致本轮失败」的问题。

## 功能

### 1. 80% 自动触发（总结最优先 + 压缩后验）

- 通过 `ctx.tokenMeter` 估算当前会话 token 用量；
- 达到模型窗口 **80%**（`thresholdRatio` 默认 0.8）时，下一步前**自动先做详细总结**：
  把全部较早历史用 LLM 压缩成一份详尽中文 checkpoint，替换旧消息，只保留最近
  `retainRatio`（默认 16%）的原样尾巴；
- 本引擎的监听器以 **prepend** 注册，会抢在任何 preset 默认压缩引擎之前执行，
  保证“总结最优先”且用的是详细版总结；
- 压缩前后都有会话日志事件（`compaction/start`、`compaction/summary`、`compaction/end`）。

### 1.5 硬性保证：压缩必须真的变小

- **每次压缩都会做 before/after 校验**：压缩后 `totalTokens` 必须**严格小于**压缩前；
- 自动压缩：
  - 目标 = 低于 80% 阈值（所以 80% → 必须 < 80%，不是“压完还是 80%”）；
  - overflow 恢复：目标 = 低于压缩前；
  - 若第一次没达标，会自动**逐级降保留尾巴**（16% → 8% → 4% → 0%）并
    **逐级降总结预算**（12288 → 6144 → 3072 → 1024）反复压缩全部较早历史；
- 手动 `/compact`（包括按钮）：同样做 before/after 校验；若总结反而变大，
  自动降低总结预算重试，最多 4 次；仍不能下降就明确报错，绝不“假压缩”；
- 日志会打印 `before → after tokens（xx% reduced）`，方便确认真的压缩了。

### 1.6 真实上下文窗口（modlens / 第三方 provider 适配）

- 部分 provider（如 `modlens-qwen`）会向 DSH 上报一个很大的 `contextWindow`
  （例如 1,000,000），但真实可用窗口只有 256k。这会导致阈值算错、永远“不到 80%”。
- 插件现在的窗口解析顺序：
  1. `modelPolicies[].contextWindow`（显式覆盖，最优先）；
  2. 会话请求头里 ≥100k 的 `maxTokens`（视为真实窗口兜底，如 256000）；
  3. 适配器上报的 `contextWindow`（最后回退）。
- 需要手动指定时，在 profile 的插件 config 里加：

```yaml
modelPolicies:
  - provider: modlens-qwen
    model: DeepSeek-V4-Flash-0731
    contextWindow: 262144   # 按真实窗口填
    thresholdRatio: 0.8
```

### 2. 全局详细总结 + 双份保存

- **全局，不是只压一段**：每次触发都把“全部较早历史”（从最早消息到保留尾巴之前）
  一次性做成一个全局 checkpoint；若历史里已有旧 checkpoint，会与本次新消息
  **全局合并**——仍然成立的事实保留，已解决/过时的删除，相同内容只保留一份。
- 总结严格按保留/删除策略执行：
  - **必须保留**：① 核心任务与当前进度 ② 关键决策及理由 ③ 待解决问题
    ④ 重要文件或代码位置（精确路径/函数/类位置，必要时保留简短关键片段）；
  - **必须删除**：详细调试过程（只留结论）、已解决的错误（不保留报错原文与排查过程）、
    客套话与所有重复内容。
- **保存 1**：会话日志持久化 checkpoint 节点（可回放）；
- **保存 2**：额外写 Markdown 到
  `~/.dsh/storages/dsh-context-compactor/summaries/<session-id>.md`（默认开启，
  可关 `saveSummaryFile: false`）；
- 总结调用生成上限默认 `maxTokens: 12288`（详细预算，可调大）。

### 3. context-overflow 自动恢复（专治 context length 报错）

- provider 明确报上下文超限时，先详细总结压缩，再自动 **retry 本轮请求**；
- 默认最多连续恢复 `maxOverflowRetries` 次。

### 4. 超大工具结果裁剪（辅助手段，不替代总结）

- 超过 `pruneThresholdChars`（默认 8192 字符）的工具输出，保留头 + 标记 + 尾；
- 只裁剪工具结果文本，**对话历史一律走详细总结**，绝不粗暴截断。

### 5. 输入框下方：官方「上下文用量」圆环即触发器（0.6.5 起）

- 浏览器半边通过 `dsh.client` 清单自动发现，注册到 `conversation.composer.dock`
  （输入框**下方**那一行，和官方 ContextMeter 圆环同一排）；
- **默认不占任何位置**：插件不再显示自己的胶囊/ meter，只保留官方的
  「上下文用量」圆环（`contextPressure` 投影，到 80% 官方会自行高亮）；
- **点击圆环**即在它**右侧**展开操作条（DOM 顺序在圆环之前，用 CSS `order` 换序）：
  - 「压缩总结」：点击通过 `remote.commands.execute(sessionId, '/compact')`
    立即触发全局详细总结压缩，按钮会显示「压缩总结中…」并在条上回显结果；
  - 「提示增强」：这是合并自 [LLM-Prompt-Enhancer](https://github.com/RunOnCodes/LLM-Prompt-Enhancer)
    的功能，点击读取输入框草稿，调用 DSH 当前模型增强为更清晰的提示词，
    自动写回输入框（无需额外 Groq Key）；按钮显示「增强中…」并在条上回显结果；
- 圆环自此只作本插件的触发器：官方自带的 breakdown 面板被拦截（同口径数据
  仍可用 `/context-status` 查看）；再点一次圆环或点页面别处即收起；
- agent 运行中按钮自动禁用；全新空白会话不显示。

### 5.1 设置页配置卡片（0.6.3 新增）

- 「设置 → 插件 → 上下文压缩」页可直接修改 `dsh-context-compactor`
  namespace 的 5 个压缩参数（压缩触发阈值 / 保留比例 / 保留 Token 数 /
  摘要最大 Token 数 / 压缩指令）；
- 保存即写入用户层并**热更新生效**（下一次压缩检查即采用新值），某项留空
  等同「恢复默认」（回落到 cordis 配置或内置模板）；
- 宿主为内存模式或插件服务端未加载时，卡片会显示「当前不可用」。

### 6. 手动命令

| 命令 | 作用 |
| --- | --- |
| `/compact` | 立即【全局详细总结】并把全部较早历史压缩成一个 checkpoint |
| `/enhance-prompt` | 用当前模型增强提示词（支持直接跟文本或 JSON `{"text":"..."}`） |
| `/context-status` | 查看 token 用量、窗口、80% 阈值、风险与总结保存路径 |

## 默认配置

```yaml
enabled: true
auto: true                      # 开启 80% 压力压缩 + overflow 自动恢复
thresholdRatio: 0.8             # 用量达到窗口 80% 触发【详细总结】压缩
retainRatio: 0.16               # 保留最近 16% 的原样对话
maxTokens: 12288                # 总结调用生成上限（详细预算）
compactionRetries: 1            # 一次压力压缩后仍超阈值时的追加尝试
maxOverflowRetries: 2           # context-overflow 恢复重试上限
saveSummaryFile: true           # 总结额外落盘到 ~/.dsh/storages/dsh-context-compactor/summaries/
pruneToolResults: true          # 只裁剪超大工具结果；对话历史一律走总结
pruneThresholdChars: 8192
pruneHeadChars: 4096
pruneTailChars: 1024
registerCommands: true
compressPrompt: ''              # 自定义压缩指令；留空用内置中文 checkpoint 模板
liveSettings: true              # 注册 settings namespace 支持热更新（见下）

# —— 《DSH 5 个补丁》整合功能默认开关 ——
preserveLargeToolResults: true  # 补丁1：超大工具结果压缩前落盘防丢
offloadThresholdChars: 204800   # 超过该字符数（默认 200KB）视为“长文本”
offloadChunkChars: 131072       # 落盘时按 128KB 分块
pressureAwareCompaction: true   # 补丁2：压力感知压缩深度（>0.9 自动压得更狠）
scheduledReflection: true       # 补丁3：每日定时反思（非破坏性全局摘要）
scheduleIntervalHours: 24       # 反思冷却期
scheduleCheckMinutes: 30        # 调度器节拍
scheduleMinNewTokens: 20000     # 自上次反思起新增 ≥20k tokens 才触发
trackToolTruncations: true      # 补丁4：工具截断追踪（写 truncations.jsonl）
```

也可以给指定模型写精确覆盖策略：

```yaml
modelPolicies:
  - provider: deepseek
    model: deepseek-chat
    thresholdRatio: 0.7
    retainRatio: 0.2
    maxOverflowRetries: 3
```

### 热更新设置（liveSettings，0.6.2 新增）

`liveSettings: true`（默认）时插件会注册 settings namespace **`dsh-context-compactor`**，暴露 5 个运行时可调项：

| 键 | 说明 |
| --- | --- |
| `thresholdRatio` | 自动压缩阈值（0.01–0.99） |
| `retainRatio` / `retainTokens` | 压缩后保留尾巴（`retainTokens > 0` 时优先） |
| `maxTokens` | 总结输出 token 预算 |
| `compressPrompt` | 自定义压缩指令；留空用内置中文 checkpoint 模板 |

生效机制借鉴 dsh-auxiliary 的 `syncEngineConfig` 模式：settings 变化只写入热更新表，引擎在**下一次压力检查前**把最新值合并进引擎配置 —— 设置页改完立即对下一次压缩生效，无需重启 DSH、无需重挂引擎。`retainRatio ≥ thresholdRatio` 的非法组合会被拒绝并保留旧策略。settings 服务或 schemastery 不可用时自动降级为 cordis.patch.yml 静态配置，行为与旧版一致。`/context-status` 会显示当前生效的阈值口径（per-model 策略 > 热更新 > 静态配置）与压缩指令来源。

## 整合自《DSH 5 个补丁》的功能

`docs/dsh_5个补丁_完整提取.md` 里记载了一套针对 DSH 记忆/上下文系统的 5 个补丁。
其中与本压缩插件直接相关、且能在 DSH 插件架构里安全落地的 4 项已整合进本插件：

| 补丁 | 原始思路 | 在本插件里的落地 |
| --- | --- | --- |
| 1 长文本防丢 | `add(prevent_compaction=True)` 分块保存超大文本，避免压缩/截断丢失 | 压缩前把 **>200KB 的超大工具结果**原样分块落盘到 `~/.dsh/storages/dsh-context-compactor/preserved/<session>/<seq>.<callId>.part-N.md`，磁盘保留索引，幂等防重复；完整原文绝不因 80% 压缩或工具裁剪而丢 |
| 2 压力感知 | `recall(context_pressure=…)` 高压少召回、低压多召回 | `compactIfNeeded` 计算上下文压力 `totalTokens/window`；压力 >0.9 时跳过最宽松总结预算、压缩得更狠；把压力写进日志与 checkpoint 文件头 |
| 3 每日定时反思 | `scheduled_daily_reflection()` 24h 冷却，定时把核心记忆总结存回 | 新增 `/reflect` 命令 + 后台调度器：非破坏性对全部消息跑「全局详细总结」，**追加**写 `reflections/<session>.md`；默认 24h 冷却 + 每会话新增 ≥20k tokens 才触发 |
| 4 工具截断追踪 | `record_tool_result` 表记录被截断的调用 | 每次 `ToolResultPruner.pruneSession` 后把被裁剪的结果写成一行 JSON（`tool_name/args_summary/result_size/was_truncated/created_at`）追加到 `truncations.jsonl`；`/truncations` 可查，发现 `result_size` 小于原始输出就应改用分块方式重读 |
| 5 实体提取降噪 | 过滤虚词、按上下文推断实体类型 | **本压缩插件不含知识图谱/实体提取**，此补丁针对独立的 `fragment_store` 记忆库，故未实现；如需可做成独立记忆插件 |

新增命令：

| 命令 | 作用 |
| --- | --- |
| `/reflect` | 立即生成一次非破坏性每日反思摘要并追加到 `reflections/` |
| `/truncations` | 查看最近被截断的工具结果（可带 `<sessionId>` 过滤） |

> 说明：补丁 2 的“上下文压力”沿用插件既有的 Token Meter (`ctx.tokenMeter`)，不改动
> 会话历史；补丁 3 的反思是**非破坏性**的——只生成摘要文件与日志，不像 80% 压缩那样
> 替换对话，因此可安全定时运行。

## 工作原理（与官方架构一致）

DSH 的 `dsh-web-app` 会禁用宿主层的压缩后端，压缩由每个 **agent preset** 决定。
本插件不跟宿主层抢位置：它监听 `agent/created`（并补扫已存活 agent），对没有压缩
引擎的 agent 在其 **agent scope 内用独立 `isolate`** 挂载 `compaction-basic` 和
`tool-result-pruner`——等价于官方 `standard` preset 里的

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate: { compaction: true, toolResultPruner: true }
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

因此：

- 每个 agent 一个独立槽位，不会抢占全局服务名；
- 即使 preset 自带默认引擎，本引擎的 prepend 监听器也会在自动压缩中**先执行**，
  保证“详细总结优先”；
- 引擎生命周期跟随 agent，agent 销毁即回收。

## 安装

本插件的正式包名是 `@dsh-external/dsh-context-compactor`，已声明
`dsh.bundle.patch`，因此用 `dsh plugin --profile <profile> add <spec>` 安装后会被
自动挂成该 profile 的 layer（写进 `dsh.profile.bundles`），无需再手工配置。

### 方式一：本地 tar 包（最直接）

先构建出可安装的 tgz（或直接用仓库根目录已生成的
`dsh-external-dsh-context-compactor-<version>.tgz`）：

```bash
cd /path/to/dsh-context-compactor
pnpm pack
# 输出：dsh-external-dsh-context-compactor-0.6.0.tgz
```

然后安装：

```bash
dsh plugin --profile web add /path/to/dsh-context-compactor/dsh-external-dsh-context-compactor-0.6.0.tgz
```

### 方式二：本地源码目录

```bash
dsh plugin --profile web add /path/to/dsh-context-compactor
```

### 方式三：Git（SSH / HTTPS）

```bash
dsh plugin --profile web add git+git@github.com:huiikeung/dsh-context-compactor.git
# 或 HTTPS：
dsh plugin --profile web add git+https://github.com/huiikeung/dsh-context-compactor.git
```

> Git/本地路径安装时，pnpm 会执行包的 `prepare` 脚本自动完成 `src → lib` 构建；
> tar 包安装则直接使用包内已构建好的 `lib/`。

### 安装后

1. **刷新 / 重启 DSH web**，让 profile 的 bundle 层装配并构建前端；
2. 输入框下方官方「上下文用量」圆环保持不变，点击圆环即在它右侧展开「压缩总结」「提示增强」；
3. 输入 `/context-status` 查看 token 用量与阈值，`/reflect`、`/truncations`、
   `/compact` 等命令即可用。

### 撤销安装

```bash
dsh plugin --profile web remove @dsh-external/dsh-context-compactor
```

### 手动 / 开发模式（可选，非必须）

如果只是在本仓库里直接开发调试，不需要走 `dsh plugin add`：

```bash
# 1. 构建（host: src → lib/index.js；client: src/client → lib/client.js）
bash scripts/build.sh

# 2. 加入 profile（写入 dependencies + bundles，重启后自动装配）

# 3. 热装配（当前进程立即生效）
#    dev_install_package / dev_inject_plugin 指向本目录
#    若遇到 loader 模块缓存中毒，重启 DSH 即可（bundle 路径不依赖热装配）。
```

## 说明

- 总结调用会优先复用当前会话实际路由的 provider/model；也可用
  `summarizationProvider` + `summarizationModel` 指定专门的总结模型。
- 单条消息本身就超过模型窗口时，任何表面压缩都无法修复——这种情况需要
  换更大窗口的模型或拆小输入。
