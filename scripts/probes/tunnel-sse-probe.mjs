#!/usr/bin/env node
/**
 * SSE 经公网隧道的实时性验证。
 *
 * 为什么单独测：隧道 / 反代最常见的失效模式是**缓冲响应** —— 连接建立、事件不流，
 * 接收端界面表现为「一直没反应」。这是隧道层唯一无法用单元测试覆盖的一条，
 * 因此在这里量一次「上传动作 → 事件到达」的实际延迟。
 *
 * 用法：
 *   node --env-file=.env scripts/probes/tunnel-sse-probe.mjs
 */

import { resolveProbeBase, resolveProbeToken, createChecker, readJson } from './lib/tunnel-base.mjs'

const ORIGIN = process.env.PROBE_ORIGIN ?? 'https://hhstu-ist.github.io'
const FILE_NAME = process.env.PROBE_SSE_FILE_NAME ?? '链路验证-事件.md'
/** 首字节等待上限：超过它基本可判定「响应被上游攒住了」。 */
const FIRST_BYTE_TIMEOUT_MS = Number(process.env.PROBE_SSE_FIRST_BYTE_MS ?? 8000)
/** 上传到事件到达的上限。 */
const EVENT_TIMEOUT_MS = Number(process.env.PROBE_SSE_EVENT_MS ?? 12000)

const { base, source } = await resolveProbeBase()
const TOKEN = resolveProbeToken()
const { check, summary } = createChecker()

console.log(`隧道地址 : ${base}（来自 ${source}）\n`)

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
const call = (path, init = {}) =>
  fetch(new URL(path, base).href, {
    ...init,
    headers: { Origin: ORIGIN, ...(init.headers ?? {}) }
  })
const auth = () => ({ Authorization: `Bearer ${TOKEN}` })
/** @param {number} ms */
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

// 1. 建房 + 发票据
const room = await readJson(
  await call('/api/rooms', {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: '{}'
  })
)
const roomId = room.roomId
check('建房', Boolean(roomId), `roomId=${roomId}`)
if (!roomId) {
  summary()
  process.exit(1)
}

const ticketBody = await readJson(
  await call(`/api/rooms/${roomId}/stream-ticket`, { method: 'POST', headers: auth() })
)
check('签发票据', Boolean(ticketBody.ticket), `expiresInMs=${ticketBody.expiresInMs}`)

// 2. 建立 SSE 长连接（票据在 query，事件流 Accept）
const controller = new AbortController()
const sseRes = await call(`/api/rooms/${roomId}/events?ticket=${ticketBody.ticket}`, {
  headers: { Accept: 'text/event-stream' },
  signal: controller.signal
})
check('SSE 连接建立', sseRes.status === 200, `status=${sseRes.status}`)

/** @type {{ at: number, raw: string }[]} */
const events = []
;(async () => {
  const reader = sseRes.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        events.push({ at: Date.now(), raw: buffer.slice(0, index) })
        buffer = buffer.slice(index + 2)
      }
    }
  } catch {
    /* abort 时正常抛出 */
  }
})()

// 3. 先确认连接真的建立了（首个字节到达 = 隧道没有把响应整个攒住）
const connectDeadline = Date.now() + FIRST_BYTE_TIMEOUT_MS
while (Date.now() < connectDeadline && events.length === 0) await sleep(100)
check(
  `SSE 首个字节在 ${FIRST_BYTE_TIMEOUT_MS} ms 内到达（响应未被缓冲）`,
  events.length > 0,
  `收到 ${events.length} 个初始事件`
)

// 4. 触发一次上传，量「上传 → 事件到达」延迟
const uploadedAt = Date.now()
const uploaded = await call(`/api/rooms/${roomId}/uploads?name=${encodeURIComponent(FILE_NAME)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/markdown' },
  body: Buffer.from('# SSE 验证\n', 'utf8')
})
check('上传成功', uploaded.status === 201, `status=${uploaded.status}`)

const deadline = Date.now() + EVENT_TIMEOUT_MS
/** @type {{ at: number, raw: string } | null} */
let hit = null
while (Date.now() < deadline) {
  hit = events.find((e) => e.raw.includes(FILE_NAME)) ?? null
  if (hit) break
  await sleep(100)
}
check(
  'SSE 经隧道收到该上传事件（未被缓冲）',
  Boolean(hit),
  hit ? `延迟 ${hit.at - uploadedAt}ms，累计 ${events.length} 个事件` : `超时，仅 ${events.length} 个事件`
)
check('事件载荷含文件名（元信息口径）', Boolean(hit?.raw.includes(FILE_NAME)), hit ? hit.raw.slice(0, 90) : '(无)')

// 5. 清理
controller.abort()
await sleep(200)
const removed = await call(`/api/rooms/${roomId}`, { method: 'DELETE', headers: auth() })
check('清理测试房间', removed.status < 300, `status=${removed.status}`)

process.exitCode = summary() === 0 ? 0 : 1
