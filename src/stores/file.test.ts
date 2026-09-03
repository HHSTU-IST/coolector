import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { MAX_FILES, MAX_FILE_SIZE, useFileStore } from './file'

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
