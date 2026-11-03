/**
 * 接收端长连接的全部响应式逻辑：建房、票据换票、SSE 接线、重连退避、上传落库。
 * 抽出这一层是为了让组件只负责模板与绑定 —— 它原来把状态机、网络与 UI 混在 570 行里。
 */

import { computed, onBeforeUnmount, ref } from 'vue'
import { useCollectionStore } from '../stores/collection'
import { useFileStore } from '../stores/file'
import { formatFileSize } from '../utils/format'
import { binaryPlaceholder } from '../utils/relay-content'
import {
  DEFAULT_RELAY_URL,
  NGROK_SKIP_HEADER,
  looksWeakRoomId,
  normalizeRelayUrl,
  relayToken,
  resolveRelayUrl,
  UntrustedRelayUrlError,
  validateRelayUrl,
  validateRoomId,
  withAuth
} from '../utils/relay'
import { openRelayEventStream } from '../utils/relay-sse'
import type { RelaySseConnection } from '../utils/relay-sse'
import type {
  LogEntry, RelayEventEnvelope, RelayRoomResponse, RelayUploadSummary, RoomSnapshot
} from '../utils/relay-types'
import {
  parseEventEnvelope, parseRoomResponse, parseRoomSnapshot,
  parseStreamTicket, parseUploadCreatedData, parseUploadDetailsResponse
} from '../utils/relay-validate'

/**
 * 控制面请求（建房 / 换票 / 房间状态）都是小的 JSON 往返。给它们一个墙钟超时，
 * 是为了修掉一个可复现的死角：Relay 挂起（TCP 连上但不回响应）时，此前没有任何超时，
 * `connect()` 会永远停在 `'connecting'`、提交按钮长期禁用，用户无从自愈。
 * 有界失败远好过无限挂起。
 */
const CONTROL_TIMEOUT_MS = 15000

/** 按需拉正文可能传较大文件、且走公网，超时放宽；但仍是有界失败而非无限挂起。 */
const DETAILS_TIMEOUT_MS = 60000

export function useRelayReceiver() {

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
  /** 当前 SSE 连接；`null` 表示没有活动连接（模板据此禁用「断开连接」按钮） */
  const stream = ref<RelaySseConnection | null>(null)
  const stateUrl = ref('')
  const reconnectAttempts = ref(0)
  let manualDisconnect = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 连接世代号：每次 connect()/disconnect 递增。并发或交叠的 connect（如重连定时器与用户手动
   * 点击同时触发）据此判定「我还是最新的那次吗」——陈旧尝试在跨越 await 后一律静默退出，
   * 不再改写 connectionState/statusMessage/stream，也不为已被取代的连接触发重连。
   */
  let connectGen = 0

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
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      body
    })

    if (!response.ok) {
      if (response.status === 401) {
        // 区分「没填」与「填错」：两者服务端都回 401，但处置完全不同 —— 前者是忘了填
        // （或页面刷新后丢失），后者才是密钥本身不对。合成一条文案只会让人反复核对一个正确的值。
        throw new Error(relayToken.value.trim()
          ? '鉴权失败：接收端密钥与 Relay 的 RELAY_TOKEN 不一致（区分大小写，勿含空格或换行）'
          : '鉴权失败：未填写接收端密钥 —— 该 Relay 已启用 RELAY_TOKEN，接收端必须填写后才能建房')
      }
      const payload = await response.json().catch(() => null) as { error?: string } | null
      throw new Error(payload?.error ?? `房间创建失败（HTTP ${response.status}）`)
    }

    return parseRoomResponse(await response.json())
  }

  /**
   * 服务端返回的地址（stateUrl / detailsUrl / streamUrl …）一律按**用户配置的 Relay 地址**
   * 解析；绝对 URL 还必须同源，否则拒绝。理由见 relay.ts 的 resolveRelayUrl。
   */
  const toRelayRequestUrl = (target: string) => resolveRelayUrl(target, relayBaseUrl.value)

  const refreshRoomState = async () => {
    if (!stateUrl.value) return

    try {
      const response = await fetch(toRelayRequestUrl(stateUrl.value), { headers: withAuth(), signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) })
      if (!response.ok) {
        pushEventLog('warn', `刷新房间状态失败（HTTP ${response.status}）`)
        return
      }
      roomState.value = parseRoomSnapshot(await response.json())
    } catch (error) {
      // 调用方是 `void refreshRoomState()`，这里必须自己收口，否则会变成未处理拒绝。
      // 网络抖动保持静默（与原先一致）；「地址被拒绝」是安全事件，必须显式告知用户。
      if (error instanceof UntrustedRelayUrlError) {
        statusMessage.value = error.message
        pushEventLog('error', error.message)
      }
    }
  }

  const parseEvent = <T,>(data: string): RelayEventEnvelope<T> => {
    return parseEventEnvelope<T>(JSON.parse(data))
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

  /**
   * 记录一条被跳过的畸形 SSE 帧。
   * 单帧坏（JSON.parse 抛错 / 字段缺失）不该撕裂整条连接，也不该留下未处理拒绝 —— 就地吞掉并告知用户。
   */
  const noteBadFrame = (type: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    pushEventLog('error', `忽略畸形事件（${type}）：${message}`)
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

  /** 断线后指数退避重连，达上限即停，避免硬错误无限重试（SSE 流本身不做自动重连） */
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

  const closeStream = () => {
    if (stream.value) {
      stream.value.close()
      stream.value = null
    }
  }

  const handleRoomCreated = (data: string) => {
    const payload = parseEvent<{ roomId: string; createdAt: string }>(data)
    pushEventLog(payload.type, `房间 ${payload.data.roomId} 已就绪`, payload.createdAt)
    void refreshRoomState()
  }

  const handleReceiverReady = (data: string) => {
    const payload = parseEvent<{ roomId: string; message: string }>(data)
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

    const response = await fetch(toRelayRequestUrl(upload.detailsUrl), { headers: withAuth(), signal: AbortSignal.timeout(DETAILS_TIMEOUT_MS) })
    if (!response.ok) {
      throw new Error(`拉取文件正文失败（HTTP ${response.status}）`)
    }

    return parseUploadDetailsResponse(await response.json())
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
      // 刻意不落 downloadUrl：全前端只写不读，留着只会给未来留一条绕过同源校验的路径
      uploadId: upload.id
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

  const handleUploadCreated = async (data: string) => {
    const payload = parseEvent<unknown>(data)
    const { upload, roomId: uploadRoomId } = parseUploadCreatedData(payload.data)

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
    const streamUrl = toRelayRequestUrl(room.streamUrl)

    // 未配置接收端密钥时服务端不做鉴权，直接用 streamUrl 即可
    if (!relayToken.value) return streamUrl

    const response = await fetch(toRelayRequestUrl(room.streamTicketUrl), {
      method: 'POST',
      headers: withAuth(),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS)
    })
    if (!response.ok) {
      throw new Error(`获取流票据失败（HTTP ${response.status}）`)
    }

    const ticket = parseStreamTicket(await response.json())
    return `${streamUrl}?ticket=${encodeURIComponent(ticket)}`
  }

  const connect = async (isReconnect = false) => {
    // 本次尝试的世代号：跨越任一 await 后若已被更新的 connect/disconnect 取代，则静默退出。
    const gen = ++connectGen
    const isStale = () => gen !== connectGen

    // 首次连接重置计数与手动断开标记；重连复用已有参数
    if (!isReconnect) {
      reconnectAttempts.value = 0
      manualDisconnect = false
    }
    clearReconnectTimer()
    closeStream()

    connectionState.value = 'connecting'
    statusMessage.value = '正在创建房间并建立长连接...'

    try {
      // 顺序要紧：**先校验原始输入，再归一**。归一对非法形态返回空串，
      // 若先归一会把「带了查询串」这类明确的配置错误伪装成「地址没填」，提示失真。
      // 手填地址同样要校验：`relay.example.com` 这类无 scheme 的值会被当成页面相对路径，
      // 静默把请求打到静态站自己身上（构建期变量已在 relay.ts 模块加载期校验）
      const relayUrlError = validateRelayUrl(relayBaseUrl.value)
      if (relayUrlError) {
        throw new Error(relayUrlError)
      }

      const baseUrl = normalizeRelayUrl(relayBaseUrl.value)

      const targetRoomId = roomId.value.trim()
      const roomIdError = validateRoomId(targetRoomId, { allowEmpty: true })

      if (roomIdError) {
        throw new Error(roomIdError)
      }

      const room = await ensureRoom(baseUrl, targetRoomId)
      if (isStale()) return
      stateUrl.value = room.stateUrl
      roomId.value = room.roomId
      serverWeakRoomId.value = room.weakRoomId ?? null

      await refreshRoomState()
      if (isStale()) return

      // SSE 的凭据走一次性短时效票据（避免长期 token 进 URL：日志 / Referer / 浏览器历史）。
      // 额外携带的 NGROK_SKIP_HEADER 是换掉 EventSource 的直接原因 —— 原生 EventSource
      // **无法设置任何请求头**，在 ngrok 免费隧道下会被浏览器警告页拦成 CORS 失败。
      const streamUrl = await buildStreamUrl(room)
      if (isStale()) return
      stream.value = openRelayEventStream(streamUrl, NGROK_SKIP_HEADER, {
        onOpen: () => {
          if (isStale()) return
          reconnectAttempts.value = 0
          connectionState.value = 'connected'
          statusMessage.value = `已连接到 ${room.roomId}`
          pushEventLog('open', `已连接到 ${room.roomId}`)
        },
        onEvent: ({ type, data }) => {
          if (isStale()) return
          // 逐事件隔离：单帧畸形绝不能冒泡到 relay-sse 的读循环——那里任何 throw 都会被当作连接
          // 故障走 fail()→onError→重连，一条坏帧就会拆掉整条流，还会连带把这一帧对应的上传静默丢弃。
          // 这里就地吞掉并记日志，保住连接与后续事件。未知类型仍静默忽略。
          try {
            if (type === 'receiver.ready') handleReceiverReady(data)
            else if (type === 'room.created') handleRoomCreated(data)
            else if (type === 'upload.created') {
              // async handler 里的同步抛错（parseEvent / 字段缺失）会变成 rejected promise，
              // 不接住就是未处理拒绝；就地收口并告知用户。
              handleUploadCreated(data).catch((error) => noteBadFrame(type, error))
            }
          } catch (error) {
            noteBadFrame(type, error)
          }
        },
        // 与原生 EventSource 不同，这里**不自动重连**：统一走 scheduleReconnect，
        // 以复用它的手动断开守卫与重试上限（原生会自己无限重试，正是要避开的行为）
        onError: () => {
          if (isStale()) return
          stream.value = null
          scheduleReconnect()
        }
      })
    } catch (error) {
      // 已被更新的连接取代时，本次尝试的失败不再改写全局状态——否则会把新尝试刚置好的
      // 'connecting'/'connected' 覆盖成陈旧尝试的错误，制造「闪断」假象。
      if (isStale()) return
      connectionState.value = 'error'
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        statusMessage.value = `连接超时：Relay 在 ${Math.round(CONTROL_TIMEOUT_MS / 1000)} 秒内未响应，请检查 Relay 地址与网络`
      } else {
        statusMessage.value = error instanceof Error ? error.message : '建立连接失败'
      }
      pushEventLog('error', statusMessage.value)
    }
  }

  const disconnect = () => {
    // 递增世代号：让任何仍在 await 中的 connect 尝试在恢复后立即判定为陈旧并退出，
    // 不再于用户主动断开之后偷偷开出一条新流。
    connectGen += 1
    manualDisconnect = true
    clearReconnectTimer()
    closeStream()
    connectionState.value = 'idle'
    statusMessage.value = '连接已断开'
  }

  onBeforeUnmount(() => {
    connectGen += 1
    manualDisconnect = true
    clearReconnectTimer()
    closeStream()
  })

  return {
    relayToken,
    roomId,
    roomIdHint,
    relayBaseUrl,
    connectionState,
    statusLabel,
    statusBadgeClass,
    statusMessage,
    roomState,
    recentEvents,
    stream,
    storageUsageRatio,
    storageUsageLabel,
    connect,
    disconnect
  }
}
