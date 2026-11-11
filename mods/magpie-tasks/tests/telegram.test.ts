// Telegram parts (plan section 12.1, telegram row): the channel tag of real Telegram messages as the
// Router session received them (tests/data/channel-*.txt), and clipping to what Telegram accepts.
import { expect, test } from 'claude-code/testing'
import { clip, parseChannelTag } from '../src/telegram'
import { channelImage1043, channelPhoto1170, channelPlain953, channelReply1108, channelReply1110 } from './data/channel-blocks'

test('a plain message: chat, message and the text without the tag', () => {
  expect(parseChannelTag(channelPlain953)).toEqual({ chatId: '7051661301', messageId: 953, body: '看看我们这个设备上有什么没做的？' })
})

test('a reply carries the message it replies to', () => {
  expect(parseChannelTag(channelReply1110)).toEqual({ chatId: '7051661301', messageId: 1110, replyTo: 1109, body: '去吧' })
  const r = parseChannelTag(channelReply1108)!
  expect(r.replyTo).toBe(1105)
  expect(r.body).toBe('你觉得我们这个 super agent 插件是不是应该让你这个主 router 在我这种没有指定 session 的情况下自己转发一下消息呢？')
})

test('a photo carries its path in the inbox', () => {
  expect(parseChannelTag(channelImage1043)).toEqual({
    chatId: '7051661301',
    messageId: 1043,
    imagePath: '/home/ubuntu/.claude/channels/telegram-live/inbox/1793844899621-AQADIRdrG800YFd-.jpg',
    body: '排查一下这个排查一下这个问题，我们哪台机器又触发告警了？',
  })
  expect(parseChannelTag(channelPhoto1170)?.body).toBe('(photo)')
})

test('text with no channel tag, or a tag without chat and message, is not a channel message', () => {
  expect(parseChannelTag('看看我们这个设备上有什么没做的？')).toBeNull()
  expect(parseChannelTag(channelPlain953.replace(/ message_id="953"/, ''))).toBeNull()
  expect(parseChannelTag(channelPlain953.replace(/ chat_id="7051661301"/, ''))).toBeNull()
})

test('clip keeps short text and cuts long text at whole characters with a count of what is left', () => {
  const body = parseChannelTag(channelReply1108)!.body
  expect(clip(body)).toBe(body)
  const long = body.repeat(100)
  const cut = clip(long)
  const kept = Array.from(cut.slice(0, cut.indexOf('…（')))
  expect(kept.length).toBe(4000)
  expect(cut.endsWith(`（后面还有 ${Array.from(long).length - 4000} 字，见终端）`)).toBe(true)
  expect(clip(body, 10)).toBe(`${Array.from(body).slice(0, 10).join('')}…（后面还有 ${Array.from(body).length - 10} 字，见终端）`)
  // A character outside the BMP is never split in half.
  const emoji = '🔧'.repeat(5)
  expect(clip(emoji, 3).startsWith('🔧🔧🔧…')).toBe(true)
})
