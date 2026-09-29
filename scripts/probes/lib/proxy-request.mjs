/**
 * 用 `curl` 取一个 URL 的状态码，支持「直连」与「经 HTTP 代理（CONNECT 隧道）」两种出口。
 *
 * 存在的理由：判定「**按客户端地址分桶**」还是「**全站单桶**」必须有两个来源 —— 这两者在
 * 单一来源下的表象完全相同（换伪造头都无效），后果却相反：前者正常，后者是「一个滥用者
 * 让全班 429」。A2 在自建反代台子上靠三个回环源地址解决；隧道形态下改不了 socket 源地址，
 * 只能换**出口**（本机直连出口 vs 代理出口）。
 *
 * 实现选择：`curl` 子进程而非手写 socket + TLS —— curl 的代理链在取证里已逐条验证过，
 * 而手写 CONNECT 要在 Windows 上叠 net + tls 两层，调试成本远高于收益。
 * 参数走数组、不经 shell，避免 Windows 引号问题。
 */

import { spawn } from 'node:child_process'

/** curl 经代理偶发抖动会返回 0；不重试会把「失败」当成读数混进序列。 */
const ATTEMPTS = 3

/**
 * @param {string[]} extraArgs
 * @returns {Promise<number>} 状态码；0 表示连接层失败
 */
function curlStatus(extraArgs) {
  const args = [
    '-s',
    '-o',
    process.platform === 'win32' ? 'NUL' : '/dev/null',
    '-w',
    '%{http_code}',
    '-m',
    '25',
    ...extraArgs
  ]

  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout?.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.on('error', (error) => reject(new Error(`无法调用 curl：${error.message}`)))
    child.on('close', () => {
      const code = Number.parseInt(out.trim(), 10)
      resolve(Number.isFinite(code) ? code : 0)
    })
  })
}

/**
 * @param {() => Promise<number>} run
 * @returns {Promise<number>}
 */
async function withRetry(run) {
  let last = 0
  for (let i = 0; i < ATTEMPTS; i += 1) {
    last = await run()
    if (last !== 0) return last
  }
  return last
}

/**
 * @param {Record<string, string>} headers
 * @returns {string[]}
 */
function headerArgs(headers) {
  /** @type {string[]} */
  const args = []
  for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`)
  return args
}

/**
 * 直连（绕过环境里的 HTTP(S)_PROXY）。
 *
 * @param {object} options
 * @param {string} options.targetUrl
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body]
 * @returns {Promise<number>}
 */
export function statusDirect({ targetUrl, method = 'POST', headers = {}, body = '' }) {
  const extra = ['--noproxy', '*', '-X', method, ...headerArgs(headers)]
  if (body) extra.push('--data-binary', body)
  extra.push(targetUrl)
  return withRetry(() => curlStatus(extra))
}

/**
 * 经 HTTP 代理（CONNECT 隧道）。
 *
 * @param {object} options
 * @param {string} options.proxyUrl 形如 `http://127.0.0.1:7890`
 * @param {string} options.targetUrl
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body]
 * @returns {Promise<number>}
 */
export function statusViaHttpProxy({ proxyUrl, targetUrl, method = 'POST', headers = {}, body = '' }) {
  const extra = ['-x', proxyUrl, '-X', method, ...headerArgs(headers)]
  if (body) extra.push('--data-binary', body)
  extra.push(targetUrl)
  return withRetry(() => curlStatus(extra))
}
