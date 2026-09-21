/**
 * 探针：用 MCP stdio 协议驱动 `headroom mcp serve`，验证握手 + 工具清单 + 实际压缩。
 * 用法：node probe-mcp.mjs
 */
import { spawn } from 'node:child_process'

const HR = process.env.HEADROOM_BIN || '/vol1/@appdata/deepseek.harness/headroom/venv/bin/headroom'
const child = spawn(HR, ['mcp', 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] })

let buf = ''
const pending = new Map()
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})
child.stderr.on('data', (d) => process.stderr.write('[headroom stderr] ' + d.toString()))

const send = (method, params) => new Promise((resolve, reject) => {
  const id = Math.floor(Math.random() * 1e6)
  pending.set(id, resolve)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  setTimeout(() => reject(new Error('timeout: ' + method)), 20000)
})

const fail = (m) => { console.log('FAIL', m); child.kill(); process.exit(1) }

try {
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-probe', version: '1.0.0' },
  })
  console.log('initialize →', init.result?.serverInfo?.name, init.result?.serverInfo?.version)
  if (!init.result) fail('initialize 没有返回 result')

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  const tools = await send('tools/list', {})
  const names = (tools.result?.tools ?? []).map((t) => t.name)
  console.log('工具清单 →', names.join(', '))
  const expected = ['headroom_compress', 'headroom_retrieve', 'headroom_stats']
  for (const n of expected) if (!names.includes(n)) fail('缺少工具 ' + n)

  // 用一个重复 JSON 数组当"大块工具输出"试压缩
  const rows = []
  for (let i = 0; i < 400; i++) {
    rows.push({ id: i, status: i === 137 ? 'ERROR' : 'ok', file: `src/mod${i % 40}/handler.ts`, bytes: 1000 + i, note: ' routine log line that repeats' })
  }
  const payload = JSON.stringify({ results: rows })
  console.log('原始长度 →', payload.length, '字符')

  const t0 = Date.now()
  const call = await send('tools/call', { name: 'headroom_compress', arguments: { content: payload } })
  const ms = Date.now() - t0
  const text = (call.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  console.log('压缩耗时 →', ms, 'ms')
  console.log('压缩返回（截断）→', text.slice(0, 400))
  if (!text) fail('压缩没有返回文本')
  const saved = /savings_percent"?\s*[:=]\s*([\d.]+)/.exec(text)
  console.log('节省比例 →', saved ? saved[1] + '%' : '（返回里没解析到，看上面的原始返回）')
  console.log('ALL PASS')
  child.kill()
  process.exit(0)
} catch (e) {
  fail(e.message)
}
