// @vitest-environment node
/**
 * Relay HTTP 层集成测试。
 *
 * 为什么需要它：`server/relay-utils.test.js` 只覆盖纯函数，**路由层长期零覆盖** ——
 * 上一轮的两条发布阻塞缺陷（`.json` 被误判信封、配额跨房间扩散）都发生在这里，
 * 单测看不见、只有端到端浏览器回归能间接碰到。
 *
 * 这里起真实进程、打真实 HTTP，覆盖鉴权边界、公开写路径、体积与配额、配置校验。
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOCX_MIME, buildDocx } from '../scripts/lib/docx-fixture.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOKEN = 'integration-test-token'

/** @returns {Promise<number>} */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      // 只监听 TCP，地址必然是 AddressInfo；显式收窄而不是断言成 AddressInfo
      if (address === null || typeof address === 'string') {
        reject(new Error('未能从探测服务器取到 TCP 端口'))
        return
      }
      probe.close(() => resolve(address.port))
    })
  })
}

/**
 * @param {string} baseUrl
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`)
      if (response.ok) return
    } catch {
      // 尚未监听，继续等
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }

  throw new Error('relay 启动超时')
}

/**
 * 仍是**运维变量**的键；其余键由 `splitEnv` 归入 `RELAY_TUNING` 覆盖通道。
 * 与 `server/relay-config.js` 的「① 运维变量」一节一一对应。
 *
 * 漏项是 **fail-closed** 的：若这里把某个仍属运维的键当成调参项，relay 会因「RELAY_TUNING 含
 * 未知键」**拒绝启动** ⇒ 测试以「启动超时」立刻失败，不会静默走默认值蒙混过关。
 */
const OP_ENV_KEYS = new Set([
  'PORT', 'HOST', 'UPLOAD_DIR', 'RELAY_TOKEN', 'RELAY_ALLOWED_ORIGINS',
  'RELAY_PUBLIC_BASE_URL', 'RELAY_TRUSTED_PROXIES', 'MAX_FILE_BYTES', 'MAX_TOTAL_UPLOAD_BYTES'
])

/**
 * 把调用方给的扁平 env 拆成「运维变量」与 `RELAY_TUNING`。
 *
 * 内部调参从 env 降级为模块常量后（`relay-config.js`），覆盖只能走 `RELAY_TUNING`。
 * 这里做一次拆分，让用例继续写成 `startRelay({ MAX_ROOMS: '3' })` 这种一眼可读的形式，
 * 而不必在每个用例里手写 JSON —— 拆分的权威名单就是上面的 `OP_ENV_KEYS`。
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ opEnv: Record<string, string | undefined>, tuning: Record<string, number> }}
 */
function splitEnv(env) {
  /** @type {Record<string, string | undefined>} */
  const opEnv = {}
  /** @type {Record<string, number>} */
  const tuning = {}

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || OP_ENV_KEYS.has(key)) {
      opEnv[key] = value
      continue
    }
    tuning[key] = Number(value)
  }

  return { opEnv, tuning }
}

/**
 * 一个**已启动**的 relay 进程及其配套设施。集中在这里定义，是为了让 `let relay`（在 `beforeAll`
 * 里赋值）能拿到类型 —— 否则该变量在闭包内被赋值、在用例中被读取，TS 只能当隐式 `any` 处理，
 * 本文件 122 处 `relay.*` 会一并失去检查。
 *
 * @typedef {object} RelayHarness
 * @property {string} baseUrl
 * @property {number} port
 * @property {string} uploadDir
 * @property {string[]} logs
 * @property {(options?: { keepUploadDir?: boolean }) => Promise<void>} stop
 */

/**
 * 房间状态响应里 `uploads` 元素的形状。
 *
 * ⚠️ 这是**类型层**的 `import()`，不产生运行时依赖：本文件从不 import relay 的服务端模块，
 * 而是把 relay 当子进程跑起来走真实 HTTP。之所以从这里取类型，是为了不再手写一份同形状的
 * typedef —— 那属于「同一语义两个判据」（铁律 20 的同类问题），字段改名时两边会各自漂移。
 *
 * @typedef {ReturnType<typeof import('./relay-state.js').uploadSummary>} UploadSummary
 */

/**
 * 起一个真实 relay 进程；返回停止函数
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ uploadDir?: string }} [options]
 * @returns {Promise<RelayHarness>}
 */
async function startRelay(env = {}, { uploadDir: fixedUploadDir } = {}) {
  const port = await getFreePort()
  const uploadDir = fixedUploadDir ?? (await mkdtemp(join(tmpdir(), 'coolector-it-')))
  const { opEnv, tuning } = splitEnv(env)

  const child = spawn(process.execPath, ['server/relay-server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      RELAY_TOKEN: TOKEN,
      UPLOAD_DIR: uploadDir,
      // 限流保持"开启但足够宽松"——注意**不要**设为 0 把它关掉，
      // 否则等于把刚新增的限流逻辑从测试里删掉（专门用例见「上传字节限流」一节）
      RELAY_TUNING: JSON.stringify({
        RATE_LIMIT_MAX: 10000,
        MAX_UPLOAD_BYTES_PER_WINDOW: 104857600,
        ...tuning
      }),
      ...opEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  /** @type {string[]} */
  const logs = []
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))

  const baseUrl = `http://127.0.0.1:${port}`
  await waitForHealth(baseUrl)

  return {
    baseUrl,
    port,
    uploadDir,
    logs,
    async stop({ keepUploadDir = false } = {}) {
      child.kill('SIGTERM')
      await new Promise((resolve) => {
        child.once('exit', resolve)
        setTimeout(resolve, 2000)
      })
      if (!keepUploadDir) await rm(uploadDir, { recursive: true, force: true })
    }
  }
}

/**
 * 组装上传请求体（JSON 信封）
 *
 * `content` 接受 `Buffer`：体积与配额类用例需要构造真二进制负载，而信封路径下
 * `Buffer.from(content)` 对字符串与 Buffer 是同一条处理，故放宽度量而不必逐处 `toString()`。
 *
 * @param {{ name: string, mimeType?: string, content: string | Buffer }} fields
 * @returns {string}
 */
function envelopeBody({ name, mimeType = 'text/markdown', content }) {
  return JSON.stringify({
    name,
    mimeType,
    lastModified: new Date(0).toISOString(),
    contentBase64: Buffer.from(content).toString('base64')
  })
}

const ENVELOPE_HEADERS = { 'Content-Type': 'application/json', 'X-Relay-Envelope': '1' }
const authHeaders = { Authorization: `Bearer ${TOKEN}` }

/**
 * 建房并返回服务端生成的房间信息。
 *
 * @param {string} baseUrl
 * @param {string} [roomId] 留空则由服务端生成完整 UUID
 * @returns {Promise<{ roomId: string }>}
 */
async function createRoom(baseUrl, roomId) {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: roomId ? JSON.stringify({ roomId }) : '{}'
  })
  expect(response.status).toBe(201)
  return readJson(response)
}

/**
 * 服务端默认只返回**相对路径**（F-001 修复：绝不用请求头拼绝对地址），
 * 而 Node 的 `fetch` 要求绝对地址 —— 这里按 harness 的 baseUrl 拼接。
 * 语义与前端 `resolveRelayUrl` 一致（相对路径拼到配置的 Relay 地址上）。
 *
 * @param {string} baseUrl
 * @param {string} target
 * @returns {string}
 */
function resolveUrl(baseUrl, target) {
  return target.startsWith('/') ? `${baseUrl}${target}` : target
}

/**
 * 用 `node:http` 发请求，以便**伪造 `Host` 头**。
 *
 * 为什么不能直接用 `fetch`：`Host` 是 fetch 规范的 forbidden header name，undici 会
 * 静默忽略它 —— 那样这个用例就成了空转（永远测不到真实攻击面）。
 * `node:http` 则允许显式覆盖，能真实复现 F-001。
 *
 * @param {number} port
 * @param {string} pathname
 * @param {{ method?: string, host?: string, headers?: Record<string, string | number>, body?: string }} [options]
 * @returns {Promise<{
 *   status: number | undefined,
 *   headers: import('node:http').IncomingHttpHeaders,
 *   text: string
 * }>}
 */
function requestWithHost(port, pathname, { method = 'GET', host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body)
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...headers,
        ...(host ? { Host: host } : {}),
        ...(payload ? { 'Content-Length': payload.length } : {})
      }
    }, (res) => {
      /** @type {Buffer[]} */
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }))
    })

    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * 读 JSON 响应体。
 *
 * `Response.json()` 经 `undici-types` 返回 **`unknown`（不是 `any`）**，而本文件有近 40 处读取点。
 * 这里统一做一次「采信服务端形状」的收窄，比在每处各写一次断言少得多噪音。
 *
 * ⚠️ 这是本文件**唯一**的类型宽松点，且是刻意保留的：这些响应是黑盒 HTTP 的产物，
 * 它们的形状**正是被紧随其后的 `expect` 所断言的对象**。给它们编一套 typedef 只会得到一个
 * 未经任何验证的契约（假精确），反而掩盖「服务端改了形状而测试没跟上」这种真实的失效。
 *
 * 判据：某个响应若具有**稳定且被多处复用**的形状，就单独为它写 typedef
 * （本文件里成立的是 `createRoom` 的返回值与上面的 `UploadSummary`）。
 *
 * 不加 `async`：`response.json()` 本就是 Promise，再包一层会被 oxlint 判为多余的 async。
 *
 * @param {Response} response
 * @returns {Promise<any>}
 */
function readJson(response) {
  return response.json()
}

/**
 * 读取 SSE 流直到收到指定事件类型，返回该事件的原始帧文本
 *
 * @param {string} streamUrl
 * @param {string} eventName
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
async function readSseEvent(streamUrl, eventName, timeoutMs = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(streamUrl, { signal: controller.signal })
    if (!response.body) throw new Error('SSE 响应没有可读的 body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        if (frame.includes(`event: ${eventName}\n`)) {
          await reader.cancel().catch(() => { })
          return frame
        }
      }
    }

    throw new Error(`未在 ${timeoutMs}ms 内收到 ${eventName}`)
  } finally {
    clearTimeout(timer)
  }
}

describe('relay HTTP 层', () => {
  /** @type {RelayHarness} */
  let relay

  beforeAll(async () => {
    relay = await startRelay()
  }, 30000)

  afterAll(async () => {
    await relay?.stop()
  })

  it('无凭据访问受保护路由返回 401', async () => {
    const room = await createRoom(relay.baseUrl, 'auth-room-1')

    expect((await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`)).status).toBe(401)
    expect((await fetch(`${relay.baseUrl}/api/rooms`, { method: 'POST' })).status).toBe(401)
    expect((await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { method: 'DELETE' })).status).toBe(401)
  })

  it('?token= 查询参数不再能通过鉴权', async () => {
    const response = await fetch(`${relay.baseUrl}/api/rooms?token=${TOKEN}`, { method: 'POST' })
    expect(response.status).toBe(401)
  })

  it('建房返回完整 UUID，且裸 token 头不被接受', async () => {
    const room = await createRoom(relay.baseUrl)
    expect(room.roomId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)

    const bare = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, {
      headers: { Authorization: TOKEN }
    })
    expect(bare.status).toBe(401)
  })

  it('公开写路径免凭据，但房间必须已存在', async () => {
    const room = await createRoom(relay.baseUrl, 'public-write-room')

    const ok = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: '张三.md', content: '作业正文' })
    })
    expect(ok.status).toBe(201)

    const missing = await fetch(`${relay.baseUrl}/api/rooms/nonexistent-room-x/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'x.md', content: 'x' })
    })
    expect(missing.status).toBe(404)
  })

  it('中文文件名经信封往返无损', async () => {
    const room = await createRoom(relay.baseUrl, 'chinese-name-room')
    const name = '李四-20230102.docx'

    await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name, mimeType: 'application/octet-stream', content: 'binary-ish' })
    })

    const state = await readJson(await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders }))
    /** @type {UploadSummary[]} */
    const uploads = state.uploads
    expect(uploads.map((item) => item.name)).toContain(name)
  })

  it('裸 body 不会被误判为信封（.json 文件照常上传）', async () => {
    const room = await createRoom(relay.baseUrl, 'raw-body-room')
    const jsonText = JSON.stringify({ name: '赵六', text: '正文本身就是 JSON' })
    const fileName = 'zhao-20230104.json'

    // 关键：Content-Type 是 application/json，但**没有** X-Relay-Envelope 标志
    const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Filename': fileName
      },
      body: jsonText
    })

    expect(response.status).toBe(201)
    const payload = await readJson(response)
    expect(payload.upload.size).toBe(Buffer.byteLength(jsonText))
    // 回读文件名与**落盘内容**：上一版只断言 status 与 size，正是这里让下面的百分号编码缺陷
    // 带着一条空转断言活过了六轮审计（断言了 201 却没断言存下来的到底是什么）。
    // 内容改从 download 端点回读而不是取 201 的 contentText —— 201 只回元信息（见下一条用例）。
    expect(payload.upload.name).toBe(fileName)

    const download = await fetch(resolveUrl(relay.baseUrl, payload.upload.downloadUrl), { headers: authHeaders })
    expect(await download.text()).toBe(jsonText)
  })

  describe('裸 body 路径的文件名通道', () => {
    const CHINESE_NAME = '赵六-20230104.md'
    const PERCENT_ENCODED = encodeURIComponent(CHINESE_NAME)

    /**
     * @param {string} roomId
     * @returns {Promise<string[]>}
     */
    async function uploadedNames(roomId) {
      const state = await readJson(await fetch(`${relay.baseUrl}/api/rooms/${roomId}`, { headers: authHeaders }))
      /** @type {UploadSummary[]} */
      const uploads = state.uploads
      return uploads.map((item) => item.name)
    }

    it('?name=<百分号编码> 还原为正确的中文文件名', async () => {
      const room = await createRoom(relay.baseUrl, 'raw-name-query')
      const body = '# 作业正文'

      const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads?name=${PERCENT_ENCODED}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/markdown' },
        body
      })

      expect(response.status).toBe(201)
      const payload = await readJson(response)
      expect(payload.upload.name).toBe(CHINESE_NAME)
      expect(payload.upload.size).toBe(Buffer.byteLength(body))
      expect(await uploadedNames(room.roomId)).toContain(CHINESE_NAME)
    })

    it('请求头里的百分号编码文件名也能还原（缺陷本体）', async () => {
      const room = await createRoom(relay.baseUrl, 'raw-name-header-pct')

      const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/markdown', 'X-Relay-Filename': PERCENT_ENCODED },
        body: '# 作业正文'
      })

      expect(response.status).toBe(201)
      expect((await readJson(response)).upload.name).toBe(CHINESE_NAME)
    })

    it('请求头里的原始 UTF-8 字节（curl 直发）仍按 latin1 还原', async () => {
      const room = await createRoom(relay.baseUrl, 'raw-name-header-latin1')

      // fetch 无法发送非 ASCII 头值（ByteString 约束），只能用 node:http 复现 curl 的直发行为
      const response = await requestWithHost(relay.port, `/api/rooms/${room.roomId}/uploads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/markdown',
          'X-Relay-Filename': Buffer.from(CHINESE_NAME, 'utf8').toString('latin1')
        },
        body: '# 作业正文'
      })

      expect(response.status).toBe(201)
      expect(JSON.parse(response.text).upload.name).toBe(CHINESE_NAME)
    })

    it('纯 ASCII 的 %XX 不被当作转义（不把合法文件名悄悄改掉）', async () => {
      const room = await createRoom(relay.baseUrl, 'raw-name-literal')
      const literal = 'note%20f.md'

      const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/markdown', 'X-Relay-Filename': literal },
        body: 'x'
      })

      expect(response.status).toBe(201)
      expect((await readJson(response)).upload.name).toBe(literal)
    })

    it('?name= 优先于请求头，且能表达「名字里本来就含 %XX」', async () => {
      const room = await createRoom(relay.baseUrl, 'raw-name-precedence')
      const literal = 'note%20f.md'

      const response = await fetch(
        `${relay.baseUrl}/api/rooms/${room.roomId}/uploads?name=${encodeURIComponent(literal)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/markdown', 'X-Relay-Filename': 'stale-header.md' },
          body: 'x'
        }
      )

      expect(response.status).toBe(201)
      // 残留的头不会顶掉显式指定的名字 —— 这也正是「字面量 %XX」的逃生口
      expect((await readJson(response)).upload.name).toBe(literal)
    })

    it('下载头按 RFC 6266 单次编码，不再二次编码', async () => {
      const room = await createRoom(relay.baseUrl, 'raw-name-download')

      // 走**请求头**的百分号编码通道：这条守的是「上传 → 落盘 → 下载头」整条链。
      // 若改用 `?name=`，服务端拿到的本来就是 URLSearchParams 解好的值，缺陷会被绕过去。
      const created = await readJson(await fetch(
        `${relay.baseUrl}/api/rooms/${room.roomId}/uploads`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'text/markdown', 'X-Relay-Filename': PERCENT_ENCODED },
          body: '# 作业正文'
        }
      ))

      const download = await fetch(
        `${relay.baseUrl}/api/rooms/${room.roomId}/uploads/${created.upload.id}?download=1`,
        { headers: authHeaders }
      )

      expect(download.status).toBe(200)
      const disposition = download.headers.get('content-disposition')
      expect(disposition).toContain(`filename*=UTF-8''${PERCENT_ENCODED}`)
      // `%` → `%25` 是「名字里带着百分号串」的指纹：缺陷年代老师下载到的就是这种名字
      expect(disposition).not.toContain('%25')
    })
  })

  describe('上传不再回吐正文', () => {
    // 201 从前把整个文件以 base64 塞回去（原注释写的是「发送方自检用」）。实测代价：
    // 一次 10MB 上传的往返是上行 10.49MB + 下行 13.98MB —— **响应比请求还大**，
    // 而发送方刚把这些字节发上去，回显只是让它再下载一遍。服务端还得为此多编码一次。
    // 文本类文件还有第二层：摘要的 `contentText` 最多带 1MB —— 见本组最后一条用例。
    const MAX_SIZE = Buffer.alloc(10 * 1024 * 1024, 0x42)

    it('裸 body 通道：201 只回元信息，响应体与文件大小无关', async () => {
      const room = await createRoom(relay.baseUrl, 'no-echo-raw')

      const response = await fetch(
        `${relay.baseUrl}/api/rooms/${room.roomId}/uploads?name=big.bin`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: MAX_SIZE
        }
      )

      expect(response.status).toBe(201)
      const text = await response.text()
      // 判据是「响应体不随文件增长」：10MB 的文件如果被回吐，这里至少 13MB
      expect(text.length).toBeLessThan(4096)
      const payload = JSON.parse(text)
      expect(payload.upload.contentBase64).toBeNull()
      expect(payload.upload.size).toBe(MAX_SIZE.length)
    })

    it('JSON 信封通道：201 同样不回吐文件字节', async () => {
      const room = await createRoom(relay.baseUrl, 'no-echo-envelope')

      const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
        method: 'POST',
        headers: ENVELOPE_HEADERS,
        body: JSON.stringify({
          name: 'big2.bin',
          mimeType: 'application/octet-stream',
          lastModified: new Date(0).toISOString(),
          contentBase64: MAX_SIZE.toString('base64')
        })
      })

      expect(response.status).toBe(201)
      const text = await response.text()
      expect(text.length).toBeLessThan(4096)
      expect(JSON.parse(text).upload.size).toBe(MAX_SIZE.length)
    })

    it.each([
      ['裸 body', 'raw'],
      ['JSON 信封', 'envelope']
    ])('落盘的就是原始字节，逐字节一致（%s）', async (_label, form) => {
      const room = await createRoom(relay.baseUrl, `bytes-fidelity-${form}`)
      // 含 0x00 与高位字节：任何「当作文本处理」或编码往返有损的路径都会在这里露馅
      const bytes = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff, 0xfe, 0x00, 0x41])

      const response = await fetch(
        form === 'raw'
          ? `${relay.baseUrl}/api/rooms/${room.roomId}/uploads?name=fidelity.bin`
          : `${relay.baseUrl}/api/rooms/${room.roomId}/uploads`,
        form === 'raw'
          ? { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }
          : {
            method: 'POST',
            headers: ENVELOPE_HEADERS,
            body: JSON.stringify({
              name: 'fidelity.bin',
              mimeType: 'application/octet-stream',
              lastModified: new Date(0).toISOString(),
              contentBase64: bytes.toString('base64')
            })
          }
      )

      expect(response.status).toBe(201)
      const { upload: summary } = await readJson(response)
      expect(summary.size).toBe(bytes.length)

      const download = await fetch(resolveUrl(relay.baseUrl, summary.downloadUrl), { headers: authHeaders })
      expect(download.status).toBe(200)
      expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true)
    })

    it('文本类文件同样只回元信息（contentText 从前最多带 1MB）', async () => {
      // 这一层是 e2e 发现的：10MB 二进制那条已修好后，一份 8.5MB 的 .md 仍换回 1.05MB 响应
      // —— 因为摘要默认带 `contentText`（截断到 MAX_TEXT_BYTES = 1MB）。
      const room = await createRoom(relay.baseUrl, 'no-echo-text')
      const text = '作业正文'.repeat(200_000) // ≈2.4MB UTF-8，已超过 MAX_TEXT_BYTES

      const response = await fetch(
        `${relay.baseUrl}/api/rooms/${room.roomId}/uploads?name=long.md`,
        { method: 'POST', headers: { 'Content-Type': 'text/markdown' }, body: text }
      )

      expect(response.status).toBe(201)
      const responseText = await response.text()
      // 判据：响应体只在 `previewText` 的量级（4096 字符 ≈12KB），不是 1MB
      expect(responseText.length).toBeLessThan(64 * 1024)

      const { upload: summary } = JSON.parse(responseText)
      expect(summary.contentIncluded).toBe(false)
      expect(summary.contentText).toBeNull()
      expect(summary.textTruncated).toBe(true)
      expect(summary.size).toBe(Buffer.byteLength(text))

      // 正文仍可从 details 端点取回 —— 接收端走的就是这条
      const details = await readJson(await fetch(resolveUrl(relay.baseUrl, summary.detailsUrl), { headers: authHeaders }))
      expect(Buffer.byteLength(details.upload.contentText, 'utf8')).toBeLessThanOrEqual(1024 * 1024)
    })
  })

  /**
   * 1h：docx 的正文提取已移到服务端，于是 docx 与普通文件走**同一条**裸 body 通道。
   *
   * 从前 docx 必须走 JSON 信封（把客户端提取好的正文随请求一起送达），代价是整份文件
   * base64 膨胀 33%，且浏览器要先解压一遍。这条用例钉住三件事：
   *   ① 裸 body 上传的 docx 也能拿到正文（服务端自己解）
   *   ② 接收端经 details 端点读到的正文就是解析结果
   *   ③ 下载端点取回的是**原始 docx 字节** —— 「正文只进预览，原件必须保真」（铁律 1 的实质）
   */
  it('docx 走裸 body，正文由服务端提取，且原件字节完整保留', async () => {
    const room = await createRoom(relay.baseUrl, 'docx-raw-room')
    const docx = buildDocx(['DOCX 服务端提取哨兵', '第二段：梯度下降实验'])
    const name = '张三-20230101.docx'

    const response = await fetch(
      `${relay.baseUrl}/api/rooms/${room.roomId}/uploads?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': DOCX_MIME, 'X-Relay-Mime-Type': DOCX_MIME },
        body: docx
      }
    )

    expect(response.status).toBe(201)
    const { upload: summary } = await readJson(response)
    expect(summary.name).toBe(name)
    expect(summary.size).toBe(docx.length)
    // 请求体就是文件字节，服务端不做任何 base64 往返
    expect(summary.contentText).toBeNull()

    const details = await readJson(await fetch(resolveUrl(relay.baseUrl, summary.detailsUrl), { headers: authHeaders }))
    expect(details.upload.contentText).toBe('DOCX 服务端提取哨兵\n第二段：梯度下降实验')

    const download = await fetch(resolveUrl(relay.baseUrl, summary.downloadUrl), { headers: authHeaders })
    expect(Buffer.from(await download.arrayBuffer()).equals(docx)).toBe(true)
  })

  it('0 字节文件可上传（空 contentBase64 不被当作缺失）', async () => {
    const room = await createRoom(relay.baseUrl, 'empty-file-room')

    const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'empty.md', content: '' })
    })

    expect(response.status).toBe(201)
    expect((await readJson(response)).upload.size).toBe(0)
  })

  it('超过单文件上限返回可读的 413', async () => {
    const room = await createRoom(relay.baseUrl, 'too-large-room')

    const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'huge.md', content: Buffer.alloc(10 * 1024 * 1024 + 1, 0x41) })
    })

    expect(response.status).toBe(413)
    expect((await readJson(response)).error).toMatch(/size limit/iu)
  })

  it('带提取正文的 docx 不被体积口径误判（信封同时装 base64 与 text）', async () => {
    const room = await createRoom(relay.baseUrl, 'docx-text-room')

    // 精确复现原缺陷的最小组合：10MB 文件（正好是上限）+ 256KB 提取正文
    // （256KB 正是前端 FileViewer 发送正文的上限，所以这是真实主路径而非构造场景）。
    // 请求体 ≈ 13981014 + 262144 ≈ 14.24MB
    //   · 修复前的派生上限 14046550（只算 base64 膨胀）→ 413 ✗
    //   · 修复后的派生上限 15160662（含 MAX_TEXT_BYTES 与余量）→ 201 ✓
    const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: JSON.stringify({
        name: '大文档.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        lastModified: new Date(0).toISOString(),
        contentBase64: Buffer.alloc(10 * 1024 * 1024, 0x42).toString('base64'),
        text: '正'.repeat((256 * 1024) / 3)
      })
    })

    expect(response.status).toBe(201)
    const payload = await readJson(response)
    expect(payload.upload.size).toBe(10 * 1024 * 1024)
    expect(payload.upload.textTruncated).toBe(false)
  })

  it('超出 MAX_TEXT_BYTES 的正文被截断并标记', async () => {
    const room = await createRoom(relay.baseUrl, 'text-truncate-room')
    const limit = 1024 * 1024

    const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: JSON.stringify({
        name: '超长正文.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        lastModified: new Date(0).toISOString(),
        contentBase64: Buffer.from('tiny').toString('base64'),
        // 3MB 正文，超过 1MB 的 MAX_TEXT_BYTES
        text: '文'.repeat(1024 * 1024)
      })
    })

    expect(response.status).toBe(201)
    const payload = await readJson(response)
    expect(payload.upload.textTruncated).toBe(true)

    // 截断后的正文从 details 端点读回（201 只回元信息）。这条是接收端真正走的那条路。
    const details = await fetch(resolveUrl(relay.baseUrl, payload.upload.detailsUrl), { headers: authHeaders })
    expect(details.status).toBe(200)
    const { upload: detail } = await readJson(details)
    expect(Buffer.byteLength(detail.contentText, 'utf8')).toBeLessThanOrEqual(limit)
  })

  it.each([
    ['控制字符（防响应头注入）', 'text/plain\r\nX-Injected: 1', 'mime-case-inject'],
    ['超长 subtype', `application/${'a'.repeat(200000)}`, 'mime-case-longsub'],
    ['超长 type', `${'a'.repeat(200000)}/json`, 'mime-case-longtype']
  ])('畸形 mimeType 被中和为 octet-stream 且该文件仍可下载：%s', async (_label, mimeType, roomId) => {
    const room = await createRoom(relay.baseUrl, roomId)

    const upload = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'mime-case.md', mimeType, content: 'hi' })
    })

    expect(upload.status).toBe(201)
    const { upload: summary } = await readJson(upload)
    expect(summary.mimeType).toBe('application/octet-stream')

    // 过去畸形/超长 mimeType 会让下载响应头非法或溢出，该文件永久不可下载
    const download = await fetch(resolveUrl(relay.baseUrl, summary.downloadUrl), { headers: authHeaders })
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/octet-stream')
    expect(download.headers.get('x-content-type-options')).toBe('nosniff')
  })
}, 60000)

describe('房间配额隔离', () => {
  /** @type {RelayHarness} */
  let relay
  const ROOM_QUOTA = 1024 * 1024

  beforeAll(async () => {
    relay = await startRelay({
      // 单文件上限足够大，以便把「房间配额」与「单文件上限」区分开
      MAX_FILE_BYTES: String(600 * 1024),
      MAX_ROOM_UPLOAD_BYTES: String(ROOM_QUOTA),
      MAX_TOTAL_UPLOAD_BYTES: String(4 * ROOM_QUOTA)
    })
  }, 30000)

  afterAll(async () => {
    await relay?.stop()
  })

  it('单房间超配额返回 507，但其它房间不受影响', async () => {
    const crowded = await createRoom(relay.baseUrl, 'crowded-room-1')
    const neighbour = await createRoom(relay.baseUrl, 'neighbour-room-1')

    // 用二进制 mimeType：文本类文件的服务端会另存一份提取文本，占用约为文件大小 ×2，
    // 这里要测的是"房间配额隔离"而非计费口径，故选不产生提取文本的类型
    const payload = envelopeBody({
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      content: Buffer.alloc(600 * 1024, 0x43)
    })
    /** @type {(roomId: string) => Promise<Response>} */
    const send = (roomId) => fetch(`${relay.baseUrl}/api/rooms/${roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: payload
    })

    // 灌满第一个房间：两次 600KB 触发 1MB 房间配额
    expect((await send(crowded.roomId)).status).toBe(201)
    const second = await send(crowded.roomId)
    expect(second.status).toBe(507)
    expect((await readJson(second)).error).toMatch(/Room storage quota/iu)

    // 关键回归：另一个房间仍可正常上传 —— 免凭据发送方不能再造成跨房间拒绝服务
    const other = await send(neighbour.roomId)
    expect(other.status).toBe(201)
  })
}, 60000)

describe('配置校验 fail-closed', () => {
  /**
   * 以给定环境变量启动 relay 子进程，等它退出后取回退出码与完整输出。
   *
   * @type {(env: Record<string, string | undefined>) => Promise<{ code: number | null, output: string }>}
   */
  const spawnWithEnv = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['server/relay-server.js'], {
      cwd: ROOT,
      env: { ...process.env, HOST: '127.0.0.1', RELAY_TOKEN: TOKEN, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('exit', (code) => resolve({ code, output }))
  })

  it('非数字的 MAX_FILE_BYTES 让进程拒绝启动（而非静默关闭体积校验）', async () => {
    const { code, output } = await spawnWithEnv({ MAX_FILE_BYTES: '10mb' })
    expect(code).toBe(1)
    expect(output).toMatch(/MAX_FILE_BYTES/u)
  }, 20000)

  it('RELAY_TUNING 含未知键时拒绝启动（静默忽略会让运维以为改动生效了）', async () => {
    // MAX_ROOM 是 MAX_ROOMS 的笔误 —— 正是「写错名字」这一类最需要被拦下的情况
    const { code, output } = await spawnWithEnv({ RELAY_TUNING: JSON.stringify({ MAX_ROOM: 5 }) })
    expect(code).toBe(1)
    expect(output).toMatch(/未知键/u)
    expect(output).toMatch(/MAX_ROOM/u)
  }, 20000)

  it('RELAY_TUNING 的值不是正整数时拒绝启动', async () => {
    const { code, output } = await spawnWithEnv({ RELAY_TUNING: JSON.stringify({ RATE_LIMIT_MAX: -1 }) })
    expect(code).toBe(1)
    expect(output).toMatch(/RELAY_TUNING\.RATE_LIMIT_MAX/u)
  }, 20000)

  it('RELAY_TUNING 不是合法 JSON 时拒绝启动', async () => {
    const { code, output } = await spawnWithEnv({ RELAY_TUNING: '{nope}' })
    expect(code).toBe(1)
    expect(output).toMatch(/RELAY_TUNING/u)
  }, 20000)

  it('未设置令牌且监听非回环地址时拒绝启动（fail-closed 保持）', async () => {
    const { code, output } = await spawnWithEnv({ RELAY_TOKEN: '', HOST: '0.0.0.0' })
    expect(code).toBe(1)
    expect(output).toMatch(/拒绝启动/u)
  }, 20000)

  it('非法的 RELAY_TRUSTED_PROXIES 让进程拒绝启动（避免「以为已按客户端分桶」）', async () => {
    const { code, output } = await spawnWithEnv({ RELAY_TRUSTED_PROXIES: '10.0.0.0/33' })
    expect(code).toBe(1)
    expect(output).toMatch(/RELAY_TRUSTED_PROXIES/u)
  }, 20000)
}, 60000)

describe('元数据上限与配额计量', () => {
  /** @type {RelayHarness} */
  let relay

  beforeAll(async () => {
    relay = await startRelay({
      MAX_FILE_BYTES: String(1024 * 1024),
      MAX_ROOM_UPLOAD_BYTES: String(2 * 1024 * 1024),
      MAX_UPLOAD_NAME_BYTES: '255',
      MAX_ROOM_UPLOADS: '3'
    })
  }, 30000)

  afterAll(async () => {
    await relay?.stop()
  })

  it('超长文件名被截断，且元数据计入配额', async () => {
    const room = await createRoom(relay.baseUrl, 'metadata-room-1')

    // 0 字节正文 + 4KB 文件名：过去这是「零配额成本」的资源放大入口
    const longName = `${'n'.repeat(4096)}.md`
    const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: longName, content: '' })
    })

    expect(response.status).toBe(201)
    const payload = await readJson(response)
    expect(Buffer.byteLength(payload.upload.name, 'utf8')).toBeLessThanOrEqual(255)
    expect(payload.upload.name.endsWith('.md')).toBe(true)

    const state = await readJson(await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders }))
    // 关键回归：配额必须被真实占用，而不是恒为 0
    expect(state.storedBytes).toBeGreaterThan(0)
    expect(state.storedBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
  })

  it('荒谬超长的文件名被请求体上限直接挡住（413）', async () => {
    const room = await createRoom(relay.baseUrl, 'metadata-room-oversize')

    const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: `${'n'.repeat(3 * 1024 * 1024)}.md`, content: '' })
    })

    expect(response.status).toBe(413)
  })

  it('房间快照不会被超长元数据放大', async () => {
    const room = await createRoom(relay.baseUrl, 'metadata-room-2')

    await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: `${'n'.repeat(1024 * 1024)}.md`, content: '' })
    })

    const raw = await (await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })).text()
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(64 * 1024)
  })

  it('房间上传条数上限返回 429（而非误报"配额已满"）', async () => {
    const room = await createRoom(relay.baseUrl, 'metadata-room-3')
    /** @type {(index: number) => Promise<Response>} */
    const send = (index) => fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: `n${index}.md`, content: 'x' })
    })

    expect((await send(1)).status).toBe(201)
    expect((await send(2)).status).toBe(201)
    expect((await send(3)).status).toBe(201)

    const overflow = await send(4)
    expect(overflow.status).toBe(429)
    expect((await readJson(overflow)).error).toMatch(/upload count limit/iu)
  })

  it('并发上传不能击穿条数上限（与字节配额同型的竞态）', async () => {
    const room = await createRoom(relay.baseUrl, 'metadata-room-count-race')
    const payload = envelopeBody({ name: 'n.md', content: 'x' })

    // MAX_ROOM_UPLOADS 在该实例里是 3，用远大于它的并发数打
    const results = await Promise.all(Array.from({ length: 24 }, () => fetch(
      `${relay.baseUrl}/api/rooms/${room.roomId}/uploads`,
      { method: 'POST', headers: ENVELOPE_HEADERS, body: payload }
    )))

    const accepted = results.filter((response) => response.status === 201).length
    const state = await readJson(await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders }))

    expect(accepted).toBeLessThanOrEqual(3)
    expect(state.uploadCount).toBeLessThanOrEqual(3)
  })

}, 60000)

describe('配额并发安全', () => {
  /** @type {RelayHarness} */
  let relay
  const ROOM_QUOTA = 1024 * 1024

  beforeAll(async () => {
    relay = await startRelay({
      MAX_FILE_BYTES: String(600 * 1024),
      MAX_ROOM_UPLOAD_BYTES: String(ROOM_QUOTA),
      MAX_TOTAL_UPLOAD_BYTES: String(8 * ROOM_QUOTA)
    })
  }, 30000)

  afterAll(async () => {
    await relay?.stop()
  })

  it('并发上传不能击穿单房间配额', async () => {
    const room = await createRoom(relay.baseUrl, 'concurrent-room-1')
    const payload = envelopeBody({
      name: 'c.bin',
      mimeType: 'application/octet-stream',
      content: Buffer.alloc(600 * 1024, 0x44)
    })

    const results = await Promise.all(Array.from({ length: 16 }, () => fetch(
      `${relay.baseUrl}/api/rooms/${room.roomId}/uploads`,
      { method: 'POST', headers: ENVELOPE_HEADERS, body: payload }
    )))

    const accepted = results.filter((response) => response.status === 201).length
    const state = await readJson(await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders }))

    // 预占配额后，并发请求必须有一部分被 507 拒绝，而不是全部落盘（过去 16 个全落盘）
    expect(accepted).toBeGreaterThan(0)
    expect(accepted).toBeLessThan(16)
    // 核心断言：占用不得超过配额
    expect(state.storedBytes).toBeLessThanOrEqual(ROOM_QUOTA)
  })
}, 60000)

describe('上传字节限流', () => {
  /** @type {RelayHarness} */
  let relay

  beforeAll(async () => {
    relay = await startRelay({
      MAX_FILE_BYTES: String(1024 * 1024),
      MAX_ROOM_UPLOAD_BYTES: String(64 * 1024 * 1024),
      // 窗口额度 4MB：每次请求体约 1.4MB（1MB 正文的 base64），第 3 次越界
      MAX_UPLOAD_BYTES_PER_WINDOW: String(4 * 1024 * 1024),
      RATE_LIMIT_MAX: '10000'
    })
  }, 30000)

  afterAll(async () => {
    await relay?.stop()
  })

  it('超出窗口字节额度返回 429，且不误伤同窗口内的读请求', async () => {
    const room = await createRoom(relay.baseUrl, 'byte-window-room')
    const payload = envelopeBody({
      name: 'w.bin',
      mimeType: 'application/octet-stream',
      content: Buffer.alloc(1024 * 1024, 0x45)
    })
    const send = () => fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: payload
    })

    expect((await send()).status).toBe(201)
    expect((await send()).status).toBe(201)

    // 第三次会超出 4MB 窗口额度
    const limited = await send()
    expect(limited.status).toBe(429)
    expect((await readJson(limited)).error).toMatch(/rate exceeded/iu)

    // 同窗口内的读请求不应被误伤
    expect((await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })).status).toBe(200)
    expect((await fetch(`${relay.baseUrl}/`)).status).toBe(200)
  })
}, 60000)

describe('限流分桶与可信代理', () => {
  const BUDGET = 5

  /** @type {(baseUrl: string, forwardedFor: string) => Promise<Response>} */
  const createWithXff = (baseUrl, forwardedFor) => fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
    body: '{}'
  })

  it('未声明可信代理时忽略 X-Forwarded-For：换 XFF 也换不掉桶', async () => {
    const relay = await startRelay({ RATE_LIMIT_MAX: String(BUDGET) })

    try {
      const statuses = []
      for (let i = 0; i < BUDGET + 1; i += 1) {
        statuses.push((await createWithXff(relay.baseUrl, `203.0.113.${i}`)).status)
      }

      expect(statuses.at(-1)).toBe(429)
    } finally {
      await relay.stop()
    }
  }, 30000)

  it('声明可信代理后按 X-Forwarded-For 分桶：一个客户端打满不影响别人', async () => {
    const relay = await startRelay({ RATE_LIMIT_MAX: String(BUDGET), RELAY_TRUSTED_PROXIES: '127.0.0.0/8' })

    try {
      for (let i = 0; i < BUDGET; i += 1) {
        expect((await createWithXff(relay.baseUrl, '203.0.113.1')).status).toBe(201)
      }

      expect((await createWithXff(relay.baseUrl, '203.0.113.1')).status).toBe(429)
      // 这正是声明可信代理的目的：另一个客户端不该被牵连
      expect((await createWithXff(relay.baseUrl, '203.0.113.2')).status).toBe(201)
    } finally {
      await relay.stop()
    }
  }, 30000)
}, 90000)

describe('建房上限与按房间字节限流', () => {
  it('房间数达 MAX_ROOMS 后拒绝新建，重进已有房间与删除后重建不受影响', async () => {
    const relay = await startRelay({ MAX_ROOMS: '3' })

    try {
      const created = []
      for (let index = 0; index < 3; index += 1) {
        created.push(await createRoom(relay.baseUrl, `cap-room-${index}`))
      }

      const blocked = await fetch(`${relay.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: 'cap-room-overflow' })
      })
      expect(blocked.status).toBe(429)
      expect((await readJson(blocked)).error).toMatch(/room count limit/iu)

      // 上限只约束「新增」：重进自己那个房间仍然 201
      const reenter = await fetch(`${relay.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: created[0].roomId })
      })
      expect(reenter.status).toBe(201)

      // 回收一个房间后又能建新的（上限是软上限，随 TTL 回收自动缓解）
      await fetch(`${relay.baseUrl}/api/rooms/${created[0].roomId}`, { method: 'DELETE', headers: authHeaders })
      const afterDelete = await createRoom(relay.baseUrl, 'cap-room-after-delete')
      expect(afterDelete.roomId).toBe('cap-room-after-delete')
    } finally {
      await relay.stop()
    }
  }, 30000)

  it('单房间字节窗口额度用尽返回 429，且不牵连其它房间', async () => {
    const relay = await startRelay({
      MAX_FILE_BYTES: String(1024 * 1024),
      MAX_ROOM_UPLOAD_BYTES: String(64 * 1024 * 1024),
      MAX_TOTAL_UPLOAD_BYTES: String(128 * 1024 * 1024),
      // IP 维度给足额度，确保 429 只可能来自「房间维度」
      MAX_UPLOAD_BYTES_PER_WINDOW: String(64 * 1024 * 1024),
      MAX_ROOM_BYTES_PER_WINDOW: String(2 * 1024 * 1024)
    })

    try {
      const roomA = await createRoom(relay.baseUrl, 'room-window-a')
      const roomB = await createRoom(relay.baseUrl, 'room-window-b')
      const payload = envelopeBody({
        name: 'w.bin',
        mimeType: 'application/octet-stream',
        content: Buffer.alloc(1024 * 1024, 0x45)
      })
      /** @type {(roomId: string) => Promise<Response>} */
      const send = (roomId) => fetch(`${relay.baseUrl}/api/rooms/${roomId}/uploads`, {
        method: 'POST',
        headers: ENVELOPE_HEADERS,
        body: payload
      })

      expect((await send(roomA.roomId)).status).toBe(201)

      // 第二次就越过 2MB 的房间窗口额度（单次请求体约 1.4MB）
      const limited = await send(roomA.roomId)
      expect(limited.status).toBe(429)
      expect((await readJson(limited)).error).toMatch(/per room per window/iu)

      // 另一个房间完全不受影响 —— 这正是房间维度的意义
      expect((await send(roomB.roomId)).status).toBe(201)
    } finally {
      await relay.stop()
    }
  }, 30000)
}, 90000)

describe('房间生命周期', () => {
  /** @type {RelayHarness} */
  let relay

  beforeAll(async () => {
    relay = await startRelay({
      // 绝对上限 1 秒、扫描周期 200ms，用来验证"绝对上限不豁免接收端"
      ROOM_MAX_LIFETIME_MS: '1000',
      ROOM_CLEANUP_INTERVAL_MS: '200',
      ROOM_TTL_MS: '3600000'
    })
  }, 30000)

  afterAll(async () => {
    await relay?.stop()
  })

  it('持有一条 SSE 连接也不能阻止绝对存活上限生效', async () => {
    const room = await createRoom(relay.baseUrl, 'lifetime-room-1')

    const ticketResponse = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/stream-ticket`, {
      method: 'POST',
      headers: authHeaders
    })
    const { ticket } = await readJson(ticketResponse)

    // 保持一条 SSE 长连接
    const controller = new AbortController()
    const stream = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/events?ticket=${encodeURIComponent(ticket)}`, {
      signal: controller.signal
    })
    expect(stream.status).toBe(200)

    if (!stream.body) throw new Error('SSE 响应没有可读的 body')
    const reader = stream.body.getReader()
    void reader.read()

    // 等超过绝对上限 + 若干扫描周期
    await new Promise((resolve) => {
      setTimeout(resolve, 2500)
    })

    const state = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })
    expect(state.status).toBe(404)

    controller.abort()
    await reader.cancel().catch(() => { })
  }, 20000)
}, 60000)

describe('启动恢复的归属门控', () => {
  /** @type {string} */
  let uploadDir

  beforeAll(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'coolector-foreign-'))
    // 这些目录没有房间元数据（room.json），启动恢复必须放过它们
    await mkdir(join(uploadDir, 'notes.backup'), { recursive: true })
    await writeFile(join(uploadDir, 'notes.backup', 'db-dump.sql'), 'precious data'.repeat(512))
    await mkdir(join(uploadDir, 'my notes'), { recursive: true })
    await writeFile(join(uploadDir, 'my notes', 'a.txt'), 'x'.repeat(4096))
    await writeFile(join(uploadDir, 'loose.txt'), 'x'.repeat(4096))
  }, 30000)

  afterAll(async () => {
    await rm(uploadDir, { recursive: true, force: true })
  })

  it('无元数据的目录与散落文件既不被删除，也不计入配额', async () => {
    // 配额刻意设得比这些「外来文件」的总字节还小：若它们被计入配额，下面那次上传必然 507
    const relay = await startRelay({
      MAX_TOTAL_UPLOAD_BYTES: '2048',
      MAX_ROOM_UPLOAD_BYTES: '2048'
    }, { uploadDir })

    try {
      // 关键回归：过去是无差别递归删除，这些文件会全部消失
      expect(existsSync(join(uploadDir, 'notes.backup', 'db-dump.sql'))).toBe(true)
      expect(existsSync(join(uploadDir, 'my notes', 'a.txt'))).toBe(true)
      expect(existsSync(join(uploadDir, 'loose.txt'))).toBe(true)

      // 匿名根路由不再暴露用量与上限（信息暴露收敛）
      const root = await readJson(await fetch(`${relay.baseUrl}/`))
      expect(root.storageUsedBytes).toBeUndefined()
      expect(root.storageLimitBytes).toBeUndefined()

      // 行为断言（取代原先读数字）：外来字节没有占用全局配额 —— 新房间照常能上传
      const room = await createRoom(relay.baseUrl, 'foreign-quota-room')
      const upload = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
        method: 'POST',
        headers: ENVELOPE_HEADERS,
        body: envelopeBody({ name: 'small.md', content: 'y'.repeat(64) })
      })
      expect(upload.status).toBe(201)
    } finally {
      await relay.stop()
    }
  }, 40000)
}, 60000)

// 「删除失败的错误隔离」原先在这里，靠生产代码里的故障注入开关
// （RELAY_TEST_INJECT_RM_FAILURE）拉起进程来验证。状态拆到 relay-state.js 之后，
// 该分支改由 server/relay-state.test.js 注入 removeDir 替身直接单测，
// 生产代码里的注入开关已删除。

describe('在途上传与房间删除的交界', () => {
  /** @type {RelayHarness} */
  let relay

  beforeAll(async () => {
    relay = await startRelay({ MAX_FILE_BYTES: String(8 * 1024 * 1024), MAX_REQUEST_TIMEOUT: undefined })
  }, 30000)

  afterAll(async () => {
    await relay?.stop()
  })

  it('删除房间后不得留下无人认领的文件', async () => {
    const room = await createRoom(relay.baseUrl, 'inflight-room-1')
    const payload = envelopeBody({
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      content: Buffer.alloc(4 * 1024 * 1024, 0x48)
    })

    const uploadPromise = fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: payload
    }).catch(() => null)

    const deletePromise = fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, {
      method: 'DELETE',
      headers: authHeaders
    }).catch(() => null)

    await Promise.all([uploadPromise, deletePromise])

    // 等落盘/清理收尾
    await new Promise((resolve) => {
      setTimeout(resolve, 400)
    })

    const roomGone = (await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })).status === 404
    const roomDir = join(relay.uploadDir, room.roomId)
    // 只算「上传正文」：房间元数据（room.json / .tmp）与点号文件不算载荷，
    // 否则本用例会把「元数据还在」误判成「留下了无人认领的作业」
    const hasPayloadFile = existsSync(roomDir)
      && readdirSync(roomDir).some((name) => (
        !name.startsWith('.') && name !== 'room.json' && name !== 'room.json.tmp'
      ))

    // 需要防住的状态：房间已不存在，磁盘上却留着没有归属的文件（静默丢件 + 占额）
    expect(roomGone && hasPayloadFile).toBe(false)
  }, 30000)
}, 60000)

describe('details 端点契约', () => {
  /** @type {RelayHarness} */
  let relay

  beforeAll(async () => {
    relay = await startRelay()
  }, 30000)

  afterAll(async () => {
    await relay?.stop()
  })

  it('落盘后仍能从磁盘读回完整 base64（内存不再常驻副本）', async () => {
    const room = await createRoom(relay.baseUrl, 'details-room-1')
    const content = '正文内容-完整往返'

    await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'details.md', content })
    })

    const state = await readJson(await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders }))
    const details = await readJson(await fetch(resolveUrl(relay.baseUrl, state.uploads[0].detailsUrl), { headers: authHeaders }))

    // 只保留 `upload.contentBase64` 一处（顶层重复副本已删除）
    expect(Buffer.from(details.upload.contentBase64, 'base64').toString('utf8')).toBe(content)
    expect(details.contentBase64).toBeUndefined()
  })

  it('房间目录写入元数据 room.json（供重启恢复判定）', async () => {
    const room = await createRoom(relay.baseUrl, 'details-room-2')

    await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'meta.md', content: 'x' })
    })

    const metadataPath = join(relay.uploadDir, room.roomId, 'room.json')
    expect(existsSync(metadataPath)).toBe(true)

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    expect(metadata.generator).toBe('coolector-relay')
    expect(metadata.version).toBe(1)
    expect(metadata.roomId).toBe(room.roomId)
    expect(metadata.uploads).toHaveLength(1)
    expect(metadata.uploads[0].name).toBe('meta.md')
    // 正文不落进元数据（它是字节的纯函数，写进去会让元数据随作业量线性膨胀）
    expect(metadata.uploads[0]).not.toHaveProperty('text')
    // 但截断信息无法事后还原，必须持久化
    expect(metadata.uploads[0]).toHaveProperty('textTruncated')
  })
}, 60000)

describe('重启后恢复房间与作业（房间元数据持久化）', () => {
  /** @type {string} */
  let uploadDir

  beforeAll(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'coolector-restore-'))
  }, 30000)

  afterAll(async () => {
    await rm(uploadDir, { recursive: true, force: true })
  })

  it('房间、上传与配额在重启后完整复原，且正文仍可按需推导', async () => {
    const first = await startRelay({ MAX_FILE_BYTES: String(1024 * 1024) }, { uploadDir })
    const room = await createRoom(first.baseUrl, 'restore-room-1')

    // 文本类：正文可推导；二进制类：正文为 null（不是空串）
    const textContent = '重启后仍应能读到的正文'
    await fetch(`${first.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: '作业.md', content: textContent })
    })
    const binaryBytes = Buffer.from([0x00, 0x01, 0x80, 0xff, 0x0a])
    await fetch(`${first.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'raw.bin', mimeType: 'application/octet-stream', content: binaryBytes })
    })

    const before = await readJson(await fetch(`${first.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders }))
    expect(before.uploadCount).toBe(2)
    const storedBefore = before.storedBytes
    expect(storedBefore).toBeGreaterThan(0)

    // 重启：房间与上传现在应能从磁盘恢复（旧行为是整目录被当「无主目录」回收、作业全丢）
    await first.stop({ keepUploadDir: true })

    const second = await startRelay({ MAX_FILE_BYTES: String(1024 * 1024) }, { uploadDir })
    try {
      const after = await readJson(await fetch(`${second.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders }))
      expect(after.uploadCount).toBe(2)
      // 配额逐字节复原 —— 否则重启会「凭空」放出磁盘额度
      expect(after.storedBytes).toBe(storedBefore)

      /** @type {UploadSummary[]} */
      const restoredUploads = after.uploads
      const textUpload = restoredUploads.find((item) => item.name === '作业.md')
      const binaryUpload = restoredUploads.find((item) => item.name === 'raw.bin')
      expect(textUpload).toBeTruthy()
      expect(binaryUpload).toBeTruthy()
      // `toBeTruthy` 不做类型收窄，故补一次显式判断：元数据没恢复时给出可读的失败原因
      if (textUpload === undefined || binaryUpload === undefined) {
        throw new Error('重启后未从 room.json 恢复上传元数据')
      }

      // 正文：重启后 `upload.text` 为空，details 端点从落盘字节按需推导
      const textDetails = await readJson(await fetch(resolveUrl(second.baseUrl, textUpload.detailsUrl), { headers: authHeaders }))
      expect(textDetails.upload.contentText).toBe(textContent)

      // 非文本类推导结果应为 null，而不是空串
      const binaryDetails = await readJson(await fetch(resolveUrl(second.baseUrl, binaryUpload.detailsUrl), { headers: authHeaders }))
      expect(binaryDetails.upload.contentText).toBeNull()

      // 原件字节保真：下载拿到的必须与上传的逐字节一致
      const download = await fetch(resolveUrl(second.baseUrl, binaryUpload.downloadUrl), { headers: authHeaders })
      expect(Buffer.from(await download.arrayBuffer()).equals(binaryBytes)).toBe(true)
    } finally {
      await second.stop()
    }
  }, 60000)

  it('元数据损坏的目录不被删除也不被恢复（宁可留占用，不可误删）', async () => {
    // 伪造一个「名字像房间、元数据却是半截 JSON」的目录
    const brokenDir = join(uploadDir, 'broken-room-00')
    await mkdir(brokenDir, { recursive: true })
    await writeFile(join(brokenDir, 'room.json'), '{ "generator": "coolector-relay", "upload')
    await writeFile(join(brokenDir, 'leftover.bin'), 'x'.repeat(8192))

    const restarted = await startRelay({ MAX_TOTAL_UPLOAD_BYTES: '4096', MAX_ROOM_UPLOAD_BYTES: '4096' }, { uploadDir })
    try {
      // 关键回归：坏元数据既不触发删除，也不占用配额
      expect(existsSync(join(brokenDir, 'leftover.bin'))).toBe(true)

      const room = await createRoom(restarted.baseUrl, 'restore-quota-room')
      const upload = await fetch(`${restarted.baseUrl}/api/rooms/${room.roomId}/uploads`, {
        method: 'POST',
        headers: ENVELOPE_HEADERS,
        body: envelopeBody({ name: 'ok.md', content: 'ok' })
      })
      // 外来 8KB 若被计入 4KB 的全局配额，这次上传必然 507
      expect(upload.status).toBe(201)
    } finally {
      await restarted.stop()
    }
  }, 40000)
}, 60000)

describe('对外 URL 不得受请求头影响（F-001 回归）', () => {
  /** @type {RelayHarness} */
  let relay
  /** @type {number} F-001 用例用 `node:http` 直连，需要端口号（fetch 无法伪造 Host） */
  let port

  beforeAll(async () => {
    relay = await startRelay()
    port = Number(new URL(relay.baseUrl).port)
  }, 30000)

  afterAll(async () => {
    await relay?.stop()
  })

  /**
   * F-001：无凭据的发送方伪造 `Host` 头，曾能让服务端把 detailsUrl / downloadUrl 拼成
   * `http://evil.example/...`，而接收端前端会自动带 `Authorization` 去拉取它 ——
   * 于是全局 `RELAY_TOKEN` 被送进攻击者服务器。
   *
   * 修复后的契约：对外地址只可能是**相对路径**（或运维配置的 RELAY_PUBLIC_BASE_URL），
   * 请求头一律不参与拼接。
   */
  /**
   * 门禁自身的体检 ——「本用例的存在理由」。
   *
   * 下面三条 F-001 断言的判别力，完全建立在「我们真的能把 `Host` 伪造成 evil.example」之上。
   * 如果哪天 `node:http` 不再允许覆盖 `Host`，那些断言就会变成空转（永远通过），
   * 而漏洞可能已经悄悄回来。所以这里把伪造手段本身也验证一次。
   */
  it('伪造 Host 的手段确实生效（本组用例的存在理由）', async () => {
    const echo = createHttpServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(String(req.headers.host ?? ''))
    })

    const echoPort = await new Promise((resolve, reject) => {
      echo.listen(0, '127.0.0.1', () => {
        const address = echo.address()
        // 只监听 TCP，地址必然是 AddressInfo；显式收窄而不是断言成 AddressInfo
        if (address === null || typeof address === 'string') {
          reject(new Error('未能从回显服务器取到 TCP 端口'))
          return
        }
        resolve(address.port)
      })
    })

    try {
      const { text } = await requestWithHost(echoPort, '/', { host: 'evil.example' })
      expect(text).toBe('evil.example')
    } finally {
      await new Promise((resolve) => { echo.close(resolve) })
    }
  })

  it('伪造 Host 不能进入建房响应里的任何 URL', async () => {
    const { status, text } = await requestWithHost(port, '/api/rooms', {
      method: 'POST',
      host: 'evil.example',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: 'host-injection-room-1' })
    })

    expect(status).toBe(201)
    expect(text).not.toContain('evil.example')

    const payload = JSON.parse(text)
    for (const key of ['streamUrl', 'streamTicketUrl', 'uploadUrl', 'stateUrl']) {
      expect(payload[key]).toMatch(/^\/api\/rooms\//u)
    }
  })

  it('伪造 Host 不能进入上传响应与房间快照', async () => {
    const room = await createRoom(relay.baseUrl, 'host-injection-room-2')

    const upload = await requestWithHost(port, `/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      host: 'evil.example',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'x.md', content: 'hi' })
    })

    expect(upload.status).toBe(201)
    expect(upload.text).not.toContain('evil.example')

    const { upload: summary } = JSON.parse(upload.text)
    expect(summary.detailsUrl).toMatch(/^\/api\/rooms\//u)
    expect(summary.downloadUrl).toBe(`${summary.detailsUrl}?download=1`)

    const stateText = await (await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })).text()
    expect(stateText).not.toContain('evil.example')
  })

  it('伪造 Host 不能进入 SSE 广播的 downloadUrl（F-001 的原始窃密链路）', async () => {
    const room = await createRoom(relay.baseUrl, 'host-injection-room-3')

    const ticketResponse = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/stream-ticket`, {
      method: 'POST',
      headers: authHeaders
    })
    const { ticket } = await readJson(ticketResponse)

    // 接收端先连上 —— 它就是会被骗着把凭据发出去的一方
    const framePromise = readSseEvent(
      `${relay.baseUrl}/api/rooms/${room.roomId}/events?ticket=${encodeURIComponent(ticket)}`,
      'upload.created'
    )

    const upload = await requestWithHost(port, `/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      host: 'evil.example',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'poisoned.md', content: 'payload' })
    })
    expect(upload.status).toBe(201)

    const frame = await framePromise
    // 核心断言：接收端收到的帧里不得出现攻击者域名
    expect(frame).not.toContain('evil.example')

    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
    if (dataLine === undefined) throw new Error('SSE 帧里没有 data: 行')
    const payload = JSON.parse(dataLine.slice('data: '.length))
    expect(payload.data.downloadUrl).toMatch(/^\/api\/rooms\//u)
    expect(payload.data.upload.detailsUrl).toMatch(/^\/api\/rooms\//u)
  })

  it('仅伪造 X-Forwarded-*（Host 保持真实）也不能影响对外 URL', async () => {
    // 刻意**不**覆盖 Host：这条用例要独立证明 X-Forwarded-* 不被采信。
    // 若同时伪造 Host，失败会由 Host 触发，这条断言就证明不了 XFF 那一条（弱断言）。
    const { status, text } = await requestWithHost(port, '/api/rooms', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        'X-Forwarded-Host': 'attacker.example',
        'X-Forwarded-Proto': 'https'
      },
      body: '{}'
    })

    // 先证明请求真的成功了：否则「不含 attacker.example」可能只是错误响应，断言等于空转
    expect(status).toBe(201)
    const payload = JSON.parse(text)
    expect(payload.stateUrl).toMatch(/^\/api\/rooms\//u)
    expect(payload.streamUrl).toMatch(/^\/api\/rooms\//u)
    expect(text).not.toContain('attacker.example')
  })
}, 60000)

describe('RELAY_PUBLIC_BASE_URL：唯一允许产生绝对 URL 的来源', () => {
  /** @type {RelayHarness} */
  let relay

  beforeAll(async () => {
    relay = await startRelay({ RELAY_PUBLIC_BASE_URL: 'https://relay.example.com' })
  }, 30000)

  afterAll(async () => {
    await relay?.stop()
  })

  /**
   * 这条同时是上一条的**判别力对照**：把「外部域名」放进对外 URL 时，本文件的
   * `not.toContain('evil.example')` 断言确实会命中 —— 也就是说那些断言不是空转。
   * 区别只在于：这里的外部域名来自运维配置，而 F-001 里它来自攻击者可控的请求头。
   */
  it('配置基址后输出绝对 URL，且伪造 Host 依然无法覆盖它', async () => {
    const port = Number(new URL(relay.baseUrl).port)
    const { text } = await requestWithHost(port, '/api/rooms', {
      method: 'POST',
      host: 'evil.example',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: 'public-base-room-1' })
    })

    const payload = JSON.parse(text)
    expect(payload.stateUrl).toBe('https://relay.example.com/api/rooms/public-base-room-1')
    expect(payload.streamUrl).toBe('https://relay.example.com/api/rooms/public-base-room-1/events')

    // 伪造的 Host 不能覆盖运维配置的基址
    expect(text).not.toContain('evil.example')
  })

  it('非法基址拒绝启动（fail-closed，不静默回退）', async () => {
    const port = await getFreePort()
    const uploadDir = await mkdtemp(join(tmpdir(), 'coolector-badbase-'))

    const child = spawn(process.execPath, ['server/relay-server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        RELAY_TOKEN: TOKEN,
        UPLOAD_DIR: uploadDir,
        RELAY_PUBLIC_BASE_URL: 'ftp://example.com'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })

    const code = await new Promise((resolve) => {
      child.once('exit', resolve)
      setTimeout(() => { child.kill('SIGTERM'); resolve(null) }, 10000)
    })

    await rm(uploadDir, { recursive: true, force: true })

    expect(code).toBe(1)
    expect(output).toContain('RELAY_PUBLIC_BASE_URL')
  })
}, 60000)
