// @vitest-environment node
/**
 * 房间状态与资源记账的**单元**测试。
 *
 * 这些断言过去只能靠「起进程 + 打真实 HTTP」间接覆盖，甚至要靠一个生产代码里的
 * 故障注入开关（`RELAY_TEST_INJECT_RM_FAILURE`）才能摸到「删除失败」这条分支。
 * 把状态拆到 `relay-state.js` 之后，可以直接 import 并注入替身，注入开关随之删除。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 模块命名空间。`relay-config` 在**模块加载时**读环境变量，故只能动态 import（见 `beforeAll`），
 * 类型因此无法由初始化式推断 —— 在这里显式声明，否则全部约 47 处 `state.*` 都是隐式 `any`。
 *
 * @type {typeof import('./relay-state.js')}
 */
let state
/** @type {string} */
let uploadDir

const failingRemove = () => Promise.reject(new Error('injected remove failure'))

/**
 * `Upload` 替身工厂：只传关心的字段，其余给中性默认值。
 *
 * 为什么要「完整」而不是只写用到的几个字段：`Upload` 是生产侧的真实契约，少写字段会让夹具在
 * **契约新增必填项时静默失真**（测试照旧通过，但它已经不是一份合法输入）。集中在一处构造，
 * 契约一变就只有这一处报错。
 *
 * 它在**调用时**才读 `uploadDir`（该变量由 `beforeAll` 赋值，模块求值期仍是 undefined），
 * 因此放在模块顶层是安全的。
 *
 * @param {Partial<import('./relay-state.js').Upload>} [overrides]
 * @returns {import('./relay-state.js').Upload}
 */
const makeUpload = (overrides = {}) => ({
  id: 'u1',
  roomId: 'r1',
  name: 'a.md',
  mimeType: 'text/markdown',
  size: 10,
  uploadedAt: new Date(0).toISOString(),
  lastModified: new Date(0).toISOString(),
  quotaBytes: 0,
  text: null,
  textTruncated: false,
  previewText: null,
  storagePath: join(uploadDir, 'secret', 'u1-a.md'),
  storageFileName: 'u1-a.md',
  ...overrides
})

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
        // 生产代码抛的是带 statusCode 的 Error；`catch` 绑定在 strict 下为 unknown，显式收窄
        const failure = /** @type {Error & { statusCode: number }} */ (error)
        expect(failure.statusCode).toBe(429)
        expect(failure.message).toMatch(/upload count limit/u)
        break
      }
      if (i > 5000) throw new Error('未能在合理次数内触顶')
    }

    // 释放一个槽位后应当可以再占
    const release = fills.pop()
    if (!release) throw new Error('未取到待释放的槽位')
    release()
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

describe('persistUpload', () => {
  it('接收 Buffer 并逐字节落盘', async () => {
    const { room } = state.createRoom('unit-persist-room')
    const upload = makeUpload({ id: 'persist-1', roomId: room.id, name: 'raw.bin' })
    const bytes = Buffer.from([0x00, 0x80, 0xff, 0x0a])

    await state.persistUpload(upload, bytes)

    // `storagePath` / `storageFileName` 是 `persistUpload` 的**产物**（它写入而非读取），
    // 而 `Upload` 上它们是可选字段 —— 这里收窄为必填，好让下面的读盘断言拿到确切的路径类型。
    const persisted = /** @type {{ storagePath: string, storageFileName: string }} */ (upload)
    expect(Buffer.from(await readFile(persisted.storagePath)).equals(bytes)).toBe(true)
    expect(persisted.storageFileName).toBe('persist-1-raw.bin')
  })

  it('传 base64 字符串 fail-fast，不静默写出一份坏文件', async () => {
    // 旧签名 `persistUpload(upload, contentBase64)` 收字符串。改成收 Buffer 之后，
    // 若还有调用方照旧传 base64，最坏结果是一份「看起来正常」的坏文件 —— 必须当场抛。
    const { room } = state.createRoom('unit-persist-guard-room')

    await expect(
      state.persistUpload(
        makeUpload({ id: 'persist-2', roomId: room.id, name: 'x.txt' }),
        // 同样**故意违约**：`bytes` 声明为 Buffer，而这里要验的正是「收到 base64 字符串必须 fail-fast」
        /** @type {any} */ ('aGk=')
      )
    ).rejects.toThrowError(TypeError)
  })
})

describe('serializeRoom / persistRoomMetadata（房间元数据持久化）', () => {
  /** @param {string} roomId */
  const makeRoomWithUpload = (roomId) => {
    const { room } = state.createRoom(roomId)
    room.uploads.set('meta-1', {
      id: 'meta-1',
      roomId: room.id,
      name: '作业.md',
      mimeType: 'text/markdown',
      lastModified: new Date(0).toISOString(),
      uploadedAt: new Date(0).toISOString(),
      size: 42,
      quotaBytes: 99,
      text: '完整正文（不应出现元数据里）',
      textTruncated: true,
      previewText: '完整正文',
      storagePath: join(uploadDir, room.id, 'meta-1-作业.md'),
      storageFileName: 'meta-1-作业.md'
    })
    return room
  }

  it('元数据不含正文，但保留无法事后推导的截断信息与配额', () => {
    const parsed = JSON.parse(state.serializeRoom(makeRoomWithUpload('unit-meta-serialize')))

    expect(parsed.generator).toBe('coolector-relay')
    expect(parsed.uploads).toHaveLength(1)
    // 正文是字节的纯函数：写进元数据会让它随文本类作业线性膨胀
    expect(parsed.uploads[0]).not.toHaveProperty('text')
    expect(JSON.stringify(parsed)).not.toContain('完整正文（不应出现元数据里）')
    // 这两项事后推导不出来（是上传那一刻的截断产物），必须持久化
    expect(parsed.uploads[0].textTruncated).toBe(true)
    expect(parsed.uploads[0].previewText).toBe('完整正文')
    // 配额是复原依据：缺了它重启后配额会凭空变化
    expect(parsed.uploads[0].quotaBytes).toBe(99)
  })

  it('persistRoomMetadata 落盘为可读回的合法 JSON', async () => {
    const room = makeRoomWithUpload('unit-meta-persist')

    await state.persistRoomMetadata(room)

    /** @type {{ uploads: { id: string }[] }} */
    const onDisk = JSON.parse(await readFile(join(uploadDir, room.id, state.ROOM_METADATA_FILENAME), 'utf8'))
    expect(onDisk.roomId).toBe(room.id)
    expect(onDisk.uploads[0].name).toBe('作业.md')
  })

  it('并发触发的多次写入被串行化（任何时刻只有一个写入在跑）', async () => {
    // 每次写入都是「全量快照」，且共用同一个临时文件。若不排队，多个写入会同时写 tmp
    // 并各自 rename，最终留下的是哪个快照就成了竞态 —— 可能少几条作业。
    //
    // 这里注入一个「会记录并发度」的替身来直接观测串行性：不注入的话，五次写入的
    // serializeRoom 都发生在各自 await 之后，读到的都是「五次修改之后」的全量状态，
    // 于是用例会因错误的理由通过（实测过）。
    const { room } = state.createRoom('unit-meta-chain')

    let active = 0
    let maxActive = 0
    const write = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
      active -= 1
    }

    await Promise.all(
      ['c1', 'c2', 'c3', 'c4', 'c5'].map(() => state.persistRoomMetadata(room, { write }))
    )

    expect(maxActive).toBe(1)
  })

  it('落盘内容始终是当前完整快照', async () => {
    const room = makeRoomWithUpload('unit-meta-snapshot')
    // `Map.get` 的类型含 undefined；meta-1 是夹具刚写入的，此处断言其存在（取不到即夹具坏了）
    const base = /** @type {import('./relay-state.js').Upload} */ (room.uploads.get('meta-1'))
    room.uploads.set('meta-2', {
      ...base,
      id: 'meta-2',
      name: 'second.md',
      storageFileName: 'meta-2-second.md'
    })

    await state.persistRoomMetadata(room)

    /** @type {{ uploads: { id: string }[] }} */
    const onDisk = JSON.parse(await readFile(join(uploadDir, room.id, state.ROOM_METADATA_FILENAME), 'utf8'))
    expect(onDisk.uploads.map((item) => item.id).sort()).toEqual(['meta-1', 'meta-2'])
  })
})
