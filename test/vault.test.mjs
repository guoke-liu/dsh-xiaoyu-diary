// 记忆仓库适配器测试。
//
// 这一层最容易悄悄坏掉：接口换参数、换返回结构、仓库没装 ——
// 表现形式都是"当天没候选"，看起来像"那天真没聊什么"，极难排查。
// 所以这里重点验两件事：
//   1. 适配器命中时，真的走接口（不是偷偷退回读文件）
//   2. 适配器拿不到时，真的退回读文件（功能不中断）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 探测仓库, 读当天聊天, 列出有记录的日期 } from '../lib/vault.js'

/** 造一个假的记忆仓库目录，写一天的聊天文件。 */
async function 造仓库 (日期, 行们) {
  const root = await mkdtemp(join(tmpdir(), 'vault-t-'))
  await mkdir(join(root, 'chat', 'private'), { recursive: true })
  await writeFile(join(root, 'chat', 'private', `${日期}.txt`), 行们.join('\n'))
  return root
}

/** 造一个假的适配器（模拟记忆仓库接口命中）。 */
function 造假适配器 ({ 私聊行们 = [], 群行们 = {}, 日期们 = [] } = {}) {
  const 调用 = []
  return {
    调用,
    ok: true,
    via: '测试假接口',
    版本: '9.9.9',
    原因: '',
    列日期: async (rootDir, opts) => {
      调用.push(['列日期', opts])
      if (opts?.chatType === 'private') return 日期们
      if (opts?.chatType === 'group') return 日期们
      return [] // 模拟真接口：不传 chatType 返回空
    },
    按天读: async (rootDir, opts) => {
      调用.push(['按天读', opts])
      if (opts?.chatType === 'group') return 群行们[opts?.groupId] || []
      return 私聊行们
    },
  }
}

test('适配器：绝不抛异常，拿不到就返回 ok:false', async () => {
  const a = await 探测仓库()
  assert.equal(typeof a, 'object')
  assert.equal(typeof a.ok, 'boolean')
  // 无论本机装没装记忆仓库，都必须有原因字段可看
  assert.ok('原因' in a)
})

test('适配器：读不到接口时退回直接读文件（功能不中断）', async () => {
  const 日期 = '2026-11-03'
  const root = await 造仓库(日期, [
    '[09:00:00] 小明(p1): 明天下午三点开会，别忘了',
    '[09:05:00] 小红(p2): 好',
  ])
  try {
    // 传 null 适配器 = 模拟"接口完全不可用"
    const r = await 读当天聊天(root, 日期, null)
    assert.equal(r.行数, 2, '兜底路径应该读到 2 行')
    assert.ok(r.行们[0].内容.includes('开会'))
    assert.equal(r.行们[0].时间, '09:00:00', '兜底也要正确拆出时间')
    assert.equal(r.行们[0].昵称, '小明')
    assert.equal(r.行们[0].pid, 'p1')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('适配器：接口能命中时必须走接口，不走文件', async () => {
  const 日期 = '2026-11-03'
  // 文件里故意放一条，接口里放另一条 —— 靠内容区分走了哪条路
  const root = await 造仓库(日期, ['[09:00:00] 文件里的人(p9): 我是文件内容'])
  try {
    const 假 = 造假适配器({
      私聊行们: ['[10:00:00] 接口里的人(p1): 我是接口内容'],
      日期们: [日期],
    })
    const r = await 读当天聊天(root, 日期, 假)
    assert.equal(r.行数, 1)
    assert.ok(r.行们[0].内容.includes('接口内容'), '应该走接口，而不是读文件')
    assert.ok(!r.行们[0].内容.includes('文件内容'))
    assert.ok(r.来源.some((s) => s.includes('私聊')))
    // 确认确实问了接口
    assert.ok(假.调用.some((c) => c[0] === '按天读'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('适配器：列日期要分别传 private 和 group（真接口的契约）', async () => {
  const 假 = 造假适配器({ 日期们: ['2026-11-01', '2026-11-02'] })
  const 出 = await 列出有记录的日期('/tmp/不存在的仓库', 假)
  const 问过的 = 假.调用.filter((c) => c[0] === '列日期').map((c) => c[1]?.chatType)
  assert.ok(问过的.includes('private'), '必须问私聊')
  assert.ok(问过的.includes('group'), '必须问群聊')
  // 去重 + 升序
  assert.deepEqual(出, ['2026-11-01', '2026-11-02'])
})

test('适配器：列日期去重（私聊群聊同一天只算一次）', async () => {
  const 假 = 造假适配器({ 日期们: ['2026-11-02', '2026-11-01'] })
  const 出 = await 列出有记录的日期('/tmp/不存在', 假)
  assert.equal(出.length, 2, '同一天问两次不该出两条')
  assert.deepEqual(出, ['2026-11-01', '2026-11-02'], '必须升序')
})

test('适配器：接口返回整行字符串也能正确拆出时间/昵称', async () => {
  const 假 = 造假适配器({
    私聊行们: ['[14:30:22] 小鱼(p2): 今天有点累'],
    日期们: ['2026-11-03'],
  })
  const r = await 读当天聊天('/tmp/不存在', '2026-11-03', 假)
  assert.equal(r.行数, 1)
  assert.equal(r.行们[0].时间, '14:30:22')
  assert.equal(r.行们[0].昵称, '小鱼')
  assert.equal(r.行们[0].pid, 'p2')
})

test('适配器：接口抛错时退回读文件，不把整次调用弄挂', async () => {
  const 日期 = '2026-11-03'
  const root = await 造仓库(日期, ['[09:00:00] 兜底(p1): 接口坏了我也要在'])
  try {
    const 坏适配器 = {
      ok: true,
      列日期: async () => { throw new Error('接口炸了') },
      按天读: async () => { throw new Error('接口炸了') },
    }
    const r = await 读当天聊天(root, 日期, 坏适配器)
    assert.equal(r.行数, 1, '接口抛错也要退回文件读到数据')
    assert.ok(r.行们[0].内容.includes('接口坏了我也要在'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('适配器：仓库和接口都没有时如实返回 0，不编造', async () => {
  const r = await 读当天聊天('/tmp/绝对不存在的仓库xyz', '2026-11-03', null)
  assert.equal(r.行数, 0)
  assert.deepEqual(r.行们, [])
})

test('适配器：群聊按仓库报的群号去取，不写死群号', async () => {
  const 日期 = '2026-11-03'
  const root = await mkdtemp(join(tmpdir(), 'vault-g-'))
  await mkdir(join(root, 'chat', 'group', '999888'), { recursive: true })
  await writeFile(join(root, 'chat', 'group', '999888', `${日期}.txt`), '[09:00:00] 群里人(p3): 群里的话')
  try {
    const 假 = 造假适配器({
      私聊行们: [],
      群行们: { 999888: ['[09:00:00] 群里人(p3): 群里的话'] },
      日期们: [日期],
    })
    const r = await 读当天聊天(root, 日期, 假)
    assert.equal(r.行数, 1)
    assert.equal(r.行们[0].群, '999888', '群号要能带出来')
  } finally { await rm(root, { recursive: true, force: true }) }
})
