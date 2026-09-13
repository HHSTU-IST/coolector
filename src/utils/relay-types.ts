/**
 * 接收端与 Relay 交互的数据契约。
 * 独立成模块是为了让 composable、组件与测试共用同一份定义 ——
 * 过去它们挤在组件的 <script setup> 里，测试无从引用。
 */

export interface RelayRoomResponse {
  roomId: string
  createdAt: string
  /** 服务端对该房间号的「偏弱」判定（权威） */
  weakRoomId: boolean
  streamUrl: string
  streamTicketUrl: string
  uploadUrl: string
  stateUrl: string
}

export interface RelayUploadSummary {
  id: string
  name: string
  mimeType: string
  size: number
  uploadedAt: string
  lastModified: string
  previewText: string | null
  /** 正文是否因超过服务端 MAX_TEXT_BYTES 被截断 */
  textTruncated: boolean
  contentIncluded: boolean
  contentText: string | null
  contentBase64: string | null
  detailsUrl: string
  downloadUrl: string
}

export interface RelayEventEnvelope<T> {
  id: string
  type: string
  createdAt: string
  data: T
}

export interface RoomSnapshot {
  roomId: string
  createdAt: string
  updatedAt: string
  hasReceiver: boolean
  queuedEvents: number
  uploadCount: number
  /** 本房间已占用配额（正文 + 元数据） */
  storedBytes: number
  /** 本房间配额上限 */
  storageLimitBytes: number
  uploads: RelayUploadSummary[]
  stats: {
    receiverConnections: number
    uploads: number
    eventsDelivered: number
  }
}

export interface UploadCreatedData {
  roomId: string
  upload: RelayUploadSummary
  downloadUrl: string
}

export interface LogEntry {
  id: string
  type: string
  message: string
  createdAt: string
}
