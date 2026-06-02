import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 10 * 1024 * 1024)
const MAX_QUEUE_EVENTS = Number(process.env.MAX_QUEUE_EVENTS ?? 200)
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS ?? 6 * 60 * 60 * 1000)
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? fileURLToPath(new URL('./uploads', import.meta.url))

const rooms = new Map()

function nowIso() {
  return new Date().toISOString()
}

function baseUrl(req) {
  const forwardedProto = req.headers['x-forwarded-proto']
  const protocol = typeof forwardedProto === 'string' ? forwardedProto : 'http'
  const host = req.headers.host ?? `localhost:${PORT}`
  return `${protocol}://${host}`
}

function sanitizeRoomId(roomId) {
  if (!roomId || typeof roomId !== 'string') return null
  const normalized = roomId.trim()
  return /^[a-zA-Z0-9_-]{4,64}$/.test(normalized) ? normalized : null
}

function createRoom(roomId = randomUUID().slice(0, 8)) {
  const id = sanitizeRoomId(roomId)
  if (!id) {
    throw new Error('Invalid room id')
  }

  const existing = rooms.get(id)
  if (existing) {
    return { room: existing, created: false }
  }

  const room = {
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastActivity: Date.now(),
    receiver: null,
    queue: [],
    uploads: new Map(),
    stats: {
      receiverConnections: 0,
      uploads: 0,
      eventsDelivered: 0
    }
  }

  rooms.set(id, room)
  return { room, created: true }
}

function getRoom(roomId) {
  const id = sanitizeRoomId(roomId)
  if (!id) return null
  return rooms.get(id) ?? null
}

function roomSnapshot(room, req) {
  const uploads = Array.from(room.uploads.values())
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
    .map((upload) => uploadSummary(upload, req))

  return {
    roomId: room.id,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    hasReceiver: Boolean(room.receiver),
    queuedEvents: room.queue.length,
    uploadCount: room.uploads.size,
    stats: room.stats,
    uploads
  }
}

function uploadSummary(upload, req) {
  const detailsUrl = `${baseUrl(req)}/api/rooms/${upload.roomId}/uploads/${upload.id}`
  const summary = {
    id: upload.id,
    name: upload.name,
    mimeType: upload.mimeType,
    size: upload.size,
    uploadedAt: upload.uploadedAt,
    lastModified: upload.lastModified,
    hasTextPreview: Boolean(upload.previewText),
    previewText: upload.previewText ?? null,
    contentText: upload.text ?? null,
    contentBase64: upload.contentBase64,
    detailsUrl,
    downloadUrl: `${detailsUrl}?download=1`,
    serverStored: Boolean(upload.storagePath),
    storageFileName: upload.storageFileName ?? null,
    storageRelativePath: upload.storagePath ? relative(UPLOAD_DIR, upload.storagePath) : null
  }

  return summary
}

function trimQueue(room) {
  while (room.queue.length > MAX_QUEUE_EVENTS) {
    room.queue.shift()
  }
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Filename, X-Relay-Mime-Type, X-Relay-Last-Modified, X-Relay-Text-Preview'
  })
  res.end(body)
}

function writeText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Filename, X-Relay-Mime-Type, X-Relay-Last-Modified, X-Relay-Text-Preview'
  })
  res.end(body)
}

function writeSseFrame(res, eventName, payload) {
  res.write(`event: ${eventName}\n`)
  res.write(`id: ${payload.id}\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function closeReceiver(room) {
  if (!room.receiver) return

  const { res, heartbeat } = room.receiver
  clearInterval(heartbeat)
  room.receiver = null

  if (!res.writableEnded) {
    res.end()
  }
}

function queueEvent(room, event) {
  room.queue.push(event)
  trimQueue(room)
}

function dispatchEvent(room, eventName, data) {
  const event = {
    id: randomUUID(),
    type: eventName,
    createdAt: nowIso(),
    data
  }

  room.updatedAt = event.createdAt
  room.lastActivity = Date.now()

  if (room.receiver && room.receiver.res.writable) {
    try {
      writeSseFrame(room.receiver.res, eventName, event)
      room.stats.eventsDelivered += 1
      return event
    } catch {
      closeReceiver(room)
    }
  }

  queueEvent(room, event)
  return event
}

function isTextMimeType(mimeType, fileName) {
  if (mimeType.startsWith('text/')) return true
  return /\.(txt|md|json|xml|csv|log|conf|ini|yaml|yml|env|toml|sql|js|ts|tsx|jsx|css|scss|html|htm)$/i.test(fileName)
}

function sanitizeStorageFileName(fileName) {
  const safeBaseName = basename(String(fileName))
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/^\.+$/, 'file')
    .trim()

  return (safeBaseName || 'file').slice(0, 180)
}

async function persistUpload(upload) {
  const storageFileName = `${upload.id}-${sanitizeStorageFileName(upload.name)}`
  const roomUploadDir = join(UPLOAD_DIR, upload.roomId)
  const storagePath = join(roomUploadDir, storageFileName)
  const buffer = Buffer.from(upload.contentBase64, 'base64')

  await mkdir(roomUploadDir, { recursive: true })
  await writeFile(storagePath, buffer)

  upload.storagePath = storagePath
  upload.storageFileName = storageFileName
}

function parseUploadMetadata(req, bodyBuffer, headers, query) {
  const contentType = String(req.headers['content-type'] ?? '')
  if (contentType.includes('application/json')) {
    const raw = bodyBuffer.length ? JSON.parse(bodyBuffer.toString('utf8')) : {}
    const fileName = raw.name ?? raw.fileName ?? headers['x-relay-filename'] ?? query.get('name')
    if (!fileName) {
      throw new Error('Missing file name')
    }

    const mimeType = raw.mimeType ?? headers['x-relay-mime-type'] ?? 'text/plain'
    const lastModified = raw.lastModified ?? headers['x-relay-last-modified'] ?? nowIso()
    const text = typeof raw.text === 'string' ? raw.text : typeof raw.contentText === 'string' ? raw.contentText : null
    const contentBase64 = typeof raw.contentBase64 === 'string'
      ? raw.contentBase64
      : text !== null
        ? Buffer.from(text, 'utf8').toString('base64')
        : typeof raw.content === 'string'
          ? Buffer.from(raw.content, 'utf8').toString('base64')
          : null

    if (!contentBase64) {
      throw new Error('Missing file content')
    }

    const decoded = Buffer.from(contentBase64, 'base64')
    return {
      name: String(fileName),
      mimeType: String(mimeType),
      lastModified: String(lastModified),
      contentBase64,
      text: text ?? (isTextMimeType(String(mimeType), String(fileName)) ? decoded.toString('utf8') : null)
    }
  }

  const fileName = headers['x-relay-filename'] ?? query.get('name')
  if (!fileName) {
    throw new Error('Missing file name')
  }

  const mimeType = headers['x-relay-mime-type'] ?? 'application/octet-stream'
  const lastModified = headers['x-relay-last-modified'] ?? nowIso()
  const contentBase64 = bodyBuffer.toString('base64')
  const text = isTextMimeType(String(mimeType), String(fileName))
    ? bodyBuffer.toString('utf8')
    : null

  return {
    name: String(fileName),
    mimeType: String(mimeType),
    lastModified: String(lastModified),
    contentBase64,
    text
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Filename, X-Relay-Mime-Type, X-Relay-Last-Modified, X-Relay-Text-Preview'
  })
  res.flushHeaders?.()
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

  const room = createRoom(requestedId ?? undefined)
  if (room.created) {
    dispatchEvent(room.room, 'room.created', {
      roomId: room.room.id,
      createdAt: room.room.createdAt
    })
  }

  return writeJson(res, 201, {
    roomId: room.room.id,
    createdAt: room.room.createdAt,
    streamUrl: `${baseUrl(req)}/api/rooms/${room.room.id}/events`,
    uploadUrl: `${baseUrl(req)}/api/rooms/${room.room.id}/uploads`,
    stateUrl: `${baseUrl(req)}/api/rooms/${room.room.id}`
  })
}

async function handleUpload(req, res, room, query) {
  const body = await readBody(req)
  const metadata = parseUploadMetadata(req, body, req.headers, query)
  const upload = {
    id: randomUUID(),
    roomId: room.id,
    name: metadata.name,
    mimeType: metadata.mimeType,
    lastModified: metadata.lastModified,
    uploadedAt: nowIso(),
    size: Buffer.from(metadata.contentBase64, 'base64').length,
    contentBase64: metadata.contentBase64,
    text: metadata.text,
    previewText: metadata.text ? metadata.text.slice(0, 4096) : null
  }

  await persistUpload(upload)

  room.uploads.set(upload.id, upload)
  room.stats.uploads += 1
  room.updatedAt = upload.uploadedAt
  room.lastActivity = Date.now()

  const uploadPayload = uploadSummary(upload, req)
  const event = dispatchEvent(room, 'upload.created', {
    roomId: room.id,
    upload: uploadPayload,
    downloadUrl: `${baseUrl(req)}/api/rooms/${room.id}/uploads/${upload.id}`
  })

  return writeJson(res, 201, {
    upload: uploadPayload,
    eventId: event.id
  })
}

async function handleDownload(req, res, room, uploadId, query) {
  const upload = room.uploads.get(uploadId)
  if (!upload) {
    return writeJson(res, 404, { error: 'Upload not found' })
  }

  const download = query.get('download')
  if (download === '1') {
    const buffer = upload.storagePath
      ? await readFile(upload.storagePath)
      : Buffer.from(upload.contentBase64, 'base64')
    res.writeHead(200, {
      'Content-Type': upload.mimeType,
      'Content-Disposition': `attachment; filename="${upload.name.replaceAll('"', '\\"')}"`,
      'Content-Length': buffer.length,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Filename, X-Relay-Mime-Type, X-Relay-Last-Modified, X-Relay-Text-Preview'
    })
    res.end(buffer)
    return
  }

  return writeJson(res, 200, {
    upload: uploadSummary(upload, req),
    text: upload.previewText,
    contentBase64: upload.contentBase64
  })
}

function handleEvents(req, res, room) {
  closeReceiver(room)
  sendSseHeaders(res)

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n')
    }
  }, 15000)

  room.receiver = { res, heartbeat }
  room.stats.receiverConnections += 1
  room.lastActivity = Date.now()

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

function handleRoomDelete(req, res, roomId) {
  const room = getRoom(roomId)
  if (!room) {
    return writeJson(res, 404, { error: 'Room not found' })
  }

  closeReceiver(room)
  rooms.delete(room.id)
  void rm(join(UPLOAD_DIR, room.id), { recursive: true, force: true })
  return writeJson(res, 200, {
    deleted: true,
    roomId: room.id
  })
}

function cleanupRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS
  for (const room of rooms.values()) {
    if (room.lastActivity < cutoff && !room.receiver && room.uploads.size === 0) {
      rooms.delete(room.id)
    }
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${PORT}`}`)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Filename, X-Relay-Mime-Type, X-Relay-Last-Modified, X-Relay-Text-Preview',
        'Access-Control-Max-Age': '86400'
      })
      res.end()
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
          upload: 'POST /api/rooms/:roomId/uploads',
          uploadDetails: 'GET /api/rooms/:roomId/uploads/:uploadId',
          download: 'GET /api/rooms/:roomId/uploads/:uploadId?download=1',
          deleteRoom: 'DELETE /api/rooms/:roomId',
          healthz: 'GET /healthz'
        },
        uploadDir: UPLOAD_DIR
      })
      return
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      writeJson(res, 200, {
        status: 'ok',
        rooms: rooms.size,
        uptimeSeconds: Math.floor(process.uptime())
      })
      return
    }

    if (req.method === 'POST' && pathname === '/api/rooms') {
      await handleCreateRoom(req, res)
      return
    }

    const roomMatch = pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(events|uploads)(?:\/([^/]+))?)?$/)
    if (!roomMatch) {
      writeJson(res, 404, { error: 'Not found' })
      return
    }

    const [, roomIdRaw, subresource, subresourceId] = roomMatch
    const roomId = sanitizeRoomId(roomIdRaw)
    if (!roomId) {
      writeJson(res, 400, { error: 'Invalid room id' })
      return
    }

    let room = getRoom(roomId)
    if (!room && req.method !== 'POST') {
      writeJson(res, 404, { error: 'Room not found' })
      return
    }

    if (!room && req.method === 'POST' && subresource === 'uploads') {
      room = createRoom(roomId).room
    }

    if (req.method === 'GET' && !subresource) {
      writeJson(res, 200, roomSnapshot(room, req))
      return
    }

    if (req.method === 'DELETE' && !subresource) {
      handleRoomDelete(req, res, roomId)
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

    writeJson(res, 405, { error: 'Method not allowed' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error'
    writeJson(res, 400, { error: message })
  }
})

setInterval(cleanupRooms, 30 * 60 * 1000).unref()

server.listen(PORT, HOST, () => {
  console.log(`Relay server listening on http://${HOST}:${PORT}`)
})
