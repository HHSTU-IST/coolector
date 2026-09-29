/**
 * 发送方上传请求的构造 —— 纯函数、无副作用，便于单测直接断言请求形状。
 *
 * **只有一种形态：裸 body。** 请求体就是文件的原始字节；文件名走
 * `?name=<百分号编码的 UTF-8>`，MIME 与修改时间走请求头。全程不做 base64。
 *
 * 为什么不保留 JSON 信封：它存在的**唯一**理由是「docx 的提取正文没有位置可放」——
 * 裸 body 通道里只有文件字节本身。正文提取移到服务端之后（`server/relay-docx.js`），
 * 这个理由消失，信封只剩代价：整份文件 base64 膨胀 33%、客户端生成 base64 阻塞主线程
 * （10MB 实测 212.7 ms），以及服务端得按 `MAX_BODY_BYTES` 放宽请求体上限。
 * 服务端仍**保留**信封解析以兼容第三方客户端（`relay-server.js` 的 `parseUploadMetadata`），
 * 只是本前端不再使用它 —— 因此那条分支不再是主路径，只作为协议兼容面存在。
 *
 * 文件名为什么放 `?name=` 而不是请求头：HTTP 头值只接受 ISO-8859-1，浏览器 `fetch`
 * 在请求出网前就会对非 ASCII 头值抛 `TypeError`。查询串还能被 `URLSearchParams`
 * 精确反转义 —— 文件名里本来就含 `%XX` 时，写双重编码（`note%2520f.md`）即可表达字面量。
 */

import { NGROK_SKIP_HEADER } from './relay'

/**
 * base64 → Blob。
 *
 * 中继接收来的文件本地只有 base64（服务端不回传原始字节）。这里把它还原成 Blob 走
 * **同一条**裸 body 路径，而不是退回信封 —— 信封一旦只为一个冷门场景留着，
 * 它就会一直躺在主路径上被误用（这正是上一轮协议形态反复的成因）。
 *
 * 转换是**懒**的：只有真要重传时才付这份代价，接收本身不会为它买单。
 */
export const base64ToBlob = (contentBase64: string, mimeType: string): Blob => {
  const binary = atob(contentBase64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }

  return new Blob([bytes], { type: mimeType })
}

export interface RelayUploadInput {
  baseUrl: string
  roomId: string
  name: string
  mimeType: string
  lastModified: Date
  /** 本地文件的原始字节句柄 */
  blob?: Blob
  /** 中继接收来的文件没有 blob，只有 base64 —— 在本地还原为 Blob 后走同一条路径 */
  contentBase64?: string
}

export interface RelayUploadRequest {
  url: string
  init: RequestInit
  /** 请求体的字节数，供调用方与测试断言（无需读取内容） */
  bodyBytes: number
}

export const buildRelayUploadRequest = (input: RelayUploadInput): RelayUploadRequest => {
  // 浏览器对无扩展名或未注册类型会给出空串。空串不是合法的头值，
  // 统一在此兜底，免得每个调用方各写一遍 `?? 'application/octet-stream'`。
  const mimeType = input.mimeType || 'application/octet-stream'
  // 空串是**合法的** base64：它表示一个 0 字节文件，不能与「缺失」混为一谈
  // （服务端对信封里的 contentBase64 用的是同一判据 —— 见 relay-server.js）。
  const blob = input.blob ?? (typeof input.contentBase64 === 'string' ? base64ToBlob(input.contentBase64, mimeType) : null)

  if (!blob) {
    // 既没有字节也没有 base64 是调用方的 bug：静默发一个 0 字节请求会让接收端收到空文件
    throw new Error('缺少文件字节：RelayUploadInput 需要 blob 或 contentBase64 之一')
  }

  return {
    url: `${input.baseUrl}/api/rooms/${encodeURIComponent(input.roomId)}/uploads?name=${encodeURIComponent(input.name)}`,
    bodyBytes: blob.size,
    init: {
      method: 'POST',
      headers: {
        // 服务端裸 body 分支只认 X-Relay-Mime-Type（Content-Type 不参与判定）；
        // 一并带上真实 Content-Type 是为了让请求自描述，也便于反代与抓包排查。
        'Content-Type': mimeType,
        'X-Relay-Mime-Type': mimeType,
        'X-Relay-Last-Modified': input.lastModified.toISOString(),
        // 上传是 POST，当前 ngrok 策略下不会被插页；统一携带是为了不依赖那条策略细节
        ...NGROK_SKIP_HEADER
      },
      body: blob
    }
  }
}
