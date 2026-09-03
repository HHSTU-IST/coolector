import { describe, expect, it } from 'vitest'
import {
  extractStudentId,
  getFileBaseName,
  getFileExtension,
  normalizeComparableName
} from './filename'

describe('getFileExtension', () => {
  it('返回小写扩展名', () => {
    expect(getFileExtension('a.MD')).toBe('md')
  })
  it('无扩展名时返回空串', () => {
    expect(getFileExtension('README')).toBe('')
  })
})

describe('getFileBaseName', () => {
  it('去掉扩展名', () => {
    expect(getFileBaseName('22301001_张三.md')).toBe('22301001_张三')
  })
})

describe('extractStudentId', () => {
  it('提取 6-12 位学号', () => {
    expect(extractStudentId('22301001_张三.md')).toBe('22301001')
  })
  it('无学号时返回 null', () => {
    expect(extractStudentId('张三的作业')).toBeNull()
  })
})

describe('normalizeComparableName', () => {
  it('归一化分隔符与大小写', () => {
    expect(normalizeComparableName('22301001 张三.MD')).toBe('22301001 张三')
    expect(normalizeComparableName('22301001-张三')).toBe('22301001 张三')
  })
})
