import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { MAX_FILES, MAX_FILE_SIZE, MAX_TOTAL_SIZE, useFileStore } from './file'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('validateFileName', () => {
  it('拦截灾难性回溯范式', () => {
    const store = useFileStore()
    store.setFilenamePattern('^(a+)+$')
    const result = store.validateFileName('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!')
    expect(result.isValid).toBe(false)
    expect(result.message).toContain('回溯')
  })

  it('拦截嵌套可选量词范式', () => {
    const store = useFileStore()
    const dangerous = ['(a?)*', '(a?)+', '(\\w+\\s?)*']
    for (const pattern of dangerous) {
      store.setFilenamePattern(pattern)
      const result = store.validateFileName('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!')
      expect(result.isValid, `应拦截 ${pattern}`).toBe(false)
      expect(result.message).toContain('回溯')
    }
  })

  it('拦截超长范式', () => {
    const store = useFileStore()
    store.setFilenamePattern('a'.repeat(300))
    const result = store.validateFileName('anything')
    expect(result.isValid).toBe(false)
  })

  it('接受安全范式', () => {
    const store = useFileStore()
    store.setFilenamePattern('^.+\\.(md|ipynb|docx)$')
    expect(store.validateFileName('note.md').isValid).toBe(true)
  })
})

describe('addFile', () => {
  it('拒绝超过体积上限的文件', async () => {
    const store = useFileStore()
    const big = new File([new Uint8Array(MAX_FILE_SIZE + 1)], 'big.md', { type: 'text/markdown' })
    await expect(store.addFile(big)).rejects.toThrow()
  })

  it('达到数量上限后拒绝新增', async () => {
    const store = useFileStore()
    for (let i = 0; i < MAX_FILES; i++) {
      const file = new File(['x'], `f${i}.md`, { type: 'text/markdown' })
      await store.addFile(file)
    }
    expect(store.files.length).toBe(MAX_FILES)
    const extra = new File(['x'], 'extra.md', { type: 'text/markdown' })
    await expect(store.addFile(extra)).rejects.toThrow()
  })
})

/**
 * 假 File：只提供 `addFile` 实际读取的属性。
 *
 * 刻意不用 `new File([...])` —— 总量用例需要 10MB 乃至 128MB 量级的 `size`，
 * 真实构造会真的分配那么多内存（还全是零字节数组），测试本身就会把进程撑爆。
 * 这里 `arrayBuffer()` 返回空 buffer，`size` 仅作为计数依据，语义上等价于「内容已在别处」。
 */
const fakeFile = (name: string, size: number, arrayBuffer?: () => Promise<ArrayBuffer>): File =>
  ({
    name,
    size,
    type: 'text/markdown',
    lastModified: Date.now(),
    arrayBuffer: arrayBuffer ?? (() => Promise.resolve(new ArrayBuffer(0)))
  } as unknown as File)

describe('addFile 体积总量上限', () => {
  it('累加体积达到总量上限后拒绝新增', async () => {
    const store = useFileStore()
    const capacity = Math.floor(MAX_TOTAL_SIZE / MAX_FILE_SIZE)

    for (let i = 0; i < capacity; i++) {
      await store.addFile(fakeFile(`f${i}.md`, MAX_FILE_SIZE))
    }
    expect(store.usedBytes).toBe(capacity * MAX_FILE_SIZE)

    // 再加一个 10MB 就会越过上限；条数（200）远未触顶，拦下它的必须是总量闸
    await expect(store.addFile(fakeFile('overflow.md', MAX_FILE_SIZE))).rejects.toThrow(/上限/)
    expect(store.files.length).toBe(capacity)
  })

  it('删除文件后释放已占体积', async () => {
    const store = useFileStore()
    const file = await store.addFile(fakeFile('a.md', 4096))
    expect(store.usedBytes).toBe(4096)

    store.removeFileById(file.id)
    expect(store.usedBytes).toBe(0)
  })

  it('入列失败时回滚已预占的体积', async () => {
    const store = useFileStore()
    const broken = fakeFile('broken.md', 4096, () => Promise.reject(new Error('读取失败')))

    await expect(store.addFile(broken)).rejects.toThrow('读取失败')
    expect(store.usedBytes).toBe(0)
    expect(store.files).toHaveLength(0)
  })

  it('并发入列不会同时穿过总量上限（预占必须在 await 之前）', async () => {
    const store = useFileStore()
    const capacity = Math.floor(MAX_TOTAL_SIZE / MAX_FILE_SIZE)
    for (let i = 0; i < capacity; i++) {
      await store.addFile(fakeFile(`bulk${i}.md`, MAX_FILE_SIZE))
    }

    // 余量不足 10MB：单独放得下一个 half，两个一起就放不下。
    // 若检查落在 `await` 之后，两次调用都会读到同一个旧计数而双双通过（即击穿）。
    const half = MAX_FILE_SIZE / 2
    const settled = await Promise.allSettled([
      store.addFile(fakeFile('c1.md', half)),
      store.addFile(fakeFile('c2.md', half))
    ])

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(store.usedBytes).toBeLessThanOrEqual(MAX_TOTAL_SIZE)
  })
})

describe('中继文件的体积记账', () => {
  const relayFile = (uploadId: string, size: number) => ({
    name: 'relay.md',
    content: 'x',
    size,
    type: 'text/markdown',
    lastModified: new Date(),
    roomId: 'room-1',
    uploadId
  })

  it('接收的文件计入总量', () => {
    const store = useFileStore()
    store.upsertRelayFile(relayFile('u1', 2048))
    expect(store.usedBytes).toBe(2048)
  })

  it('同一 uploadId 重复 upsert 不重复累加', () => {
    const store = useFileStore()
    store.upsertRelayFile(relayFile('u1', 2048))
    store.upsertRelayFile(relayFile('u1', 2048))
    expect(store.usedBytes).toBe(2048)
  })
})
