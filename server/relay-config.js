// Relay 的运行期配置：集中解析全部环境变量，非法即 fail-closed 退出。
// 本模块**无副作用**（除校验失败时退出），可被单测直接 import。
//
// ── 两类配置，界线是「运维是否真的需要调它」 ─────────────────────────────────
//
// ① **运维变量（9 项）**：部署形态因环境而异，无法用一套默认值覆盖 ——
//    PORT / HOST / UPLOAD_DIR / RELAY_TOKEN / RELAY_ALLOWED_ORIGINS /
//    RELAY_PUBLIC_BASE_URL / RELAY_TRUSTED_PROXIES / MAX_FILE_BYTES / MAX_TOTAL_UPLOAD_BYTES
//
// ② **内部调参（15 项，模块常量）**：旋钮之间**互相耦合** —— `MAX_BODY_BYTES` 由
//    `MAX_FILE_BYTES` + `MAX_TEXT_BYTES` 派生、`MAX_ROOM_UPLOAD_BYTES` 默认取全局配额的 1/8。
//    逐个暴露到 env 只会制造「改了一个、另一个没跟上」的错配（实测过一次：只调大
//    `MAX_FILE_BYTES` 而没重算 `MAX_BODY_BYTES`，带提取正文的 docx 有效上限掉到约 8.55MB）。
//    因此它们**只能改代码**，不能改 `.env`。
//
//    确有需要时（测试、或确知自己在做什么的高级用户）走**唯一一个显式通道**：
//    `RELAY_TUNING` —— 一个 JSON 对象，如 `RELAY_TUNING={"MAX_ROOMS":10,"RATE_LIMIT_MAX":9999}`。
//    未知键与非法值一律拒绝启动：静默忽略未知键最危险，运维会以为改动生效了、实际跑的还是默认值。
//
// 数值型变量一律 fail-closed 校验：写成 `MAX_FILE_BYTES=10mb` 这类非整数会让进程**拒绝启动**，
// 而不是把 `NaN` 带进体积判断（那会让所有校验静默失效）。

import { fileURLToPath } from 'node:url'
import { normalizeAllowedOrigins, parsePositiveInt, parsePublicBaseUrl, parseTrustedProxies } from './relay-utils.js'

/**
 * 读取正整数型环境变量，非法即拒绝启动。
 * 不能让 `Number('10mb')` 这类笔误静默变成 `NaN` —— 那会让体积校验全部失效（fail-open）。
 *
 * @param {string} name 环境变量名（仅用于报错）
 * @param {number} fallback 未设置时的默认值
 * @param {{ min?: number, max?: number }} [bounds] 允许区间
 * @returns {number}
 */
function requirePositiveInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const result = parsePositiveInt(process.env[name], { fallback, min, max })

  if (!result.ok) {
    console.error(`[relay] 拒绝启动：环境变量 ${name} 必须是 ${min}–${max} 之间的整数，当前值为 ${JSON.stringify(result.raw)}。`)
    process.exit(1)
  }

  return result.value
}


// ══════════════════════════════════════════════════════════════════════════
// ① 运维变量
// ══════════════════════════════════════════════════════════════════════════

const PORT = requirePositiveInt('PORT', 8787, { max: 65535 })

const HOST = process.env.HOST ?? '0.0.0.0'

// 单个文件「解码后」的体积上限，与前端 src/stores/file.ts 的 MAX_FILE_SIZE 保持一致
const MAX_FILE_BYTES = requirePositiveInt('MAX_FILE_BYTES', 10 * 1024 * 1024)

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? fileURLToPath(new URL('./uploads', import.meta.url))

// 设为非空后，除「发送方公开写」与 SSE 一次性票据外的 /api 请求必须携带 `Authorization: Bearer <token>`。
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? ''

// 逗号分隔的 CORS 白名单；`*` 表示任意来源（仅建议本机/内网用）。
// **未配置 = 不发任何 CORS 头**（拒绝所有跨源前端），这是刻意的 fail-closed 默认值：
// 公开写路径本来就免凭据，若再默认放开跨源，任意站点都能向已知房间号灌文件。
const ALLOWED_ORIGINS = normalizeAllowedOrigins(process.env.RELAY_ALLOWED_ORIGINS)

// 整个上传目录的磁盘配额硬上限。它决定「这台机器最多收多少作业」，必须由运维按磁盘容量定。
const MAX_TOTAL_UPLOAD_BYTES = requirePositiveInt('MAX_TOTAL_UPLOAD_BYTES', 1024 * 1024 * 1024)

// 对外基址。**这是服务端唯一允许产生绝对 URL 的来源。**
//
// 服务端绝不从 `Host` / `x-forwarded-*` 推断自己的对外地址：那些请求头由调用方任意控制，
// 而接收端前端会自动带凭据去拉取服务端返回的 URL —— 无凭据的发送方只要伪造 `Host`，
// 就能让接收端把管理密钥发往攻击者域（F-001）。
//
// 留空（默认）= 对外只输出相对路径，由客户端按自己配置的 Relay 地址解析。
// 反代 HTTPS 部署下这同样是正确的：接收端在界面上填的就是 `https://relay.example`，
// 因此不再需要服务端猜自己的协议与域名，也就不会再有混合内容问题。
// 只有**非浏览器客户端**（curl / 自定义集成）需要绝对 URL 时才显式设置本项。
const PUBLIC_BASE_URL = (() => {
  const result = parsePublicBaseUrl(process.env.RELAY_PUBLIC_BASE_URL)

  if (!result.ok) {
    console.error(`[relay] 拒绝启动：环境变量 RELAY_PUBLIC_BASE_URL 必须是 http(s) 绝对地址，且不含凭据/查询串/hash，当前值为 ${JSON.stringify(result.raw)}。`)
    process.exit(1)
  }

  return result.value
})()

// 可信反向代理网段（IP / CIDR，逗号分隔）。只有来自这些网段的请求才会按 `X-Forwarded-For`
// 分桶 —— 反代后 socket 地址恒为代理 IP，不声明它就等于全站共用一个限流桶。
// 分桶取 XFF **最右端向左**第一个不可信地址（跳过落在本网段内的跳）；因此这里**只能填代理自身
// 网段** —— 把客户端地址段也写进来，会让真实客户端被当作可信跳跳过、退回到可伪造的最左值。
// 非法条目 fail-closed：静默忽略会让运维以为「已按客户端分桶」，实际仍在共用一个桶。
const TRUSTED_PROXIES_RESULT = parseTrustedProxies(process.env.RELAY_TRUSTED_PROXIES)
if (TRUSTED_PROXIES_RESULT.invalid.length > 0) {
  console.error(`[relay] 拒绝启动：RELAY_TRUSTED_PROXIES 的每一项都必须是不带端口/掩码以外的合法 IP 或 CIDR（如 10.0.0.0/8），非法值：${TRUSTED_PROXIES_RESULT.invalid.join(', ')}`)
  process.exit(1)
}
const TRUSTED_PROXIES = TRUSTED_PROXIES_RESULT.list


// ══════════════════════════════════════════════════════════════════════════
// ② 内部调参（模块常量；覆盖通道见文件头）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 可调项的默认值。**每一项都经实测标定，改动前请读 INVARIANTS.md 的对应依据。**
 *
 * 注意这里**不含**两个派生项 `MAX_BODY_BYTES` / `MAX_ROOM_UPLOAD_BYTES` —— 它们的默认值
 * 必须由「覆盖之后」的其它配置算出（见下方 `pick`），否则会出现「只调大了 MAX_TEXT_BYTES，
 * 而 MAX_BODY_BYTES 还按旧值算」的错配。
 */
const TUNING_DEFAULTS = {
  /** 信封 / 提取正文的上限。前端只发前 256KB，这里再兜一层防止第三方客户端塞入超大正文 */
  MAX_TEXT_BYTES: 1024 * 1024,
  /** 房间的离线事件队列上限：接收端短暂断线时靠它重放事件 */
  MAX_QUEUE_EVENTS: 200,
  /** 单个房间的上传条数上限：即使每个文件都是 0 字节，也不能让 room.uploads 无限增长 */
  MAX_ROOM_UPLOADS: 500,
  /** 上传文件名上限（字节）。文件名会进入内存、房间快照、SSE 帧与审计日志，必须有界 */
  MAX_UPLOAD_NAME_BYTES: 255,
  /** 同时存在的房间数上限：建房是持凭据方唯一能持续新增内存对象的入口 */
  MAX_ROOMS: 200,
  /** 单个来源 IP 在限流窗口内可写入的字节数（0 = 关闭） */
  MAX_UPLOAD_BYTES_PER_WINDOW: 256 * 1024 * 1024,
  /** 单个**房间**在限流窗口内可写入的字节数（0 = 关闭）。挡住「多来源一起灌同一个房间」 */
  MAX_ROOM_BYTES_PER_WINDOW: 256 * 1024 * 1024,
  /** 房间空闲存活时间。上传会刷新这个计时（活跃的收集不应被回收） */
  ROOM_TTL_MS: 6 * 60 * 60 * 1000,
  /** 房间绝对存活上限：没有这一层，「每 <TTL 传 1 字节」就能永久占住配额与磁盘 */
  ROOM_MAX_LIFETIME_MS: 24 * 60 * 60 * 1000,
  /** 房间清理扫描周期 */
  ROOM_CLEANUP_INTERVAL_MS: 30 * 60 * 1000,
  /** SSE 票据有效期：短时效一次性，替代 URL 中的长期 token */
  STREAM_TICKET_TTL_MS: 60_000,
  /** 限流固定窗口长度（按客户端 IP 计数） */
  RATE_LIMIT_WINDOW_MS: 60 * 1000,
  /** 每个来源 IP 在窗口内的 /api 请求上限 */
  RATE_LIMIT_MAX: 120
}

/** 允许取 `0` 表示「关闭」的项（其余项要求 ≥1 —— 0 会让校验恒真或让定时器空转） */
const TUNING_ZERO_ALLOWED = new Set(['MAX_UPLOAD_BYTES_PER_WINDOW', 'MAX_ROOM_BYTES_PER_WINDOW'])

/** 由其它配置算出默认值、但仍允许显式覆盖的项 */
const TUNING_DERIVED_KEYS = ['MAX_BODY_BYTES', 'MAX_ROOM_UPLOAD_BYTES']

const TUNING_KEYS = new Set([...Object.keys(TUNING_DEFAULTS), ...TUNING_DERIVED_KEYS])

/**
 * 解析 `RELAY_TUNING` 覆盖通道（JSON 对象）。未设置时返回空对象。
 *
 * 拒绝启动的三种情形：无法解析为 JSON、不是普通对象、**含未知键或非法值**。
 * 未知键与非法值都必须 fail-closed —— 它们都意味着「配置没生效」，而静默失效会让运维
 * 在错误的前提下排查问题（这与「数值型 env 必须校验」是同一个理由，见铁律 10）。
 *
 * @param {string | undefined} raw
 * @returns {Record<string, number>}
 */
function parseTuning(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return {}

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    console.error(`[relay] 拒绝启动：RELAY_TUNING 必须是 JSON 对象，当前值无法解析：${text.slice(0, 200)}`)
    process.exit(1)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`[relay] 拒绝启动：RELAY_TUNING 必须是 JSON 对象（如 {"MAX_ROOMS":10}），当前值为 ${text.slice(0, 200)}`)
    process.exit(1)
  }

  const unknown = Object.keys(parsed).filter((key) => !TUNING_KEYS.has(key))
  if (unknown.length > 0) {
    console.error(`[relay] 拒绝启动：RELAY_TUNING 含未知键 ${unknown.join(', ')}（可能是拼写错误或已废弃的旋钮）。`)
    console.error(`[relay] 可调项共 ${TUNING_KEYS.size} 个：${[...TUNING_KEYS].join(', ')}`)
    process.exit(1)
  }

  /** @type {Record<string, number>} */
  const overrides = {}
  for (const [key, value] of Object.entries(parsed)) {
    const min = TUNING_ZERO_ALLOWED.has(key) ? 0 : 1
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
      console.error(`[relay] 拒绝启动：RELAY_TUNING.${key} 必须是 ≥${min} 的整数，当前值为 ${JSON.stringify(value)}。`)
      process.exit(1)
    }
    overrides[key] = value
  }

  return overrides
}

const TUNING = parseTuning(process.env.RELAY_TUNING)

/**
 * 取「有默认值」的可调项：`RELAY_TUNING` 覆盖优先，否则用 `TUNING_DEFAULTS` 里的默认值。
 *
 * 参数被限定为 `TUNING_DEFAULTS` 的键，因此返回值**一定是 `number`**（不是 `number | undefined`）。
 * 这一点在服务端受类型检查（`tsconfig.server.json` 的 `checkJs` + `strict`）后是硬要求：
 * 只要签名里带上 `undefined`，它就会顺着下面十几个配置常量一路传染成一片 TS18048。
 *
 * @param {keyof typeof TUNING_DEFAULTS} key
 * @returns {number}
 */
function pick(key) {
  const override = TUNING[key]
  return typeof override === 'number' ? override : TUNING_DEFAULTS[key]
}

/**
 * 取「派生项」的显式覆盖值。
 *
 * 派生项刻意**不在 `TUNING_DEFAULTS` 里** —— 它们的默认值必须由「覆盖之后」的其它配置算出
 * （见下方 `??` 右侧的推导式），写进默认值表就会出现「只调大了 MAX_TEXT_BYTES，而
 * MAX_BODY_BYTES 还按旧值算」的错配。因此这里返回 `undefined` 是正常语义，由调用方兜住。
 *
 * @param {'MAX_BODY_BYTES' | 'MAX_ROOM_UPLOAD_BYTES'} key
 * @returns {number | undefined}
 */
function pickDerived(key) {
  const override = TUNING[key]
  return typeof override === 'number' ? override : undefined
}

const MAX_TEXT_BYTES = Math.max(
  pick('MAX_TEXT_BYTES'),
  // 不得低于客户端的正文上限，否则「10MB 文件 + 正文」会被自己的派生上限误判 413
  256 * 1024
)

// 请求体上限：contentBase64 相比原始字节膨胀约 4/3，**再加上信封里同时携带的 text**，
// 最后留 JSON 字段与头部开销余量。
// 过去只算 base64 膨胀，导致带提取正文的 docx 有效上限掉到约 8.55MB（名义 10MB）。
const MAX_BODY_BYTES = pickDerived('MAX_BODY_BYTES')
  ?? (Math.ceil((MAX_FILE_BYTES * 4) / 3) + MAX_TEXT_BYTES + 128 * 1024)

// 单个房间的配额上限。默认取全局的 1/8 —— 免凭据的发送方只能填满「自己那个房间」，
// 而不是把全站配额吃光导致所有班级都上传失败。
const MAX_ROOM_UPLOAD_BYTES = pickDerived('MAX_ROOM_UPLOAD_BYTES')
  ?? Math.max(Math.floor(MAX_TOTAL_UPLOAD_BYTES / 8), 8 * 1024 * 1024)

const MAX_QUEUE_EVENTS = pick('MAX_QUEUE_EVENTS')
const MAX_ROOM_UPLOADS = pick('MAX_ROOM_UPLOADS')
const MAX_UPLOAD_NAME_BYTES = pick('MAX_UPLOAD_NAME_BYTES')
const MAX_ROOMS = pick('MAX_ROOMS')
const MAX_UPLOAD_BYTES_PER_WINDOW = pick('MAX_UPLOAD_BYTES_PER_WINDOW')
const MAX_ROOM_BYTES_PER_WINDOW = pick('MAX_ROOM_BYTES_PER_WINDOW')
const ROOM_TTL_MS = pick('ROOM_TTL_MS')
const ROOM_MAX_LIFETIME_MS = pick('ROOM_MAX_LIFETIME_MS')
const ROOM_CLEANUP_INTERVAL_MS = pick('ROOM_CLEANUP_INTERVAL_MS')
const STREAM_TICKET_TTL_MS = pick('STREAM_TICKET_TTL_MS')
const RATE_LIMIT_WINDOW_MS = pick('RATE_LIMIT_WINDOW_MS')
const RATE_LIMIT_MAX = pick('RATE_LIMIT_MAX')


// 房间快照 / SSE 帧里展示的正文预览长度（**字符**数）。
// 纯模块常量（连 RELAY_TUNING 都不开放）：改它没有运维意义，但两端必须一致 ——
// server 侧截 previewText 用它，relay-state 恢复元数据时也用它兜住 previewText 的上限，
// 否则一份被改过的元数据就能塞进任意长度的预览串。
const PREVIEW_TEXT_CHARS = 4096


export {
  requirePositiveInt,
  PORT,
  HOST,
  MAX_FILE_BYTES,
  MAX_TEXT_BYTES,
  MAX_BODY_BYTES,
  MAX_QUEUE_EVENTS,
  ROOM_TTL_MS,
  ROOM_MAX_LIFETIME_MS,
  UPLOAD_DIR,
  RELAY_TOKEN,
  ALLOWED_ORIGINS,
  MAX_TOTAL_UPLOAD_BYTES,
  MAX_ROOM_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES_PER_WINDOW,
  MAX_ROOM_BYTES_PER_WINDOW,
  MAX_ROOMS,
  MAX_ROOM_UPLOADS,
  MAX_UPLOAD_NAME_BYTES,
  ROOM_CLEANUP_INTERVAL_MS,
  PREVIEW_TEXT_CHARS,
  PUBLIC_BASE_URL,
  STREAM_TICKET_TTL_MS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  TRUSTED_PROXIES
}
