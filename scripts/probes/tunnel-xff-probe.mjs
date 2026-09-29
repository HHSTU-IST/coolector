/**
 * 行为级取证：**经真实公网隧道**，客户端能否用伪造的 `X-Forwarded-For` 换掉限流桶。
 *
 * 为什么必须单独做这一条：`RELAY_TRUSTED_PROXIES` 一旦声明，relay 就会采信 XFF 决定分桶
 * （`makeClientIpResolver`：自最右端向左跳过可信跳、取第一个不可信地址）。自建反代形态已在
 * A2 用 6 个臂测过（nginx / Caddy / 单层 / 双层 / 三层 / 专用头），但**隧道工具是另一个上游实现**，
 * 它的转发头语义不能从反代的结论外推 —— 何况它跑在本机之外、我们改不了它。
 *
 * 台子的判据（隧道形态下源地址不可变，故不能照搬 A2 的三态设计）：
 *   把桶打满（出现 429）后**换一个伪造值**再打一次 ——
 *     · 仍 429 ⇒ 桶键与伪造值无关（= 隧道提供/覆盖了真实客户端地址）……安全
 *     · 201   ⇒ 桶键就是伪造值（= 隧道原样透传）………………………………可绕过
 *   单看这一条不足以区分「追加」与「不采信」（两者都表现为不可绕过），
 *   机制层面的「追加还是覆盖」由 `tunnel-xff-header-probe.mjs` 的头级回显给出。
 *
 * ⚠️ 前置：relay 必须以 `RELAY_TRUSTED_PROXIES=127.0.0.1`（隧道的直接对端）和
 *    `RELAY_TUNING={"RATE_LIMIT_MAX":<PROBE_RATE_MAX>}` 启动，否则读数无意义。
 *
 * 用法：
 *   PROBE_BASE=https://xxx.ngrok-free.dev RELAY_TOKEN=... PROBE_RATE_MAX=6 \
 *     node scripts/probes/tunnel-xff-probe.mjs
 * 或（自动读 ngrok 本地 API + .env 里的令牌）：
 *   node --env-file=.env scripts/probes/tunnel-xff-probe.mjs
 */

import { resolveProbeBase, resolveProbeToken, createChecker, readJson } from './lib/tunnel-base.mjs'
import { statusDirect, statusViaHttpProxy } from './lib/proxy-request.mjs'

const SPOOF_HEADER = process.env.PROBE_SPOOF_HEADER ?? 'X-Forwarded-For'
const RATE_MAX = Number(process.env.PROBE_RATE_MAX ?? 6)
/** 换桶尝试用的第一个伪值。 */
const SPOOF_A = process.env.PROBE_SPOOF_A ?? '9.9.9.9'
/** 换桶尝试用的第二个伪值。 */
const SPOOF_B = process.env.PROBE_SPOOF_B ?? '8.8.8.8'
/** 第三个伪值刻意取「可信网段内」——若被当可信跳跳过，桶键会左移到更靠左的伪造段。 */
const SPOOF_TRUSTED = process.env.PROBE_SPOOF_TRUSTED ?? '127.0.0.1'
const EXPECT = process.env.PROBE_EXPECT ?? 'no-bypass'

const { base, source } = await resolveProbeBase()
const TOKEN = resolveProbeToken()
const { check, summary } = createChecker()

console.log(`隧道地址   : ${base}（来自 ${source}）`)
console.log(`伪造头     : ${SPOOF_HEADER}`)
console.log(`RATE_MAX   : ${RATE_MAX}（须与 relay 的 RATE_LIMIT_MAX 一致）\n`)

/** @param {string} path */
const url = (path) => new URL(path, base).href

/** 建房（凭据）。这一步也计入同一个限流桶 —— 判定时会把它算进去。 */
const created = await fetch(url('/api/rooms'), {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: '{}'
})
const roomId = (await readJson(created)).roomId
check('建房成功（且未在建房这一步就被限流）', created.status === 201 && Boolean(roomId), `status=${created.status}`)
if (!roomId) {
  summary()
  process.exit(1)
}

let seq = 0
/**
 * 发送方姿态上传：无凭据、裸 body、文件名走查询串；唯一的变量是伪造头。
 * @param {string} spoofValue
 */
const upload = async (spoofValue) => {
  seq += 1
  const res = await fetch(url(`/api/rooms/${roomId}/uploads?name=${encodeURIComponent(`probe-${seq}.md`)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'text/markdown', [SPOOF_HEADER]: spoofValue },
    body: Buffer.from('# probe\n', 'utf8')
  })
  return res.status
}

// ① 用固定伪值把桶打满。上限取 RATE_MAX + 4：留出「建房已消耗额度」与「多打几次」的余量。
const aStatuses = []
for (let i = 0; i < RATE_MAX + 4; i += 1) {
  const status = await upload(SPOOF_A)
  aStatuses.push(status)
  if (aStatuses.filter((s) => s === 429).length >= 2) break
}
console.log(`① 固定 ${SPOOF_HEADER}=${SPOOF_A} 连发 ${aStatuses.length} 次`)
console.log(`   ${aStatuses.join(', ')}\n`)

const hitLimit = aStatuses.includes(429)
check(
  `限流确实生效（${SPOOF_HEADER} 固定时打到 429，否则本条无判定力）`,
  hitLimit,
  `读数 ${aStatuses.join(',')}`
)
check(
  '上传路径按预期返回 201 / 429（未出现 401/404/413 等旁路错误）',
  aStatuses.every((s) => s === 201 || s === 429),
  aStatuses.join(',')
)

// ② 桶已满，换一个伪造值：桶键若来自伪造值，这里会拿到 201。
const afterSwitch = await upload(SPOOF_B)
console.log(`② 换 ${SPOOF_HEADER}=${SPOOF_B} 再打 1 次 → ${afterSwitch}`)

// ③ 再试一个「可信网段内」的伪值：若它被当作可信跳跳过，桶键会左移到 SPOOF_A/SPOOF_B。
const afterTrustedSpoof = await upload(SPOOF_TRUSTED)
console.log(`③ 换 ${SPOOF_HEADER}=${SPOOF_TRUSTED}（可信网段内）再打 1 次 → ${afterTrustedSpoof}\n`)

const noBypass = afterSwitch === 429 && afterTrustedSpoof === 429
/** @type {Record<string, string>} */
const SHAPE = {
  'no-bypass': '不可用伪造头换桶（桶键来自隧道提供的地址）',
  bypass: '可用伪造头换桶（隧道原样透传 ⇒ 限流可被绕过）'
}
const shape = noBypass ? 'no-bypass' : 'bypass'

check(`判定 = ${SHAPE[shape]}`, shape === EXPECT, `实测 ${SHAPE[shape]}；预期 ${SHAPE[EXPECT] ?? EXPECT}`)

// ④ 第二个出口：区分「按客户端地址分桶」与「全站单桶」。
//    两者在本段之前的所有读数上**完全一致**（换伪造头都无效），后果却相反 ——
//    前者是正常形态，后者意味着单个滥用者能让全班 429。
//    做法：换一个**出口**（本机直连 vs 代理）再打同一个桶；桶在出口之间共享 = 全站单桶。
//    目标刻意用一个不存在的房间号：限流先于房间查找，故「桶有空位」表现为 404、「桶已满」表现为 429，
//    且不会在磁盘上留下任何垃圾。
//    ⚠️ 前提是那个代理的出口**与本机直连出口不同**；同一出口会被误读成「全站单桶」。
const ALT_PROXY = process.env.PROBE_ALT_PROXY ?? ''
const GHOST_PATH = '/api/rooms/__probe-no-such-room__/uploads?name=probe.md'
const ghostHeaders = { 'Content-Type': 'text/markdown', [SPOOF_HEADER]: SPOOF_A }

if (!ALT_PROXY) {
  console.log(
    '\n④ 跳过「按客户端分桶 / 全站单桶」判别：未设 PROBE_ALT_PROXY。\n' +
      '   要跑这一段请给一个**出口与本机直连不同**的 HTTP 代理，例如：\n' +
      '   PROBE_ALT_PROXY=http://127.0.0.1:7890 node scripts/probes/tunnel-xff-probe.mjs'
  )
} else {
  const fromMain = await statusDirect({ targetUrl: url(GHOST_PATH), headers: ghostHeaders })

  /** @type {number[]} */
  const altSeq = []
  // 上限放到 RATE_MAX + 6：curl 经代理偶发抖动会返回 0（已内置重试，仍可能耗尽），
  // 上限不足会把「额度恰好用完」误读成「桶不存在」。
  for (let i = 0; i < RATE_MAX + 6; i += 1) {
    const status = await statusViaHttpProxy({
      proxyUrl: ALT_PROXY,
      targetUrl: url(GHOST_PATH),
      headers: ghostHeaders
    })
    altSeq.push(status)
    if (status === 429) break
  }

  const valid = altSeq.filter((status) => status !== 0)
  const altExhausted = valid.includes(429)
  console.log(`\n④ 主出口（直连）打 1 次不存在房间 → ${fromMain}（预期 429：前提「桶已满」仍成立）`)
  console.log(
    `   备用出口（${ALT_PROXY}）读数 → ${altSeq.join(', ')}` +
      (altExhausted ? '（该出口额度也已耗尽 ⇒ 确为独立计数）' : '')
  )
  if (altSeq.includes(0)) console.log('   （读数中的 0 = curl 连接层失败，重试后仍未成功，不计入判定）')

  const hadHeadroom = valid.includes(404)
  const bucketShape = valid.length === 0 || fromMain !== 429 ? 'unknown' : hadHeadroom ? 'client-bucket' : 'shared-bucket'

  /** @type {Record<string, string>} */
  const BUCKET_DESC = {
    'client-bucket': '按客户端地址分桶（正确：每个出口各计各的）',
    'shared-bucket': '两个出口共用一个桶（全站单桶；也可能是该代理与本机同一出口）',
    unknown: '无法判定（读数不完整）'
  }

  check('前提：主出口的桶仍处于已满状态', fromMain === 429, `实测 ${fromMain}`)
  check(
    `④ 判定 = ${BUCKET_DESC[bucketShape] ?? bucketShape}`,
    bucketShape === 'client-bucket',
    `备用出口读数 ${altSeq.join(',')}`
  )
}

const failed = summary()
process.exitCode = failed === 0 ? 0 : 1
