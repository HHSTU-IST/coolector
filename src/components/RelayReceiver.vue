<template>
  <div class="w-full">
    <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      <div class="p-6 border-b border-gray-200">
        <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p class="text-xs font-semibold uppercase tracking-[0.24em] text-indigo-500">Receiver Long Connection</p>
            <h2 class="text-xl font-semibold text-gray-900 mt-1">公网接收长连接</h2>
            <p class="text-sm text-gray-500 mt-2">
              通过 SSE 保持和 Relay Server 的长连接，自动接收远端上传并灌入本地文件列表。
            </p>
          </div>

          <div class="text-left md:text-right">
            <span
              class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium"
              :class="statusBadgeClass"
            >
              {{ statusLabel }}
            </span>
            <p class="text-xs text-gray-500 mt-2">{{ statusMessage }}</p>
          </div>
        </div>
      </div>

      <div class="p-6 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <form class="space-y-4" @submit.prevent="connect">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">Relay 地址</label>
            <input
              v-model="relayBaseUrl"
              type="url"
              class="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              placeholder="http://127.0.0.1:8787"
            >
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">房间 ID</label>
            <input
              v-model="roomId"
              type="text"
              class="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              placeholder="demo-room"
            >
          </div>

          <div class="flex flex-wrap gap-3">
            <button
              type="submit"
              :disabled="connectionState === 'connecting'"
              class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {{ connectionState === 'connected' ? '重新连接' : '建立长连接' }}
            </button>
            <button
              type="button"
              @click="disconnect"
              :disabled="!eventSource"
              class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              断开连接
            </button>
          </div>

          <div class="rounded-xl bg-indigo-50 border border-indigo-100 p-4 text-sm text-indigo-900">
            <p class="font-medium">连接说明</p>
            <p class="mt-1">
              组件会先创建或进入房间，然后打开 `/events` 的 SSE 通道，接收到 `upload.created` 后自动拉取文件内容。
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
              <div
                v-for="event in recentEvents"
                :key="event.id"
                class="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700"
              >
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

interface RelayRoomResponse {
  roomId: string
  createdAt: string
  streamUrl: string
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
  hasTextPreview: boolean
  previewText: string | null
  contentText: string | null
  contentBase64: string
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

const DEFAULT_RELAY_URL = import.meta.env.VITE_RELAY_URL ?? 'http://127.0.0.1:8787'

const fileStore = useFileStore()
const collectionStore = useCollectionStore()

const relayBaseUrl = ref(DEFAULT_RELAY_URL)
const roomId = ref('demo-room')
const connectionState = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
const statusMessage = ref('尚未建立连接')
const roomState = ref<RoomSnapshot | null>(null)
const recentEvents = ref<LogEntry[]>([])
const eventSource = ref<EventSource | null>(null)
const streamUrl = ref('')
const stateUrl = ref('')

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

const normalizeRelayUrl = (value: string) => value.trim().replace(/\/+$/, '')

const ensureRoom = async (baseUrl: string, targetRoomId: string) => {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ roomId: targetRoomId })
  })

  if (!response.ok) {
    throw new Error(await response.text())
  }

  return response.json() as Promise<RelayRoomResponse>
}

const refreshRoomState = async () => {
  if (!stateUrl.value) return

  const response = await fetch(stateUrl.value)
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

const reconnect = () => {
  if (connectionState.value !== 'connected') {
    connectionState.value = 'reconnecting'
    statusMessage.value = '连接中断，正在自动重连...'
  }
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

const decodeRelayContent = (upload: RelayUploadSummary) => {
  if (upload.contentText !== null) {
    return upload.contentText
  }

  if (upload.contentBase64) {
    try {
      return atob(upload.contentBase64)
    } catch {
      return ''
    }
  }

  return upload.previewText ?? ''
}

const handleUploadCreated = async (event: MessageEvent<string>) => {
  const payload = parseEvent<UploadCreatedData>(event)
  const upload = payload.data.upload

  try {
    const content = decodeRelayContent(upload)
    const file = fileStore.upsertRelayFile({
      name: upload.name,
      content,
      contentBase64: upload.contentBase64,
      hasTextContent: upload.contentText !== null || Boolean(upload.previewText),
      size: upload.size,
      type: upload.mimeType,
      lastModified: upload.lastModified,
      roomId: payload.data.roomId,
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

    pushEventLog(payload.type, `已内存转发 ${upload.name}`, payload.createdAt)
    statusMessage.value = `已内存转发文件：${upload.name}`
    void refreshRoomState()
  } catch (error) {
    const fallbackContent = upload.previewText ?? ''
    const file = fileStore.upsertRelayFile({
      name: upload.name,
      content: fallbackContent,
      contentBase64: upload.contentBase64,
      hasTextContent: Boolean(fallbackContent),
      size: upload.size,
      type: upload.mimeType,
      lastModified: upload.lastModified,
      roomId: payload.data.roomId,
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

    pushEventLog(payload.type, `接收成功，但内存内容不可用：${upload.name}`, payload.createdAt)
    statusMessage.value = error instanceof Error ? error.message : '内存内容不可用'
    void refreshRoomState()
  }
}

const connect = async () => {
  disconnect()

  connectionState.value = 'connecting'
  statusMessage.value = '正在创建房间并建立长连接...'

  try {
    const baseUrl = normalizeRelayUrl(relayBaseUrl.value)
    const targetRoomId = roomId.value.trim()

    if (!targetRoomId) {
      throw new Error('房间 ID 不能为空')
    }

    const room = await ensureRoom(baseUrl, targetRoomId)
    streamUrl.value = room.streamUrl
    stateUrl.value = room.stateUrl
    roomId.value = room.roomId

    await refreshRoomState()

    const source = new EventSource(room.streamUrl)
    eventSource.value = source

    source.addEventListener('open', () => {
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

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        connectionState.value = 'error'
        statusMessage.value = '长连接已关闭'
        pushEventLog('error', '长连接已关闭')
      } else {
        reconnect()
      }
    }
  } catch (error) {
    connectionState.value = 'error'
    statusMessage.value = error instanceof Error ? error.message : '建立连接失败'
    pushEventLog('error', statusMessage.value)
  }
}

const disconnect = () => {
  closeEventSource()
  connectionState.value = 'idle'
  statusMessage.value = '连接已断开'
}

onBeforeUnmount(() => {
  closeEventSource()
})
</script>
