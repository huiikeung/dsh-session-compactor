#!/usr/bin/env node
/**
 * dsh-context-compactor — pin the sidebar icon for the 「上下文压缩」 settings section.
 *
 * DSH renders settings-section nav glyphs through a hard-coded id→icon map
 * (`navIcon(id)` in @deepseek-ai/dsh-client-ui-settings-general). The
 * `settings.section` slot contract carries no icon field, so every third-party
 * section (ours included) falls back to the generic settings gear. The only way
 * to get a real 「压缩」 glyph is this tiny core patch — same approach the
 * dsh-search plugin uses for its 联网搜索 section (web-tools → globe).
 *
 * ⚠️ 已被**运行时 Pin** 取代：`src/client/index.cjs` 的 `pinNavGlyph()` 在浏览器里
 * 按导航标签找到自己的 cell、原地换 svg 几何，DSH 升级 / pnpm install / 别的插件装卸
 * 补丁都冲不掉（本目录下 `.dsh-*.bak` 的历任补丁就是这么丢的）。本脚本保留仅作回退：
 * 只有在运行时 Pin 因外壳结构变动失效时，才需要跑它，并且跑完仍要刷新页面。
 *
 * Idempotent; writes a `.dsh-context-compactor.bak` next to the file on first
 * patch. Re-run after every DSH runtime update.
 *
 * Usage: node scripts/patch-sidebar-icon.mjs
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SECTION_ID = 'context-compactor'
const BACKUP_SUFFIX = '.dsh-context-compactor.bak'

const candidates = [
  process.env.DSH_RUNTIME && join(process.env.DSH_RUNTIME, 'node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js'),
  // fnOS app layout on this machine
  '/vol1/@appdata/deepseek.harness/dsh-runtime/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js',
  join(homedir(), '.dsh', 'runtime', 'node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js'),
].filter(Boolean)

const target = candidates.find((p) => existsSync(p))
if (!target) {
  console.error('[dsh-context-compactor] settings-general client bundle not found; set DSH_RUNTIME and re-run.')
  process.exit(1)
}

let source = readFileSync(target, 'utf8')
if (source.includes(`id === "${SECTION_ID}"`)) {
  console.log('[dsh-context-compactor] sidebar icon patch already present:', target)
  process.exit(0)
}

// The gear fallback is the anchor; our branch goes right in front of it so it
// coexists with the patches other plugins applied to the same function.
const anchor = [
  '\t\t\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutline16, {',
  '\t\t\t\tclassName: SettingsRoot_module_css_default.navIcon,',
  '\t\t\t\tsize: 16',
  '\t\t\t});',
  '\t\t}',
].join('\n')

if (!source.includes(anchor)) {
  console.error('[dsh-context-compactor] navIcon anchor not found (DSH bundle changed?); patch NOT applied.')
  process.exit(1)
}

// IconCompactOutline16 = 圆环 + 弧线，和「上下文用量」圆环同源，最贴近「上下文压缩」。
const branch = [
  `\t\t\tif (id === "${SECTION_ID}") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCompactOutline16, {`,
  '\t\t\t\tclassName: SettingsRoot_module_css_default.navIcon,',
  '\t\t\t\tsize: 16',
  '\t\t\t});',
].join('\n')

if (!existsSync(target + BACKUP_SUFFIX)) copyFileSync(target, target + BACKUP_SUFFIX)
writeFileSync(target, source.replace(anchor, branch + '\n' + anchor))
console.log(`[dsh-context-compactor] sidebar icon patched: ${SECTION_ID} → IconCompactOutline16 in`, target)
