#!/usr/bin/env node
/**
 * dsh-session-compactor — 把 Headroom 的 MCP server 注册进 web profile。
 *
 * Headroom（github.com/headroomlabs-ai/headroom）是一个本地上下文压缩层：
 * SmartCrusher 压 JSON/工具输出、CodeCompressor 压代码，压完原文进本地 CCR 仓，
 * 模型可随时用 headroom_retrieve 取回。这里以 MCP 工具形式接进来，DSH 的
 * mcp-client 自己拉起 stdio 子进程，**不需要常驻服务**。
 *
 * 接法：在 <profile>/cordis.patch.yml 的 mcp-client insert 列表里加一条
 * mcp-headroom（和现有 mcp-playwright / mcp-context7 同款写法），command 用
 * venv 里的绝对路径（PATH 不继承，不能写 "headroom"）。
 *
 * 幂等；首次改写留 .bak。用法：node scripts/install-headroom-mcp.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = process.env.DSH_PROFILE_DIR
  || '/vol1/@appdata/deepseek.harness/dsh-data/profiles/web'
const PATCH = join(PROFILE, 'cordis.patch.yml')
const BACKUP = PATCH + '.dsh-session-compactor.bak'

const HR_HOME = process.env.HEADROOM_HOME || '/vol1/@appdata/deepseek.harness/headroom'
const HR_BIN = join(HR_HOME, 'venv', 'bin', 'headroom')

if (!existsSync(HR_BIN)) {
  console.error(`[dsh-session-compactor] headroom 二进制不在 ${HR_BIN}；先装：python3 -m venv ${HR_HOME}/venv && ${HR_HOME}/venv/bin/pip install "headroom-ai[mcp]"`)
  process.exit(1)
}

let yaml = readFileSync(PATCH, 'utf8')
if (yaml.includes('id: mcp-headroom')) {
  console.log('[dsh-session-compactor] mcp-headroom 已注册：', PATCH)
  process.exit(0)
}

// 锚点：mcp-context7 那一段的结尾（serverName: context7 / transport: stdio），
// 在它后面插入同级的 mcp-headroom 段。缩进与既有条目一致（insert 列表项 4 空格）。
const anchor = [
  '        serverName: context7',
  '        transport: stdio',
].join('\n')
if (!yaml.includes(anchor)) {
  console.error('[dsh-session-compactor] cordis.patch.yml 里找不到 mcp-context7 锚点（文件被改过？）；未改动。')
  process.exit(1)
}

const entry = [
  anchor,
  '    - id: mcp-headroom',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        # Headroom 上下文压缩（MCP 工具形态，无常驻进程）',
  '        # command 必须用绝对路径：mcp-client 的子进程 env 是清洗过的，PATH 不继承',
  `        command: ${HR_BIN}`,
  '        args:',
  '            - mcp',
  '            - serve',
  '        env:',
  '            # 关掉默认开启的匿名用量上报；配置与 CCR/统计等读写状态都落到 app 数据',
  '            # 目录，不往 /root/.headroom 写（paths.py：CONFIG=只读配置，WORKSPACE=读写状态）',
  '            HEADROOM_BEACON: "off"',
  `            HEADROOM_CONFIG_DIR: "${HR_HOME}/config"`,
  `            HEADROOM_WORKSPACE_DIR: "${HR_HOME}/workspace"`,
  '        serverName: headroom',
  '        transport: stdio',
].join('\n')

if (!existsSync(BACKUP)) copyFileSync(PATCH, BACKUP)
writeFileSync(PATCH, yaml.replace(anchor, entry))
console.log('[dsh-session-compactor] mcp-headroom 已写入：', PATCH)
console.log('  备份：', BACKUP)
console.log('  重启 dsh 后生效（服务端 patch 层改动）。')
