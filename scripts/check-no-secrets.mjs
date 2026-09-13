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

import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
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

  const secrets = await collectSecrets()
  const offenders = []
  let scanned = 0

  for await (const file of walk(DIST_DIR)) {
    const info = await stat(file)
    if (info.size > 20 * 1024 * 1024) continue

    scanned += 1
    const relativePath = relative(ROOT, file).replaceAll('\\', '/')
    const content = await readFile(file, 'utf8')

    for (const literal of FORBIDDEN_LITERALS) {
      if (content.includes(literal)) offenders.push(`${relativePath} —— 残留标识 ${literal}`)
    }
    for (const [key, value] of secrets) {
      if (content.includes(value)) offenders.push(`${relativePath} —— 含 ${key} 的明文值`)
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
    console.warn(`[guard] ⚠️  未发现可检查的密钥变量（已扫描 ${scanned} 个产物文件）。`)
    console.warn('[guard]    守卫处于空转状态 —— 请确认 .env 或 CI 环境里确实提供了密钥。')
    process.exit(0)
  }

  const names = [...secrets.keys()].join(', ')
  console.log(`[guard] ✅ 产物干净：扫描 ${scanned} 个文件，未命中任何密钥值（已核对：${names}）。`)
}

await main()
