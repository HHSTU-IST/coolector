// @vitest-environment node
/**
 * `relay-config.js` 的**分层契约**单元测试（1g）。
 *
 * 配置被刻意为两层，这里的断言就是那条界线本身：
 *
 * - **运维变量（9 项）** 仍从同名 env 读取；
 * - **内部调参（15 项）** 只认 `RELAY_TUNING`，**同名 env 完全不再被读取** ——
 *   这一条尤其重要：如果它退化成「又去读 env 了」，运维会以为 `.env` 里那行还生效，
 *   实际却是代码里的默认值，于是照着错误的旋钮排查问题。
 *
 * 本文件只测**合法入参**：非法入参一律 `process.exit(1)`，那会杀掉 vitest 的 worker，
 * 因此它们放在 `relay-server.test.js` 的「配置校验 fail-closed」里用子进程断言。
 *
 * 每个用例都需要一份全新的模块实例（配置在**模块求值期**读取 env），故用 `vi.resetModules()`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 所有可能影响配置的 env 键（含本文件不设置但可能被宿主环境污染的） */
const ENV_KEYS = [
  'PORT', 'HOST', 'UPLOAD_DIR', 'RELAY_TOKEN', 'RELAY_ALLOWED_ORIGINS',
  'RELAY_PUBLIC_BASE_URL', 'RELAY_TRUSTED_PROXIES', 'MAX_FILE_BYTES', 'MAX_TOTAL_UPLOAD_BYTES',
  'RELAY_TUNING',
  // 已降级的 15 项：本文件要证明它们**不再**被读取
  'MAX_TEXT_BYTES', 'MAX_BODY_BYTES', 'MAX_QUEUE_EVENTS', 'MAX_ROOM_UPLOADS', 'MAX_UPLOAD_NAME_BYTES',
  'MAX_ROOMS', 'MAX_UPLOAD_BYTES_PER_WINDOW', 'MAX_ROOM_BYTES_PER_WINDOW',
  'ROOM_TTL_MS', 'ROOM_MAX_LIFETIME_MS', 'ROOM_CLEANUP_INTERVAL_MS',
  'STREAM_TICKET_TTL_MS', 'RATE_LIMIT_WINDOW_MS', 'RATE_LIMIT_MAX', 'MAX_ROOM_UPLOAD_BYTES'
]

/** @type {Map<string, string | undefined>} */
let savedEnv

beforeEach(() => {
  savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/**
 * 在指定的 env 下重新加载配置模块。
 *
 * 刻意**不是 `async`**：函数体内只需同步地改 env，再把 `import()` 的 promise 直接返回
 * （写了 `async` 却没有 `await` 会被 `eslint(require-await)` 判为 warning）。
 *
 * @param {Record<string, string>} [env]
 * @returns {Promise<typeof import('./relay-config.js')>}
 */
function loadConfig(env = {}) {
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, env)

  vi.resetModules()
  return import('./relay-config.js')
}

describe('默认值（未设置任何 env）', () => {
  it('运维变量取各自默认值', async () => {
    const config = await loadConfig()

    expect(config.PORT).toBe(8787)
    expect(config.HOST).toBe('0.0.0.0')
    expect(config.MAX_FILE_BYTES).toBe(10 * 1024 * 1024)
    expect(config.MAX_TOTAL_UPLOAD_BYTES).toBe(1024 * 1024 * 1024)
    expect(config.RELAY_TOKEN).toBe('')
    expect(config.ALLOWED_ORIGINS).toEqual([])
    expect(config.PUBLIC_BASE_URL).toBeNull()
  })

  it('派生项按公式算出（不是写死的数字）', async () => {
    const config = await loadConfig()

    // 房间配额 = 全局的 1/8（下限 8MB）
    expect(config.MAX_ROOM_UPLOAD_BYTES).toBe(1024 * 1024 * 1024 / 8)
    // 请求体上限 = base64 膨胀 4/3 + MAX_TEXT_BYTES + 128KB 余量
    expect(config.MAX_TEXT_BYTES).toBe(1024 * 1024)
    expect(config.MAX_BODY_BYTES).toBe(
      Math.ceil((config.MAX_FILE_BYTES * 4) / 3) + config.MAX_TEXT_BYTES + 128 * 1024
    )
  })
})

describe('内部调参只认 RELAY_TUNING，同名 env 不再被读取', () => {
  it('把已降级的键写成普通 env 完全不生效', async () => {
    const config = await loadConfig({
      MAX_ROOMS: '3',
      RATE_LIMIT_MAX: '5',
      ROOM_TTL_MS: '1000',
      MAX_ROOM_UPLOAD_BYTES: '4096'
    })

    // 全部落在代码里的默认值 —— 若哪天有人把 env 读取加回来，这几条会立刻变红
    expect(config.MAX_ROOMS).toBe(200)
    expect(config.RATE_LIMIT_MAX).toBe(120)
    expect(config.ROOM_TTL_MS).toBe(6 * 60 * 60 * 1000)
    expect(config.MAX_ROOM_UPLOAD_BYTES).toBe(1024 * 1024 * 1024 / 8)
  })

  it('RELAY_TUNING 里的同名键才生效', async () => {
    const config = await loadConfig({
      RELAY_TUNING: JSON.stringify({ MAX_ROOMS: 3, RATE_LIMIT_MAX: 5, ROOM_TTL_MS: 1000 })
    })

    expect(config.MAX_ROOMS).toBe(3)
    expect(config.RATE_LIMIT_MAX).toBe(5)
    expect(config.ROOM_TTL_MS).toBe(1000)
    // 未覆盖的项仍走默认值
    expect(config.MAX_ROOM_UPLOADS).toBe(500)
  })

  it('「0 = 关闭」只对两个窗口额度开放', async () => {
    const config = await loadConfig({
      RELAY_TUNING: JSON.stringify({
        MAX_UPLOAD_BYTES_PER_WINDOW: 0,
        MAX_ROOM_BYTES_PER_WINDOW: 0
      })
    })

    expect(config.MAX_UPLOAD_BYTES_PER_WINDOW).toBe(0)
    expect(config.MAX_ROOM_BYTES_PER_WINDOW).toBe(0)
  })
})

describe('派生的耦合关系（1g 要解决的正是这类错配）', () => {
  it('调大 MAX_TEXT_BYTES 时 MAX_BODY_BYTES 跟着重算', async () => {
    const base = await loadConfig()
    const raised = await loadConfig({ RELAY_TUNING: JSON.stringify({ MAX_TEXT_BYTES: 4 * 1024 * 1024 }) })

    expect(raised.MAX_TEXT_BYTES).toBe(4 * 1024 * 1024)
    // 增量必须精确等于正文上限的增量：否则「N MB 文件 + 大正文」会被自己派生的上限误判 413
    expect(raised.MAX_BODY_BYTES - base.MAX_BODY_BYTES).toBe(3 * 1024 * 1024)
  })

  it('MAX_TEXT_BYTES 有 256KB 下限（不得低于客户端发送正文的上限）', async () => {
    const config = await loadConfig({ RELAY_TUNING: JSON.stringify({ MAX_TEXT_BYTES: 1 }) })
    expect(config.MAX_TEXT_BYTES).toBe(256 * 1024)
  })

  it('MAX_ROOM_UPLOAD_BYTES 默认随 MAX_TOTAL_UPLOAD_BYTES 取 1/8，但有单独覆盖的口子', async () => {
    const derived = await loadConfig({ MAX_TOTAL_UPLOAD_BYTES: String(800 * 1024 * 1024) })
    expect(derived.MAX_ROOM_UPLOAD_BYTES).toBe(100 * 1024 * 1024)

    const overridden = await loadConfig({
      MAX_TOTAL_UPLOAD_BYTES: String(800 * 1024 * 1024),
      RELAY_TUNING: JSON.stringify({ MAX_ROOM_UPLOAD_BYTES: 4096 })
    })
    expect(overridden.MAX_ROOM_UPLOAD_BYTES).toBe(4096)
  })
})

describe('运维变量仍然生效', () => {
  it('从同名 env 读取（含数值校验与路径）', async () => {
    const config = await loadConfig({
      PORT: '9000',
      HOST: '127.0.0.1',
      MAX_FILE_BYTES: '12345',
      MAX_TOTAL_UPLOAD_BYTES: '2048',
      RELAY_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
      RELAY_PUBLIC_BASE_URL: 'https://relay.example.com/'
    })

    expect(config.PORT).toBe(9000)
    expect(config.HOST).toBe('127.0.0.1')
    expect(config.MAX_FILE_BYTES).toBe(12345)
    expect(config.MAX_TOTAL_UPLOAD_BYTES).toBe(2048)
    expect(config.ALLOWED_ORIGINS).toEqual(['https://a.example', 'https://b.example'])
    // 尾部斜杠被归一掉（判据来自 shared/relay-base-url.js）
    expect(config.PUBLIC_BASE_URL).toBe('https://relay.example.com')
    // 房间配额随全局配额变小，但受 8MB 下限保护
    expect(config.MAX_ROOM_UPLOAD_BYTES).toBe(8 * 1024 * 1024)
  })
})
