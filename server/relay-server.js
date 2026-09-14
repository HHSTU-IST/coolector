import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import {
  contentDisposition,
  decodeHeaderValue,
  digestName,
  isLoopbackHost,
  isTextMimeType,
  isWeakRoomId,
  limitUploadName,
  normalizeIsoDate,
  sanitizeMimeType,
  sanitizeRoomId,
  truncateUtf8
} from './relay-utils.js'
import {
  ALLOWED_ORIGINS, HOST, MAX_FILE_BYTES, MAX_ROOMS, MAX_ROOM_BYTES_PER_WINDOW, MAX_TEXT_BYTES,
  MAX_UPLOAD_BYTES_PER_WINDOW, MAX_UPLOAD_NAME_BYTES, PORT, RELAY_TOKEN,
  ROOM_CLEANUP_INTERVAL_MS, RATE_LIMIT_WINDOW_MS, STREAM_TICKET_TTL_MS
} from './relay-config.js'
import {
  HttpError, auditLog, corsHeaders, isAuthorized, isPublicUpload,
  isRateLimited, isStreamTicketAuthorized, isUploadBytesExceeded, nowIso, relayUrl,
  rateBuckets, readBody, roomByteBuckets, sendSseHeaders, streamTickets,
  uploadByteBuckets, writeJson, writeSseFrame
} from './relay-http.js'
import {
  cleanupRooms, closeReceiver, createRoom, destroyRoom, dispatchEvent, getRoom,
  initStoredBytes, persistUpload, reserveStorageQuota, reserveUploadSlot,
  roomSnapshot, rooms, uploadSummary
} from './relay-state.js'

// Relay 主服务：只做**编排** —— 路由分发 + 各 handler + 定时器 + 监听。
// 配置在 relay-config.js；HTTP 原语与准入在 relay-http.js；房间状态与资源记账在 relay-state.js。
// 改动前请先确认逻辑属于哪一层，不要重新把状态或原语塞回本文件。

function parseUploadMetadata(req, bodyBuffer, headers, query) {
  // 是否按 JSON 信封解析，只取决于显式头 X-Relay-Envelope: 1。
  // 过去仅凭 Content-Type: application/json 判断，会把正文本身就是 JSON 的文件（如 .json/.ipynb）
  // 误当成信封，最终报 400 Missing file content。
  const isEnvelope = String(req.headers['x-relay-envelope'] ?? '') === '1'

  if (isEnvelope) {
    let raw
    try {
      raw = bodyBuffer.length ? JSON.parse(bodyBuffer.toString('utf8')) : {}
    } catch {
      throw new HttpError(400, 'Invalid JSON body')
    }

    const fileName = raw.name ?? raw.fileName
    if (!fileName) {
      throw new HttpError(400, 'Missing file name')
    }

    const lastModified = raw.lastModified ?? nowIso()
    const safeMimeType = sanitizeMimeType(raw.mimeType ?? 'text/plain')
    const text = typeof raw.text === 'string' ? raw.text : typeof raw.contentText === 'string' ? raw.contentText : null
    const contentBase64 = typeof raw.contentBase64 === 'string'
      ? raw.contentBase64
      : text !== null
        ? Buffer.from(text, 'utf8').toString('base64')
        : typeof raw.content === 'string'
          ? Buffer.from(raw.content, 'utf8').toString('base64')
          : null

    // 用 typeof 判存在：0 字节文件的 contentBase64 是空串，不能当「缺失」拒绝
    if (typeof contentBase64 !== 'string') {
      throw new HttpError(400, 'Missing file content')
    }

    const decoded = Buffer.from(contentBase64, 'base64')
    const safeName = limitUploadName(fileName, MAX_UPLOAD_NAME_BYTES).name
    return {
      name: safeName,
      mimeType: safeMimeType,
      lastModified: normalizeIsoDate(lastModified, nowIso()),
      contentBase64,
      text: text ?? (isTextMimeType(safeMimeType, safeName) ? decoded.toString('utf8') : null),
      // 客户端按 256KB 截断过提取正文时上报（服务端只知道自己那 1MB 的截断）
      textTruncatedByClient: raw.textTruncatedByClient === true
    }
  }

  // 裸 body 分支：正文即请求体，元信息放在头或查询参数里（curl 等非浏览器客户端）
  const fileName = decodeHeaderValue(headers['x-relay-filename']) ?? query.get('name')
  if (!fileName) {
    throw new HttpError(400, 'Missing file name')
  }

  const safeMimeType = sanitizeMimeType(headers['x-relay-mime-type'] ?? 'application/octet-stream')
  const safeName = limitUploadName(fileName, MAX_UPLOAD_NAME_BYTES).name
  const contentBase64 = bodyBuffer.toString('base64')
  const text = isTextMimeType(safeMimeType, safeName)
    ? bodyBuffer.toString('utf8')
    : null

  return {
    name: safeName,
    mimeType: safeMimeType,
    lastModified: normalizeIsoDate(headers['x-relay-last-modified'], nowIso()),
    contentBase64,
    text,
    // 裸 body 路径没有「客户端提取正文」这一步，自然也没有客户端截断
    textTruncatedByClient: false
  }
}

async function handleCreateRoom(req, res) {
  const body = await readBody(req)
  let requestedId = null

  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString('utf8'))
      requestedId = sanitizeRoomId(parsed.roomId ?? parsed.id)
    } catch {
      throw new Error('Invalid JSON body')
    }
  }

  // 建房上限：房间只在内存里，而建房是持凭据方唯一能持续新增内存对象的入口。
  // 已存在的房间不算新增 —— 重进自己那个房间不该被上限拦住。
  if (!(requestedId && getRoom(requestedId)) && rooms.size >= MAX_ROOMS) {
    auditLog('room_limit_reached', { rooms: rooms.size, limit: MAX_ROOMS, ip: req.socket.remoteAddress })
    throw new HttpError(429, `Room count limit reached (limit ${MAX_ROOMS})`)
  }

  const room = createRoom(requestedId ?? undefined)
  if (room.created) {
    dispatchEvent(room.room, 'room.created', {
      roomId: room.room.id,
      createdAt: room.room.createdAt
    })
    auditLog('room_created', { roomId: room.room.id, ip: req.socket.remoteAddress })
    // 发送方公开写模型下房间 ID 即能力凭据；自定义弱 ID 只告警不阻断（班级可能确有命名约定）
    if (isWeakRoomId(room.room.id)) {
      auditLog('weak_room_id', { roomId: room.room.id, ip: req.socket.remoteAddress })
    }
  }

  return writeJson(res, 201, {
    roomId: room.room.id,
    createdAt: room.room.createdAt,
    // 「房间号偏弱」的判定权威在服务端：前端据此提示，无需自己复刻一份弱名清单
    weakRoomId: isWeakRoomId(room.room.id),
    // 这些地址默认是**相对路径**，由客户端按自己配置的 Relay 地址解析。
    // 服务端绝不从 Host / x-forwarded-* 推断自身对外地址（见 relay-http.js 的 relayUrl / F-001）。
    streamUrl: relayUrl(`/api/rooms/${room.room.id}/events`),
    streamTicketUrl: relayUrl(`/api/rooms/${room.room.id}/stream-ticket`),
    uploadUrl: relayUrl(`/api/rooms/${room.room.id}/uploads`),
    stateUrl: relayUrl(`/api/rooms/${room.room.id}`)
  }, corsHeaders(req))
}

async function handleUpload(req, res, room, query) {
  const headers = corsHeaders(req)
  const body = await readBody(req)
  const metadata = parseUploadMetadata(req, body, req.headers, query)
  const size = Buffer.from(metadata.contentBase64, 'base64').length

  if (size > MAX_FILE_BYTES) {
    throw new HttpError(413, `File exceeds size limit (${MAX_FILE_BYTES} bytes)`)
  }

  if (isUploadBytesExceeded(req, room.id, body.length)) {
    throw new HttpError(429, `Upload rate exceeded (limit ${MAX_UPLOAD_BYTES_PER_WINDOW} bytes per IP / ${MAX_ROOM_BYTES_PER_WINDOW} bytes per room per window)`)
  }

  // 正文只用于预览/展示，按 UTF-8 边界截断，避免第三方客户端塞入超大正文撑爆内存
  const textField = metadata.text === null ? null : truncateUtf8(metadata.text, MAX_TEXT_BYTES)

  // 元数据也要计入配额：`name` / `mimeType` / `lastModified` / `text` 都会常驻内存，
  // 并进入房间快照与 SSE 帧。过去只按 contentBase64 计费，0 字节文件带数 MB 文件名
  // 就能以 storedBytes=0 通过全部配额检查。
  const metadataBytes = Buffer.byteLength(metadata.name, 'utf8')
    + Buffer.byteLength(metadata.mimeType, 'utf8')
    + Buffer.byteLength(metadata.lastModified, 'utf8')
    + (textField ? Buffer.byteLength(textField.text, 'utf8') : 0)
  const quotaBytes = size + metadataBytes

  // —— 两处原子预留，都必须在任何 await 之前同步完成 ——
  // 条数与字节是两类独立资源，历史上各自被并发绕过过一次（字节 8.39×、条数 10×）。
  const releaseSlot = reserveUploadSlot(room)
  let releaseQuota

  try {
    releaseQuota = reserveStorageQuota(room, quotaBytes)
  } catch (error) {
    releaseSlot()
    throw error
  }

  // 注意：`upload` 对象上**不放** contentBase64 —— 正文只作为落盘入参传一次。
  // 过去它在对象上「赋值 → 落盘后置 null → 响应前又从 metadata 塞回」，字段在三态之间来回抖。
  const upload = {
    id: randomUUID(),
    roomId: room.id,
    name: metadata.name,
    mimeType: metadata.mimeType,
    lastModified: metadata.lastModified,
    uploadedAt: nowIso(),
    size,
    /** 该条上传占用配额的字节数（正文 + 元数据 + 保留文本），回收时按此值扣减 */
    quotaBytes,
    text: textField ? textField.text : null,
    // 两端任一发生截断都要告诉接收端，否则用户以为看到的就是全文
    textTruncated: Boolean(textField?.truncated) || metadata.textTruncatedByClient,
    previewText: textField ? textField.text.slice(0, 4096) : null
  }

  try {
    await persistUpload(upload, metadata.contentBase64)
  } catch (error) {
    // 落盘失败必须退回预占的配额与槽位，否则房间会被永久"占额"
    releaseQuota()
    releaseSlot()
    throw error
  }

  // 落盘期间房间可能已被销毁（绝对上限到期，或收到 DELETE）。
  // 此时必须把刚写下的文件删掉并回滚配额，并明确告知调用方 —— 绝不能返回 201 让
  // 发送方以为成功，而接收端永远收不到（静默丢件）。
  if (room.destroyed || !rooms.has(room.id)) {
    try {
      await rm(upload.storagePath, { force: true })
    } catch (error) {
      auditLog('orphan_file_cleanup_failed', {
        roomId: room.id,
        message: error instanceof Error ? error.message : String(error)
      })
    }
    releaseQuota()
    releaseSlot()
    throw new HttpError(410, 'Room was deleted while the upload was in flight')
  }

  room.uploads.set(upload.id, upload)
  releaseSlot()
  room.stats.uploads += 1
  room.updatedAt = upload.uploadedAt
  room.lastActivity = Date.now()
  // 不记原始文件名：作业名普遍是「学号+姓名」，那是 PII；摘要 + 长度既够归并排查，又不落个人信息。
  // （同时也避免了超长文件名把审计日志放大到 MB 级）
  auditLog('upload_created', {
    roomId: room.id,
    nameLength: upload.name.length,
    nameDigest: digestName(upload.name),
    size
  })

  // 201 响应里带上完整正文（发送方原本就能拿到），广播事件里只带元信息
  const uploadPayload = uploadSummary(upload)
  uploadPayload.contentBase64 = metadata.contentBase64

  const event = dispatchEvent(room, 'upload.created', {
    roomId: room.id,
    upload: uploadSummary(upload, { includeContent: false }),
    downloadUrl: relayUrl(`/api/rooms/${room.id}/uploads/${upload.id}`)
  })

  return writeJson(res, 201, {
    upload: uploadPayload,
    eventId: event.id
  }, headers)
}

async function handleDownload(req, res, room, uploadId, query) {
  const headers = corsHeaders(req)
  const upload = room.uploads.get(uploadId)
  if (!upload) {
    return writeJson(res, 404, { error: 'Upload not found' }, headers)
  }

  const download = query.get('download')
  if (download === '1') {
    // 正文落盘后内存不留副本（见 handleUpload），下载一律从磁盘读回
    const buffer = await readFile(upload.storagePath)
    res.writeHead(200, {
      ...headers,
      'Content-Type': upload.mimeType,
      // 下载是附件语义：加 nosniff 防止浏览器把内容按上传者声明的类型嗅探渲染
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': contentDisposition(upload.name),
      'Content-Length': buffer.length
    })
    res.end(buffer)
    return
  }

  // 落盘后内存里不保留 base64 副本（见 handleUpload），这里从磁盘读回。
  // 这是全仓**唯一**一处「正文 → base64」的产出路径。
  const summary = uploadSummary(upload)
  summary.contentBase64 = (await readFile(upload.storagePath)).toString('base64')

  return writeJson(res, 200, { upload: summary }, headers)
}

function handleEvents(req, res, room) {
  closeReceiver(room)
  sendSseHeaders(res, corsHeaders(req))

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n')
    }
  }, 15000)

  room.receiver = { res, heartbeat }
  room.stats.receiverConnections += 1
  room.lastActivity = Date.now()
  auditLog('receiver_connected', { roomId: room.id })

  writeSseFrame(res, 'receiver.ready', {
    id: randomUUID(),
    type: 'receiver.ready',
    createdAt: nowIso(),
    data: {
      roomId: room.id,
      message: 'Receiver connected'
    }
  })

  while (room.queue.length > 0 && res.writable) {
    const event = room.queue.shift()
    writeSseFrame(res, event.type, event)
    room.stats.eventsDelivered += 1
  }

  req.on('close', () => {
    clearInterval(heartbeat)
    if (room.receiver?.res === res) {
      room.receiver = null
    }
  })
}

async function handleRoomDelete(req, res, roomId) {
  const room = getRoom(roomId)
  if (!room) {
    return writeJson(res, 404, { error: 'Room not found' }, corsHeaders(req))
  }

  const removed = await destroyRoom(room)
  auditLog('room_deleted', { roomId: room.id, dirRemoved: removed })

  // 即使磁盘目录没删干净，房间在服务端也已经不存在了 —— 对外仍报成功，
  // 否则调用方会以为删除失败而反复重试，反而放大问题。
  return writeJson(res, 200, {
    deleted: true,
    roomId: room.id,
    storageRemoved: removed
  }, corsHeaders(req))
}

const server = createServer(async (req, res) => {
  try {
    // 用固定基准解析请求行：只取 pathname 与查询串，**不采信 `Host`**。
    // 请求头不该参与任何服务端内部计算 —— 这里曾经用 Host 当基准，属同类隐患的同一来源。
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname.replace(/\/+$/u, '') || '/'

    const cors = corsHeaders(req)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Max-Age': '86400'
      })
      res.end()
      return
    }

    // 速率限制：/api 请求按来源 IP 计数，超出上限返回 429
    if (pathname.startsWith('/api/') && isRateLimited(req)) {
      auditLog('rate_limited', { ip: req.socket.remoteAddress, path: pathname })
      writeJson(res, 429, { error: 'Too many requests' }, cors)
      return
    }

    if (req.method === 'GET' && pathname === '/') {
      writeJson(res, 200, {
        name: 'Coolector Relay Server',
        status: 'ok',
        routes: {
          createRoom: 'POST /api/rooms',
          roomState: 'GET /api/rooms/:roomId',
          receiverStream: 'GET /api/rooms/:roomId/events',
          streamTicket: 'POST /api/rooms/:roomId/stream-ticket',
          upload: 'POST /api/rooms/:roomId/uploads',
          uploadDetails: 'GET /api/rooms/:roomId/uploads/:uploadId',
          download: 'GET /api/rooms/:roomId/uploads/:uploadId?download=1',
          deleteRoom: 'DELETE /api/rooms/:roomId',
          healthz: 'GET /healthz'
        },
        authRequired: Boolean(RELAY_TOKEN)
        // 刻意不再暴露用量与上限：这两个数字对匿名访问者没有价值，
        // 却能帮他判断「服务有多少存量、离打满还有多远」。房间维度的用量在
        // 需鉴权的房间快照里照常可见（接收端面板的「存储用量」不受影响）。
      }, cors)
      return
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      // 只回存活状态：健康检查只需要一个 200；房间数/uptime 属可被匿名收集的运营信息
      writeJson(res, 200, { status: 'ok' }, cors)
      return
    }

    // /api 下统一走鉴权，但有两类例外：
    // 1) 发送方公开写：POST /api/rooms/:roomId/uploads 不要求凭据 —— 发送方（学生）本就不该持有
    //    接收端管理密钥，房间 ID 本身就是不可猜的能力凭据；配合限流与体积上限控制滥用。
    // 2) SSE 一次性票据：EventSource 无法自定义请求头，用短时效票据替代长期 token。
    if (pathname.startsWith('/api/') && !isAuthorized(req) && !isStreamTicketAuthorized(req, pathname) && !isPublicUpload(req, pathname)) {
      auditLog('auth_failed', { method: req.method, path: pathname, ip: req.socket.remoteAddress })
      writeJson(res, 401, { error: 'Unauthorized' }, cors)
      return
    }

    if (req.method === 'POST' && pathname === '/api/rooms') {
      await handleCreateRoom(req, res)
      return
    }

    const roomMatch = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(events|uploads|stream-ticket)(?:\/([^/]+))?)?$/u)
    if (!roomMatch) {
      writeJson(res, 404, { error: 'Not found' }, cors)
      return
    }

    const [, roomIdRaw, subresource, subresourceId] = roomMatch
    const roomId = sanitizeRoomId(roomIdRaw)
    if (!roomId) {
      writeJson(res, 400, { error: 'Invalid room id' }, cors)
      return
    }

    // 房间必须由接收端（持凭据）先创建。取消「上传即建房」是因为：发送方落进一个
    // 没有接收端的房间等于进黑洞，且允许自造 ID 建房会让任何人无限占用内存与磁盘。
    const room = getRoom(roomId)
    if (!room) {
      writeJson(res, 404, { error: 'Room not found or expired' }, cors)
      return
    }

    if (req.method === 'GET' && !subresource) {
      writeJson(res, 200, roomSnapshot(room), cors)
      return
    }

    if (req.method === 'DELETE' && !subresource) {
      await handleRoomDelete(req, res, roomId)
      return
    }

    if (req.method === 'POST' && subresource === 'stream-ticket') {
      const ticket = streamTickets.issue(room.id)
      auditLog('stream_ticket_issued', { roomId: room.id, ip: req.socket.remoteAddress })
      writeJson(res, 201, { ticket, expiresInMs: STREAM_TICKET_TTL_MS }, cors)
      return
    }

    if (req.method === 'GET' && subresource === 'events') {
      handleEvents(req, res, room)
      return
    }

    if (req.method === 'POST' && subresource === 'uploads') {
      await handleUpload(req, res, room, url.searchParams)
      return
    }

    if (req.method === 'GET' && subresource === 'uploads' && subresourceId) {
      await handleDownload(req, res, room, subresourceId, url.searchParams)
      return
    }

    writeJson(res, 405, { error: 'Method not allowed' }, cors)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error'
    // 只记 pathname：完整 req.url 会带上 SSE 一次性票据（虽然在 URL 里，但没必要落进日志）
    auditLog('request_error', { path: String(req.url ?? '').split('?')[0], message })

    // HttpError 的 message 由本服务自行构造，可安全回传给客户端（400/413/507 等）
    if (error instanceof HttpError) {
      writeJson(res, error.statusCode, { error: error.message }, corsHeaders(req))
      return
    }

    // 任何未包装的异常一律脱敏，细节只落审计日志
    writeJson(res, 400, { error: 'Bad request' }, corsHeaders(req))
  }
})

setInterval(() => {
  const now = Date.now()
  // 三个限流桶：按来源 IP 的请求计数、按来源 IP 的字节、按房间的字节
  for (const store of [rateBuckets, uploadByteBuckets, roomByteBuckets]) {
    for (const [key, bucket] of store) {
      if (bucket.resetAt <= now) store.delete(key)
    }
  }
}, RATE_LIMIT_WINDOW_MS).unref()

setInterval(() => {
  // 定时任务绝不允许抛未处理拒绝 —— 那会让整个 relay 进程退出
  cleanupRooms().catch((error) => {
    console.error(`[relay] 房间清理任务异常：${error instanceof Error ? error.message : error}`)
  })
}, ROOM_CLEANUP_INTERVAL_MS).unref()

// fail-closed：非回环监听且未配置 RELAY_TOKEN 时拒绝启动，防止公网裸奔
if (!RELAY_TOKEN && !isLoopbackHost(HOST)) {
  console.error('[relay] 拒绝启动：未设置 RELAY_TOKEN 时仅允许监听回环地址（127.0.0.1 / localhost / ::1）。')
  console.error(`[relay] 当前 HOST=${HOST}。请在 .env 设置 RELAY_TOKEN，或将 HOST 改为回环地址用于本地调试。`)
  process.exit(1)
}

// 未配置 CORS 白名单时明确告知，避免「前端请求全被浏览器拦掉」被误诊为服务端故障。
// 这是刻意的 fail-closed 默认值：公开写路径本就免凭据，默认放开跨源等于允许任意站点灌文件。
if (ALLOWED_ORIGINS.length === 0) {
  console.warn('[relay] 未配置 RELAY_ALLOWED_ORIGINS：不发送任何 CORS 头，跨源前端会被浏览器拦截。')
  console.warn('[relay] 同源部署无需配置；前后端不同源时请显式白名单，例：RELAY_ALLOWED_ORIGINS=https://app.example.com')
}

await initStoredBytes()

server.listen(PORT, HOST, () => {
  console.log(`Relay server listening on http://${HOST}:${PORT}`)
})
