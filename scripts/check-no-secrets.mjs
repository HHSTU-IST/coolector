#!/usr/bin/env node
/**
 * 构建产物密钥泄露守卫。
 *
 * 背景：Vite 会把 `VITE_*` 变量在构建期内联进 `dist/`。一旦把服务端管理密钥经
 * `VITE_RELAY_TOKEN` 传入，产物里就会带着明文密钥发布出去，任何打开公开提交页的人
 * 都能从 JS 里取出接收端凭据。这个脚本把「产物不含密钥」变成一条可自动执行的断言。
 *
 * 用法：pnpm build && pnpm guard:no-secret
 * 退出码：0 通过；1 发现泄露或缺少产物。
 */

import { createReadStream, existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST_DIR = join(ROOT, 'dist')

/** 敏感变量名：这些键的值绝不允许出现在前端产物里 */
const SECRET_KEY_PATTERN = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|API_KEY|PRIVATE_KEY)($|_)/iu

/** 除真实密钥值外，也不允许产物里残留这些标识（防止有人把读取逻辑加回来） */
const FORBIDDEN_LITERALS = ['VITE_RELAY_TOKEN']

/** 低于该长度的值视为占位符（如 `changeme`），不作为泄露依据，避免误报 */
const MIN_SECRET_LENGTH = 8

/** 分块扫描的块大小；用于让超大产物也能被完整检查 */
const SCAN_CHUNK_BYTES = 64 * 1024

/**
 * 构建期注入的 Relay 地址合法形态。
 *
 * 它不是密钥，所以不在密钥扫描范围内；但接收端**只会把凭据发往这一个源**，
 * 一个畸形的值（`//evil.example` 会指向外部主机、`relay.example.com` 会被浏览器
 * 当成页面自身路径）在构建期没有任何运行期校验能拦住 —— 只能在门禁里挡。
 */
const RELAY_URL_PATTERN = /^https?:\/\/[^\s/]+/iu

function assertRelayUrlLooksSafe() {
  const value = (process.env.VITE_RELAY_URL ?? '').trim()
  if (!value) return

  if (!RELAY_URL_PATTERN.test(value)) {
    console.error(`[guard] ❌ VITE_RELAY_URL 必须是 http(s) 绝对地址，当前值为 ${JSON.stringify(value)}。`)
    console.error('[guard]    例：VITE_RELAY_URL=https://relay.example.com')
    process.exit(1)
  }
}

/**
 * 以滑动窗口分块扫描单个文件。
 *
 * 分块是为了不把超大文件整体读进内存；窗口重叠保证**跨块边界**的密钥也能被发现。
 * 原先这里是 `size > 20MB 则 continue` —— 那是 fail-open：实测一个 21MiB 含密钥的产物
 * 能让守卫静默通过（exit 0），且该文件连分母都不计入。
 */
async function scanForHits(file, needles) {
  const window = Math.max(0, Math.max(...needles.map((needle) => needle.value.length), 1) - 1)
  const hits = new Set()
  let tail = ''

  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: SCAN_CHUNK_BYTES })
  for await (const chunk of stream) {
    const haystack = tail + chunk

    for (const needle of needles) {
      if (!hits.has(needle.label) && haystack.includes(needle.value)) hits.add(needle.label)
    }

    tail = window > 0 ? haystack.slice(-window) : ''
  }

  return hits
}

async function parseEnvFile(path) {
  const map = new Map()
  if (!existsSync(path)) return map

  const text = await readFile(path, 'utf8')
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const index = trimmed.indexOf('=')
    if (index <= 0) continue

    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    if (quoted) value = value.slice(1, -1)
    if (value) map.set(key, value)
  }

  return map
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else {
      yield full
    }
  }
}

async function collectSecrets() {
  const found = new Map()

  for (const [key, value] of await parseEnvFile(join(ROOT, '.env'))) {
    if (SECRET_KEY_PATTERN.test(key) && value.length >= MIN_SECRET_LENGTH) found.set(key, value)
  }

  // CI 场景下密钥经进程环境注入
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue
    if (key.startsWith('npm_') || key.startsWith('PNPM_')) continue
    if (SECRET_KEY_PATTERN.test(key)) found.set(key, value)
  }

  return found
}

async function main() {
  if (!existsSync(DIST_DIR)) {
    console.error('[guard] 未找到 dist/ —— 请先执行 `pnpm build` 再运行本守卫。')
    process.exit(1)
  }

  assertRelayUrlLooksSafe()

  const secrets = await collectSecrets()
  const needles = [
    ...FORBIDDEN_LITERALS.map((literal) => ({ label: `残留标识 ${literal}`, value: literal })),
    ...[...secrets].map(([key, value]) => ({ label: `含 ${key} 的明文值`, value }))
  ]
  const offenders = []
  let scanned = 0

  for await (const file of walk(DIST_DIR)) {
    scanned += 1
    const relativePath = relative(ROOT, file).replaceAll('\\', '/')

    for (const label of await scanForHits(file, needles)) {
      offenders.push(`${relativePath} —— ${label}`)
    }
  }

  if (offenders.length > 0) {
    console.error('[guard] ❌ 构建产物中发现密钥泄露：')
    for (const item of offenders) console.error(`  - ${item}`)
    console.error('')
    console.error('[guard] 前端产物是公开的：请移除 VITE_* 形式的密钥注入，')
    console.error('[guard] 改由用户在界面上提供密钥（见 src/utils/relay.ts），并轮换已泄露的密钥。')
    process.exit(1)
  }

  if (secrets.size === 0) {
    // fail-closed：没有可比对的值时，这条守卫对「真实密钥被打进产物」零判别力。
    // 过去这里只 warn 后 exit 0，而 CI/deploy 都不注入密钥 Secret —— 等于整条防线空转。
    console.error(`[guard] ❌ 没有可核对的密钥值（已扫描 ${scanned} 个产物文件）—— 守卫处于**空转**状态。`)
    console.error('[guard]    请提供至少一个敏感键值，二选一：')
    console.error('[guard]      1) 本地：在 .env 里设置 RELAY_TOKEN；')
    console.error('[guard]      2) CI：构建与守卫两步都注入同一个 canary（如 `VITE_RELAY_TOKEN=coolector-canary-<run id>`）。')
    console.error('[guard]        这样一旦有人把构建期读取逻辑加回来，产物里就会出现 canary 值并被本守卫拦下。')
    process.exit(1)
  }

  const names = [...secrets.keys()].join(', ')
  console.log(`[guard] ✅ 产物干净：扫描 ${scanned} 个文件，未命中任何密钥值（已核对：${names}）。`)
}

await main()
