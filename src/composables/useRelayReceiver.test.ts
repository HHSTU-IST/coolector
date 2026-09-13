/**
 * 接收端 composable 的最小回归网。
 *
 * 重点守一条**安全语义**：服务端返回的详情地址若指向非配置的 Relay 源，
 * 接收端必须**在发出请求之前**就拒绝它 —— 否则 `RELAY_TOKEN` 会被送到攻击者域（F-001）。
 * 这条语义此前没有任何断言守护：把它换成「吞掉异常、照发请求」的实现，全套测试依然全绿。
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

/** 假的 EventSource：捕获实例，并允许测试手动派发 SSE 事件 */
class FakeEventSource {
  static instances: FakeEventSource[] = []

  onerror: ((event: Event) => void) | null = null
  closed = false

  readonly url: string

  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>()

  // 不用构造函数参数属性：tsconfig 开了 erasableSyntaxOnly（Vite 的纯擦除语义）
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  close() {
    this.closed = true
  }

  /** 模拟服务端推送一帧 SSE 事件 */
  emit(type: string, data: unknown) {
    const event = {
      data: JSON.stringify({ id: 'event-1', type, createdAt: new Date(0).toISOString(), data })
    } as MessageEvent<string>

    for (const listener of this.listeners.get(type) ?? []) listener(event)
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

  const source = FakeEventSource.instances.at(-1)
  expect(source, '未建立 EventSource 长连接').toBeTruthy()

  return { wrapper, source: source as FakeEventSource }
}

beforeEach(() => {
  setActivePinia(createPinia())
  FakeEventSource.instances = []
  calls = []
  relayToken.value = ''

  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)

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
    const { wrapper, source } = await connectReceiver()
    const before = calls.length

    source.emit('upload.created', {
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
    const { wrapper, source } = await connectReceiver()
    const before = calls.length

    source.emit('upload.created', {
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
