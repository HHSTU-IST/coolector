// Relay 的运行期配置：集中解析全部环境变量，非法即 fail-closed 退出。
// 本模块**无副作用**（除校验失败时退出），可被单测直接 import。

import { fileURLToPath } from 'node:url'
import { normalizeAllowedOrigins, parsePositiveInt, parsePublicBaseUrl } from './relay-utils.js'

/**
 * 读取正整数型环境变量，非法即拒绝启动。
 * 不能让 `Number('10mb')` 这类笔误静默变成 `NaN` —— 那会让体积校验全部失效（fail-open）。
 */
function requirePositiveInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const result = parsePositiveInt(process.env[name], { fallback, min, max })

  if (!result.ok) {
    console.error(`[relay] 拒绝启动：环境变量 ${name} 必须是 ${min}–${max} 之间的整数，当前值为 ${JSON.stringify(result.raw)}。`)
    process.exit(1)
  }

  return result.value
}


const PORT = requirePositiveInt('PORT', 8787, { max: 65535 })

const HOST = process.env.HOST ?? '0.0.0.0'

// 单个文件「解码后」的体积上限，与前端 src/stores/file.ts 的 MAX_FILE_SIZE 保持一致
const MAX_FILE_BYTES = requirePositiveInt('MAX_FILE_BYTES', 10 * 1024 * 1024)

// 信封里 text 字段的上限。前端只发前 256KB，这里再兜一层防止第三方客户端塞入超大正文
const MAX_TEXT_BYTES = Math.max(
  requirePositiveInt('MAX_TEXT_BYTES', 1024 * 1024),
  // 不得低于客户端的正文上限，否则「10MB 文件 + 正文」会被自己的派生上限误判 413
  256 * 1024
)

// 请求体上限：contentBase64 相比原始字节膨胀约 4/3，**再加上信封里同时携带的 text**，
// 最后留 JSON 字段与头部开销余量。
// 过去只算 base64 膨胀，导致带提取正文的 docx 有效上限掉到约 8.55MB（名义 10MB）。
const MAX_BODY_BYTES = requirePositiveInt(
  'MAX_BODY_BYTES',
  Math.ceil((MAX_FILE_BYTES * 4) / 3) + MAX_TEXT_BYTES + 128 * 1024
)

const MAX_QUEUE_EVENTS = requirePositiveInt('MAX_QUEUE_EVENTS', 200)

const ROOM_TTL_MS = requirePositiveInt('ROOM_TTL_MS', 6 * 60 * 60 * 1000)

// 房间绝对存活上限：空闲 TTL 会被上传刷新，没有这一层则「每 <TTL 传 1 字节」即可永久占住配额
const ROOM_MAX_LIFETIME_MS = requirePositiveInt('ROOM_MAX_LIFETIME_MS', 24 * 60 * 60 * 1000)

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? fileURLToPath(new URL('./uploads', import.meta.url))


// 设为非空后，除「发送方公开写」与 SSE 一次性票据外的 /api 请求必须携带 `Authorization: Bearer <token>`。
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? ''

// 逗号分隔的白名单；`*` 表示任意来源。部署到公网时务必收窄。
// 空串（如 docker-compose 的 ${VAR:-} 传入）在此归一为 `*`，避免白名单被误判为空导致 CORS 头缺失。
const ALLOWED_ORIGINS = normalizeAllowedOrigins(process.env.RELAY_ALLOWED_ORIGINS)

// 整个上传目录的磁盘配额硬上限。
const MAX_TOTAL_UPLOAD_BYTES = requirePositiveInt('MAX_TOTAL_UPLOAD_BYTES', 1024 * 1024 * 1024)

// 单个房间的配额上限。默认取全局的 1/8 —— 免凭据的发送方只能填满「自己那个房间」，
// 而不是把全站配额吃光导致所有班级都上传失败。
const MAX_ROOM_UPLOAD_BYTES = requirePositiveInt(
  'MAX_ROOM_UPLOAD_BYTES',
  Math.max(Math.floor(MAX_TOTAL_UPLOAD_BYTES / 8), 8 * 1024 * 1024)
)

// 单个来源 IP 在限流窗口内可写入的字节数（0 = 关闭）。与请求计数限流互补，直接限制配额消耗速率。
const MAX_UPLOAD_BYTES_PER_WINDOW = requirePositiveInt('MAX_UPLOAD_BYTES_PER_WINDOW', 256 * 1024 * 1024, { min: 0 })

// 单个房间的上传条数上限：即使每个文件都是 0 字节，也不能让 room.uploads 无限增长
const MAX_ROOM_UPLOADS = requirePositiveInt('MAX_ROOM_UPLOADS', 500)

// 上传文件名上限（字节）。文件名会进入内存、房间快照、SSE 帧与审计日志，必须有界
const MAX_UPLOAD_NAME_BYTES = requirePositiveInt('MAX_UPLOAD_NAME_BYTES', 255)

// 房间清理扫描周期（毫秒）
const ROOM_CLEANUP_INTERVAL_MS = requirePositiveInt('ROOM_CLEANUP_INTERVAL_MS', 30 * 60 * 1000)

// 启动时是否保留「无主目录」（磁盘存在但内存无对应房间的目录）。
// 默认回收：房间只活在内存里，重启后这些文件已无法通过任何 HTTP 路径访问，
// 却会被 initStoredBytes 永久计入全局配额，且没有回收路径。
const KEEP_ORPHAN_UPLOADS = (process.env.RELAY_KEEP_ORPHAN_UPLOADS ?? 'false') === 'true'


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


// SSE 票据有效期（毫秒），短时效一次性，替代 URL 中的长期 token。
const STREAM_TICKET_TTL_MS = requirePositiveInt('STREAM_TICKET_TTL_MS', 60_000)


// —— 速率限制（固定窗口，按 socket 来源 IP 计数；反向代理后为代理 IP，属尽力而为） ——
const RATE_LIMIT_WINDOW_MS = requirePositiveInt('RATE_LIMIT_WINDOW_MS', 60 * 1000)

const RATE_LIMIT_MAX = requirePositiveInt('RATE_LIMIT_MAX', 120)


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
  MAX_ROOM_UPLOADS,
  MAX_UPLOAD_NAME_BYTES,
  ROOM_CLEANUP_INTERVAL_MS,
  KEEP_ORPHAN_UPLOADS,
  PUBLIC_BASE_URL,
  STREAM_TICKET_TTL_MS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX
}
