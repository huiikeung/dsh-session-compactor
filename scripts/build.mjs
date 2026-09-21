/**
 * dsh-context-compactor build:
 * 1. src/index.js → lib/index.js
 * 2. 在插件自己的 node_modules 下建 @deepseek-ai peer junction，
 *    指向当前激活 profile 的 node_modules（版本与 host 运行版本严格一致），
 *    保证运行时从插件真实路径也能解析依赖。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 编译产物
const libDir = join(root, 'lib')
mkdirSync(libDir, { recursive: true })
copyFileSync(join(root, 'src', 'index.js'), join(libDir, 'index.js'))
// 进程内热激活入口：唯一用途是被 dev_stage 工具以全新 URL 动态 import，
// 绕开 loader 对 lib/index.js 的陈旧模块缓存。
copyFileSync(join(root, 'src', 'index.js'), join(libDir, 'index.live.js'))

// 运行期 peer junction（可选）：优先 DSH_HOME，其次 ~/.dsh。
// 该步骤只为「独立 / dev_stage 热装配」时的模块解析服务；经 `dsh plugin add`
// 正常安装到 profile 时，import 由 pnpm 的 node_modules 直接解析，link 只是
// 冗余的便利。因此任何 peer 缺失或链接失败都只告警、绝不让安装失败。
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileNodeModules = join(dshHome, 'profiles', 'node_modules')
const peers = [
  'dsh-compaction',
  'dsh-compaction-basic',
  'dsh-compaction-tool-result-pruner',
  'dsh-llm',
  'schemastery', // 热更新 settings schema（动态 import，缺失时功能自动降级）
]
const linkRoot = join(root, 'node_modules', '@deepseek-ai')
let linked = 0
let linkWarnings = 0
try {
  mkdirSync(linkRoot, { recursive: true })
  for (const peer of peers) {
    const target = join(profileNodeModules, '@deepseek-ai', peer)
    if (!existsSync(join(target, 'package.json'))) {
      linkWarnings += 1
      console.warn(`build: (skip, optional) peer ${peer} not found at ${target}; package imports peer through profile node_modules`)
      continue
    }
    const link = join(linkRoot, peer)
    try {
      rmSync(link, { recursive: true, force: true })
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      linked += 1
      console.log(`build: linked ${peer} -> ${target}`)
    } catch (error) {
      linkWarnings += 1
      console.warn(
        `build: (skip, optional) failed to link ${peer}: `
        + (error instanceof Error ? error.message : String(error)),
      )
    }
  }
} catch {
  linkWarnings += 1
  console.warn('build: (skip, optional) peer linking step unavailable')
}
if (linked === 0 && linkWarnings > 0) {
  console.log('build: lib output is independent of peer linking (pnpm resolves peers at runtime)')
}

console.log('build: lib/index.js ready')

// 生成浏览器 client bundle（lib/client.js）
await import('./build-client.mjs')
