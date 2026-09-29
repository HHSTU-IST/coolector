#!/usr/bin/env node
/**
 * 构建期门禁：校验 `VITE_RELAY_URL` 的形态。
 *
 * 为什么需要它：这个值是**构建期内联**进 `dist/` 的，发布出去之后没人能再修。
 * 一个畸形的值（`//evil.example` 会把凭据送去攻击者域、`relay.example.com` 会被
 * 当成页面相对路径而静默打错源、带 `?` 的值会让后续拼接的路径被吞进查询串）
 * 在构建期没有任何运行期校验能拦住。
 *
 * 为什么用 Node 脚本而不是 workflow 里的 shell `case`：本值在运行期**已经有**一份判据
 * （前端 `src/utils/relay.ts`、服务端 `server/relay-utils.js`、本仓库的
 * `guard:no-secret` 都调 `shared/relay-base-url.js`）。此前 workflow 里那份 shell 版
 * 因语言不通无法复用，长期是**唯一需要人肉同步**的判据副本 —— 而它恰恰比共享判据**更宽**：
 * `https://r.example.com?x=1` 能过门禁、却被运行期判非法并回落到 `127.0.0.1`，
 * 结果是「流水线绿、发布成功、但站点连不上」。改为调用本脚本后，判据重新只剩一处。
 *
 * 用法：`VITE_RELAY_URL=https://relay.example.com node scripts/check-relay-url.mjs`
 * 退出码：0 通过；1 非法值或缺失。
 */

import { parseRelayBaseUrl, RELAY_BASE_URL_REASON } from '../shared/relay-base-url.js'

/** 各原因码的可执行文案（门禁面向运维，措辞比前端更直接）。 */
const REASON_TEXT = {
  [RELAY_BASE_URL_REASON.UNPARSABLE]:
    '必须是 http(s) 绝对地址（缺 scheme 的裸域名、协议相对地址、含空格的值都无法解析）。同域子路径要写成绝对形式，如 https://app.example.com/relay。',
  [RELAY_BASE_URL_REASON.SCHEME]: '必须以 http:// 或 https:// 开头。',
  [RELAY_BASE_URL_REASON.CREDENTIALS]:
    '不能包含用户名或密码（如 https://user:pass@host）—— 基址里带凭据会让同源判定失去意义。',
  [RELAY_BASE_URL_REASON.QUERY_OR_HASH]:
    '不能带查询串（?）或锚点（#）—— 后续拼接的路径会被吞掉（https://x/relay? 会拼成 https://x/relay?/api/...）。'
}

const raw = process.env.VITE_RELAY_URL ?? ''
const result = parseRelayBaseUrl(raw)

if (result.reason === RELAY_BASE_URL_REASON.EMPTY) {
  console.error(
    '::error::VITE_RELAY_URL 为空。产物会内联回落地址 http://127.0.0.1:8787（那是访问者自己的机器），' +
      '发布出去等于一个谁也连不上的站点。请先配置该仓库变量；若确实只想跳过发布，不要运行本步骤。'
  )
  process.exit(1)
}

if (!result.ok || result.value === null) {
  console.error(`::error::VITE_RELAY_URL 非法：${REASON_TEXT[result.reason] ?? '未知原因'}`)
  console.error(`收到的值：${JSON.stringify(raw)}`)
  console.error('（运行期的共享判据会拒绝同样的值并回落到 127.0.0.1，即「发布成功但连不上」。）')
  process.exit(1)
}

const base = result.value
const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(base)
if (base.startsWith('http://') && !isLoopback) {
  console.log(
    '::warning::前端发布在 GitHub Pages（HTTPS），而 Relay 填的是 HTTP —— 浏览器会按混合内容拦截，请为 Relay 配 TLS。'
  )
}

console.log(`VITE_RELAY_URL 形态合法，前端将连接 Relay：${base}`)
if (raw.trim() !== base) console.log(`（已归一：原始值 ${JSON.stringify(raw.trim())}）`)
