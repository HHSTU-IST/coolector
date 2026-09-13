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
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOKEN = 'integration-test-token'

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

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

/** 起一个真实 relay 进程；返回停止函数 */
async function startRelay(env = {}, { uploadDir: fixedUploadDir } = {}) {
  const port = await getFreePort()
  const uploadDir = fixedUploadDir ?? (await mkdtemp(join(tmpdir(), 'coolector-it-')))

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
      RATE_LIMIT_MAX: '10000',
      MAX_UPLOAD_BYTES_PER_WINDOW: '104857600',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const logs = []
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))

  const baseUrl = `http://127.0.0.1:${port}`
  await waitForHealth(baseUrl)

  return {
    baseUrl,
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

/** 组装上传请求体（JSON 信封） */
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

async function createRoom(baseUrl, roomId) {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: roomId ? JSON.stringify({ roomId }) : '{}'
  })
  expect(response.status).toBe(201)
  return response.json()
}

describe('relay HTTP 层', () => {
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

    const state = await (await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })).json()
    expect(state.uploads.map((item) => item.name)).toContain(name)
  })

  it('裸 body 不会被误判为信封（.json 文件照常上传）', async () => {
    const room = await createRoom(relay.baseUrl, 'raw-body-room')
    const jsonText = JSON.stringify({ name: '赵六', text: '正文本身就是 JSON' })

    // 关键：Content-Type 是 application/json，但**没有** X-Relay-Envelope 标志
    const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Filename': encodeURIComponent('赵六-20230104.json')
      },
      body: jsonText
    })

    expect(response.status).toBe(201)
    const payload = await response.json()
    expect(payload.upload.size).toBe(Buffer.byteLength(jsonText))
  })

  it('0 字节文件可上传（空 contentBase64 不被当作缺失）', async () => {
    const room = await createRoom(relay.baseUrl, 'empty-file-room')

    const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'empty.md', content: '' })
    })

    expect(response.status).toBe(201)
    expect((await response.json()).upload.size).toBe(0)
  })

  it('超过单文件上限返回可读的 413', async () => {
    const room = await createRoom(relay.baseUrl, 'too-large-room')

    const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'huge.md', content: Buffer.alloc(10 * 1024 * 1024 + 1, 0x41) })
    })

    expect(response.status).toBe(413)
    expect((await response.json()).error).toMatch(/size limit/iu)
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
    const payload = await response.json()
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
    const payload = await response.json()
    expect(payload.upload.textTruncated).toBe(true)
    expect(Buffer.byteLength(payload.upload.contentText, 'utf8')).toBeLessThanOrEqual(limit)
  })

  it('畸形的 mimeType 被清洗，下载不再永久 400', async () => {
    const room = await createRoom(relay.baseUrl, 'mime-clean-room')

    const upload = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'injected.md', mimeType: 'text/plain\r\nX-Injected: 1', content: 'hi' })
    })
    expect(upload.status).toBe(201)
    const { upload: summary } = await upload.json()
    expect(summary.mimeType).toBe('application/octet-stream')

    const download = await fetch(summary.downloadUrl, { headers: authHeaders })
    expect(download.status).toBe(200)
    expect(download.headers.get('x-content-type-options')).toBe('nosniff')
  })
}, 60000)

describe('房间配额隔离', () => {
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
    const send = (roomId) => fetch(`${relay.baseUrl}/api/rooms/${roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: payload
    })

    // 灌满第一个房间：两次 600KB 触发 1MB 房间配额
    expect((await send(crowded.roomId)).status).toBe(201)
    const second = await send(crowded.roomId)
    expect(second.status).toBe(507)
    expect((await second.json()).error).toMatch(/Room storage quota/iu)

    // 关键回归：另一个房间仍可正常上传 —— 免凭据发送方不能再造成跨房间拒绝服务
    const other = await send(neighbour.roomId)
    expect(other.status).toBe(201)
  })
}, 60000)

describe('配置校验 fail-closed', () => {
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

  it('非正数的 RATE_LIMIT_MAX 让进程拒绝启动', async () => {
    const { code, output } = await spawnWithEnv({ RATE_LIMIT_MAX: '-1' })
    expect(code).toBe(1)
    expect(output).toMatch(/RATE_LIMIT_MAX/u)
  }, 20000)

  it('未设置令牌且监听非回环地址时拒绝启动（fail-closed 保持）', async () => {
    const { code, output } = await spawnWithEnv({ RELAY_TOKEN: '', HOST: '0.0.0.0' })
    expect(code).toBe(1)
    expect(output).toMatch(/拒绝启动/u)
  }, 20000)
}, 60000)

describe('元数据上限与配额计量', () => {
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
    const payload = await response.json()
    expect(Buffer.byteLength(payload.upload.name, 'utf8')).toBeLessThanOrEqual(255)
    expect(payload.upload.name.endsWith('.md')).toBe(true)

    const state = await (await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })).json()
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
    expect((await overflow.json()).error).toMatch(/upload count limit/iu)
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
    const state = await (await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })).json()

    expect(accepted).toBeLessThanOrEqual(3)
    expect(state.uploadCount).toBeLessThanOrEqual(3)
  })

  it('超长 mimeType 被中和为 octet-stream，且该文件仍可下载', async () => {
    const room = await createRoom(relay.baseUrl, 'metadata-room-4')

    const upload = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({
        name: 'long-mime.md',
        mimeType: `application/${'a'.repeat(200000)}`,
        content: 'hi'
      })
    })

    expect(upload.status).toBe(201)
    const { upload: summary } = await upload.json()
    expect(summary.mimeType).toBe('application/octet-stream')

    // 过去超长 mimeType 会让下载响应头溢出，客户端连响应头都解析不了 → 永久不可下载
    const download = await fetch(summary.downloadUrl, { headers: authHeaders })
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('application/octet-stream')
  })
}, 60000)

describe('配额并发安全', () => {
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
    const state = await (await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })).json()

    // 预占配额后，并发请求必须有一部分被 507 拒绝，而不是全部落盘（过去 16 个全落盘）
    expect(accepted).toBeGreaterThan(0)
    expect(accepted).toBeLessThan(16)
    // 核心断言：占用不得超过配额
    expect(state.storedBytes).toBeLessThanOrEqual(ROOM_QUOTA)
  })
}, 60000)

describe('上传字节限流', () => {
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
    expect((await limited.json()).error).toMatch(/rate exceeded/iu)

    // 同窗口内的读请求不应被误伤
    expect((await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })).status).toBe(200)
    expect((await fetch(`${relay.baseUrl}/`)).status).toBe(200)
  })
}, 60000)

describe('房间生命周期', () => {
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
    const { ticket } = await ticketResponse.json()

    // 保持一条 SSE 长连接
    const controller = new AbortController()
    const stream = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/events?ticket=${encodeURIComponent(ticket)}`, {
      signal: controller.signal
    })
    expect(stream.status).toBe(200)

    const reader = stream.body.getReader()
    void reader.read()

    // 等超过绝对上限 + 若干扫描周期
    await new Promise((resolve) => {
      setTimeout(resolve, 2500)
    })

    const state = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })
    expect(state.status).toBe(404)

    controller.abort()
    await reader.cancel().catch(() => {})
  }, 20000)
}, 60000)

describe('启动回收的归属门控', () => {
  let uploadDir

  beforeAll(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'coolector-sentinel-'))
    // 这些目录不属于本程序（没有归属标记），启动回收必须放过它们
    await mkdir(join(uploadDir, 'notes.backup'), { recursive: true })
    await writeFile(join(uploadDir, 'notes.backup', 'db-dump.sql'), 'precious data')
    await mkdir(join(uploadDir, 'my notes'), { recursive: true })
    await writeFile(join(uploadDir, 'my notes', 'a.txt'), 'x')
    await writeFile(join(uploadDir, 'loose.txt'), 'x')
  }, 30000)

  afterAll(async () => {
    await rm(uploadDir, { recursive: true, force: true })
  })

  it('无归属标记的目录与散落文件既不被删除，也不计入配额', async () => {
    const relay = await startRelay({}, { uploadDir })

    try {
      // 关键回归：过去是无差别递归删除，这些文件会全部消失
      expect(existsSync(join(uploadDir, 'notes.backup', 'db-dump.sql'))).toBe(true)
      expect(existsSync(join(uploadDir, 'my notes', 'a.txt'))).toBe(true)
      expect(existsSync(join(uploadDir, 'loose.txt'))).toBe(true)

      const root = await (await fetch(`${relay.baseUrl}/`)).json()
      expect(root.storageUsedBytes).toBe(0)
    } finally {
      await relay.stop()
    }
  }, 40000)
}, 60000)

describe('删除失败的错误隔离', () => {
  it('DELETE 时目录删除失败仍返回 200，但如实标记 storageRemoved=false', async () => {
    const relay = await startRelay({ RELAY_TEST_INJECT_RM_FAILURE: 'true' })

    try {
      const room = await createRoom(relay.baseUrl, 'rm-failure-delete-room')

      await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
        method: 'POST',
        headers: ENVELOPE_HEADERS,
        body: envelopeBody({ name: 'x.md', content: 'x' })
      })

      const response = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, {
        method: 'DELETE',
        headers: authHeaders
      })

      // 房间在服务端已经不存在；磁盘删不掉是次生问题，不能让调用方以为删除失败而反复重试
      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(payload.deleted).toBe(true)
      expect(payload.storageRemoved).toBe(false)

      // 配额已回收，进程仍健康
      expect((await fetch(`${relay.baseUrl}/healthz`)).status).toBe(200)
    } finally {
      await relay.stop()
    }
  }, 40000)

  it('目录删除失败不会让 relay 进程退出（清理任务必须吞掉异常）', async () => {
    const relay = await startRelay({
      // 故障注入：让 destroyRoom 的 rm 必定失败
      RELAY_TEST_INJECT_RM_FAILURE: 'true',
      ROOM_MAX_LIFETIME_MS: '800',
      ROOM_CLEANUP_INTERVAL_MS: '300'
    })

    try {
      const room = await createRoom(relay.baseUrl, 'rm-failure-room')

      await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
        method: 'POST',
        headers: ENVELOPE_HEADERS,
        body: envelopeBody({ name: 'x.md', content: 'x' })
      })

      // 等房间被绝对上限回收（此时 rm 会失败）
      await new Promise((resolve) => {
        setTimeout(resolve, 2000)
      })

      // 关键断言：进程仍然服务，没有被未处理拒绝带走
      const health = await fetch(`${relay.baseUrl}/healthz`)
      expect(health.status).toBe(200)

      // 房间在服务端已经不存在
      const state = await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })
      expect(state.status).toBe(404)
    } finally {
      await relay.stop()
    }
  }, 40000)
}, 60000)

describe('在途上传与房间删除的交界', () => {
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
    const hasPayloadFile = existsSync(roomDir)
      && readdirSync(roomDir).some((name) => !name.startsWith('.'))

    // 需要防住的状态：房间已不存在，磁盘上却留着没有归属的文件（静默丢件 + 占额）
    expect(roomGone && hasPayloadFile).toBe(false)
  }, 30000)
}, 60000)

describe('details 端点契约', () => {
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

    const state = await (await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}`, { headers: authHeaders })).json()
    const details = await (await fetch(state.uploads[0].detailsUrl, { headers: authHeaders })).json()

    // 只保留 `upload.contentBase64` 一处（顶层重复副本已删除）
    expect(Buffer.from(details.upload.contentBase64, 'base64').toString('utf8')).toBe(content)
    expect(details.contentBase64).toBeUndefined()
  })

  it('房间目录写入归属标记（供启动回收判定）', async () => {
    const room = await createRoom(relay.baseUrl, 'details-room-2')

    await fetch(`${relay.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'sentinel.md', content: 'x' })
    })

    const sentinelPath = join(relay.uploadDir, room.roomId, '.coolector-room')
    expect(existsSync(sentinelPath)).toBe(true)

    const sentinel = JSON.parse(await readFile(sentinelPath, 'utf8'))
    expect(sentinel.generator).toBe('coolector-relay')
    expect(sentinel.roomId).toBe(room.roomId)
  })
}, 60000)

describe('启动时回收无主上传目录', () => {
  let uploadDir

  beforeAll(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'coolector-orphan-'))
  }, 30000)

  afterAll(async () => {
    await rm(uploadDir, { recursive: true, force: true })
  })

  it('重启后无主目录被回收，不再永久占用全局配额', async () => {
    const first = await startRelay({ MAX_FILE_BYTES: String(1024 * 1024) }, { uploadDir })
    const room = await createRoom(first.baseUrl, 'orphan-room-1')

    await fetch(`${first.baseUrl}/api/rooms/${room.roomId}/uploads`, {
      method: 'POST',
      headers: ENVELOPE_HEADERS,
      body: envelopeBody({ name: 'o.md', content: Buffer.alloc(512 * 1024, 0x46) })
    })

    // 重启：房间只在内存里，磁盘上的目录随即变成"无主目录"
    await first.stop({ keepUploadDir: true })

    const second = await startRelay({ MAX_FILE_BYTES: String(1024 * 1024) }, { uploadDir })
    try {
      const root = await (await fetch(`${second.baseUrl}/`)).json()
      // 关键回归：不再把无主字节计入配额（否则新房间会被 507 挡住且无法回收）
      expect(root.storageUsedBytes).toBe(0)

      const fresh = await createRoom(second.baseUrl, 'orphan-room-2')
      const upload = await fetch(`${second.baseUrl}/api/rooms/${fresh.roomId}/uploads`, {
        method: 'POST',
        headers: ENVELOPE_HEADERS,
        body: envelopeBody({ name: 'n.md', content: 'ok' })
      })
      expect(upload.status).toBe(201)
    } finally {
      await second.stop()
    }
  }, 40000)
}, 60000)
