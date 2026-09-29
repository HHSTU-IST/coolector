/**
 * `relay-sse` 的回归网。
 *
 * 重点守两条**在本地回环下测不出来**的语义：
 *   1. 跨 chunk 分帧 —— 本机回环上通常一次 read 就拿到整帧，残片处理错了也不会红
 *   2. 非事件流响应要被识别出来 —— 那是 ngrok 浏览器警告页在客户端眼里的样子，
 *      若按「HTTP 200 就算成功」处理，连接会静默挂死，用户只看到界面卡在「连接中」
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { openRelayEventStream, parseSseFrame, splitSseFrames } from './relay-sse'
import type { RelaySseEvent } from './relay-sse'

const EVENT_STREAM_MIME = 'text/event-stream; charset=utf-8'

/** 假的事件流响应：只实现实现体真正用到的成员，避免依赖完整 Response 实现 */
const streamResponse = (chunks: string[], contentType = EVENT_STREAM_MIME) => {
  const encoder = new TextEncoder()
  const queue = chunks.map((chunk) => encoder.encode(chunk))
  let index = 0

  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    body: {
      getReader: () => ({
        read: async () => (index < queue.length
          ? { done: false, value: queue[index++] }
          : { done: true, value: undefined }),
        releaseLock: () => { /* 假 reader 无锁可释放 */ }
      })
    }
  } as unknown as Response
}

/** 永不结束的响应：模拟长连接，用于验证 close() 的行为 */
const hangingResponse = () => ({
  ok: true,
  status: 200,
  headers: { get: () => EVENT_STREAM_MIME },
  body: {
    getReader: () => ({
      read: () => new Promise<never>(() => { /* 永不 settle */ }),
      releaseLock: () => { /* 空实现 */ }
    })
  }
}) as unknown as Response

interface Collected {
  events: RelaySseEvent[]
  errors: Error[]
  opened: number
  requestedHeaders: Record<string, string>
}

/** 跑完一次完整流（流自然结束即收口），返回三个回调收到的全部内容 */
async function collect(chunks: string[], contentType?: string): Promise<Collected> {
  const collected: Collected = { events: [], errors: [], opened: 0, requestedHeaders: {} }

  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    collected.requestedHeaders = init.headers as Record<string, string>
    return streamResponse(chunks, contentType)
  }))

  openRelayEventStream('https://relay.test/api/rooms/r1/events?ticket=t1', { 'ngrok-skip-browser-warning': '1' }, {
    onOpen: () => { collected.opened += 1 },
    onEvent: (event) => { collected.events.push(event) },
    onError: (error) => { collected.errors.push(error) }
  })

  // 流会在最后一个 chunk 之后自然结束并触发 onError（「事件流已结束」）
  await vi.waitFor(() => {
    if (collected.errors.length === 0) throw new Error('流尚未收口')
  })

  return collected
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('splitSseFrames', () => {
  it('按空行切出多帧，且不保留尾部分隔符', () => {
    const { frames, rest } = splitSseFrames('data: a\n\ndata: b\n\n')
    expect(frames).toEqual(['data: a', 'data: b'])
    expect(rest).toBe('')
  })

  it('尾部不完整片段留在 rest 里，不当作帧', () => {
    const { frames, rest } = splitSseFrames('data: a\n\ndata: par')
    expect(frames).toEqual(['data: a'])
    expect(rest).toBe('data: par')
  })

  it('CRLF 行尾同样能分帧', () => {
    const { frames, rest } = splitSseFrames('event: x\r\ndata: 1\r\n\r\n')
    expect(frames).toEqual(['event: x\r\ndata: 1'])
    expect(rest).toBe('')
  })

  it('空缓冲不产出任何帧', () => {
    expect(splitSseFrames('')).toEqual({ frames: [], rest: '' })
  })
})

describe('parseSseFrame', () => {
  it('解析 event 与 data', () => {
    expect(parseSseFrame('event: upload.created\ndata: {"a":1}'))
      .toEqual({ type: 'upload.created', data: '{"a":1}' })
  })

  it('缺省 event 时类型为 message', () => {
    expect(parseSseFrame('data: hello')).toEqual({ type: 'message', data: 'hello' })
  })

  it('多行 data 以换行连接', () => {
    expect(parseSseFrame('data: 第一行\ndata: 第二行'))
      .toEqual({ type: 'message', data: '第一行\n第二行' })
  })

  it('冒号后的单个空格属于分隔符，不进值里；第二个空格保留', () => {
    expect(parseSseFrame('data:  两个空格')).toEqual({ type: 'message', data: ' 两个空格' })
  })

  it('注释帧（心跳）返回 null，不会变成空事件', () => {
    expect(parseSseFrame(': heartbeat')).toBeNull()
  })

  it('只有 event 没有 data 的帧返回 null', () => {
    expect(parseSseFrame('event: orphan')).toBeNull()
  })
})

describe('openRelayEventStream', () => {
  it('把完整帧按顺序派发，并在流结束时收口', async () => {
    const { events, errors, opened } = await collect([
      'event: receiver.ready\ndata: {"n":1}\n\n',
      'event: upload.created\ndata: {"n":2}\n\n'
    ])

    expect(opened).toBe(1)
    expect(events).toEqual([
      { type: 'receiver.ready', data: '{"n":1}' },
      { type: 'upload.created', data: '{"n":2}' }
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('事件流已结束')
  })

  it('一帧横跨两个 chunk 时不被丢弃（本机回环下测不出的那类缺陷）', async () => {
    const { events } = await collect([
      'event: upload.created\ndata: {"na',
      'me":"张三.md"}\n\n'
    ])

    expect(events).toEqual([{ type: 'upload.created', data: '{"name":"张三.md"}' }])
  })

  it('心跳注释被忽略，不产生事件', async () => {
    const { events } = await collect([': heartbeat\n\n', 'data: real\n\n'])

    expect(events).toEqual([{ type: 'message', data: 'real' }])
  })

  it('请求头带上调用方给的头与 Accept: text/event-stream', async () => {
    const { requestedHeaders } = await collect(['data: x\n\n'])

    expect(requestedHeaders.Accept).toBe('text/event-stream')
    expect(requestedHeaders['ngrok-skip-browser-warning']).toBe('1')
  })

  it('响应不是事件流时报出可定位的错误（ngrok 插页的样子）', async () => {
    const { errors, events, opened } = await collect(
      ['<!DOCTYPE html><html>ngrok warning page</html>'],
      'text/plain'
    )

    expect(opened).toBe(0)
    expect(events).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('不是事件流')
    expect(errors[0]?.message).toContain('ngrok-skip-browser-warning')
  })

  it('非 2xx 响应报出状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as Response))

    const errors: Error[] = []
    openRelayEventStream('https://relay.test/events', {}, {
      onEvent: () => { /* 不会触发 */ },
      onError: (error) => { errors.push(error) }
    })

    await vi.waitFor(() => {
      if (errors.length === 0) throw new Error('尚未报错')
    })
    expect(errors[0]?.message).toContain('HTTP 404')
  })

  it('close() 之后不再触发 onError，且 closed 为真', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => hangingResponse()))

    const controller: { errors: Error[] } = { errors: [] }
    const connection = openRelayEventStream('https://relay.test/events', {}, {
      onEvent: () => { /* 不会触发 */ },
      onError: (error) => { controller.errors.push(error) }
    })

    // 让 run() 走到挂起的 read()
    await vi.waitFor(() => {
      if (!vi.mocked(fetch).mock.calls.length) throw new Error('尚未发起请求')
    })

    connection.close()
    expect(connection.closed).toBe(true)

    // 再等两轮微任务，确认没有迟到的 onError
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controller.errors).toEqual([])
  })
})
