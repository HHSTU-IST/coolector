/**
 * Relay 响应/事件契约的运行期边界校验。
 *
 * 过去前端把服务端 JSON 与 SSE 帧直接用 `as RelayXxx` 断言成类型 —— 一旦字段缺失或形态走样，
 * 断言只是把 `undefined` 伪装成 `string`/`number` 塞进响应式 store，故障点后移、报错含糊。
 * 这里在**进入 store / 深层解引用之前**做一次轻量校验：只断言客户端真正读取的关键字段，
 * 容忍服务端多带的字段（如 `serverStored`），畸形即抛 `RelayContractError`。
 *
 * 刻意保持「同源仓库、按实际产线形状对齐」的严格度：既拦住真正的畸形，又不至于因服务端
 * 偶尔多/少一个纯展示字段就把整条链路打挂。抛出的错误都汇进既有的逐事件隔离 / 连接错误处理。
 */

import type {
  RelayEventEnvelope, RelayRoomResponse, RelayUploadSummary, RoomSnapshot, UploadCreatedData
} from './relay-types'

export class RelayContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayContractError'
  }
}

const describe = (value: unknown): string => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 断言是非空普通对象并交出可按键读写的视图 */
const asObject = (value: unknown, what: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayContractError(`${what}：期望 JSON 对象，实际是 ${describe(value)}`)
  }
  return value as Record<string, unknown>
}

const reqString = (obj: Record<string, unknown>, key: string, what: string): string => {
  const value = obj[key]
  if (typeof value !== 'string') {
    throw new RelayContractError(`${what}.${key}：期望 string，实际是 ${describe(value)}`)
  }
  return value
}

const reqNumber = (obj: Record<string, unknown>, key: string, what: string): number => {
  const value = obj[key]
  // 排除 NaN：typeof NaN === 'number'，但它会污染配额展示与 history
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new RelayContractError(`${what}.${key}：期望 number，实际是 ${describe(value)}`)
  }
  return value
}

const reqBoolean = (obj: Record<string, unknown>, key: string, what: string): boolean => {
  const value = obj[key]
  if (typeof value !== 'boolean') {
    throw new RelayContractError(`${what}.${key}：期望 boolean，实际是 ${describe(value)}`)
  }
  return value
}

/** string | null：允许显式 null（正文缺省即如此），但拒绝其它非字符串形态 */
const reqStringOrNull = (obj: Record<string, unknown>, key: string, what: string): string | null => {
  const value = obj[key]
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new RelayContractError(`${what}.${key}：期望 string | null，实际是 ${describe(value)}`)
  }
  return value
}

/** 建房响应：接收端接下来一切 URL 与房间号都源于此，必须逐字段坐实 */
export function parseRoomResponse(value: unknown): RelayRoomResponse {
  const obj = asObject(value, 'RoomResponse')
  return {
    roomId: reqString(obj, 'roomId', 'RoomResponse'),
    createdAt: reqString(obj, 'createdAt', 'RoomResponse'),
    weakRoomId: reqBoolean(obj, 'weakRoomId', 'RoomResponse'),
    streamUrl: reqString(obj, 'streamUrl', 'RoomResponse'),
    streamTicketUrl: reqString(obj, 'streamTicketUrl', 'RoomResponse'),
    uploadUrl: reqString(obj, 'uploadUrl', 'RoomResponse'),
    stateUrl: reqString(obj, 'stateUrl', 'RoomResponse')
  }
}

/** 一次性流票据：只关心 ticket 字符串 */
export function parseStreamTicket(value: unknown): string {
  const obj = asObject(value, 'StreamTicket')
  return reqString(obj, 'ticket', 'StreamTicket')
}

/**
 * 上传摘要：SSE 广播、details 端点、201 响应共用同一形状。
 * 逐字段坐实客户端会读的成员，忽略服务端多带的字段（如 serverStored）。
 */
export function parseUploadSummary(value: unknown): RelayUploadSummary {
  const obj = asObject(value, 'UploadSummary')
  return {
    id: reqString(obj, 'id', 'UploadSummary'),
    name: reqString(obj, 'name', 'UploadSummary'),
    mimeType: reqString(obj, 'mimeType', 'UploadSummary'),
    size: reqNumber(obj, 'size', 'UploadSummary'),
    uploadedAt: reqString(obj, 'uploadedAt', 'UploadSummary'),
    lastModified: reqString(obj, 'lastModified', 'UploadSummary'),
    previewText: reqStringOrNull(obj, 'previewText', 'UploadSummary'),
    textTruncated: reqBoolean(obj, 'textTruncated', 'UploadSummary'),
    contentIncluded: reqBoolean(obj, 'contentIncluded', 'UploadSummary'),
    contentText: reqStringOrNull(obj, 'contentText', 'UploadSummary'),
    contentBase64: reqStringOrNull(obj, 'contentBase64', 'UploadSummary'),
    detailsUrl: reqString(obj, 'detailsUrl', 'UploadSummary'),
    downloadUrl: reqString(obj, 'downloadUrl', 'UploadSummary')
  }
}

/**
 * 房间快照：客户端会遍历 `uploads` 列表并把标量喂给配额展示，故坐实 uploads 数组；
 * 其余标量透传（与既有 `as` 断言相比不新增严格度，避免因纯展示字段缺失而整体拒绝）。
 */
export function parseRoomSnapshot(value: unknown): RoomSnapshot {
  const obj = asObject(value, 'RoomSnapshot')
  if (!Array.isArray(obj.uploads)) {
    throw new RelayContractError(`RoomSnapshot.uploads：期望数组，实际是 ${describe(obj.uploads)}`)
  }
  // 逐条校验上传摘要——这是真正会被解引用与入库的部分
  const uploads = obj.uploads.map((entry) => parseUploadSummary(entry))
  return { ...(obj as unknown as Omit<RoomSnapshot, 'uploads'>), uploads }
}

/** details 端点返回 `{ upload }` 包一层 */
export function parseUploadDetailsResponse(value: unknown): RelayUploadSummary {
  const obj = asObject(value, 'UploadDetailsResponse')
  return parseUploadSummary(obj.upload)
}

/** SSE 事件信封：id/type/createdAt 为字符串，data 必须存在（其内部结构由各处理器再校验） */
export function parseEventEnvelope<T>(value: unknown): RelayEventEnvelope<T> {
  const obj = asObject(value, 'EventEnvelope')
  const id = reqString(obj, 'id', 'EventEnvelope')
  const type = reqString(obj, 'type', 'EventEnvelope')
  const createdAt = reqString(obj, 'createdAt', 'EventEnvelope')
  if (obj.data === undefined) {
    throw new RelayContractError('EventEnvelope.data：缺失')
  }
  return { id, type, createdAt, data: obj.data as T }
}

/** upload.created 载荷：roomId + 经校验的上传摘要（downloadUrl 客户端不用，仅原样保留形状） */
export function parseUploadCreatedData(value: unknown): UploadCreatedData {
  const obj = asObject(value, 'UploadCreatedData')
  const downloadUrl = obj.downloadUrl
  return {
    roomId: reqString(obj, 'roomId', 'UploadCreatedData'),
    upload: parseUploadSummary(obj.upload),
    downloadUrl: typeof downloadUrl === 'string' ? downloadUrl : ''
  }
}
