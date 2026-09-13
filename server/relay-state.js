// 房间状态、资源记账与生命周期。所有可变状态集中在这里，便于单测与审阅。
//
// ⚠️ 本模块是**唯一**允许改动配额计数（room.storedBytes / totalStoredBytes）的地方，
// 且所有「检查 + 消耗」都必须走 reserveStorageQuota / reserveUploadSlot 两个原子原语。

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizeRoomId, sanitizeStorageFileName } from './relay-utils.js'
import {
  KEEP_ORPHAN_UPLOADS, MAX_QUEUE_EVENTS, MAX_ROOM_UPLOAD_BYTES,
  MAX_ROOM_UPLOADS, MAX_TOTAL_UPLOAD_BYTES, ROOM_MAX_LIFETIME_MS, ROOM_TTL_MS, UPLOAD_DIR
} from './relay-config.js'
import { HttpError, auditLog, nowIso, relayUrl, writeSseFrame } from './relay-http.js'

const rooms = new Map()


/** 已落盘的字节总数，用于配额判断；进程重启后重新累计。 */
let totalStoredBytes = 0


function createRoom(roomId = randomUUID()) {
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
    /** 本房间已占用的字节数（正文 + 元数据 + 保留文本），用于单房间配额 */
    storedBytes: 0,
    /** 已预占但尚未完成落盘的上传条数（见 reserveUploadSlot） */
    pendingUploads: 0,
    /** 是否已被销毁：用于让在途上传感知到「房间已没了」而不是静默写入 */
    destroyed: false,
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


/**
 * 原子预留存储配额 —— 本项目**唯一**允许增加 `room.storedBytes` / `totalStoredBytes` 的入口。
 *
 * 检查与扣减必须**同步**完成：一旦中间插入 `await`，并发请求会全部读到旧值而击穿配额
 * （实测 32 并发可把 4MB 配额打到 8.39×）。返回值是回滚函数，落盘失败时必须调用。
 */
function reserveStorageQuota(room, quotaBytes) {
  if (room.storedBytes + quotaBytes > MAX_ROOM_UPLOAD_BYTES) {
    throw new HttpError(507, `Room storage quota exceeded (limit ${MAX_ROOM_UPLOAD_BYTES} bytes)`)
  }
  if (totalStoredBytes + quotaBytes > MAX_TOTAL_UPLOAD_BYTES) {
    throw new HttpError(507, `Upload storage quota exceeded (limit ${MAX_TOTAL_UPLOAD_BYTES} bytes)`)
  }

  room.storedBytes += quotaBytes
  totalStoredBytes += quotaBytes

  return () => {
    // 房间已被销毁时，它的占用已经在 destroyRoom 里整体回收过了 —— 这里再减就会把
    // 其它房间的额度一起吃掉（全局计数被多减）。故以 destroyed 标记短路。
    if (room.destroyed) return
    room.storedBytes = Math.max(room.storedBytes - quotaBytes, 0)
    totalStoredBytes = Math.max(totalStoredBytes - quotaBytes, 0)
  }
}


/**
 * 原子预留一个上传槽位。
 *
 * 与配额同理：必须把「正在落盘中」的请求也计入，否则并发下每个请求都只看到
 * `uploads.size` 的旧值（实测限额 5、50 并发可全部通过）。成功落盘后调用返回的函数，
 * 此时 `uploads.size` 已经加过，`pendingUploads` 减回，账目守恒。
 */
function reserveUploadSlot(room) {
  if (room.uploads.size + room.pendingUploads >= MAX_ROOM_UPLOADS) {
    throw new HttpError(429, `Room upload count limit reached (limit ${MAX_ROOM_UPLOADS})`)
  }

  room.pendingUploads += 1
  let released = false

  return () => {
    if (released) return
    released = true
    room.pendingUploads = Math.max(room.pendingUploads - 1, 0)
  }
}


function roomSnapshot(room) {
  // 房间状态只暴露元信息与下载链接，正文走 details 端点按需拉取
  const uploads = Array.from(room.uploads.values())
    .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
    .map((upload) => uploadSummary(upload, { includeContent: false }))

  return {
    roomId: room.id,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    hasReceiver: Boolean(room.receiver),
    queuedEvents: room.queue.length,
    uploadCount: room.uploads.size,
    storedBytes: room.storedBytes,
    storageLimitBytes: MAX_ROOM_UPLOAD_BYTES,
    stats: room.stats,
    uploads
  }
}


/**
 * 生成上传摘要；SSE 广播传 includeContent:false 只推元信息，正文按需走 details 端点。
 *
 * 刻意**不接受 `req`**：URL 由 relayUrl 生成（相对路径或运维配置的基址），
 * 绝不让请求头参与拼接 —— 见 relay-http.js 的 relayUrl 与 F-001。
 */
function uploadSummary(upload, { includeContent = true } = {}) {
  const detailsPath = `/api/rooms/${upload.roomId}/uploads/${upload.id}`
  const summary = {
    id: upload.id,
    name: upload.name,
    mimeType: upload.mimeType,
    size: upload.size,
    uploadedAt: upload.uploadedAt,
    lastModified: upload.lastModified,
    previewText: upload.previewText ?? null,
    /** 正文是否因超过 MAX_TEXT_BYTES 被截断（前端据此提示用户） */
    textTruncated: Boolean(upload.textTruncated),
    contentIncluded: includeContent,
    contentText: includeContent ? upload.text ?? null : null,
    contentBase64: includeContent ? upload.contentBase64 : null,
    detailsUrl: relayUrl(detailsPath),
    downloadUrl: relayUrl(`${detailsPath}?download=1`),
    // 只暴露「是否已落盘」，不返回服务端存储文件名/相对路径，避免路径信息泄露
    serverStored: Boolean(upload.storagePath)
  }

  return summary
}


function trimQueue(room) {
  while (room.queue.length > MAX_QUEUE_EVENTS) {
    room.queue.shift()
  }
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


/**
 * 房间目录的归属标记文件名。
 *
 * 启动回收**只删**「内含该标记、且标记里的 roomId 与目录名一致」的目录。
 * 没有这一层守卫的话，一个无差别的 `rm -rf` 在 `UPLOAD_DIR` 指向卷根时会删掉无关数据
 * （实测把 `notes.backup/`、`my notes/` 一起删光）。
 */
const ROOM_SENTINEL_FILENAME = '.coolector-room'


async function writeRoomSentinel(roomUploadDir, roomId) {
  const payload = JSON.stringify({ generator: 'coolector-relay', version: 1, roomId })
  await writeFile(join(roomUploadDir, ROOM_SENTINEL_FILENAME), payload, 'utf8')
}


/** 读取目录归属标记；缺失 / 损坏 / 非本程序所写一律返回 null（此时**绝不删除**） */
async function readRoomSentinel(roomUploadDir) {
  try {
    const raw = await readFile(join(roomUploadDir, ROOM_SENTINEL_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.generator !== 'coolector-relay') return null
    return typeof parsed.roomId === 'string' ? parsed.roomId : null
  } catch {
    return null
  }
}


async function persistUpload(upload, contentBase64 = '') {
  const roomUploadDir = join(UPLOAD_DIR, upload.roomId)
  const storageFileName = `${upload.id}-${sanitizeStorageFileName(upload.name)}`
  const storagePath = join(roomUploadDir, storageFileName)
  const buffer = Buffer.from(contentBase64, 'base64')

  await mkdir(roomUploadDir, { recursive: true })
  // 先写归属标记再写正文，保证目录一旦有内容就一定带标记
  await writeRoomSentinel(roomUploadDir, upload.roomId)
  await writeFile(storagePath, buffer)

  upload.storagePath = storagePath
  upload.storageFileName = storageFileName
}


/**
 * 删除房间并回收其占用的磁盘配额。
 *
 * **错误隔离**：`rm` 失败（文件被占用、权限不足等）绝不允许冒泡 —— 清理任务由定时器驱动，
 * 未处理的拒绝会让整个 relay 进程退出（实测 exit=1，整站下线）。
 * 删除失败时返回 false，由调用方记录并等待下次重试。
 */
async function destroyRoom(room, { removeDir = rm } = {}) {
  // 先置标记：在途上传据此判断「房间已经没了」，避免落盘后静默写入无人认领的文件
  room.destroyed = true
  closeReceiver(room)
  rooms.delete(room.id)

  totalStoredBytes = Math.max(totalStoredBytes - (room.storedBytes ?? 0), 0)
  room.storedBytes = 0
  room.pendingUploads = 0
  room.uploads.clear()

  const roomDir = join(UPLOAD_DIR, room.id)

  try {
    await removeDir(roomDir, { recursive: true, force: true })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    auditLog('room_delete_failed', { roomId: room.id, message })
    console.error(`[relay] 房间目录删除失败，留待下次重试或人工清理：${roomDir} —— ${message}`)
    return false
  }
}


async function cleanupRooms({ removeDir = rm } = {}) {
  const now = Date.now()
  const idleCutoff = now - ROOM_TTL_MS
  const expired = []

  for (const room of rooms.values()) {
    const age = now - new Date(room.createdAt).getTime()
    // 空闲回收：无接收端且长时间无活动（上传会刷新 lastActivity，这是有意的）
    const expiredByIdle = room.lastActivity < idleCutoff && !room.receiver
    // 绝对年龄上限：**不豁免 receiver** —— 否则持一条 SSE 连接就能把房间与配额永久钉住，
    // 「绝对上限」也就名不副实了。
    const expiredByAge = age > ROOM_MAX_LIFETIME_MS

    if (expiredByIdle || expiredByAge) {
      expired.push({ room, age, reason: expiredByAge ? 'max_lifetime' : 'idle' })
    }
  }

  // 每个房间独立处理：一个房间删除失败不能中断整轮清理（否则后续房间永远等不到回收）
  for (const { room, age, reason } of expired) {
    auditLog('room_expired', {
      roomId: room.id,
      reason,
      ageMs: age,
      storedBytes: room.storedBytes ?? 0
    })

    try {
      await destroyRoom(room, { removeDir })
    } catch (error) {
      // destroyRoom 内部已经吞掉了 rm 失败；这里兜住任何意外，保证清理循环不中断
      auditLog('room_expire_failed', {
        roomId: room.id,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  if (totalStoredBytes < 0) {
    totalStoredBytes = 0
  }
}


/**
 * 启动时扫描 UPLOAD_DIR。
 *
 * 房间只存在于内存，所以**启动瞬间磁盘上的每个目录都是「无主目录」** ——
 * 它们已无法通过任何 HTTP 路径访问（房间 404），却会被永久计入全局配额、把磁盘占住。
 *
 * ⚠️ 但回收**必须可判定**：只删「内含本程序写的归属标记、且标记里的 roomId 与目录名一致」的目录。
 * 无标记 / 标记不匹配 / 标记损坏的目录一律**不动**（宁可留一点占用，也不能误删运维自己的数据），
 * 并且不计入配额 —— 它们不是本程序产生的，与配额无关。
 */
async function measureDirectoryBytes(dirPath) {
  let total = 0
  const files = await readdir(dirPath, { withFileTypes: true })

  for (const file of files) {
    if (!file.isFile()) continue
    const fileStat = await stat(join(dirPath, file.name))
    total += fileStat.size
  }

  return total
}


async function initStoredBytes() {
  totalStoredBytes = 0

  let entries
  try {
    entries = await readdir(UPLOAD_DIR, { withFileTypes: true })
  } catch {
    // 目录不存在（首次启动），无需初始化
    return
  }

  let reclaimedDirs = 0
  let reclaimedBytes = 0
  let keptBytes = 0
  const foreignDirs = []
  let strayFiles = 0

  for (const entry of entries) {
    const entryPath = join(UPLOAD_DIR, entry.name)

    if (!entry.isDirectory()) {
      strayFiles += 1
      continue
    }

    const sentinelRoomId = await readRoomSentinel(entryPath)
    if (!sentinelRoomId || sentinelRoomId !== entry.name || !sanitizeRoomId(sentinelRoomId)) {
      foreignDirs.push(entry.name)
      continue
    }

    let dirBytes = 0
    try {
      dirBytes = await measureDirectoryBytes(entryPath)
    } catch {
      foreignDirs.push(entry.name)
      continue
    }

    if (KEEP_ORPHAN_UPLOADS) {
      keptBytes += dirBytes
      continue
    }

    try {
      await rm(entryPath, { recursive: true, force: true })
      reclaimedDirs += 1
      reclaimedBytes += dirBytes
    } catch (error) {
      // 删不掉就保留并计入配额 —— 启动过程绝不能因为一个目录删不掉而失败
      keptBytes += dirBytes
      console.warn(`[relay] 无主上传目录删除失败，已保留并计入配额：${entryPath} —— ${error instanceof Error ? error.message : error}`)
    }
  }

  if (reclaimedDirs > 0) {
    auditLog('orphan_uploads_reclaimed', { dirs: reclaimedDirs, bytes: reclaimedBytes })
    console.log(`[relay] 已回收 ${reclaimedDirs} 个无主上传目录（${reclaimedBytes} 字节）：房间仅存于内存，重启后这些文件已不可访问。`)
  }
  if (keptBytes > 0) {
    console.warn(`[relay] 保留了 ${keptBytes} 字节无主上传文件（RELAY_KEEP_ORPHAN_UPLOADS=true 或删除失败）：仍计入配额，只能人工清理。`)
  }
  if (foreignDirs.length > 0) {
    // 这里是刻意不删、也不计账的：无法证明它们是本程序产生的
    console.warn(`[relay] ⚠️ UPLOAD_DIR 下有 ${foreignDirs.length} 个目录不属于本程序（无有效归属标记），已跳过、不计入配额、也不会被删除：`)
    console.warn(`[relay]    ${foreignDirs.slice(0, 10).join(', ')}${foreignDirs.length > 10 ? ` …（共 ${foreignDirs.length} 个）` : ''}`)
    console.warn('[relay]    若确认这些是历史版本遗留的上传目录，请人工删除或迁移；UPLOAD_DIR 建议指向专用子目录。')
  }
  if (strayFiles > 0) {
    console.warn(`[relay] UPLOAD_DIR 根目录下有 ${strayFiles} 个散落文件：既不计入配额也不会被回收，请确认 UPLOAD_DIR 配置是否正确。`)
  }

  totalStoredBytes = keptBytes
}



export {
  rooms,
  totalStoredBytes,
  createRoom,
  getRoom,
  reserveStorageQuota,
  reserveUploadSlot,
  roomSnapshot,
  uploadSummary,
  trimQueue,
  closeReceiver,
  queueEvent,
  dispatchEvent,
  ROOM_SENTINEL_FILENAME,
  writeRoomSentinel,
  readRoomSentinel,
  persistUpload,
  destroyRoom,
  cleanupRooms,
  measureDirectoryBytes,
  initStoredBytes
}
