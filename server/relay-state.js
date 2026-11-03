// 房间状态、资源记账与生命周期。所有可变状态集中在这里，便于单测与审阅。
//
// ⚠️ 本模块是**唯一**允许改动配额计数（room.storedBytes / totalStoredBytes）的地方，
// 且所有「检查 + 消耗」都必须走 reserveStorageQuota / reserveUploadSlot 两个原子原语。

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { normalizeIsoDate, sanitizeMimeType, sanitizeRoomId, sanitizeStorageFileName } from './relay-utils.js'
import {
  MAX_QUEUE_EVENTS, MAX_ROOM_UPLOAD_BYTES,
  MAX_ROOM_UPLOADS, MAX_TOTAL_UPLOAD_BYTES, PREVIEW_TEXT_CHARS, ROOM_MAX_LIFETIME_MS, ROOM_TTL_MS, SSE_MAX_BUFFERED_BYTES, UPLOAD_DIR
} from './relay-config.js'
import { HttpError, auditLog, nowIso, relayUrl, writeSseFrame } from './relay-http.js'

/**
 * 一条落进房间的上传（内存态）。字段与 relay-server 的 parseUploadMetadata 产物一一对应。
 *
 * 其中只有 `storageFileName` / `previewText` / `textTruncated` 会持久化（见 serializeRoom）：
 * 正文 `text` 是**字节的纯函数**（`deriveUploadText`），重启后按需从磁盘重新推导即可，
 * 把它写进元数据会让每个房间的元数据文件随文本类作业线性膨胀到几百 MB。
 *
 * @typedef {object} Upload
 * @property {string} id
 * @property {string} roomId
 * @property {string} name
 * @property {string} mimeType
 * @property {string} lastModified
 * @property {string} uploadedAt
 * @property {number} size
 * @property {number} quotaBytes
 * @property {string | null} text 本进程内上传过才有；重启后为 null，由 details 端点按需推导
 * @property {boolean} textTruncated
 * @property {string | null} previewText
 * @property {string} [storagePath] 落盘后的绝对路径；未落盘时不存在
 * @property {string} [storageFileName] 落盘后的文件名；未落盘时不存在
 */

/**
 * 房间内存态。**字段即契约**：`serverStored`、下载链接等都从这里派生。
 *
 * @typedef {object} Room
 * @property {string} id
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {number} lastActivity
 * @property {{ res: import('node:http').ServerResponse, heartbeat: NodeJS.Timeout } | null} receiver
 * @property {{ id: string, type: string, createdAt: string, data: unknown }[]} queue
 * @property {Map<string, Upload>} uploads
 * @property {number} storedBytes
 * @property {number} pendingUploads
 * @property {boolean} destroyed
 * @property {Promise<void>} metadataChain 元数据写入的串行链（并发上传不得互相覆盖）
 * @property {{ receiverConnections: number, uploads: number, eventsDelivered: number }} stats
 */

/** @type {Map<string, Room>} */
const rooms = new Map()


/** 已落盘的字节总数，用于配额判断；进程启动时按磁盘上的房间元数据重建。 */
let totalStoredBytes = 0


/**
 * 构造一个房间内存态（**不**入 rooms Map）。
 *
 * 与 `createRoom` 分开是为了让恢复路径复用同一份字段定义：恢复出来的房间只多带
 * 持久化的 `createdAt` / `updatedAt`，其余字段（含 `metadataChain`、`stats`）必须完全一致，
 * 否则「恢复的房间」与「新建的房间」会走上两条不同的代码路径。
 *
 * @param {string} id 已归一化的房间 ID
 * @param {{ createdAt?: string, updatedAt?: string }} [persisted]
 * @returns {Room}
 */
function makeRoom(id, { createdAt, updatedAt } = {}) {
  const timestamp = nowIso()

  return {
    id,
    createdAt: createdAt ?? timestamp,
    updatedAt: updatedAt ?? timestamp,
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
    /** 元数据写入串行链：并发上传各自触发一次全量写，必须排队，否则后写覆盖先写 */
    metadataChain: Promise.resolve(),
    stats: {
      receiverConnections: 0,
      uploads: 0,
      eventsDelivered: 0
    }
  }
}


/**
 * @param {string} [roomId] 省略时生成完整 UUID
 * @returns {{ room: Room, created: boolean }}
 */
function createRoom(roomId = randomUUID()) {
  const id = sanitizeRoomId(roomId)
  if (!id) {
    throw new Error('Invalid room id')
  }

  const existing = rooms.get(id)
  if (existing) {
    return { room: existing, created: false }
  }

  const room = makeRoom(id)
  rooms.set(id, room)
  return { room, created: true }
}


/**
 * @param {unknown} roomId
 * @returns {Room | null}
 */
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
 *
 * @atomic `scripts/check-atomic-invariants.mjs` 会断言本函数体内（不含嵌套函数）没有 `await`。
 *   要在这里做异步操作时，请把异步那半挪到调用方，不要挪进来。
 *
 * @param {Room} room
 * @param {number} quotaBytes
 * @returns {() => void} 回滚函数（幂等且受 `room.destroyed` 短路）
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
 *
 * @atomic 同 `reserveStorageQuota`：本函数体内不得出现 `await`（由静态检查断言）。
 *
 * @param {Room} room
 * @returns {() => void} 槽位释放函数（幂等）
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


/**
 * @param {Room} room
 * @returns {object} 房间元信息 + 上传摘要列表（**不含正文**）
 */
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
 *
 * @param {Upload} upload
 * @param {{ includeContent?: boolean }} [options] 默认 `true` **只对 details 端点成立**；
 *   SSE 广播与 201 响应必须显式传 `false`（否则回吐正文，见铁律 22）
 * @returns {{
 *   id: string, name: string, mimeType: string, size: number,
 *   uploadedAt: string, lastModified: string,
 *   previewText: string | null, textTruncated: boolean,
 *   contentIncluded: boolean, contentText: string | null, contentBase64: string | null,
 *   detailsUrl: string, downloadUrl: string, serverStored: boolean
 * }}
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
    // 正文不常驻内存（见 relay-server 的 handleUpload）：需要正文的端点自己从磁盘读回并覆盖本字段。
    // 过去这里读的是 `upload.contentBase64` —— 一个**从未被赋值**的字段，两个调用方都还得再覆盖一次。
    contentBase64: null,
    detailsUrl: relayUrl(detailsPath),
    downloadUrl: relayUrl(`${detailsPath}?download=1`),
    // 只暴露「是否已落盘」，不返回服务端存储文件名/相对路径，避免路径信息泄露
    serverStored: Boolean(upload.storagePath)
  }

  return summary
}


/**
 * @param {Room} room
 * @returns {void}
 */
function trimQueue(room) {
  while (room.queue.length > MAX_QUEUE_EVENTS) {
    room.queue.shift()
  }
}


/**
 * @param {Room} room
 * @returns {void}
 */
function closeReceiver(room) {
  if (!room.receiver) return

  const { res, heartbeat } = room.receiver
  clearInterval(heartbeat)
  room.receiver = null

  if (!res.writableEnded) {
    res.end()
  }
}


/**
 * @param {Room} room
 * @param {{ id: string, type: string, createdAt: string, data: unknown }} event
 * @returns {void}
 */
function queueEvent(room, event) {
  room.queue.push(event)
  trimQueue(room)
}


/**
 * @param {Room} room
 * @param {string} eventName
 * @param {unknown} data
 * @returns {{ id: string, type: string, createdAt: string, data: unknown }} 已投递或已入队的 SSE 事件
 */
function dispatchEvent(room, eventName, data) {
  const event = {
    id: randomUUID(),
    type: eventName,
    createdAt: nowIso(),
    data
  }

  room.updatedAt = event.createdAt
  room.lastActivity = Date.now()

  const receiver = room.receiver
  if (receiver && receiver.res.writable) {
    // 背压上界：慢/卡住的接收端会让未 flush 的写缓冲只增不减，越过阈值即判定「太慢」并断开，
    // 让本事件落回**有界**离线队列，等其带 Last-Event-ID 重连时重放——否则内存随事件数无界膨胀。
    if (receiver.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
      auditLog('receiver_too_slow', {
        roomId: room.id,
        eventType: eventName,
        bufferedBytes: receiver.res.writableLength
      })
      closeReceiver(room)
    } else {
      try {
        writeSseFrame(receiver.res, eventName, event)
        room.stats.eventsDelivered += 1
        return event
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        auditLog('receiver_push_failed', { roomId: room.id, eventType: eventName, message })
        closeReceiver(room)
      }
    }
  }

  queueEvent(room, event)
  return event
}


/**
 * 房间元数据的文件名与写入约定。
 *
 * 房间的可持久化状态就是**房间目录内的这一个 JSON**，它同时承担三件事：
 * ① 「重启不丢作业」—— 启动时据此重建房间与上传；
 * ② **归属证明** —— 取代原先的 `.coolector-room` 标记（内容更丰富、可自校验）；
 * ③ 全局配额的复原依据 —— 每条上传的 `quotaBytes` 落在这里。
 *
 * 正文（`text`）**不写进去**：它是**字节的纯函数**（`deriveUploadText`），而文本类作业的
 * 正文可达 1MB —— 写进去会让每个房间的元数据文件随作业量线性膨胀到几百 MB，
 * 而它随时可以从落盘字节重新推导。`previewText` / `textTruncated` 则**必须**持久化：
 * 它们是「上传那一刻」的截断产物，事后无法从字节还原。
 *
 * 文件名用 `room.json` 而非 `.coolector-room`：上传正文一律存为 `<上传ID>-<安全文件名>`，
 * 不可能恰好等于 `room.json`，因此两者不会互相覆盖；而点号开头的名字反而会被
 * `sanitizeStorageFileName` 归一成 `file`，在上传通道里造成歧义。
 */
const ROOM_METADATA_FILENAME = 'room.json'

/** 元数据的临时写入口：先写它再 `rename` 覆盖正式文件，避免读者看到半截 JSON */
const ROOM_METADATA_TEMP_FILENAME = 'room.json.tmp'

const ROOM_METADATA_GENERATOR = 'coolector-relay'
const ROOM_METADATA_VERSION = 1

// —— 恢复时的字段约束 ——
// 元数据由本程序写出，但磁盘会损坏、文件也可能被人工改过：恢复路径必须能容忍任何内容，
// 且**一律以「跳过 + 告警」应对**，绝不因为一份坏元数据而删除目录（见 restoreRooms）。
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u
const MAX_PERSISTED_NAME_CHARS = 512
const MAX_STORAGE_FILE_NAME_CHARS = 200

/**
 * 启动恢复的并发上限。恢复是 I/O 密集的（逐目录读 `room.json`、逐上传 `stat` 其正文文件）：
 * 完全串行会让重启时间随作业数线性拉长；而无上限的 `Promise.all` 又可能瞬时打开成千上万个
 * 文件描述符（触发 EMFILE）。取一个中等并发度，兼顾「快」与「不把 FD 打满」。
 */
const RESTORE_CONCURRENCY = 32


/**
 * 以固定并发度遍历 items，对每项调用异步 mapper，返回**与输入同序**的结果数组。
 *
 * 采用「工作池抢占共享游标」而非一次性 `Promise.all`：同时在跑的 mapper 数被 `limit` 钉死，
 * 结果仍按输入下标回填，因此调用方可以依赖顺序（告警目录清单等须与磁盘枚举顺序一致）。
 * `cursor++` 跨 worker 安全：JS 单线程，自增与读取之间不会被其它任务插入。
 *
 * @template T
 * @template R
 * @param {T[]} items
 * @param {number} limit 同时进行的 mapper 上限（≥1）
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, mapper) {
  /** @type {R[]} */
  const results = new Array(items.length)
  let cursor = 0

  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) break
      results[index] = await mapper(items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}


/**
 * 把房间的可持久化状态序列化为 JSON 文本（不含正文，理由见上）。
 *
 * @param {Room} room
 * @returns {string}
 */
function serializeRoom(room) {
  const payload = {
    generator: ROOM_METADATA_GENERATOR,
    version: ROOM_METADATA_VERSION,
    roomId: room.id,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    uploads: Array.from(room.uploads.values(), (upload) => ({
      id: upload.id,
      name: upload.name,
      mimeType: upload.mimeType,
      lastModified: upload.lastModified,
      uploadedAt: upload.uploadedAt,
      size: upload.size,
      quotaBytes: Number.isFinite(upload.quotaBytes) ? upload.quotaBytes : upload.size,
      textTruncated: Boolean(upload.textTruncated),
      previewText: upload.previewText ?? null,
      storageFileName: upload.storageFileName ?? null
    }))
  }

  return JSON.stringify(payload, null, 2)
}


/**
 * 落盘一次房间元数据：写临时文件再 `rename` 原子替换。
 *
 * **绝不抛出**。元数据写入失败不能让一次已经成功的上传变成 500，更不能让清理定时器
 * 产生未处理拒绝（那会让整个 relay 进程退出）。失败只记审计日志与 stderr，
 * 代价是「该条记录重启后丢失」，由运维从日志发现 —— 比丢掉整个请求小得多。
 *
 * @param {Room} room
 * @returns {Promise<void>}
 */
async function writeRoomMetadataNow(room) {
  const roomDir = join(UPLOAD_DIR, room.id)

  try {
    await mkdir(roomDir, { recursive: true })
    const tempPath = join(roomDir, ROOM_METADATA_TEMP_FILENAME)
    await writeFile(tempPath, serializeRoom(room), 'utf8')
    // rename 覆盖是原子的：读到 room.json 的一方要么看到旧内容、要么看到新内容，不会是半截
    await rename(tempPath, join(roomDir, ROOM_METADATA_FILENAME))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    auditLog('room_metadata_write_failed', { roomId: room.id, message })
    console.error(`[relay] 房间元数据写入失败（本次上传仍已落盘，但重启后该条记录会丢失）：${roomDir} —— ${message}`)
  }
}


/**
 * 排队写一次房间元数据，返回本次写入完成（无论成败）的 Promise，**永不 reject**。
 *
 * 必须**串行**：并发上传各自触发一次「全量写」，若不排队，多次写入会共用同一个临时文件
 * 并各自 `rename`，最终 `rename` 未必来自最新快照 —— 后写的旧快照会覆盖先写的新快照，
 * 重启后就少一条作业（静默丢件）。
 *
 * @param {Room} room
 * @param {{ write?: (room: Room) => Promise<void> }} [options] 便于单测注入一个「会记录并发度」
 *   的替身来断言串行性（与 `destroyRoom` 的 `removeDir` 同一模式）
 * @returns {Promise<void>}
 */
function persistRoomMetadata(room, { write = writeRoomMetadataNow } = {}) {
  const run = () => write(room)
  const next = room.metadataChain.then(run, run)
  room.metadataChain = next
  return next
}


/**
 * @param {unknown} fileName
 * @returns {boolean} 能否作为「房间目录内的一个文件名」安全使用
 */
function isSafeStorageFileName(fileName) {
  if (typeof fileName !== 'string' || !fileName) return false
  if (fileName.length > MAX_STORAGE_FILE_NAME_CHARS) return false
  // basename 相等 = 不含路径分隔符，阻断元数据被篡改成 `../../etc/passwd` 一类的读取
  if (basename(fileName) !== fileName) return false
  return fileName !== ROOM_METADATA_FILENAME && fileName !== ROOM_METADATA_TEMP_FILENAME
}


/**
 * 房间元数据的**前向迁移缝**：把自报版本落后于 `ROOM_METADATA_VERSION` 的历史文件就地升到当前版本。
 *
 * 为什么要有这条缝：`readRoomMetadata` 若对任何「非当前版本」一律整份丢弃，等于「一改元数据格式，
 * 所有存量房间目录都在下次重启时凭空蒸发、作业全部读不回」。有了逐级升版，新增可选字段这类**向后
 * 兼容**的演进只需在此追加一个 `parsed.version === <旧值>` 分支补齐默认字段，存量文件即可继续被识别，
 * 而写路径（serializeRoom）始终直接写最新版本，读侧只需负责「升上来」。
 *
 * 迁移只做**无损**动作（补默认值、改名），绝不猜测语义；任何需要正文或无法自证正确的转换都返回 `null`，
 * 交回上层「跳过 + 告警、绝不删目录」的既定处置。当前 `ROOM_METADATA_VERSION = 1`，尚无任何历史版本，
 * 因此没有可执行的升版步骤 —— 一旦把版本 bump 到 2，就在这里加一步「v1→v2 的无损字段补齐」，
 * 把 `parsed.version` 置为 2 后返回。
 *
 * @param {Record<string, unknown>} parsed 已通过 generator/roomId 校验、且 version < ROOM_METADATA_VERSION
 * @returns {Record<string, unknown> | null} 升不动时返回 null（调用方据此跳过该目录）
 */
function migrateRoomMetadata(parsed) {
  // 逐级升版：尚无 (version → version+1) 步骤 —— version=1 是首个版本，没有更早格式可迁移。
  // 保留按 parsed.version 分支的骨架：未来 bump 到 2 时，此处 `if (parsed.version === 1) { …; parsed.version = 2; return parsed }`。
  if (typeof parsed.version !== 'number') return null
  return null
}


/**
 * 读取并校验房间元数据。
 *
 * 返回 `null` 覆盖三种情况，**且都绝不删除目录**：文件不存在（外来目录 / 老版本遗留）、
 * JSON 解析失败（半截文件 / 磁盘损坏）、字段校验不通过（被人工改过）。宁可让一个目录
 * 变成「不认识的目录」，也不能把运维自己的数据当成垃圾清掉。
 *
 * @param {string} roomDir
 * @param {string} roomId 目录名；必须与元数据内的 roomId 一致，否则视为不属于本程序
 * @returns {Promise<{ version?: unknown, createdAt?: unknown, updatedAt?: unknown, uploads: unknown[] } | null>}
 */
async function readRoomMetadata(roomDir, roomId) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(join(roomDir, ROOM_METADATA_FILENAME), 'utf8'))
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.generator !== ROOM_METADATA_GENERATOR) return null
  if (parsed.roomId !== roomId) return null

  // 版本号分级：先坐实它是整数，再区分「比本程序新」与「比本程序旧」
  if (typeof parsed.version !== 'number' || !Number.isInteger(parsed.version)) return null
  // 比本程序还新：无法理解其字段语义，保守跳过（绝不按不确定的格式猜测、更不删目录）
  if (parsed.version > ROOM_METADATA_VERSION) return null
  // 落后于当前版本：走前向迁移缝就地升版；升不动（暂无对应步骤）即跳过
  if (parsed.version < ROOM_METADATA_VERSION) {
    const migrated = migrateRoomMetadata(parsed)
    if (!migrated) return null
    parsed = migrated
  }

  if (!Array.isArray(parsed.uploads)) return null

  return parsed
}


/**
 * 由一条持久化记录重建上传对象。
 *
 * 恒不带正文（`text: null`）：`details` 端点会从落盘字节按需推导，与上传路径共用
 * `deriveUploadText` 这一份实现，因此重启前后的正文口径完全一致（铁律 20）。
 *
 * @param {string} roomDir
 * @param {string} roomId
 * @param {unknown} item 元数据 `uploads` 数组里的一条记录
 * @returns {Promise<Upload | null>} 记录不可用（文件缺失 / 字段非法）时返回 `null`
 */
async function restoreUpload(roomDir, roomId, item) {
  if (!item || typeof item !== 'object') return null
  // 从 `object` 收窄成可按名取值的记录：此后每个字段仍需各自校验 —— 元数据来自磁盘，
  // 任何字段都可能是任意类型（被人工改过 / 半截写入 / 旧版本格式）。
  const record = /** @type {Record<string, unknown>} */ (item)

  const id = record.id
  if (typeof id !== 'string' || !UPLOAD_ID_PATTERN.test(id)) return null

  const storageFileName = record.storageFileName
  if (typeof storageFileName !== 'string' || !isSafeStorageFileName(storageFileName)) return null

  const storagePath = join(roomDir, storageFileName)
  let fileStat
  try {
    fileStat = await stat(storagePath)
  } catch {
    // 元数据引用的正文不在磁盘上（被人工删除 / 写入未完成）—— 跳过这一条，其余照常恢复
    return null
  }
  if (!fileStat.isFile()) return null

  const size = fileStat.size

  // 配额以**磁盘字节**为下界：即使元数据被改小，也不允许低于文件本身的体积
  const persistedQuota = record.quotaBytes
  const quotaBytes = typeof persistedQuota === 'number' && persistedQuota >= size
    ? Math.floor(persistedQuota)
    : size

  const persistedName = record.name
  const persistedPreview = record.previewText

  return {
    id,
    roomId,
    name: typeof persistedName === 'string' && persistedName
      ? persistedName.slice(0, MAX_PERSISTED_NAME_CHARS)
      : storageFileName,
    mimeType: sanitizeMimeType(record.mimeType),
    lastModified: normalizeIsoDate(record.lastModified, nowIso()),
    uploadedAt: normalizeIsoDate(record.uploadedAt, nowIso()),
    size,
    quotaBytes,
    text: null,
    textTruncated: record.textTruncated === true,
    previewText: typeof persistedPreview === 'string'
      ? persistedPreview.slice(0, PREVIEW_TEXT_CHARS)
      : null,
    storagePath,
    storageFileName
  }
}


/**
 * @param {Upload} upload
 * @param {Buffer} bytes 解码后的文件字节（**不是** base64 字符串）
 * @returns {Promise<void>}
 */
async function persistUpload(upload, bytes) {
  // 入参是**解码后的文件字节**，不是 base64。签名收字符串时本函数要自己解一遍，
  // 加上调用方为量 `.length` 解的那一遍、以及裸 body 通道为拼响应字段做的那一遍编码，
  // 一次 10MB 上传的峰值内存会达到文件本身的 4.3 倍（实测 43.4 MB vs 10.1 MB）。
  // 这里用 fail-fast 而不是默认空 Buffer：静默接受一个 base64 字符串会写出一份看似正常的坏文件。
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError('persistUpload expects a Buffer of decoded file bytes')
  }

  const roomUploadDir = join(UPLOAD_DIR, upload.roomId)
  const storageFileName = `${upload.id}-${sanitizeStorageFileName(upload.name)}`
  const storagePath = join(roomUploadDir, storageFileName)

  await mkdir(roomUploadDir, { recursive: true })
  await writeFile(storagePath, bytes)

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
/**
 * @param {Room} room
 * @param {{ removeDir?: typeof rm }} [options] 便于单测注入「删除失败」的替身
 * @returns {Promise<boolean>} 目录是否删除成功（失败不抛出）
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


/**
 * @param {{ removeDir?: typeof rm }} [options] 透传给 destroyRoom
 * @returns {Promise<void>}
 */
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
 * 启动时按磁盘上的房间元数据重建房间与上传，并复原全局配额。
 *
 * 这取代了原先的「无主目录回收」：房间现在**不只在内存里** —— 磁盘上的房间目录不再是
 * 垃圾，而是「重启后仍然可访问的作业」。因此本函数**只读不删**：没有元数据、元数据损坏、
 * 字段不合法的目录一律跳过并告警（`UPLOAD_DIR` 指向卷根时不会误删 `notes.backup/` 这类数据）。
 *
 * 有意保留的取舍：若 `destroyRoom` 的 `rm` 失败（目录残留、元数据还在），下次启动会把这个
 * 房间**恢复出来**。磁盘上的作业确实还在、删除本就没成功，恢复比「悄悄丢掉」更符合
 * 「不误删」原则；且它若已超过绝对存活上限，下一轮清理会立即再次尝试删除（`createdAt`
 * 一并持久化就是为了让这条上限在重启后依然有效）。恢复时**不强制**反查配额上限 ——
 * 运维调小了上限不该导致既有作业被丢弃；新上传由 `reserveStorageQuota` 照常拦截。
 *
 * @returns {Promise<void>}
 */
async function restoreRooms() {
  totalStoredBytes = 0

  let entries
  try {
    entries = await readdir(UPLOAD_DIR, { withFileTypes: true })
  } catch {
    // 目录不存在（首次启动），无需恢复
    return
  }

  let restoredRooms = 0
  let restoredUploads = 0
  let restoredBytes = 0
  let skippedUploads = 0
  let strayFiles = 0
  /** 「目录名不合法」与「元数据无效」两类无法识别的目录，按枚举下标合并后再排序，复刻旧扫描顺序 */
  const unrecognizedMarks = []

  // —— 同步分类：散落文件、非法目录名先就地判定；名称合法的目录留待并发读元数据 ——
  const roomCandidates = []
  let index = 0
  for (const entry of entries) {
    const entryIndex = index++
    if (!entry.isDirectory()) {
      strayFiles += 1
      continue
    }

    const roomId = sanitizeRoomId(entry.name)
    if (!roomId || roomId !== entry.name) {
      unrecognizedMarks.push({ index: entryIndex, name: entry.name })
      continue
    }

    roomCandidates.push({ index: entryIndex, name: entry.name, roomId })
  }

  // —— 第一层并发：各候选目录读 room.json（readFile）。结果与候选同序，便于稳定分区 ——
  const metadataResults = await mapWithConcurrency(roomCandidates, RESTORE_CONCURRENCY, async (candidate) => {
    const roomDir = join(UPLOAD_DIR, candidate.name)
    const metadata = await readRoomMetadata(roomDir, candidate.roomId)
    return { ...candidate, roomDir, metadata }
  })

  // 元数据无效的目录计入 unrecognized（读是异步的，不能在第一层直接 push，否则丢序）
  /** @type {{ room: Room, roomDir: string, roomId: string, uploads: unknown[] }[]} */
  const validRooms = []
  for (const result of metadataResults) {
    if (!result.metadata) {
      unrecognizedMarks.push({ index: result.index, name: result.name })
      continue
    }
    const room = makeRoom(result.roomId, {
      createdAt: normalizeIsoDate(result.metadata.createdAt, nowIso()),
      updatedAt: normalizeIsoDate(result.metadata.updatedAt, nowIso())
    })
    validRooms.push({ room, roomDir: result.roomDir, roomId: result.roomId, uploads: result.metadata.uploads })
  }

  // —— 第二层并发：把所有房间的上传恢复任务摊平成**一个**全局列表统一限流，
  //    使并发 stat 数受 RESTORE_CONCURRENCY 约束（而非「房间数 × 每房间上传数」的乘积）。——
  /** @type {{ room: Room, roomDir: string, roomId: string, item: unknown }[]} */
  const uploadTasks = []
  for (const vr of validRooms) {
    for (const item of vr.uploads) {
      uploadTasks.push({ room: vr.room, roomDir: vr.roomDir, roomId: vr.roomId, item })
    }
  }

  const uploadResults = await mapWithConcurrency(uploadTasks, RESTORE_CONCURRENCY, async (task) => {
    const upload = await restoreUpload(task.roomDir, task.roomId, task.item)
    return { room: task.room, upload }
  })

  // 串行归并：配额累加、计数与 Map 插入都在此完成，与旧的嵌套顺序循环逐字等价
  for (const { room, upload } of uploadResults) {
    if (!upload) {
      skippedUploads += 1
      continue
    }

    room.uploads.set(upload.id, upload)
    room.storedBytes += upload.quotaBytes
    totalStoredBytes += upload.quotaBytes
    restoredBytes += upload.quotaBytes
    restoredUploads += 1
  }

  // 组装房间：按 validRooms 原序入 map，与旧循环遇到有效目录时的 rooms.set 顺序一致
  for (const vr of validRooms) {
    vr.room.stats.uploads = vr.room.uploads.size
    rooms.set(vr.roomId, vr.room)
    restoredRooms += 1
  }

  const unrecognized = unrecognizedMarks
    .sort((a, b) => a.index - b.index)
    .map((mark) => mark.name)

  if (restoredUploads > 0) {
    auditLog('rooms_restored', { rooms: restoredRooms, uploads: restoredUploads, bytes: restoredBytes })
    console.log(`[relay] 已从磁盘恢复 ${restoredRooms} 个房间 / ${restoredUploads} 条上传（${restoredBytes} 字节）：这些作业在重启后仍可访问。`)
  }
  if (skippedUploads > 0) {
    console.warn(`[relay] ${skippedUploads} 条上传记录被跳过：元数据引用的正文不在磁盘上，或记录字段不合法。`)
  }
  if (unrecognized.length > 0) {
    // 刻意不删：无法证明它们是本程序产生的（可能是老版本遗留目录或运维自己的数据）
    console.warn(`[relay] ⚠️ UPLOAD_DIR 下有 ${unrecognized.length} 个目录没有有效的房间元数据（${ROOM_METADATA_FILENAME}），已跳过、不计入配额、也不会被删除：`)
    console.warn(`[relay]    ${unrecognized.slice(0, 10).join(', ')}${unrecognized.length > 10 ? ` …（共 ${unrecognized.length} 个）` : ''}`)
    console.warn('[relay]    若是旧版本遗留的上传目录，请人工删除或迁移；UPLOAD_DIR 建议指向专用子目录。')
  }
  if (strayFiles > 0) {
    console.warn(`[relay] UPLOAD_DIR 根目录下有 ${strayFiles} 个散落文件：既不计入配额也不会被回收，请确认 UPLOAD_DIR 配置是否正确。`)
  }
}



export {
  rooms,
  totalStoredBytes,
  ROOM_METADATA_FILENAME,
  createRoom,
  getRoom,
  reserveStorageQuota,
  reserveUploadSlot,
  roomSnapshot,
  uploadSummary,
  closeReceiver,
  dispatchEvent,
  persistUpload,
  persistRoomMetadata,
  serializeRoom,
  destroyRoom,
  cleanupRooms,
  restoreRooms
}
