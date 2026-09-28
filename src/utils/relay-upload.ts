/**
 * 发送方上传请求的构造 —— 纯函数、无副作用，便于单测直接断言请求形状。
 *
 * 服务端 `parseUploadMetadata` 有两个分支，这里一一对应：
 *
 * - **裸 body（默认）**：请求体就是文件原始字节；文件名走 `?name=<百分号编码的 UTF-8>`，
 *   MIME 与修改时间走请求头。**不做任何 base64** —— 这正是它比信封快的原因。
 * - **JSON 信封**：元信息与 base64 正文都塞进 body。只在**必须携带带外数据**时使用，
 *   目前只有两种情形：
 *   ① 客户端已提取的容器类文档正文（docx）—— 裸 body 通道没有位置放它；
 *   ② 本地没有原始字节（中继接收来的文件只留下 base64）。
 *
 * 为什么文件名放 `?name=` 而不是请求头：HTTP 头值只接受 ISO-8859-1，浏览器 `fetch`
 * 在请求出网前就会对非 ASCII 头值抛 `TypeError`。查询串还能被 `URLSearchParams`
 * 精确反转义 —— 文件名里本来就含 `%XX` 时，写双重编码（`note%2520f.md`）即可表达字面量。
 */

/** 信封里 `text` 字段的字节上限；取值依据见 `truncateEnvelopeText` */
export const ENVELOPE_TEXT_MAX_BYTES = 256 * 1024

/**
 * 按 UTF-8 字节截断正文。
 *
 * 上限取 256KB 与服务端 `MAX_TEXT_BYTES` 的下限一致 —— 否则「接近 10MB 的 docx + 长提取正文」
 * 会把请求体顶到服务端上限之外，被误判 413。`stream: true` 让不完整的多字节序列被丢弃而不是变成乱码。
 */
export const truncateEnvelopeText = (value: string): { text: string; truncated: boolean } => {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= ENVELOPE_TEXT_MAX_BYTES) return { text: value, truncated: false }

  return {
    text: new TextDecoder('utf-8').decode(bytes.subarray(0, ENVELOPE_TEXT_MAX_BYTES), { stream: true }),
    truncated: true
  }
}

/** 二进制转 base64。8KB 分块低于各引擎实参上限，避免一次性展开过多参数。 */
export const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x2000
  let binary = ''

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }

  return btoa(binary)
}

export const blobToBase64 = async (blob: Blob): Promise<string> => arrayBufferToBase64(await blob.arrayBuffer())

export interface RelayUploadInput {
  baseUrl: string
  roomId: string
  name: string
  mimeType: string
  lastModified: Date
  /** 文件原始字节。有值且无需带外正文时走裸 body。 */
  blob?: Blob
  /** 中继接收来的文件本地没有原始字节，只剩 base64 —— 只能走信封 */
  contentBase64?: string
  /** 客户端已提取的容器类文档正文（docx） */
  extractedText?: string | null
}

/** 实际选用的传输形态，供调用方与测试断言 */
export type RelayUploadForm = 'raw' | 'envelope'

export interface RelayUploadRequest {
  url: string
  init: RequestInit
  form: RelayUploadForm
}

export const buildRelayUploadRequest = async (input: RelayUploadInput): Promise<RelayUploadRequest> => {
  const endpoint = `${input.baseUrl}/api/rooms/${encodeURIComponent(input.roomId)}/uploads`
  const extractedText = input.extractedText ?? null
  // 浏览器对无扩展名或未注册类型会给出空串。空串不是合法的头值，也不能落进信封，
  // 统一在此兜底，免得每个调用方各写一遍 `?? 'application/octet-stream'`。
  const mimeType = input.mimeType || 'application/octet-stream'

  // 裸 body 的前提：本地持有原始字节，且没有必须同请求送达的带外正文。
  if (input.blob && extractedText === null) {
    return {
      form: 'raw',
      url: `${endpoint}?name=${encodeURIComponent(input.name)}`,
      init: {
        method: 'POST',
        headers: {
          // 服务端裸 body 分支只认 X-Relay-Mime-Type（Content-Type 不参与判定）；
          // 一并带上真实 Content-Type 是为了让请求自描述，也便于反代与抓包排查。
          'Content-Type': mimeType,
          'X-Relay-Mime-Type': mimeType,
          'X-Relay-Last-Modified': input.lastModified.toISOString()
        },
        body: input.blob
      }
    }
  }

  const contentBase64 = input.contentBase64 ?? (input.blob ? await blobToBase64(input.blob) : undefined)

  const envelope: Record<string, unknown> = {
    name: input.name,
    mimeType,
    lastModified: input.lastModified.toISOString(),
    contentBase64
  }

  if (extractedText !== null) {
    const { text, truncated } = truncateEnvelopeText(extractedText)
    envelope.text = text
    // 客户端截断必须上报：服务端的 textTruncated 只反映它自己那 1MB 的截断，
    // 不报的话 256KB–1MB 区间两端都不会给用户任何提示（内容被静默丢掉）
    if (truncated) envelope.textTruncatedByClient = true
  }

  return {
    form: 'envelope',
    url: endpoint,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 显式标志：服务端仅在此头存在时按 JSON 信封解析，
        // 否则正文本身就是 JSON 的文件（.json/.ipynb）会被误判为信封
        'X-Relay-Envelope': '1'
      },
      body: JSON.stringify(envelope)
    }
  }
}
