import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

// 先把根 .env 读进本进程：relay 子进程原本靠 --env-file 拿到令牌，
// 但编排器需要提前知道 RELAY_TOKEN 是否已配置，才能决定 relay 该绑到哪个地址。
const ENV_FILE = '.env'
if (existsSync(ENV_FILE) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(ENV_FILE)
  } catch {
    // .env 格式异常时不在此阻断，交由 relay 子进程报错
  }
}

const hasRelayToken = Boolean((process.env.RELAY_TOKEN ?? '').trim())

const config = {
  appHost: process.env.APP_HOST ?? '0.0.0.0',
  appPort: process.env.APP_PORT ?? '5174',
  // relay 的 fail-closed 检查（非回环 + 无令牌 → 拒绝启动）与硬编码 0.0.0.0 组合，
  // 会让新克隆仓库的 `pnpm start` 两个进程全灭。未配置令牌时回退回环地址。
  relayHost: process.env.HOST ?? process.env.RELAY_HOST ?? (hasRelayToken ? '0.0.0.0' : '127.0.0.1'),
  relayPort: process.env.PORT ?? process.env.RELAY_PORT ?? '8787'
}

const processes = []
let isShuttingDown = false

function startProcess(name, command, args, env = {}, options = {}) {
  const child = spawn(command, args, {
    env: {
      ...process.env,
      ...env
    },
    stdio: 'inherit',
    ...options
  })

  processes.push({ name, child })

  child.on('exit', (code, signal) => {
    if (isShuttingDown) return

    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`
    console.error(`[start] ${name} exited with ${reason}`)
    shutdown(code && code > 0 ? code : 1)
  })
}

function shutdown(exitCode = 0) {
  if (isShuttingDown) return
  isShuttingDown = true

  for (const { child } of processes) {
    if (!child.killed) {
      child.kill('SIGTERM')
    }
  }

  setTimeout(() => {
    process.exit(exitCode)
  }, 300).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log('[start] Coolector quick start')
console.log(`[start] Web app: http://localhost:${config.appPort}`)
console.log(`[start] Relay:   http://localhost:${config.relayPort}`)
if (!hasRelayToken) {
  console.log('[start] 未检测到 RELAY_TOKEN，relay 仅监听回环地址（127.0.0.1）。')
  console.log('[start] 需要对公网提供服务时，请在 .env 中设置 RELAY_TOKEN，relay 将自动监听 0.0.0.0。')
}

// Windows 下 pnpm 实际是 pnpm.cmd，需经 shell 解析才能启动
startProcess(
  'web app',
  'pnpm',
  ['exec', 'vite', '--host', config.appHost, '--port', config.appPort],
  {},
  { shell: process.platform === 'win32' }
)

// 存在根 .env 时用 Node 原生 --env-file 注入 Relay（RELAY_* 由 Relay 读，VITE_* 由 Vite 自读）
const relayArgs = ['server/relay-server.js']
if (existsSync('.env')) {
  relayArgs.unshift('--env-file=.env')
}

startProcess('relay server', 'node', relayArgs, {
  HOST: config.relayHost,
  PORT: config.relayPort
})
