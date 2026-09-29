/**
 * 解析探针要打的公网基址。三个隧道探针共用，避免各自硬编码域名。
 *
 * 优先级：
 *   1. `PROBE_BASE`（显式覆盖，任何隧道工具都适用）
 *   2. `VITE_RELAY_URL`（`node --env-file=.env` 载入）
 *   3. ngrok 本地 API（http://127.0.0.1:<PROBE_NGROK_API_PORT|4040>/api/tunnels）里的第一个 https 隧道
 *
 * 第 3 条的用途：起隧道后直接 `pnpm probe:tunnel` 即可，不必手工把域名抄进环境变量 ——
 * 抄域名这一步正是「改了域名忘了同步」这类故障的温床（前端产物内联、`.env`、仓库变量三处都要对）。
 *
 * 为什么本模块不在 `shared/`：它是**取证工具**，不是产品代码；`shared/` 里的模块会被前后端与
 * 构建守卫共用，塞进去反而扩大判据面。
 */

const NGROK_API_PORT = Number(process.env.PROBE_NGROK_API_PORT ?? 4040)

/** @param {string} url */
const stripTrailingSlash = (url) => url.replace(/\/+$/u, '')

/**
 * 从 ngrok 本地 API 取当前隧道的公网地址。
 * @returns {Promise<string | null>}
 */
async function fromNgrokApi() {
  try {
    const res = await fetch(`http://127.0.0.1:${NGROK_API_PORT}/api/tunnels`, {
      signal: AbortSignal.timeout(2000)
    })
    if (!res.ok) return null
    const body = /** @type {{ tunnels?: { public_url?: string }[] }} */ (await res.json())
    const tunnels = body.tunnels ?? []
    const https = tunnels.find((t) => typeof t.public_url === 'string' && t.public_url.startsWith('https://'))
    return https?.public_url ? stripTrailingSlash(https.public_url) : null
  } catch {
    return null
  }
}

/**
 * @returns {Promise<{ base: string, source: string }>}
 */
export async function resolveProbeBase() {
  if (process.env.PROBE_BASE) {
    return { base: stripTrailingSlash(process.env.PROBE_BASE), source: 'PROBE_BASE' }
  }
  if (process.env.VITE_RELAY_URL) {
    return { base: stripTrailingSlash(process.env.VITE_RELAY_URL), source: 'VITE_RELAY_URL' }
  }
  const fromNgrok = await fromNgrokApi()
  if (fromNgrok) return { base: fromNgrok, source: `ngrok API :${NGROK_API_PORT}` }

  throw new Error(
    '无法确定隧道地址。请任选一种：\n' +
      '  · 起一条隧道（ngrok http 8787），让探针自动读取；\n' +
      '  · PROBE_BASE=https://xxx.ngrok-free.dev 显式指定；\n' +
      '  · node --env-file=.env 从 VITE_RELAY_URL 读取。'
  )
}

/**
 * @param {string} [token]
 */
export function resolveProbeToken(token) {
  const value = token ?? process.env.RELAY_TOKEN ?? ''
  if (!value) {
    throw new Error('缺少 RELAY_TOKEN —— 用 `node --env-file=.env` 启动探针，或显式传入环境变量。')
  }
  return value
}

/**
 * 把响应读成宽松对象。
 *
 * 黑盒 HTTP 响应体**刻意不给 typedef**：它的形状正是紧随其后的断言对象，写死 typedef
 * 等于把猜测固化成契约（假精确）—— 与 `server/relay-server.test.js` 的 `readJson` 同一取舍。
 *
 * @param {Response} response
 * @returns {Promise<any>}
 */
export function readJson(response) {
  return response.json().catch(() => ({}))
}

/**
 * 统一的 PASS/FAIL 记账器。
 * @returns {{ check: (name: string, ok: boolean, detail?: string) => void, summary: () => number }}
 */
export function createChecker() {
  let failed = 0
  return {
    check(name, ok, detail = '') {
      if (!ok) failed += 1
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
    },
    summary() {
      console.log(`\n结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
      return failed
    }
  }
}
