#!/usr/bin/env node
/**
 * 头级取证：隧道工具对 `X-Forwarded-For` 究竟**追加**、**覆盖**还是**原样透传**。
 *
 * 为什么必须单独做：relay 在 `RELAY_TRUSTED_PROXIES` 声明之后会**采信** XFF 决定限流分桶
 * （`makeClientIpResolver`：自最右端向左跳过可信跳、取第一个不可信地址）。于是「隧道往这条头里
 * 写了什么」直接决定限流是「按客户端分桶」还是「可被伪造值绕过」。行为级探针（`tunnel-xff-probe`）
 * 只能回答「能不能换桶」；「追加还是覆盖」只有头级回显能回答，且**换隧道工具时必须重测** ——
 * 这是外部实现，本仓的任何结论都不能外推到它身上。
 *
 * 判据（relay 取的是**最右端**那个不可信地址）：
 *   追加 ⇒ 伪造值留在左侧、隧道注入的真实客户端 IP 在最右 ⇒ relay 拿到真实 IP ……安全
 *   覆盖 ⇒ 伪造值整条消失 ⇒ relay 拿到真实 IP …………………………安全
 *   透传 ⇒ 伪造值直达 relay ⇒ 可换桶 ……………………………………不安全
 *
 * 前置：先起 `echo-upstream.mjs`，再把隧道指向它（`ngrok http <ECHO_PORT>`）。
 *
 * 用法：node scripts/probes/tunnel-xff-header-probe.mjs
 */

import { resolveProbeBase, createChecker, readJson } from './lib/tunnel-base.mjs'

const SPOOF_HEADER = process.env.PROBE_SPOOF_HEADER ?? 'X-Forwarded-For'

const { base, source } = await resolveProbeBase()
const { check, summary } = createChecker()

console.log(`隧道地址 : ${base}（来自 ${source}）`)
console.log('⚠️ 该隧道必须指向 echo-upstream，否则读到的不是隧道写下的原始头。\n')
console.log('case                                  上游收到的值                          x-forwarded-proto')
console.log('-'.repeat(104))

const cases = [
  { label: '不带该头', headers: {} },
  { label: `${SPOOF_HEADER} = 9.9.9.9`, headers: { [SPOOF_HEADER]: '9.9.9.9' } },
  { label: `${SPOOF_HEADER} = 9.9.9.9, 8.8.8.8`, headers: { [SPOOF_HEADER]: '9.9.9.9, 8.8.8.8' } },
  { label: `${SPOOF_HEADER} = 空串`, headers: { [SPOOF_HEADER]: '' } },
  { label: `${SPOOF_HEADER} = 2001:db8::1`, headers: { [SPOOF_HEADER]: '2001:db8::1' } }
]

/** @type {{ label: string, value: string | null }[]} */
const seen = []
for (const c of cases) {
  let value = null
  let proto = '(未知)'
  try {
    const res = await fetch(`${base}/probe`, { headers: c.headers })
    const body = await readJson(res)
    const headers = body?.headers ?? {}
    value = headers[SPOOF_HEADER.toLowerCase()] ?? null
    proto = headers['x-forwarded-proto'] ?? '(无)'
  } catch (error) {
    console.log(`${c.label.padEnd(38)}请求失败：${error instanceof Error ? error.message : String(error)}`)
    seen.push({ label: c.label, value: null })
    continue
  }
  seen.push({ label: c.label, value })
  console.log(`${c.label.padEnd(38)}${String(value ?? '(无)').padEnd(38)}${proto}`)
}

console.log('')
const noHeader = seen.find((s) => s.label === '不带该头')
const spoofed = seen.find((s) => s.label === `${SPOOF_HEADER} = 9.9.9.9`)

check(
  '隧道总会向上游注入该头（不带时也已存在）',
  Boolean(noHeader?.value),
  `值=${noHeader?.value ?? 'null'}`
)

const injected = String(noHeader?.value ?? '')
const withSpoof = String(spoofed?.value ?? '')
const lastHop = withSpoof.trim().split(',').pop()?.trim() ?? ''

check(
  '客户端伪造值没能成为**最右端**（即非原样透传）',
  Boolean(lastHop) && lastHop !== '9.9.9.9',
  `最右端=${lastHop || '(空)'}`
)

let shape = 'unknown'
if (withSpoof === '9.9.9.9') shape = 'passthrough'
else if (withSpoof === injected) shape = 'overwrite'
else if (withSpoof.startsWith('9.9.9.9')) shape = 'append'

/** @type {Record<string, string>} */
const SHAPE_DESC = {
  append: '追加（伪造值在左、隧道注入的真实客户端 IP 在右）',
  overwrite: '覆盖（伪造值被整条丢弃）',
  passthrough: '原样透传（伪造值直达上游 —— 限流可被换桶绕过）',
  unknown: '无法归入已知形态'
}

check(
  `形态判定 = ${SHAPE_DESC[shape] ?? shape}`,
  shape === 'append' || shape === 'overwrite',
  `实测 ${SHAPE_DESC[shape] ?? shape}`
)

process.exitCode = summary() === 0 ? 0 : 1
