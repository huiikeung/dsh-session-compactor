/**
 * 生成浏览器 client bundle：lib/client.js。
 * 格式与官方 tsdown clientBundle 产物一致：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 * 源码为 CJS 形态，react / primitives 通过模块表的 require 解析。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_ID = 'dsh-session-compactor'

const source = readFileSync(join(root, 'src', 'client', 'index.cjs'), 'utf8')

/**
 * 把 host 半边内置的默认压缩指令（src/index.js 的 DETAIL_SUMMARY_INSTRUCTION）在构建时
 * 注入 client bundle，设置页的 compressPrompt 输入框用它当灰色 placeholder。
 * 单一事实来源：改默认模板只改 src/index.js，客户端自动跟着变，不会两份漂移。
 * 客户端用 `typeof DEFAULT_COMPRESS_PROMPT === 'string'` 兜底，所以裸源码在测试里也能跑。
 */
function readDefaultCompressPrompt() {
  const host = readFileSync(join(root, 'src', 'index.js'), 'utf8')
  const matched = /const DETAIL_SUMMARY_INSTRUCTION = (\[[\s\S]*?\])\.join\('\\n'\)/.exec(host)
  if (matched === null) throw new Error('build-client: DETAIL_SUMMARY_INSTRUCTION not found in src/index.js')
  const lines = new Function(`return (${matched[1]})`)()
  if (!Array.isArray(lines)) throw new Error('build-client: DETAIL_SUMMARY_INSTRUCTION is not an array literal')
  return lines.join('\n')
}

const injected = `const DEFAULT_COMPRESS_PROMPT = ${JSON.stringify(readDefaultCompressPrompt())};\n`

const bundle = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
  '  var module = { exports: {} };',
  '  var exports = module.exports;',
  injected,
  source,
  '  return module.exports;',
  '} });',
  '',
].join('\n')

const outDir = join(root, 'lib')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'client.js'), bundle, 'utf8')
// 保持 lib/client.js 与 src 同步副本（便于直接查改）。
console.log('build: lib/client.js ready')
