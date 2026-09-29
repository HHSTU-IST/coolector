/**
 * 接收端 composable 的最小回归网。
 *
 * 重点守两条**安全语义**：
 *   1. 服务端返回的详情地址若指向非配置的 Relay 源，接收端必须**在发出请求之前**就拒绝它 ——
 *      否则 `RELAY_TOKEN` 会被送到攻击者域（F-001）。这条语义此前没有任何断言守护：
 *      把它换成「吞掉异常、照发请求」的实现，全套测试依然全绿。
 *   2. SSE 请求必须携带 ngrok 跳过头 —— 原生 `EventSource` **无法携带任何请求头**，
 *      这正是实现从 `EventSource` 改为 fetch 流的原因；头一旦丢了，公网形态下长连接必失败。
 */

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { binaryPlaceholder } from '../utils/relay-content'
import { relayToken } from '../utils/relay'
import { useFileStore } from '../stores/file'
import { useRelayReceiver } from './useRelayReceiver'
import type { RelayUploadSummary } from '../utils/relay-types'

const BASE = 'http://127.0.0.1:8787'
const ROOM_ID = 'room-under-test'
const UPLOAD_ID = 'u1'

/**
 * 假的事件流主体 —— 让测试能按需推帧。
 *
 * 不使用真实 `ReadableStream`：测试环境（happy-dom）与 Node 对它的实现细节不同，
 * 而这里只需要「读会挂起、推入即唤醒」这一条语义，手写反而更稳定。
 */
class FakeEventStreamBody {
  private readonly queue: Uint8Array[] = []
  private readonly waiters: ((result: { done: boolean; value: Uint8Array | undefined }) => void)[] = []
  private closed = false

  /** 推入一帧原始文本；若已有挂起的 read，立即唤醒它 */
  push(text: string) {
    const bytes = new TextEncoder().encode(text)
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value: bytes })
    else this.queue.push(bytes)
  }

  /** 组装成 fetch 能看到的事件流响应（只实现实现体真正读到的成员） */
  response(): Response {
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null) },
      body: {
        getReader: () => ({
          read: () => new Promise<{ done: boolean; value: Uint8Array | undefined }>((resolve) => {
            const queued = this.queue.shift()
            if (queued) { resolve({ done: false, value: queued }); return }
            if (this.closed) { resolve({ done: true, value: undefined }); return }
            this.waiters.push(resolve)
          }),
          releaseLock: () => { /* 假 reader 无锁可释放 */ }
        })
      }
    } as unknown as Response
  }
}

/** 只实现 composable 用到的三个成员，避免依赖完整 Response 实现 */
const jsonResponse = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload
}) as Response

const roomResponse = () => ({
  roomId: ROOM_ID,
  createdAt: new Date(0).toISOString(),
  weakRoomId: false,
  streamUrl: `/api/rooms/${ROOM_ID}/events`,
  streamTicketUrl: `/api/rooms/${ROOM_ID}/stream-ticket`,
  uploadUrl: `/api/rooms/${ROOM_ID}/uploads`,
  stateUrl: `/api/rooms/${ROOM_ID}`
})

/** SSE 广播帧里的上传摘要：只有元信息，正文需按 detailsUrl 另拉 */
const uploadFrame = (detailsUrl: string): RelayUploadSummary => ({
  id: UPLOAD_ID,
  name: '张三-20230101.md',
  mimeType: 'text/markdown',
  size: 12,
  uploadedAt: new Date(0).toISOString(),
  lastModified: new Date(0).toISOString(),
  previewText: null,
  textTruncated: false,
  contentIncluded: false,
  contentText: null,
  contentBase64: null,
  detailsUrl,
  downloadUrl: `/api/rooms/${ROOM_ID}/uploads/${UPLOAD_ID}?download=1`
})

let api!: ReturnType<typeof useRelayReceiver>
let calls: string[] = []
/** 每一次请求的 URL 与请求头 —— 用于断言 SSE 是否携带了跳过头 */
let requests: { url: string; headers: Record<string, string> }[] = []
let streamBody!: FakeEventStreamBody

/** 通过事件流推一帧，形状与服务端广播一致 */
const emit = (type: string, data: unknown) => {
  const envelope = { id: 'event-1', type, createdAt: new Date(0).toISOString(), data }
  streamBody.push(`event: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 挂载一个只调用 composable 的宿主组件（生命周期钩子需要组件实例） */
async function connectReceiver() {
  const wrapper = mount(defineComponent({
    setup() {
      api = useRelayReceiver()
      return () => null
    }
  }))

  api.relayBaseUrl.value = BASE
  await api.connect()

  expect(api.stream.value, '未建立 SSE 长连接').toBeTruthy()

  return { wrapper }
}

beforeEach(() => {
  setActivePinia(createPinia())
  calls = []
  requests = []
  relayToken.value = ''
  streamBody = new FakeEventStreamBody()

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })

    if (url.includes('/events')) return streamBody.response()
    if (url.endsWith('/api/rooms')) return jsonResponse(roomResponse())
    if (url.includes(`/uploads/${UPLOAD_ID}`)) {
      return jsonResponse({
        upload: { ...uploadFrame(url), contentIncluded: true, contentText: '正文' }
      })
    }
    return jsonResponse({ uploads: [] })
  }))
})

describe('useRelayReceiver 的跨源防护', () => {
  it('跨源 detailsUrl 在发出请求前被拒绝，且文件仍以元信息兜底入库', async () => {
    const { wrapper } = await connectReceiver()
    const before = calls.length

    emit('upload.created', {
      roomId: ROOM_ID,
      upload: uploadFrame(`https://evil.example/api/rooms/${ROOM_ID}/uploads/${UPLOAD_ID}`),
      downloadUrl: ''
    })
    await flush()

    const issued = calls.slice(before)
    // 核心断言：绝不带着凭据请求非配置的源（这条断了就等于 F-001 复活）
    expect(issued.some((url) => url.includes('evil.example'))).toBe(false)
    // 任何新请求都只能打到配置的 Relay 地址
    for (const url of issued) expect(url.startsWith(BASE)).toBe(true)
    // 安全拒绝必须显式告知用户，而不是静默吞掉
    expect(api.statusMessage.value).toMatch(/拒绝向非配置的 Relay 源/u)

    // 正文拉取失败也不能丢文件，否则接收端会「少一个文件」
    const file = useFileStore().files.find((item) => item.relayUploadId === UPLOAD_ID)
    expect(file?.name).toBe('张三-20230101.md')
    expect(file?.content).toBe(binaryPlaceholder('张三-20230101.md', '已接收'))

    wrapper.unmount()
  })

  it('判别力对照：相对 detailsUrl 会真的发起请求（上一条不是因为压根不拉正文而通过）', async () => {
    const { wrapper } = await connectReceiver()
    const before = calls.length

    emit('upload.created', {
      roomId: ROOM_ID,
      upload: uploadFrame(`/api/rooms/${ROOM_ID}/uploads/${UPLOAD_ID}`),
      downloadUrl: ''
    })
    await flush()

    expect(calls.slice(before)).toContain(`${BASE}/api/rooms/${ROOM_ID}/uploads/${UPLOAD_ID}`)

    const file = useFileStore().files.find((item) => item.relayUploadId === UPLOAD_ID)
    expect(file?.content).toBe('正文')

    wrapper.unmount()
  })
})

describe('useRelayReceiver 的事件流', () => {
  it('SSE 请求携带 ngrok 跳过头（EventSource 无法携带，正是换实现的原因）', async () => {
    const { wrapper } = await connectReceiver()

    const streamRequest = requests.find((request) => request.url.includes('/events'))
    expect(streamRequest, '没有发出 SSE 请求').toBeTruthy()
    expect(streamRequest?.headers['ngrok-skip-browser-warning']).toBe('1')
    expect(streamRequest?.headers.Accept).toBe('text/event-stream')

    wrapper.unmount()
  })

  it('receiver.ready 帧会落到事件日志里（换实现后事件路由仍然通）', async () => {
    const { wrapper } = await connectReceiver()

    emit('receiver.ready', { roomId: ROOM_ID, message: '接收端已就绪' })
    await flush()

    expect(api.recentEvents.value.some((entry) => entry.message.includes('接收端已就绪'))).toBe(true)

    wrapper.unmount()
  })

  it('未知事件类型被静默忽略，不影响已建立的长连接', async () => {
    const { wrapper } = await connectReceiver()
    const before = api.recentEvents.value.length

    emit('something.brand.new', { hello: 'world' })
    await flush()

    expect(api.recentEvents.value.length).toBe(before)
    expect(api.stream.value).toBeTruthy()

    wrapper.unmount()
  })
})
