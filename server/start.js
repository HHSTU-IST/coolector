import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isBindableHost, isLoopbackHost, parsePositiveInt } from './relay-utils.js'

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

// ⚠️ 这里必须忽略 .env 里的 HOST。
// `process.loadEnvFile` 会把文件值写进 `process.env`，而 `.env.example` 恰好带
// `HOST=0.0.0.0` —— 于是 `process.env.HOST ?? '127.0.0.1'` 的回退分支**永远走不到**，
// relay 仍会因 fail-closed 拒绝启动、整栈全灭。故未配置令牌时**强制**回环。
const requestedRelayHost = process.env.RELAY_HOST ?? process.env.HOST ?? null
const relayHostForcedLoopback = !hasRelayToken && Boolean(requestedRelayHost) && !isLoopbackHost(requestedRelayHost)

// ── 唯一需要在本文件校验 env 的两项：它们会被拼进一条 shell 命令行 ──────────────
//
// `pnpm exec vite --host <host> --port <port>` 是一条交给 shell 解析的**字符串**。
// Node 的 `shell: true` 只做拼接、不做转义（DEP0190 警告讲的就是这件事），因此这两个值
// 直接落进 shell 语法：`APP_PORT=5174 & calc` 会执行第二条命令。
//
// 选择「白名单校验」而不是「加引号」，是因为合法字面量可穷举、而正确转义跨 shell 不通用
// （cmd 的 `^` 与 sh 的 `\` 不共享语义，嵌套引号在 `cmd /c "..."` 里还会被剥一层）。
//
// ⚠️ 本文件**只需**校验这两项：HOST / PORT / RELAY_* 都是通过 `env` 传给
// `server/relay-server.js` 子进程的，不经 shell，由 relay-config.js 自行 fail-closed 校验。
const appPortResult = parsePositiveInt(process.env.APP_PORT, { fallback: 5174, max: 65535 })
if (!appPortResult.ok) {
  console.error(`[start] 拒绝启动：APP_PORT 必须是 1–65535 之间的整数，当前值为 ${JSON.stringify(appPortResult.raw)}。`)
  process.exit(1)
}

const appHost = (process.env.APP_HOST ?? '0.0.0.0').trim()
if (!isBindableHost(appHost)) {
  console.error(`[start] 拒绝启动：APP_HOST 必须是主机名或 IP 字面量（如 0.0.0.0 / 127.0.0.1 / ::1），当前值为 ${JSON.stringify(process.env.APP_HOST ?? '')}。`)
  process.exit(1)
}

const config = {
  appHost,
  appPort: appPortResult.value,
  relayHost: hasRelayToken ? (requestedRelayHost ?? '0.0.0.0') : '127.0.0.1',
  relayPort: process.env.PORT ?? process.env.RELAY_PORT ?? '8787'
}

/** @type {{ name: string, child: import('node:child_process').ChildProcess }[]} */
const processes = []
let isShuttingDown = false

/**
 * 结束子进程。Windows 下 pnpm 是经 shell 派生的，真正的 vite 是**孙进程**，
 * 单纯 `child.kill()` 会把它留成孤儿并继续占用端口，因此按进程树结束。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {void}
 */
function killProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return

  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    if (result.status === 0) return
  }

  child.kill('SIGTERM')
}

/**
 * @param {string} name 子进程显示名（日志用）
 * @param {string} command
 *   ⚠️ 传 `shell: true` 时，这里必须是**整条命令**、`args` 必须为空数组。
 *   同时给 args 会触发 Node 的 DEP0190 弃用警告（只拼接、不转义），且高版本将转为硬错误。
 * @param {string[]} args
 * @param {Record<string, string>} [env] 追加到当前进程环境之上
 * @param {import('node:child_process').SpawnOptions} [options]
 * @returns {void}
 */
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

  // 显式记下退出码：否则子进程先死、事件循环提前排空时 Node 会以 0 退出，
  // 启动失败在 CI 与脚本里将完全不可见。
  process.exitCode = exitCode

  for (const { child } of processes) {
    killProcessTree(child)
  }

  setTimeout(() => {
    process.exit(exitCode)
  }, 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log('[start] Coolector quick start')
console.log(`[start] Web app: http://localhost:${config.appPort}`)
console.log(`[start] Relay:   http://localhost:${config.relayPort}`)

if (!hasRelayToken) {
  console.log('[start] 未检测到 RELAY_TOKEN，relay 仅监听回环地址（127.0.0.1）。')
  if (relayHostForcedLoopback) {
    console.log(`[start] 注意：已忽略配置里的 HOST=${requestedRelayHost} —— 没有令牌时对外监听会被 relay 拒绝启动。`)
  }
  console.log('[start] 需要对公网提供服务时，请在 .env 中设置 RELAY_TOKEN，relay 将自动监听 0.0.0.0。')
}

// Windows 下 pnpm 实际是 pnpm.cmd，需经 shell 解析才能启动。
// 因此命令必须传成**一整个字符串**（见 startProcess 的说明）：单字符串走的是 Node 自带的
// `cmd.exe /d /s /c "<命令>"` 路径、引号由 Node 处理；一旦改成 args 数组，Node 退化为纯拼接，
// 既抛 DEP0190，也让上面两道白名单校验失去意义。
startProcess(
  'web app',
  `pnpm exec vite --host ${config.appHost} --port ${config.appPort}`,
  [],
  {},
  { shell: process.platform === 'win32' }
)

// 存在根 .env 时用 Node 原生 --env-file 注入 Relay（RELAY_* 由 Relay 读，VITE_* 由 Vite 自读）
const relayArgs = ['server/relay-server.js']
if (existsSync('.env')) {
  relayArgs.unshift('--env-file=.env')
}

// 本机开发默认放行 localhost 前端：relay 的 CORS 默认「未配置 = 不给任何来源」，
// 而 `pnpm start` 起的 vite 在另一个端口（跨源），不显式放行就会被浏览器拦掉。
// 用户在自己的 .env 里配置了 RELAY_ALLOWED_ORIGINS 时以用户配置为准 ——
// 注意用 `?.trim() ||`（而非 `??`）：.env 里 `RELAY_ALLOWED_ORIGINS=` 这种「设为空」很常见，
// `??` 会把空串当成「已配置」，于是 dev 又被自己拦掉。
const devAllowedOrigins = process.env.RELAY_ALLOWED_ORIGINS?.trim()
  || `http://localhost:${config.appPort},http://127.0.0.1:${config.appPort}`

// ⚠️ 用 process.execPath 而不是 PATH 里的 `node`：父子必须是同一个解释器。
// 本机同时装着受管 node 22 与系统 node 24 时，`node` 解析到哪一个取决于 PATH 顺序，
// 会静默出现「编排器跑 24、relay 跑 22」的错配——只在两边行为有差异时才暴露。
// 这条路径不经 shell，args 数组正常转义，无需额外校验。
startProcess('relay server', process.execPath, relayArgs, {
  HOST: config.relayHost,
  PORT: config.relayPort,
  RELAY_ALLOWED_ORIGINS: devAllowedOrigins
})
