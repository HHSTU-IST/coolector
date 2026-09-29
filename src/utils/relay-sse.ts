/**
 * SSE over `fetch` —— 取代 `EventSource`，全部理由是「**能带请求头**」。
 *
 * `EventSource` 更省事（自带重连、自动解帧），但规范**不允许设置请求头**，而这个约束正好
 * 卡死在公网形态上：ngrok 免费档会对**浏览器形态的 GET** 注入 interstitial 警告页
 * （响应 `Ngrok-Error-Code: ERR_NGROK_6024`、`Content-Type: text/plain`），该响应**不带 CORS 头**
 * ⇒ 浏览器把它报成 CORS 失败，界面只看到 `Failed to fetch`。唯一的跳过头
 * （`ngrok-skip-browser-warning`）只能经请求头送达 ⇒ 用 `EventSource` 时 SSE 在免费隧道下
 * **永远连不上**，且症状完全不可诊断。取证方法与三态判别见 `.workbuddy/memory/INVARIANTS.md`。
 *
 * 代价是自己解帧与重连。解帧在本文件；重连**有意不做** —— 调用方（`useRelayReceiver`）
 * 已有退避与手动断开守卫，重复实现只会多一处要同步的状态。
 */

/** 事件流 MIME。服务端写的是 `text/event-stream; charset=utf-8`，故用包含判断 */
const EVENT_STREAM_MIME = 'text/event-stream'

/** 帧分隔：规范允许 LF / CRLF / CR 三种行尾，两个相连的行尾即结束一帧 */
const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/u

/** 行尾，用于把一帧切成字段行 */
const LINE_SEPARATOR = /\r\n|\r|\n/u

export interface RelaySseEvent {
  /** `event:` 字段的值；缺省为 `message` */
  type: string
  /** `data:` 字段的值，多行以 `\n` 连接 */
  data: string
}

export interface RelaySseHandlers {
  /** 已拿到事件流响应头、开始收帧 */
  onOpen?: () => void
  onEvent: (event: RelaySseEvent) => void
  /** 建立失败、流结束或读取出错；调用方据此决定是否重连 */
  onError: (error: Error) => void
}

export interface RelaySseConnection {
  /** 已关闭（主动 `close()` 或已触发 `onError`） */
  readonly closed: boolean
  close: () => void
}

/**
 * 切出完整帧，并返回尾部尚未成帧的片段。
 *
 * **尾部片段必须留在缓冲里**：TCP 分片与 `fetch` 的 chunk 边界和帧边界无关，一帧横跨两次
 * `reader.read()` 是常态。若每块独立解析，跨块的事件会被**静默丢弃** —— 这类缺陷在本机回环
 * 下几乎不复现，因为回环上通常一次 read 就拿到整帧。
 *
 * @param buffer 累积的原始文本
 * @returns `frames` 为完整帧，`rest` 为需要与下一个 chunk 拼接的残片
 */
export const splitSseFrames = (buffer: string): { frames: string[]; rest: string } => {
  const frames: string[] = []
  let rest = buffer

  // 正则**不带 `g`**：每轮 exec 都从当前 rest 的头部重新搜索，避免 lastIndex 跨轮残留
  for (;;) {
    const match = FRAME_SEPARATOR.exec(rest)
    if (!match) break

    frames.push(rest.slice(0, match.index))
    rest = rest.slice(match.index + match[0].length)
  }

  return { frames, rest }
}

/**
 * 解析单帧。返回 `null` 表示这一帧**不派发**事件。
 *
 * 两类帧会被 `null` 掉，都是有意为之：心跳（以 `:` 开头的注释行，服务端每 15s 发一次）与
 * 只有 `event:` 没有 `data:` 的畸形帧 —— 它们不该在界面上变成一条内容为空的事件。
 */
export const parseSseFrame = (frame: string): RelaySseEvent | null => {
  let type = 'message'
  const dataLines: string[] = []

  for (const line of frame.split(LINE_SEPARATOR)) {
    if (line === '' || line.startsWith(':')) continue

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const rawValue = colon === -1 ? '' : line.slice(colon + 1)
    // 规范：紧跟冒号的**一个**空格是分隔用的，不属于值本身
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue

    if (field === 'event') type = value
    else if (field === 'data') dataLines.push(value)
    // `id:` / `retry:` 有意忽略：服务端广播的 id 未被消费，重连退避由调用方掌管
  }

  if (dataLines.length === 0) return null
  return { type, data: dataLines.join('\n') }
}

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)))

/**
 * 建立一条 SSE 连接。
 *
 * 与 `EventSource` 的行为差异（均为有意）：
 *   · **不自动重连** —— 流结束或出错即回调 `onError`，退避留给调用方
 *   · 不发送 `Last-Event-ID` —— 重连即重新订阅，不做断点续传
 *   · 可携带任意请求头 —— 这正是换掉 `EventSource` 的全部理由
 *
 * @param url 事件流地址（绝对 URL，含一次性票据）
 * @param headers 由调用方组装（含鉴权与隧道跳过头）
 * @param handlers 三个回调；`onError` 至多被调用一次
 */
export const openRelayEventStream = (
  url: string,
  headers: Record<string, string>,
  handlers: RelaySseHandlers
): RelaySseConnection => {
  const controller = new AbortController()
  let closed = false

  /** 收口：置关闭标记、断开底层连接、只通知一次 */
  const fail = (error: Error) => {
    if (closed) return
    closed = true
    controller.abort()
    handlers.onError(error)
  }

  const run = async () => {
    let response: Response
    try {
      response = await fetch(url, {
        headers: { ...headers, Accept: EVENT_STREAM_MIME },
        signal: controller.signal
      })
    } catch (error) {
      // 主动 `close()` 走的是同一条 abort 路径 —— 那不是故障，不通知调用方
      if (!closed) fail(toError(error))
      return
    }

    if (!response.ok) {
      fail(new Error(`建立事件流失败（HTTP ${response.status}）`))
      return
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes(EVENT_STREAM_MIME)) {
      // 最典型的成因是 ngrok 的浏览器警告页把整个响应换成了 HTML。只报「HTTP 200」的话
      // 用户完全无从下手，故把这一条单独认出来并指向真正的开关。
      fail(new Error(
        `响应不是事件流（Content-Type: ${contentType || '未提供'}）。` +
        '经 ngrok 免费隧道时这通常是它的浏览器警告页拦截了请求：' +
        '前端需带 ngrok-skip-browser-warning 头，且 Relay 的 Access-Control-Allow-Headers 必须放行该头。'
      ))
      return
    }

    if (!response.body) {
      fail(new Error('事件流响应没有可读主体'))
      return
    }

    handlers.onOpen?.()

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const { frames, rest } = splitSseFrames(buffer)
        buffer = rest

        for (const frame of frames) {
          const event = parseSseFrame(frame)
          if (event) handlers.onEvent(event)
        }
      }

      fail(new Error('事件流已结束'))
    } catch (error) {
      // `fail` 内部会 abort，进而让挂起的 `read()` 抛出；此处 closed 已置位，不重复通知
      if (!closed) fail(toError(error))
    }
  }

  void run()

  return {
    get closed() {
      return closed
    },
    close: () => {
      if (closed) return
      closed = true
      controller.abort()
    }
  }
}
