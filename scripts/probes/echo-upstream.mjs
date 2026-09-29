#!/usr/bin/env node
/**
 * 回显上游：把收到的请求头原样返回，用来观测**隧道 / 反代实际向上游发送了什么头**。
 *
 * 这是 `tunnel-xff-header-probe.mjs` 的配套进程 —— 判「隧道工具对 X-Forwarded-For 是
 * 追加、覆盖还是原样透传」时，必须让隧道指向一个只会回显的上游，才看得到它写下的原始头
 * （指向 relay 是看不到的：relay 不回显请求头）。
 *
 * 典型用法（两步，隧道只能同时指向一个目标）：
 *   1. ECHO_PORT=8789 node scripts/probes/echo-upstream.mjs
 *   2. env -u HTTP_PROXY -u HTTPS_PROXY ngrok http 8789
 *   3. node scripts/probes/tunnel-xff-header-probe.mjs
 *   4. 看完读数后停掉隧道，重新指向 relay（`ngrok http 8787`）
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.ECHO_PORT ?? 8789)

createServer((req, res) => {
  const body = JSON.stringify(
    {
      method: req.method,
      url: req.url,
      httpVersion: req.httpVersion,
      headers: req.headers
    },
    null,
    2
  )
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}).listen(PORT, '127.0.0.1', () => {
  console.log(`echo upstream listening on http://127.0.0.1:${PORT}`)
  console.log('把这个端口交给隧道，例如：env -u HTTP_PROXY -u HTTPS_PROXY ngrok http ' + PORT)
})
