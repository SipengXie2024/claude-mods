// magpie-tasks' Telegram index as tg-router reads it (magpie-tasks plan section 10.1), on an index
// magpie-tasks' own Registry wrote (tests/data/magpie-index.json).
import { describe, expect, test } from 'claude-code/testing'
import { channelBody, indexPath, messageKind, ownerOf, parseIndex, RATING_TEXT, terminalHintLine, workerHintLine, workerOfAgent } from '../src/magpie'
import { channelReply1110 } from './data/channel-reply-1110'
import { magpieIndexText } from './data/magpie-index'

const PATH = '/home/ubuntu/.config/magpie-tasks/index/telegram.json'
const index = parseIndex(magpieIndexText, PATH)
const CHAT = '7051661301'

describe('the index file', () => {
  test('its path follows MAGPIE_TASKS_STATE_DIR, else ~/.config/magpie-tasks', () => {
    expect(indexPath('/home/ubuntu', undefined)).toBe(PATH)
    expect(indexPath('/home/ubuntu/', '')).toBe(PATH)
    expect(indexPath('/home/ubuntu', '/tmp/mt-e2e-AB12/state/')).toBe('/tmp/mt-e2e-AB12/state/index/telegram.json')
  })

  test('text that is not the index is refused', () => {
    expect(() => parseIndex('{"schema":2,"messages":{},"workers":{},"agents":{}}', PATH)).toThrow('is not a magpie-tasks Telegram index')
    expect(() => parseIndex('{"schema":1,"messages":[],"workers":{},"agents":{}}', PATH)).toThrow('is not a magpie-tasks Telegram index')
    expect(() => parseIndex('null', PATH)).toThrow('is not a magpie-tasks Telegram index')
    expect(() => parseIndex('{"schema":1', PATH)).toThrow()
  })
})

describe('queries', () => {
  test('a worker\'s current executor, after magpie-tasks replaced the first one', () => {
    expect(ownerOf(index, 'tg-7051661301-953')).toEqual({ taskId: 'd-20261101-a1b2c3', ownerAgentId: 'a4923915573cfbe20', long: false })
    expect(ownerOf(index, 'tg-7051661301-878')).toBe(undefined)
  })

  test('both the first and the replacing executor answer for the worker', () => {
    expect(workerOfAgent(index, 'a83b0057bf058d018')).toBe('tg-7051661301-953')
    expect(workerOfAgent(index, 'a4923915573cfbe20')).toBe('tg-7051661301-953')
    expect(workerOfAgent(index, 'a0000000000000000')).toBe(undefined)
  })

  test('a promoted worker is long, and its messages went with it', () => {
    expect(ownerOf(index, 'tg-7051661301-1043')?.long).toBe(true)
    expect(messageKind(index, CHAT, 1046)).toBe('long')
  })

  test('each kind of message magpie-tasks sent; messages of no entry are tg-router\'s', () => {
    expect(messageKind(index, CHAT, 958)).toBe('magpie')
    expect(messageKind(index, CHAT, 970)).toBe('decision')
    expect(messageKind(index, CHAT, 990)).toBe('rating')
    expect(messageKind(index, CHAT, 1109)).toBe('long')
    expect(messageKind(index, CHAT, 953)).toBe(undefined)
    expect(messageKind(index, '1', 958)).toBe(undefined)
  })
})

describe('scores and the hand-on context', () => {
  test('a real reply\'s text is what stands inside its channel tag, and it is no score', () => {
    expect(channelBody(channelReply1110)).toBe('去吧')
    expect(RATING_TEXT.test(channelBody(channelReply1110))).toBe(false)
  })

  test('评分 N in a message\'s text, in the forms magpie-tasks reads', () => {
    // the real reply's block with its text replaced, so channelBody reads the tag as Telegram sent it
    const block = (body: string) => channelReply1110.replace('\n去吧\n', `\n${body}\n`)
    for (const body of ['评分 4', '评分4', ' 评分：５ ', '评分 3 分']) expect(RATING_TEXT.test(channelBody(block(body)))).toBe(true)
    for (const body of ['评分 6', '给它评分 4', '4', '评分 4，不过测试还要再跑']) expect(RATING_TEXT.test(channelBody(block(body)))).toBe(false)
  })

  test('the worker line magpie-tasks reads beside a reply it is handed', () => {
    expect(workerHintLine('tg-7051661301-953')).toBe('[tg-router worker=tg-7051661301-953]')
  })

  test('the terminal line magpie-tasks reads beside a typed message', () => {
    expect(terminalHintLine(1794038667762)).toBe('[tg-router terminal message_id=1794038667762]')
  })
})
