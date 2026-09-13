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
import { mkdtemp, rm } from 'node:fs/promises'
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
async function startRelay(env = {}) {
  const port = await getFreePort()
  const uploadDir = await mkdtemp(join(tmpdir(), 'coolector-it-'))

  const child = spawn(process.execPath, ['server/relay-server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      RELAY_TOKEN: TOKEN,
      UPLOAD_DIR: uploadDir,
      RATE_LIMIT_MAX: '10000',
      MAX_UPLOAD_BYTES_PER_WINDOW: '0',
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
    logs,
    async stop() {
      child.kill('SIGTERM')
      await new Promise((resolve) => {
        child.once('exit', resolve)
        setTimeout(resolve, 2000)
      })
      await rm(uploadDir, { recursive: true, force: true })
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

    const payload = envelopeBody({ name: 'big.md', content: Buffer.alloc(600 * 1024, 0x43) })
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
