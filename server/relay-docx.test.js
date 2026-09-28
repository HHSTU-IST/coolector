// @vitest-environment node
/**
 * 服务端 docx 正文提取的测试。
 *
 * 这段逻辑原本只存在于浏览器（`src/utils/docx.ts`），随「docx 走裸 body」一起搬到服务端
 * （`server/relay-docx.js`）。因此这里的用例承接了原前端测试的全部场景，并补上服务端
 * 特有的部分：MIME 判定、解压失败降级、非 Buffer 入参。
 *
 * 夹具在 `scripts/lib/docx-fixture.mjs`（与集成测试、端到端脚本共用同一份）——
 * 那里是**手工拼装的最小 ZIP**，零依赖，且能精确构造出真实包不会有的边界。
 */

import { describe, expect, it } from 'vitest'
import { DOCX_MIME, buildDocumentXml, buildZip } from '../scripts/lib/docx-fixture.mjs'
import {
  extractDocxText,
  extractTextFromDocumentXml,
  isDocxMimeType
} from './relay-docx.js'

describe('extractDocxText', () => {
  it('提取 deflate 压缩的 docx 正文', () => {
    const buffer = buildZip([{ name: 'word/document.xml', content: buildDocumentXml(['第一段内容', '第二段内容']) }])

    expect(extractDocxText(buffer)).toBe('第一段内容\n第二段内容')
  })

  it('支持未压缩（stored）存储的条目', () => {
    const buffer = buildZip([{ name: 'word/document.xml', content: buildDocumentXml(['Stored 模式']), compress: false }])

    expect(extractDocxText(buffer)).toBe('Stored 模式')
  })

  it('在含多个条目的包内定位到正文（central directory 遍历）', () => {
    const buffer = buildZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'word/document.xml', content: buildDocumentXml(['唯一正文']) },
      { name: 'word/styles.xml', content: '<Styles/>' }
    ])

    expect(extractDocxText(buffer)).toBe('唯一正文')
  })

  it('缺少 word/document.xml 时返回 null', () => {
    expect(extractDocxText(buildZip([{ name: 'readme.txt', content: 'no doc here', compress: false }]))).toBeNull()
  })

  it('非 zip 的垃圾数据降级返回 null（不抛异常）', () => {
    expect(extractDocxText(Buffer.alloc(0))).toBeNull()
    expect(extractDocxText(Buffer.from([1, 2, 3, 4, 5]))).toBeNull()
    // 像 docx 开头但没有完整 EOCD 的截断包
    expect(extractDocxText(Buffer.from('PK\u0003\u0004word/', 'latin1'))).toBeNull()
  })

  /**
   * 「标称 deflate、实则非法流」必须降级而不是抛异常 —— 否则一份构造过的 docx 能让上传返回 500。
   *
   * 构造方式是**确定的**（不依赖某个 zlib 版本是否容忍孤立位翻转）：
   * 用一个字节的正文（`A`）并声明 method 8 —— 单独一个字节既凑不出合法 deflate 块，
   * 也必然以「数据不足」收场。字节翻转那种写法会随 zlib 实现漂移，不用。
   */
  it('标称 deflate 但数据非法时降级返回 null（不抛异常）', () => {
    const archive = buildZip([{ name: 'word/document.xml', content: 'A', compress: false }])
    const centralOffset = 30 + 'word/document.xml'.length + 1

    archive.writeUInt16LE(8, 8) // local file header 的 compression method
    archive.writeUInt16LE(8, centralOffset + 10) // central directory 条目的 compression method

    expect(extractDocxText(archive)).toBeNull()
  })

  it('非 Buffer 入参返回 null（fail-closed，不静默产出空正文）', () => {
    expect(extractDocxText(undefined)).toBeNull()
    expect(extractDocxText('<w:p><w:t>x</w:t></w:p>')).toBeNull()
  })

  it('正文为空白段落时返回 null，交由调用方按二进制处理', () => {
    const buffer = buildZip([
      { name: 'word/document.xml', content: '<w:document><w:body><w:p/></w:body></w:document>' }
    ])

    expect(extractDocxText(buffer)).toBeNull()
  })
})

describe('extractTextFromDocumentXml', () => {
  it('解码 XML 实体并还原 tab、br', () => {
    const xml = '<w:p><w:t>AT&amp;T &lt;ok&gt;</w:t><w:tab/><w:t>后文</w:t><w:br/><w:t>换行</w:t></w:p>'

    expect(extractTextFromDocumentXml(xml)).toBe('AT&T <ok>\t后文\n换行')
  })

  it('&amp;lt; 只还原一层（实体替换顺序）', () => {
    expect(extractTextFromDocumentXml('<w:p><w:t>&amp;lt;</w:t></w:p>')).toBe('&lt;')
  })

  it('忽略空白段落', () => {
    expect(extractTextFromDocumentXml('<w:p></w:p><w:p><w:t>有字</w:t></w:p><w:p>   </w:p>')).toBe('有字')
  })

  it('空正文返回空串', () => {
    expect(extractTextFromDocumentXml('<w:document></w:document>')).toBe('')
  })

  /**
   * 代理项区间（U+D800–U+DFFF）的数值实体**不抛错**，却会产出孤立代理项、
   * 让整段正文变成 ill-formed UTF-16 —— 比 `&#0;` 那类直接抛错的更隐蔽，必须显式丢弃。
   */
  it('非法 XML 数值实体被丢弃而不是产出孤立代理项', () => {
    expect(extractTextFromDocumentXml('<w:p><w:t>a&#xD800;b</w:t></w:p>')).toBe('ab')
    expect(extractTextFromDocumentXml('<w:p><w:t>a&#0;b</w:t></w:p>')).toBe('ab')
  })
})

describe('isDocxMimeType', () => {
  it('规范 MIME 命中', () => {
    expect(isDocxMimeType(DOCX_MIME, 'x')).toBe(true)
  })

  /**
   * 浏览器给出的 docx MIME 并不可靠（有的平台给 `application/octet-stream`，有的给空串），
   * 因此扩展名必须是独立的一条判据 —— 只认 MIME 会让这些浏览器上的 docx 变成「无正文」。
   */
  it('MIME 缺失或不可靠时靠扩展名兜底', () => {
    expect(isDocxMimeType('application/octet-stream', '张三-20230101.docx')).toBe(true)
    expect(isDocxMimeType('', '张三-20230101.DOCX')).toBe(true)
  })

  it('不误伤名字里含 docx 的其他文件', () => {
    expect(isDocxMimeType('text/plain', 'docx.md')).toBe(false)
    expect(isDocxMimeType('application/pdf', '讲义.pdf')).toBe(false)
  })
})
