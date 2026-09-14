// @vitest-environment node
/**
 * 房间状态与资源记账的**单元**测试。
 *
 * 这些断言过去只能靠「起进程 + 打真实 HTTP」间接覆盖，甚至要靠一个生产代码里的
 * 故障注入开关（`RELAY_TEST_INJECT_RM_FAILURE`）才能摸到「删除失败」这条分支。
 * 把状态拆到 `relay-state.js` 之后，可以直接 import 并注入替身，注入开关随之删除。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let state
let uploadDir

const failingRemove = () => Promise.reject(new Error('injected remove failure'))

beforeAll(async () => {
  uploadDir = await mkdtemp(join(tmpdir(), 'coolector-state-'))
  // relay-config 在**模块加载时**读取环境变量，因此必须先设好再动态 import
  process.env.UPLOAD_DIR = uploadDir
  process.env.RELAY_TOKEN = 'unit-test-token'
  state = await import('./relay-state.js')
})

afterAll(async () => {
  await rm(uploadDir, { recursive: true, force: true })
})

describe('reserveStorageQuota', () => {
  it('超出单房间配额抛 507，且不改动计数', () => {
    const { room } = state.createRoom('unit-quota-room')
    expect(() => state.reserveStorageQuota(room, 4 * 1024 * 1024 * 1024)).toThrowError(/quota exceeded/u)
    expect(room.storedBytes).toBe(0)
  })

  it('预占后立即计入，release 后复原', () => {
    const { room } = state.createRoom('unit-release-room')
    const release = state.reserveStorageQuota(room, 1000)

    expect(room.storedBytes).toBe(1000)
    release()
    expect(room.storedBytes).toBe(0)
    expect(state.totalStoredBytes).toBe(0)
  })

  it('release 幂等（重复调用不会把计数减成负数）', () => {
    const { room } = state.createRoom('unit-idempotent-room')
    const release = state.reserveStorageQuota(room, 500)

    release()
    release()
    expect(room.storedBytes).toBe(0)
    expect(state.totalStoredBytes).toBe(0)
  })

  it('房间已销毁时 release 短路，不再扣减全局计数', () => {
    const { room } = state.createRoom('unit-destroyed-room')
    const release = state.reserveStorageQuota(room, 1000)
    const globalBefore = state.totalStoredBytes

    // 模拟 destroyRoom 已经把这个房间的占用整体回收过
    room.destroyed = true
    release()

    expect(state.totalStoredBytes).toBe(globalBefore)
  })
})

describe('reserveUploadSlot', () => {
  it('达到条数上限抛 429，释放后可继续占用', () => {
    const { room } = state.createRoom('unit-slot-room')
    const fills = []

    // 先占满到上限（不真的塞文件，只占槽位）
    for (let i = 0; ; i += 1) {
      try {
        fills.push(state.reserveUploadSlot(room))
      } catch (error) {
        expect(error.statusCode).toBe(429)
        expect(error.message).toMatch(/upload count limit/u)
        break
      }
      if (i > 5000) throw new Error('未能在合理次数内触顶')
    }

    // 释放一个槽位后应当可以再占
    fills.pop()()
    expect(() => state.reserveUploadSlot(room)).not.toThrow()
  })
})

describe('destroyRoom 的错误隔离', () => {
  it('目录删除失败时返回 false 且不抛异常', async () => {
    const { room } = state.createRoom('unit-rmfail-room')

    await expect(state.destroyRoom(room, { removeDir: failingRemove })).resolves.toBe(false)
    expect(state.rooms.has(room.id)).toBe(false)
  })

  it('目录删除成功时返回 true 并回收配额', async () => {
    const { room } = state.createRoom('unit-rmok-room')
    state.reserveStorageQuota(room, 2000)

    await expect(state.destroyRoom(room, { removeDir: () => Promise.resolve() })).resolves.toBe(true)
    expect(room.storedBytes).toBe(0)
    expect(state.rooms.has(room.id)).toBe(false)
  })

  it('清理循环在删除失败时仍正常结束（不产生未处理拒绝）', async () => {
    const { room } = state.createRoom('unit-cleanup-room')
    // 让它立刻命中「绝对存活上限」
    room.createdAt = new Date(0).toISOString()
    room.lastActivity = 0

    await expect(state.cleanupRooms({ removeDir: failingRemove })).resolves.toBeUndefined()
    expect(state.rooms.has(room.id)).toBe(false)
  })
})

describe('uploadSummary', () => {
  // 夹具必须在 beforeAll 之后构造：`uploadDir` 由 beforeAll 赋值，模块求值期还是 undefined
  const makeUpload = () => ({
    id: 'u1',
    roomId: 'r1',
    name: 'a.md',
    mimeType: 'text/markdown',
    size: 10,
    uploadedAt: new Date(0).toISOString(),
    lastModified: new Date(0).toISOString(),
    previewText: null,
    text: null,
    storagePath: join(uploadDir, 'secret', 'u1-a.md'),
    storageFileName: 'u1-a.md'
  })

  it('不暴露服务端存储路径与文件名', () => {
    const summary = state.uploadSummary(makeUpload())

    expect(summary).not.toHaveProperty('storagePath')
    expect(summary).not.toHaveProperty('storageFileName')
    expect(summary.serverStored).toBe(true)
  })

  it('默认输出相对路径，不含任何主机信息（F-001 回归）', () => {
    const summary = state.uploadSummary(makeUpload())

    expect(summary.detailsUrl).toBe('/api/rooms/r1/uploads/u1')
    expect(summary.downloadUrl).toBe('/api/rooms/r1/uploads/u1?download=1')
  })

  /**
   * 这条断言守护的是**结构**：`uploadSummary` 一旦重新接受 `req`，就说明有人又把请求头
   * 接进了 URL 拼接 —— 那正是 F-001 的成因。
   *
   * 只断言 arity 是不够的：`(upload, req = null)` 这类带默认值的参数能穿过 `toHaveLength(1)`。
   * 因此这里直接对**返回值**断言「不含任何主机信息」，两条一起才守得住。
   */
  it('不接受 req，且返回值里不含任何主机信息（结构上无法采信请求头）', () => {
    expect(state.uploadSummary).toHaveLength(1)

    const summary = state.uploadSummary(makeUpload())
    expect(JSON.stringify(summary)).not.toMatch(/https?:\/\//u)
    expect(summary.detailsUrl).toMatch(/^\/api\/rooms\//u)
  })

  it('includeContent:false 时不带正文，但 URL 形态一致', () => {
    const summary = state.uploadSummary(makeUpload(), { includeContent: false })

    expect(summary.contentIncluded).toBe(false)
    expect(summary.contentText).toBeNull()
    expect(summary.contentBase64).toBeNull()
    expect(summary.detailsUrl).toBe('/api/rooms/r1/uploads/u1')
  })
})
