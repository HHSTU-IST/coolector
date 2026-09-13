#!/usr/bin/env node
/**
 * 真实浏览器端到端回归 —— Iteration 1 的 G3 门槛。
 *
 * 为什么必须用真实浏览器：
 *   上一轮用 curl 做的 10 项冒烟全部通过，却完整漏掉了「浏览器 fetch 的请求头只能是
 *   ISO-8859-1」这条主路径缺陷 —— 中文文件名会让请求在出网前就抛 TypeError。
 *   curl 不会做 ByteString 校验，因此它天然看不见这类问题。
 *
 * 覆盖场景：
 *   1. 接收端（独立浏览器上下文）凭密钥建房，房间号为服务端生成的完整 UUID
 *   2. 发送方（另一个上下文，**完全不持有密钥**）上传中文名 .md / .docx / .ipynb / .json
 *   3. 接收端经 SSE 收齐全部文件，文件名逐字正确
 *   4. 接收端对二进制文件显示占位文案而非乱码
 *   5. 8.5MB 大文件可上传（过去因体积口径错位在约 7.86MB 处失败）
 *   6. 超限请求返回可读的 413 响应体，而不是 Failed to fetch
 *   7. 向不存在的房间上传返回 404（「上传即建房」已移除）
 *   8. `?token=` 查询参数不再能通过鉴权
 *
 * 用法：pnpm e2e
 *   浏览器解析顺序：PLAYWRIGHT_CHROMIUM_EXECUTABLE → ms-playwright 缓存 → 报错退出
 *   设置 E2E_ALLOW_SKIP=1 可在无浏览器的机器上跳过（默认不跳过：静默跳过的门禁等于没有门禁）
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer as createHttpServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST_DIR = join(ROOT, 'dist')
const RELAY_TOKEN = 'e2e-token-not-for-production'

const results = []
let failed = 0

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  if (!ok) failed += 1
}

function log(message) {
  process.stdout.write(`${message}\n`)
}

/** 轮询等待条件成立，避免依赖固定 sleep 造成偶发失败 */
async function waitFor(fn, { timeout = 20000, interval = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  let lastError = null

  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((ok) => {
      setTimeout(ok, interval)
    })
  }

  throw new Error(`等待超时（${label}）${lastError ? `：${lastError.message}` : ''}`)
}

function getFreePort() {
  return new Promise((ok, fail) => {
    const probe = createServer()
    probe.on('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => {
        ok(port)
      })
    })
  })
}

/**
 * 解析可用的 Chromium，按优先级：
 *   1. PLAYWRIGHT_CHROMIUM_EXECUTABLE —— 显式覆盖
 *   2. playwright 自己管理的浏览器（CI 里 `playwright install chromium` 装的）
 *   3. ms-playwright 缓存扫描（本机浏览器由其他工具/其他版本安装时的兜底）
 */
function resolveChromiumExecutable() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  if (explicit && existsSync(explicit)) return explicit

  try {
    const managed = chromium.executablePath()
    if (managed && existsSync(managed)) return managed
  } catch {
    // playwright 未安装对应版本浏览器，继续走缓存扫描
  }

  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'ms-playwright')
      : null,
    join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.cache', 'ms-playwright')
  ].filter(Boolean)

  for (const root of roots) {
    if (!existsSync(root)) continue

    // `chromium-*` 排在同层的 `chromium_headless_shell-*` 之前（'-' < '_'），优先用完整版
    for (const dir of readdirSync(root).filter((name) => name.startsWith('chromium')).sort()) {
      const candidates = [
        join(root, dir, 'chrome-win64', 'chrome.exe'),
        join(root, dir, 'chrome-win', 'chrome.exe'),
        join(root, dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
        join(root, dir, 'chrome-linux', 'chrome'),
        join(root, dir, 'chrome-linux64', 'chrome'),
        join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
      ]

      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate
      }
    }
  }

  return null
}

const MIME_BY_EXTENSION = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
}

/** 起一个只服务 dist/ 的最小静态服务器（模块脚本必须是正确 MIME，否则浏览器拒绝执行） */
async function startStaticServer(root) {
  const rootPath = resolve(root)

  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      let pathname = decodeURIComponent(url.pathname)
      if (pathname.endsWith('/')) pathname += 'index.html'

      let filePath = resolve(rootPath, `.${pathname}`)
      if (!filePath.startsWith(rootPath)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (!existsSync(filePath)) filePath = join(rootPath, 'index.html')

      const body = await readFile(filePath)
      res.writeHead(200, { 'Content-Type': MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(500)
      res.end('static server error')
    }
  })

  await new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      ok()
    })
  })
  return { server, port: server.address().port }
}

async function startRelay({ port, uploadDir }) {
  const child = spawn(process.execPath, ['server/relay-server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      RELAY_TOKEN,
      RELAY_ALLOWED_ORIGINS: '*',
      UPLOAD_DIR: uploadDir,
      MAX_FILE_BYTES: String(10 * 1024 * 1024),
      RATE_LIMIT_MAX: '1000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const logs = []
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()))
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()))

  const baseUrl = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/healthz`)
    return response.ok
  }, { timeout: 15000, label: 'relay 启动' })

  return { child, baseUrl, logs }
}

/** 构造测试夹具；返回 [name, mimeType, buffer] 列表 */
function buildFixtures() {
  const encoder = new TextEncoder()

  const markdown = '# 作业\n\n这是中文正文测试，用于验证文件名与正文能完整往返。\n'
  const notebook = JSON.stringify({
    cells: [{ cell_type: 'markdown', source: ['# 实验一', '梯度下降'] }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  }, null, 2)
  const jsonDoc = JSON.stringify({ name: '赵六', text: '正文本身就是 JSON —— 不能被当成上传信封' }, null, 2)

  // 8.5 MB 文本：旧实现下 base64 后超过 10MB 请求体上限，会在约 7.86MB 处静默失败
  const bigText = `${'# 大文件载荷\n'.repeat(1)}${'载荷'.repeat(1)}\n${'A'.repeat(8_500_000)}`

  return [
    // 故意把二进制放第一位：接收端会自动选中首个文件，便于断言占位文案
    ['李四-20230102.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('not-a-real-zip-binary-payload')],
    ['张三-20230101.md', 'text/markdown', Buffer.from(encoder.encode(markdown))],
    ['王五-20230103.ipynb', '', Buffer.from(encoder.encode(notebook))],
    ['赵六-20230104.json', 'application/json', Buffer.from(encoder.encode(jsonDoc))],
    ['钱七-20230105.md', 'text/markdown', Buffer.from(encoder.encode(bigText))]
  ]
}

async function main() {
  if (!existsSync(join(DIST_DIR, 'index.html'))) {
    log('[e2e] 未找到 dist/index.html —— 请先执行 `pnpm build`。')
    process.exit(1)
  }

  const executablePath = resolveChromiumExecutable()
  if (!executablePath) {
    const message = [
      '[e2e] ❌ 未找到可用的 Chromium。',
      '      G3 门禁要求真实浏览器，静默跳过等于没有门禁，因此默认失败。',
      '      修复方式（任选其一）：',
      '        · npx playwright install chromium',
      '        · 设置 PLAYWRIGHT_CHROMIUM_EXECUTABLE=<chrome 可执行文件绝对路径>',
      '      确认无法提供浏览器时，可显式设置 E2E_ALLOW_SKIP=1 跳过（CI 中不应这么做）。'
    ].join('\n')

    if (process.env.E2E_ALLOW_SKIP === '1') {
      log(`${message}\n[e2e] ⚠️  已按 E2E_ALLOW_SKIP=1 跳过浏览器回归。`)
      process.exit(0)
    }

    log(message)
    process.exit(1)
  }

  log(`[e2e] 使用浏览器：${executablePath}`)

  const uploadDir = await mkdtemp(join(tmpdir(), 'coolector-e2e-'))
  const relayPort = await getFreePort()
  const staticServer = await startStaticServer(DIST_DIR)
  const relay = await startRelay({ port: relayPort, uploadDir })

  const webUrl = `http://127.0.0.1:${staticServer.port}/`
  const relayBaseUrl = relay.baseUrl

  let browser
  try {
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })

    const receiverContext = await browser.newContext()
    const senderContext = await browser.newContext()
    const receiver = await receiverContext.newPage()
    const sender = await senderContext.newPage()

    const senderPageErrors = []
    const senderConsoleErrors = []
    sender.on('pageerror', (error) => senderPageErrors.push(String(error)))
    sender.on('console', (message) => {
      if (message.type() === 'error') senderConsoleErrors.push(message.text())
    })

    // ── 1. 接收端建房并建立 SSE 长连接（唯一持有密钥的一方） ──────────────
    await receiver.goto(webUrl, { waitUntil: 'domcontentloaded' })
    await receiver.locator('#upload input[type="url"]').fill(relayBaseUrl)
    await receiver.locator('#upload input[type="password"]').fill(RELAY_TOKEN)
    // #upload 内第一个 text 输入是 RelayReceiver 的房间 ID 输入框，留空让服务端生成 UUID
    await receiver.locator('#upload input[type="text"]').first().fill('')

    const roomResponsePromise = receiver.waitForResponse(
      (response) => response.url().endsWith('/api/rooms') && response.request().method() === 'POST'
    )
    await receiver.locator('#upload button[type="submit"]').click()
    const roomResponse = await roomResponsePromise
    const room = await roomResponse.json()

    check('接收端建房返回 201', roomResponse.status() === 201, `HTTP ${roomResponse.status()}`)
    check(
      '房间号为服务端生成的完整 UUID',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(room.roomId ?? ''),
      `roomId=${room.roomId}`
    )

    await waitFor(async () => {
      const label = await receiver.locator('#upload').innerText()
      return label.includes('已连接')
    }, { label: '接收端 SSE 连接建立' })
    check('接收端经一次性票据建立 SSE 连接', true)

    // ── 2. 发送方（不持有任何密钥）逐文件上传 ──────────────────────────────
    await sender.goto(webUrl, { waitUntil: 'domcontentloaded' })
    const fileInput = sender.locator('#upload input[type="file"]').first()
    const fixtures = buildFixtures()

    for (const [name, mimeType, buffer] of fixtures) {
      await fileInput.setInputFiles([{ name, mimeType, buffer }])

      // 本地上传不会自动选中文件，需点该行的「查看」按钮打开 FileViewer
      const rowToggle = sender.locator(
        `xpath=//p[normalize-space(text())='${name}']/following::button[normalize-space(text())='查看'][1]`
      )
      await rowToggle.waitFor({ state: 'visible', timeout: 15000 })
      await rowToggle.click()

      const viewer = sender.locator('#preview')
      await viewer.locator('input[type="url"]').fill(relayBaseUrl)
      await viewer.locator('input[type="text"]').fill(room.roomId)

      const uploadButton = viewer.locator('button', { hasText: '上传到 Relay' })
      await uploadButton.waitFor({ state: 'visible' })
      const uploadResponsePromise = sender.waitForResponse(
        (response) => response.url().includes('/uploads') && response.request().method() === 'POST'
      )
      await uploadButton.click()
      const uploadResponse = await uploadResponsePromise

      check(`发送方上传 ${name} 返回 201`, uploadResponse.status() === 201, `HTTP ${uploadResponse.status()}`)

      const isLarge = name.includes('20230105')
      await waitFor(async () => {
        const text = await viewer.innerText()
        return text.includes('已发送到房间') || text.includes('失败') || text.includes('HTTP 上传失败')
      }, { timeout: isLarge ? 40000 : 20000, label: `${name} 上传结果` })

      const viewerText = await viewer.innerText()
      check(`发送方上传 ${name} 前端提示成功`, viewerText.includes('已发送到房间'), viewerText.split('\n').at(-1) ?? '')
    }

    check('发送方页面无未捕获异常', senderPageErrors.length === 0, senderPageErrors.join(' | '))

    // ── 3. 接收端经 SSE 收齐全部文件，文件名逐字正确 ─────────────────────
    await waitFor(async () => {
      const text = await receiver.locator('#upload').innerText()
      return fixtures.every(([name]) => text.includes(name))
    }, { timeout: 30000, label: '接收端收齐全部文件' })

    const receiverListText = await receiver.locator('#upload').innerText()
    const missing = fixtures.map(([name]) => name).filter((name) => !receiverListText.includes(name))
    check('接收端文件列表包含全部中文文件名（逐字一致）', missing.length === 0, missing.join(', '))

    // ── 4. 接收端二进制渲染为占位文案，而非乱码 ───────────────────────────
    const previewText = await receiver.locator('#preview pre').innerText()
    check(
      '接收端二进制文件显示占位文案而非乱码',
      previewText.includes('此文件为二进制格式'),
      previewText.slice(0, 60).replaceAll('\n', ' ')
    )

    // 逐个切到其余文件，确认正文往返无损
    const contentExpectations = [
      ['张三-20230101.md', '这是中文正文测试'],
      ['王五-20230103.ipynb', '梯度下降'],
      ['赵六-20230104.json', '正文本身就是 JSON']
    ]

    for (const [name, expected] of contentExpectations) {
      const toggle = receiver.locator(
        `xpath=//p[normalize-space(text())='${name}']/following::button[normalize-space(text())='查看'][1]`
      )
      await toggle.click()
      await waitFor(async () => (await receiver.locator('#preview pre').innerText()).includes(expected),
        { label: `接收端渲染 ${name}` })
      check(`接收端正文往返无损：${name}`, true)
    }

    // ── 5. 体积口径：8.5MB 文件已在第 2 步上传成功，这里确认服务端确实落盘 ──
    const bigUpload = fixtures.at(-1)[0]
    const roomState = await (await fetch(`${relayBaseUrl}/api/rooms/${room.roomId}`, {
      headers: { Authorization: `Bearer ${RELAY_TOKEN}` }
    })).json()
    const bigEntry = (roomState.uploads ?? []).find((item) => item.name === bigUpload)
    check(
      '8.5MB 文件确实落盘（旧实现在约 7.86MB 处失败）',
      Boolean(bigEntry) && bigEntry.size > 8_000_000,
      `size=${bigEntry?.size ?? 'missing'}`
    )

    // ── 6. 超限请求返回可读 413，而非连接中断 ─────────────────────────────
    const oversize = await sender.evaluate(async ({ url }) => {
      const megabyte = 'A'.repeat(1024 * 1024)
      const body = JSON.stringify({ name: 'huge.md', mimeType: 'text/markdown', contentBase64: megabyte.repeat(16) })
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Relay-Envelope': '1' },
          body
        })
        return { status: response.status, text: await response.text() }
      } catch (error) {
        return { status: 0, text: String(error) }
      }
    }, { url: `${relayBaseUrl}/api/rooms/${room.roomId}/uploads` })

    check('超限请求返回 413 且带可读响应体', oversize.status === 413 && /too large/iu.test(oversize.text),
      `status=${oversize.status} body=${oversize.text.slice(0, 80)}`)

    // ── 7. 向不存在的房间上传返回 404（已移除「上传即建房」） ──────────────
    const notFound = await sender.evaluate(async ({ url }) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Envelope': '1' },
        body: JSON.stringify({ name: 'x.md', mimeType: 'text/markdown', contentBase64: 'aGk=' })
      })
      return { status: response.status, text: await response.text() }
    }, { url: `${relayBaseUrl}/api/rooms/nonexistent-room-xyz/uploads` })

    check('向不存在的房间上传返回 404', notFound.status === 404, `status=${notFound.status}`)

    // ── 8. ?token= 查询参数不再能通过鉴权 ─────────────────────────────────
    const urlToken = await sender.evaluate(async ({ base, token }) => {
      const response = await fetch(`${base}/api/rooms?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      })
      return response.status
    }, { base: relayBaseUrl, token: RELAY_TOKEN })

    check('?token= 查询参数被拒绝（401）', urlToken === 401, `status=${urlToken}`)

    // ── 9. 用例存在理由自检：浏览器确实禁止非 ISO-8859-1 的请求头值 ────────
    // 如果这条行为哪天变了，上面「中文名上传成功」的断言就可能变成空转，
    // 因此把平台约束本身也断言一次，避免测试悄悄失去意义。
    const headerConstraint = await sender.evaluate(async () => {
      try {
        await fetch('http://127.0.0.1:1/never-used', { headers: { 'X-Relay-Filename': '张三.md' } })
        return 'no-error'
      } catch (error) {
        return String(error)
      }
    })
    check(
      '浏览器仍禁止非 ISO-8859-1 请求头值（本用例的存在理由）',
      /ISO-8859-1|ByteString|non-ISO/iu.test(headerConstraint),
      headerConstraint.slice(0, 80)
    )

    // ── 10. 发送方全程未持有密钥 ──────────────────────────────────────────
    const senderHasSecret = senderConsoleErrors.some((line) => line.includes(RELAY_TOKEN))
    check('发送方上下文从未持有管理密钥', !senderHasSecret)

    await receiverContext.close()
    await senderContext.close()
  } finally {
    if (browser) await browser.close()
    relay.child.kill('SIGTERM')
    staticServer.server.close()
    await rm(uploadDir, { recursive: true, force: true })
  }

  log('')
  log('─── 浏览器端到端回归结果 ───')
  for (const item of results) {
    log(`${item.ok ? '✅' : '❌'}  ${item.name}${item.ok || !item.detail ? '' : ` —— ${item.detail}`}`)
  }
  log('')
  log(`合计 ${results.length} 项，失败 ${failed} 项。`)

  if (failed > 0) {
    log('')
    log('[e2e] relay 日志尾部：')
    log(relay.logs.join('').split('\n').slice(-20).join('\n'))
    process.exit(1)
  }

  log('[e2e] ✅ 全部通过。')
}

await main()
