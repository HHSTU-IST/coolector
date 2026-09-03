import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCollectionStore } from './collection'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('checkFileStatus', () => {
  it('按完整可比文件名精确匹配', () => {
    const store = useCollectionStore()
    store.collectionList = [{
      id: '1',
      name: '22301001_张三.md',
      description: '',
      filePattern: '22301001_张三.md',
      status: 'pending'
    }]
    expect(store.checkFileStatus('22301001_张三.md')?.id).toBe('1')
  })

  it('单字名单不会误匹配含该字的文件名', () => {
    const store = useCollectionStore()
    store.collectionList = [{
      id: '1',
      name: '张',
      description: '',
      filePattern: '张',
      status: 'pending'
    }]
    expect(store.checkFileStatus('张三_22301001.md')).toBeNull()
    expect(store.checkFileStatus('张伟.md')).toBeNull()
  })

  it('跨分隔符按学号匹配', () => {
    const store = useCollectionStore()
    store.collectionList = [{
      id: '1',
      name: '22301001_张三',
      description: '',
      filePattern: '22301001_张三',
      status: 'pending'
    }]
    expect(store.checkFileStatus('22301001-张三.docx')?.id).toBe('1')
  })
})
