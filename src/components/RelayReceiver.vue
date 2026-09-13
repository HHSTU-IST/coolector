<template>
  <div class="w-full">
    <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      <div class="border-b border-gray-200 p-4 sm:p-6">
        <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p class="text-xs font-semibold uppercase tracking-[0.24em] text-indigo-500">Receiver Long Connection</p>
            <h2 class="text-xl font-semibold text-gray-900 mt-1">公网接收长连接</h2>
            <p class="text-sm text-gray-500 mt-2">
              通过 SSE 保持和 Relay Server 的长连接，自动接收远端上传并灌入本地文件列表。
            </p>
          </div>

          <div class="text-left md:text-right">
            <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium"
              :class="statusBadgeClass">
              {{ statusLabel }}
            </span>
            <p class="text-xs text-gray-500 mt-2">{{ statusMessage }}</p>
          </div>
        </div>
      </div>

      <div class="grid gap-5 p-4 sm:p-6 lg:grid-cols-[1.2fr_0.8fr] lg:gap-6">
        <form class="space-y-4" @submit.prevent="() => connect()">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">Relay 地址</label>
            <input v-model="relayBaseUrl" type="url"
              class="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              placeholder="http://127.0.0.1:8787">
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">
              接收端密钥 <span class="font-normal text-gray-400">（可选）</span>
            </label>
            <input v-model="relayToken" type="password" autocomplete="off" spellcheck="false"
              class="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              placeholder="Relay 的 RELAY_TOKEN，仅保存在本机浏览器">
            <p class="mt-1 text-xs text-gray-500">
              密钥不再随页面分发，只保存在本机 localStorage。若 Relay 未配置 RELAY_TOKEN 可留空。
            </p>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">房间 ID</label>
            <input v-model="roomId" type="text"
              class="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              placeholder="留空则由服务端生成随机房间号">
            <p v-if="roomIdHint" class="mt-1 text-xs text-amber-600">{{ roomIdHint }}</p>
          </div>

          <div class="grid gap-3 sm:flex sm:flex-wrap">
            <button type="submit" :disabled="connectionState === 'connecting'"
              class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">
              {{ connectionState === 'connected' ? '重新连接' : '建立长连接' }}
            </button>
            <button type="button" @click="disconnect" :disabled="!eventSource"
              class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60">
              断开连接
            </button>
          </div>

          <div class="rounded-xl bg-indigo-50 border border-indigo-100 p-4 text-sm text-indigo-900">
            <p class="font-medium">连接说明</p>
            <p class="mt-1">
              连接后会创建或进入房间，然后打开 `/events` 的 SSE 通道，接收到 `upload.created` 后自动拉取文件内容。
              房间号需先在此创建、再分享给发送方 —— 发送方无需任何密钥。
            </p>
          </div>
        </form>

        <div class="space-y-4">
          <div class="rounded-xl border border-gray-200 p-4">
            <div class="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p class="text-gray-500">房间</p>
                <p class="font-medium text-gray-900 truncate">{{ roomState?.roomId ?? '未连接' }}</p>
              </div>
              <div>
                <p class="text-gray-500">上传数</p>
                <p class="font-medium text-gray-900">{{ roomState?.uploadCount ?? 0 }}</p>
              </div>
              <div>
                <p class="text-gray-500">存储用量</p>
                <p class="font-medium" :class="storageUsageRatio >= 0.9 ? 'text-red-600' : 'text-gray-900'">
                  {{ storageUsageLabel }}
                </p>
              </div>
              <div>
                <p class="text-gray-500">接收端连接</p>
                <p class="font-medium text-gray-900">{{ roomState?.stats.receiverConnections ?? 0 }}</p>
              </div>
              <div>
                <p class="text-gray-500">已转发事件</p>
                <p class="font-medium text-gray-900">{{ roomState?.stats.eventsDelivered ?? 0 }}</p>
              </div>
            </div>
          </div>

          <div class="rounded-xl border border-gray-200 p-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-semibold text-gray-900">最近事件</h3>
              <span class="text-xs text-gray-500">{{ recentEvents.length }} 条</span>
            </div>
            <div class="space-y-2 max-h-56 overflow-auto pr-1">
              <div v-for="event in recentEvents" :key="event.id"
                class="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700">
                <p class="font-medium text-gray-900">{{ event.type }}</p>
                <p class="mt-1 text-gray-500">{{ event.message }}</p>
              </div>
              <p v-if="recentEvents.length === 0" class="text-xs text-gray-500">
                连接后这里会显示 receiver.ready 和上传事件。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useCollectionStore } from '../stores/collection'
import { useFileStore } from '../stores/file'
import { formatFileSize } from '../utils/format'
import { binaryPlaceholder } from '../utils/relay-content'
import {
  DEFAULT_RELAY_URL,
  looksWeakRoomId,
  normalizeRelayUrl,
  relayToken,
  validateRoomId,
  withAuth
} from '../utils/relay'

interface RelayRoomResponse {
  roomId: string
  createdAt: string
  /** 服务端对该房间号的「偏弱」判定（权威） */
  weakRoomId: boolean
  streamUrl: string
  streamTicketUrl: string
  uploadUrl: string
  stateUrl: string
}

interface RelayUploadSummary {
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

interface RelayEventEnvelope<T> {
  id: string
  type: string
  createdAt: string
  data: T
}

interface RoomSnapshot {
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

interface UploadCreatedData {
  roomId: string
  upload: RelayUploadSummary
  downloadUrl: string
}

interface LogEntry {
  id: string
  type: string
  message: string
  createdAt: string
}

const fileStore = useFileStore()
const collectionStore = useCollectionStore()

const relayBaseUrl = ref(DEFAULT_RELAY_URL)
// 留空由服务端生成完整 UUID 房间号 —— 发送方公开写模型下房间号即能力凭据，默认值不能硬编码
const roomId = ref('')

/** 服务端对当前房间号的「偏弱」判定；连接成功后才有值 */
const serverWeakRoomId = ref<boolean | null>(null)

/**
 * 房间号偏弱时提示。
 * 连接后用服务端的权威判定（它维护弱名清单），未连接时退化为「是否 UUID 形态」的启发式 ——
 * 前端**不再复刻**一份弱名清单，避免与服务端脱节。
 */
const roomIdHint = computed(() => {
  if (serverWeakRoomId.value === true) {
    return '服务端判定该房间号偏弱，建议留空让服务端生成随机房间号'
  }

  const typed = roomId.value.trim()
  if (!typed || !looksWeakRoomId(typed)) return ''
  return '该房间号看起来不是随机生成，建议留空让服务端生成'
})

/** 本房间配额使用率（0–1），用于接近上限时把数字标红 */
const storageUsageRatio = computed(() => {
  const limit = roomState.value?.storageLimitBytes ?? 0
  if (limit <= 0) return 0
  return Math.min((roomState.value?.storedBytes ?? 0) / limit, 1)
})

const storageUsageLabel = computed(() => {
  const snapshot = roomState.value
  if (!snapshot) return '—'
  return `${formatFileSize(snapshot.storedBytes)} / ${formatFileSize(snapshot.storageLimitBytes)}`
})
const connectionState = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
const statusMessage = ref('尚未建立连接')
const roomState = ref<RoomSnapshot | null>(null)
const recentEvents = ref<LogEntry[]>([])
const eventSource = ref<EventSource | null>(null)
const stateUrl = ref('')
const reconnectAttempts = ref(0)
let manualDisconnect = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

const statusLabel = computed(() => {
  switch (connectionState.value) {
    case 'connecting':
      return '连接中'
    case 'connected':
      return '已连接'
    case 'reconnecting':
      return '重连中'
    case 'error':
      return '连接失败'
    default:
      return '未连接'
  }
})

const statusBadgeClass = computed(() => {
  switch (connectionState.value) {
    case 'connected':
      return 'bg-green-100 text-green-800'
    case 'connecting':
    case 'reconnecting':
      return 'bg-yellow-100 text-yellow-800'
    case 'error':
      return 'bg-red-100 text-red-800'
    default:
      return 'bg-gray-100 text-gray-700'
  }
})

const ensureRoom = async (baseUrl: string, targetRoomId: string) => {
  // 房间号留空时不传 roomId，由服务端生成完整 UUID
  const body = targetRoomId ? JSON.stringify({ roomId: targetRoomId }) : '{}'

  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: withAuth({ 'Content-Type': 'application/json' }),
    body
  })

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('鉴权失败：请检查接收端密钥是否与 Relay 的 RELAY_TOKEN 一致')
    }
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error ?? `房间创建失败（HTTP ${response.status}）`)
  }

  return response.json() as Promise<RelayRoomResponse>
}

const refreshRoomState = async () => {
  if (!stateUrl.value) return

  const response = await fetch(stateUrl.value, { headers: withAuth() })
  if (!response.ok) return
  roomState.value = await response.json() as RoomSnapshot
}

const parseEvent = <T,>(event: MessageEvent<string>) => {
  return JSON.parse(event.data) as RelayEventEnvelope<T>
}

const pushEventLog = (type: string, message: string, createdAt = new Date().toISOString()) => {
  recentEvents.value = [
    {
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      type,
      message,
      createdAt
    },
    ...recentEvents.value
  ].slice(0, 6)
}

const MAX_RECONNECT_ATTEMPTS = 8
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 15000

const clearReconnectTimer = () => {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

/** 断线后指数退避重连，达上限即停，避免硬错误无限重试（EventSource CLOSED 不自动重连） */
const scheduleReconnect = () => {
  if (manualDisconnect || reconnectTimer !== null) return

  if (reconnectAttempts.value >= MAX_RECONNECT_ATTEMPTS) {
    connectionState.value = 'error'
    statusMessage.value = '重连次数过多已停止，请检查 Relay 地址/网络后手动重连。'
    pushEventLog('error', statusMessage.value)
    return
  }

  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** reconnectAttempts.value)
  reconnectAttempts.value += 1
  connectionState.value = 'reconnecting'
  statusMessage.value = `连接中断，${Math.ceil(delay / 1000)} 秒后第 ${reconnectAttempts.value} 次重连...`
  pushEventLog('reconnect', `计划第 ${reconnectAttempts.value} 次重连（${Math.ceil(delay / 1000)}s）`)

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connect(true)
  }, delay)
}

const closeEventSource = () => {
  if (eventSource.value) {
    eventSource.value.close()
    eventSource.value = null
  }
}

const handleRoomCreated = (event: MessageEvent<string>) => {
  const payload = parseEvent<{ roomId: string; createdAt: string }>(event)
  pushEventLog(payload.type, `房间 ${payload.data.roomId} 已就绪`, payload.createdAt)
  void refreshRoomState()
}

const handleReceiverReady = (event: MessageEvent<string>) => {
  const payload = parseEvent<{ roomId: string; message: string }>(event)
  pushEventLog(payload.type, payload.data.message, payload.createdAt)
  void refreshRoomState()
}

/** 服务端因体积上限截断正文时，在展示内容末尾给出说明 */
const TRUNCATION_NOTE = '\n\n—— 正文过长，已在接收端展示上限处截断；完整内容请下载原件。'

const decodeRelayContent = (upload: RelayUploadSummary) => {
  if (upload.contentText !== null) {
    return upload.textTruncated ? `${upload.contentText}${TRUNCATION_NOTE}` : upload.contentText
  }

  if (upload.previewText) {
    return upload.previewText
  }

  return binaryPlaceholder(upload.name, '已接收')
}

/** 是否拿到了可读文本；决定 FileViewer 以等宽字体还是普通字体渲染 */
const hasReadableText = (upload: RelayUploadSummary) =>
  upload.contentText !== null || Boolean(upload.previewText)

/**
 * SSE 广播只带元信息（contentIncluded:false），正文需按 detailsUrl 按需拉取。
 * 已包含正文（如 details 端点返回）则原样返回，避免重复请求。
 */
const fetchUploadDetails = async (upload: RelayUploadSummary): Promise<RelayUploadSummary> => {
  if (upload.contentIncluded || upload.contentText !== null || upload.contentBase64) {
    return upload
  }

  const response = await fetch(upload.detailsUrl, { headers: withAuth() })
  if (!response.ok) {
    throw new Error(`拉取文件正文失败（HTTP ${response.status}）`)
  }

  const payload = await response.json() as { upload: RelayUploadSummary }
  return payload.upload
}

/**
 * 把一条上传落进本地文件列表并同步收集状态。
 * 过去成功分支与失败分支各抄了一遍这段逻辑（约 20 行 ×2），改一处极易漏另一处。
 */
const ingestUpload = (upload: RelayUploadSummary, roomId: string) => {
  const file = fileStore.upsertRelayFile({
    name: upload.name,
    content: decodeRelayContent(upload),
    contentBase64: upload.contentBase64 ?? undefined,
    hasTextContent: hasReadableText(upload),
    size: upload.size,
    type: upload.mimeType,
    lastModified: upload.lastModified,
    roomId,
    uploadId: upload.id,
    downloadUrl: upload.downloadUrl
  })

  const collectionItem = file.filenameValidation.isValid
    ? collectionStore.checkFileStatus(file.name)
    : null
  if (collectionItem && collectionItem.status !== 'collected') {
    collectionStore.updateItemStatus(collectionItem.id, 'collected')
  }

  if (!fileStore.selectedFile) {
    fileStore.selectFile(file)
  }

  void refreshRoomState()
}

const handleUploadCreated = async (event: MessageEvent<string>) => {
  const payload = parseEvent<UploadCreatedData>(event)
  const { upload, roomId: uploadRoomId } = payload.data

  try {
    const full = await fetchUploadDetails(upload)
    ingestUpload(full, uploadRoomId)
    pushEventLog(payload.type, `已接收 ${full.name}`, payload.createdAt)
    statusMessage.value = `已接收文件：${full.name}`
  } catch (error) {
    // 正文拉取失败也要把文件落进列表（用 SSE 帧里带的元信息兜底），否则接收端会「少一个文件」
    ingestUpload(upload, uploadRoomId)
    pushEventLog(payload.type, `接收成功，但正文拉取失败：${upload.name}`, payload.createdAt)
    statusMessage.value = error instanceof Error ? error.message : '正文不可用'
  }
}

/**
 * 构造 SSE 连接地址。有 token 时先换取一次性短时效票据，避免长期 token 进入 URL
 * （会被访问日志 / Referer / 浏览器历史记录）。无 token 时直接连接。
 */
const buildStreamUrl = async (room: RelayRoomResponse): Promise<string> => {
  // 未配置接收端密钥时服务端不做鉴权，直接用 streamUrl 即可
  if (!relayToken.value) return room.streamUrl

  const response = await fetch(room.streamTicketUrl, {
    method: 'POST',
    headers: withAuth()
  })
  if (!response.ok) {
    throw new Error(`获取流票据失败（HTTP ${response.status}）`)
  }

  const payload = await response.json() as { ticket: string }
  return `${room.streamUrl}?ticket=${encodeURIComponent(payload.ticket)}`
}

const connect = async (isReconnect = false) => {
  // 首次连接重置计数与手动断开标记；重连复用已有参数
  if (!isReconnect) {
    reconnectAttempts.value = 0
    manualDisconnect = false
  }
  clearReconnectTimer()
  closeEventSource()

  connectionState.value = 'connecting'
  statusMessage.value = '正在创建房间并建立长连接...'

  try {
    const baseUrl = normalizeRelayUrl(relayBaseUrl.value)
    const targetRoomId = roomId.value.trim()
    const roomIdError = validateRoomId(targetRoomId, { allowEmpty: true })

    if (roomIdError) {
      throw new Error(roomIdError)
    }

    const room = await ensureRoom(baseUrl, targetRoomId)
    stateUrl.value = room.stateUrl
    roomId.value = room.roomId
    serverWeakRoomId.value = room.weakRoomId ?? null

    await refreshRoomState()

    // SSE 无法自定义请求头：改用一次性短时效票据，避免长期 token 进 URL（日志/Referer/历史）
    const streamUrl = await buildStreamUrl(room)
    const source = new EventSource(streamUrl)
    eventSource.value = source

    source.addEventListener('open', () => {
      reconnectAttempts.value = 0
      connectionState.value = 'connected'
      statusMessage.value = `已连接到 ${room.roomId}`
      pushEventLog('open', `已连接到 ${room.roomId}`)
    })

    source.addEventListener('receiver.ready', (event) => {
      handleReceiverReady(event as MessageEvent<string>)
    })

    source.addEventListener('room.created', (event) => {
      handleRoomCreated(event as MessageEvent<string>)
    })

    source.addEventListener('upload.created', (event) => {
      void handleUploadCreated(event as MessageEvent<string>)
    })

    // EventSource CLOSED 不自动重连，统一走 scheduleReconnect（内置手动断开守卫与重试上限）
    source.onerror = () => {
      scheduleReconnect()
    }
  } catch (error) {
    connectionState.value = 'error'
    statusMessage.value = error instanceof Error ? error.message : '建立连接失败'
    pushEventLog('error', statusMessage.value)
  }
}

const disconnect = () => {
  manualDisconnect = true
  clearReconnectTimer()
  closeEventSource()
  connectionState.value = 'idle'
  statusMessage.value = '连接已断开'
}

onBeforeUnmount(() => {
  manualDisconnect = true
  clearReconnectTimer()
  closeEventSource()
})
</script>
