// @vitest-environment node
/**
 * `scripts/check-atomic-invariants.mjs` 的判别力测试。
 *
 * 一个静态检查最危险的失效方式是**变成空转**：规则写歪了、匹配不到东西，于是永远通过，
 * 而它本该拦住的东西照旧进来。所以这里不只测「真实源码通过」，更要逐条证明
 * **每一种违规都会被报出来**，并且**不会把合法写法误报**（误报同样致命：
 * 下一个人会为了让它变绿而删掉检查）。
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ATOMIC_INVARIANTS, checkAtomicInvariants } from '../scripts/check-atomic-invariants.mjs'

/**
 * 最小可编译的骨架：两个原子函数 + 一个允许写计数的具名函数
 *
 * @type {(options: {
 *   quotaBody: string,
 *   slotBody: string,
 *   slotTag?: string,
 *   slotName?: string,
 *   extra?: string
 * }) => string}
 */
const skeleton = ({ quotaBody, slotBody, slotTag = '@atomic', slotName = 'reserveUploadSlot', extra = '' }) => `
const rooms = new Map()
let totalStoredBytes = 0

/**
 * 原子预留。
 * @atomic
 */
function reserveStorageQuota(room, quotaBytes) {
${quotaBody}
}

/**
 * 原子槽位。
 * ${slotTag}
 */
function ${slotName}(room) {
${slotBody}
}

/** 回收 */
function destroyRoom(room) {
  totalStoredBytes = 0
  room.storedBytes = 0
  return Promise.resolve()
}

async function persistUpload(upload, bytes) {
  await Promise.resolve(bytes)
  upload.done = true
}
${extra}
`

/** @type {(source: string) => string[]} */
const run = (source) => checkAtomicInvariants(source, 'fixture.js').problems

describe('checkAtomicInvariants —— 基线', () => {
  it('合规写法零问题', () => {
    const problems = run(skeleton({
      quotaBody: '  room.storedBytes += quotaBytes\n  totalStoredBytes += quotaBytes\n  return () => { room.storedBytes -= quotaBytes }',
      slotBody: '  room.pendingUploads += 1\n  return () => { room.pendingUploads -= 1 }'
    }))

    expect(problems).toEqual([])
  })

  it('真实 relay-state.js 零问题（当前 HEAD 的实际写法）', async () => {
    const source = await readFile(join(process.cwd(), 'server', 'relay-state.js'), 'utf8')

    expect(run(source)).toEqual([])
  })
})

describe('checkAtomicInvariants —— 违规必须报出（判别力）', () => {
  it('原子函数内出现 await', () => {
    const problems = run(skeleton({
      quotaBody: '  await Promise.resolve()\n  room.storedBytes += quotaBytes\n  return () => {}',
      slotBody: '  room.pendingUploads += 1\n  return () => {}'
    }))

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/reserveStorageQuota/u)
    expect(problems[0]).toMatch(/await/u)
    expect(problems[0]).toMatch(/铁律 14/u)
  })

  it('原子函数被声明成 async', () => {
    const source = skeleton({
      quotaBody: '  room.storedBytes += quotaBytes\n  return () => {}',
      slotBody: '  room.pendingUploads += 1\n  return () => {}'
    }).replace('function reserveStorageQuota(', 'async function reserveStorageQuota(')

    expect(run(source).some((problem) => /不得声明为 async/u.test(problem))).toBe(true)
  })

  it('@atomic 标记被删掉（否则检查会静默失效）', () => {
    const source = skeleton({
      quotaBody: '  room.storedBytes += quotaBytes\n  return () => {}',
      slotBody: '  room.pendingUploads += 1\n  return () => {}'
    }).replace(' * @atomic\n */\nfunction reserveStorageQuota(', ' */\nfunction reserveStorageQuota(')

    const problems = run(source)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/缺少 @atomic/u)
  })

  it('原子函数被改名（名单必须同步）', () => {
    const problems = run(skeleton({
      quotaBody: '  room.storedBytes += quotaBytes\n  return () => {}',
      slotBody: '  room.pendingUploads += 1\n  return () => {}',
      slotName: 'reserveSlotRenamed'
    }))

    // 两条一起报：① 名单里的函数找不到了 ② 改名后的函数不再是白名单成员，
    // 却仍在写配额计数 —— 改名会同时失去「无 await」与「唯一写入点」两层保护，故必须两条都亮。
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/reserveUploadSlot/u)
    expect(problems[0]).toMatch(/找不到/u)
    expect(problems[1]).toMatch(/reserveSlotRenamed/u)
    expect(problems[1]).toMatch(/pendingUploads/u)
  })

  it('白名单外的函数写配额计数', () => {
    const problems = run(skeleton({
      quotaBody: '  room.storedBytes += quotaBytes\n  return () => {}',
      slotBody: '  room.pendingUploads += 1\n  return () => {}',
      extra: '\nfunction sneaky(room, n) {\n  room.storedBytes += n\n}\n'
    }))

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/sneaky/u)
    expect(problems[0]).toMatch(/storedBytes/u)
  })

  it('模块顶层写配额计数', () => {
    const source = skeleton({
      quotaBody: '  room.storedBytes += quotaBytes\n  return () => {}',
      slotBody: '  room.pendingUploads += 1\n  return () => {}'
    }).replace('const rooms = new Map()', 'const rooms = new Map()\ntotalStoredBytes = 1')

    expect(run(source).some((problem) => /模块顶层/u.test(problem))).toBe(true)
  })
})

describe('checkAtomicInvariants —— 不得误报（否则会被人为绕过）', () => {
  /**
   * 「嵌套函数里的 await 不算」是这个检查能不能长期活下去的关键：
   * `reserveStorageQuota` 返回的回滚闭包里完全可以有异步需求，而定义函数并不让出控制权。
   * 一旦这里误报，最省事的处理方式是删掉整条检查 —— 那才是真正的损失。
   */
  it('原子函数内**嵌套函数**里的 await 不算违规', () => {
    const problems = run(skeleton({
      quotaBody: '  room.storedBytes += quotaBytes\n  return () => Promise.resolve().then(async () => { await Promise.resolve() })',
      slotBody: '  room.pendingUploads += 1\n  return () => {}'
    }))

    expect(problems).toEqual([])
  })

  it('非原子函数里的 await 不算违规（检查是选择性的，不是「见到 await 就报」）', () => {
    // 骨架里的 persistUpload 本身就是 async 且带 await
    const problems = run(skeleton({
      quotaBody: '  room.storedBytes += quotaBytes\n  return () => {}',
      slotBody: '  room.pendingUploads += 1\n  return () => {}'
    }))

    expect(problems).toEqual([])
  })

  it('注释/字符串里的 await 不算违规（正则式实现的典型误报）', () => {
    const problems = run(skeleton({
      quotaBody: '  // 这里绝不能写 await\n  const hint = "await"\n  room.storedBytes += quotaBytes\n  return () => {}',
      slotBody: '  room.pendingUploads += 1\n  return () => {}'
    }))

    expect(problems).toEqual([])
  })
})

describe('检查器自身的体检（防止某天变成永远通过）', () => {
  it('真实源码里确实存在 await —— 检查器的沉默因此是有意义的', async () => {
    const source = await readFile(join(process.cwd(), 'server', 'relay-state.js'), 'utf8')

    // 若某天 relay-state.js 里一个 await 都没有（比如被整体重写），
    // 「原子函数无 await」就退化成恒真命题 —— 这条断言会先亮起来提醒复核。
    expect(source).toMatch(/await /u)
    expect(run(source)).toEqual([])
  })

  it('名单与标记常量在测试中可见（改名时测试跟着一起暴露）', () => {
    expect(ATOMIC_INVARIANTS.atomicFunctions).toEqual(['reserveStorageQuota', 'reserveUploadSlot'])
    expect(ATOMIC_INVARIANTS.atomicTag).toBe('@atomic')
    expect(ATOMIC_INVARIANTS.quotaWriterAllowlist).toContain('destroyRoom')
  })
})
