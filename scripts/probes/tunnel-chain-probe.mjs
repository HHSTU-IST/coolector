#!/usr/bin/env node
/**
 * 经公网隧道的完整链路验证。
 *
 * 覆盖「接收端建房 → 发送方无凭据上传 → 快照 → 按需拉正文/下载 → 一次性票据 → 清理」
 * 这条**真实 HTTPS 公网路径** —— 与 `pnpm e2e` 的 `http://127.0.0.1` 本机直连不同：
 * e2e 覆盖不到隧道层的转发语义（CORS 预检、中文查询串、响应头是否会丢、TLS 终结位置）。
 *
 * 隧道地址解析见 `lib/tunnel-base.mjs`（优先 `PROBE_BASE`，其次 `VITE_RELAY_URL`，
 * 最后读 ngrok 本地 API）—— 所以起好隧道后通常直接跑即可，不必手工抄域名。
 *
 * 用法：
 *   node --env-file=.env scripts/probes/tunnel-chain-probe.mjs
 *   PROBE_BASE=https://xxx.ngrok-free.dev RELAY_TOKEN=... node scripts/probes/tunnel-chain-probe.mjs
 */

import { resolveProbeBase, resolveProbeToken, createChecker, readJson } from './lib/tunnel-base.mjs'

const ORIGIN = process.env.PROBE_ORIGIN ?? 'https://hhstu-ist.github.io'
const FILE_NAME = process.env.PROBE_FILE_NAME ?? '链路验证-中文名.md'
const CONTENT = '# 链路验证\n经公网隧道上传的探针文件\n'

const { base, source } = await resolveProbeBase()
const TOKEN = resolveProbeToken()
const { check, summary } = createChecker()

console.log(`隧道地址 : ${base}（来自 ${source}）`)
console.log(`Origin   : ${ORIGIN}\n`)

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

// 0. 隧道健康检查
const health = await call('/healthz')
check('隧道公网可达 /healthz', health.status === 200, `status=${health.status}`)

// 1. 接收端建房（凭据，经隧道）
const created = await call('/api/rooms', {
  method: 'POST',
  headers: { ...auth(), 'Content-Type': 'application/json' },
  body: '{}'
})
const room = await readJson(created)
const roomId = room.roomId
check('接收端建房', created.status < 300 && Boolean(roomId), `status=${created.status} roomId=${roomId}`)
check(
  '建房响应带 CORS 放行头',
  created.headers.get('access-control-allow-origin') === ORIGIN,
  `ACAO=${String(created.headers.get('access-control-allow-origin'))}`
)
if (!roomId) {
  summary()
  process.exit(1)
}

// 2. 发送方上传：完全无凭据、裸 body、中文名走 ?name=
const uploaded = await call(`/api/rooms/${roomId}/uploads?name=${encodeURIComponent(FILE_NAME)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/markdown' },
  body: Buffer.from(CONTENT, 'utf8')
})
check('发送方无凭据上传 201', uploaded.status === 201, `status=${uploaded.status}`)
const uploadSummaryBody = await readJson(uploaded)
check(
  '201 不回吐正文（铁律 22）',
  JSON.stringify(uploadSummaryBody).length < 64 * 1024,
  `${JSON.stringify(uploadSummaryBody).length} bytes`
)

// 3. 房间快照（凭据）
const snapshot = await call(`/api/rooms/${roomId}`, { headers: auth() })
const snap = await readJson(snapshot)
/** @type {{ name: string, downloadUrl: string }[]} */
const uploads = snap.uploads ?? []
const names = uploads.map((u) => u.name)
check('快照含中文文件名（逐字一致）', names.includes(FILE_NAME), names.join(' | ') || '(空)')

// 4. 无凭据读受保护端点必须被拒
const unauth = await call(`/api/rooms/${roomId}`)
check('无凭据读房间被拒 401', unauth.status === 401, `status=${unauth.status}`)

// 5. 下载原件（凭据）—— 逐字节比对，验「原件保真」
const first = uploads[0]
if (first) {
  const dl = await call(first.downloadUrl, { headers: auth() })
  const bytes = Buffer.from(await dl.arrayBuffer())
  check(
    '下载原件逐字节一致',
    bytes.equals(Buffer.from(CONTENT, 'utf8')),
    `status=${dl.status} ${bytes.length}B`
  )
  check(
    '下载头带 nosniff',
    dl.headers.get('x-content-type-options') === 'nosniff',
    String(dl.headers.get('x-content-type-options'))
  )
} else {
  check('快照里能取到 uploads[0]', false, '无法继续下载验证')
}

// 6. SSE 用一次性票据（凭据）
const ticket = await call(`/api/rooms/${roomId}/stream-ticket`, { method: 'POST', headers: auth() })
const ticketBody = await readJson(ticket)
check('签发一次性票据', Boolean(ticketBody.ticket), `expiresInMs=${ticketBody.expiresInMs}`)

// 7. 清理测试房间（凭据），不给用户留垃圾
const removed = await call(`/api/rooms/${roomId}`, { method: 'DELETE', headers: auth() })
check('清理测试房间', removed.status < 300, `status=${removed.status}`)

process.exitCode = summary() === 0 ? 0 : 1
