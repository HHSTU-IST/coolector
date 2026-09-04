// 一键启动「本机当接收端 + 公网发送方」。
// 用法：node scripts/receiver.mjs
// 流程：起 Relay 隧道(8787) → 写 .env 的 VITE_RELAY_URL → pnpm start(web+relay) → 起 Web 隧道(5174) → 打印汇总。
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = join(ROOT, '.env')
const STATUS_PATH = join(ROOT, 'scripts', '.receiver-runtime.json')

const RELAY_PORT = process.env.PORT ?? '8787'
const APP_PORT = process.env.APP_PORT ?? '5174'

const children = []
let shuttingDown = false

function log(msg) {
  process.stdout.write(`[receiver] ${msg}\n`)
}

function findTunnelUrl(chunk) {
  const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
  return m ? m[0] : null
}

function updateEnvRelayUrl(url) {
  let text = readFileSync(ENV_PATH, 'utf8')
  const lines = text.split(/\r?\n/)
  let found = false
  const out = lines.map((line) => {
    if (/^VITE_RELAY_URL=/.test(line)) {
      found = true
      return `VITE_RELAY_URL=${url}`
    }
    return line
  })
  if (!found) out.push(`VITE_RELAY_URL=${url}`)
  writeFileSync(ENV_PATH, out.join('\n'))
  log(`已写入 .env: VITE_RELAY_URL=${url}`)
}

function startTunnel(port, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'cloudflared',
      ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    children.push(child)
    let done = false
    const finish = (err, value) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      err ? reject(err) : resolve(value)
    }
    const timeout = setTimeout(() => finish(new Error(`${label} 隧道 ${port} 超时未返回 URL`)), 40000)

    const scan = (chunk) => {
      const url = findTunnelUrl(chunk)
      if (url) finish(null, { child, url })
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', (d) => {
      scan(d)
      const t = String(d).trim()
      if (t) log(`[${label}] ${t}`)
    })
    child.on('error', (err) => finish(err))
    child.on('exit', (code) => {
      if (!shuttingDown) finish(new Error(`${label} 隧道 ${port} 提前退出 code=${code}`))
    })
  })
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  log('正在关闭所有子进程…')
  for (const c of children) {
    try { c.kill('SIGTERM') } catch {}
  }
  setTimeout(() => process.exit(0), 800)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

async function main() {
  log(`Relay 端口 ${RELAY_PORT} · 前端端口 ${APP_PORT}`)

  const { url: relayUrl } = await startTunnel(RELAY_PORT, 'relay')
  log(`Relay 公网地址: ${relayUrl}`)

  updateEnvRelayUrl(relayUrl)

  log('启动 pnpm start（web + relay）…')
  const pnpm = spawn('pnpm', ['start'], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  children.push(pnpm)

  // 等 Vite dev server 就绪后再起 Web 隧道
  await new Promise((r) => setTimeout(r, 3500))

  const { url: webUrl } = await startTunnel(APP_PORT, 'web')

  const summary = {
    relayUrl,
    webUrl,
    receiverLocal: `http://localhost:${APP_PORT}`,
    roomId: 'demo-room'
  }
  writeFileSync(STATUS_PATH, JSON.stringify(summary, null, 2) + '\n')

  log('==============================================')
  log('接收端已就绪')
  log(`Relay 公网地址 : ${relayUrl}`)
  log(`发送方地址     : ${webUrl}`)
  log(`本机接收端     : http://localhost:${APP_PORT}`)
  log(`房间 ID        : demo-room`)
  log('按 Ctrl+C 停止（关闭两条隧道与本地服务）')
  log('==============================================')
}

main().catch((err) => {
  log(`启动失败: ${err.message}`)
  shutdown()
})
