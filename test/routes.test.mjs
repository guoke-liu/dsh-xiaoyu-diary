// 路由与候选取舍的测试：验「挑选放进日记」这件事真的成立。
//
// 重点验三件事：
//   1. 放进去 → 日记里真的多一条；不放 → 日记里真的没有
//   2. 重新提取不会冲掉已做的取舍（否则每天都要重挑一遍）
//   3. 路由在任何失败下都回 JSON，不抛
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import { 注册路由, PREFIX, 归到日记日 } from '../lib/routes.js'

/** 造一个假宿主：收集注册的路由，提供直接调用的入口。 */
async function 造宿主 (rootDir, vaultDir) {
  const 路由表 = new Map()
  const ctx = {
    webServer: {
      register: ({ path, handler }) => { 路由表.set(path, handler) },
    },
    effect: (fn) => fn(),
  }
  const 注册数 = 注册路由(ctx, {
    rootDir: () => rootDir,
    vaultDir: () => vaultDir,
    log: () => {},
  })
  if (注册数 === 0) throw new Error('路由一条都没注册上')

  /** 造一个假的 req/res，调某条路由，拿回 { status, body }。 */
  async function 调 (路径, { method = 'GET', body, query } = {}) {
    const handler = 路由表.get(路径)
    if (!handler) throw new Error(`没有这条路由：${路径}`)
    let status = 200
    let payload = ''
    const req = {
      method,
      url: 路径,
      query,
      body,
      async *[Symbol.asyncIterator] () { /* 没有流 */ },
    }
    const res = {
      writeHead: (c) => { status = c },
      end: (b) => { payload = b || '' },
    }
    await handler(req, res)
    let json = null
    try { json = JSON.parse(payload) } catch { json = null }
    return { status, body: json, raw: payload }
  }
  return { 调, 路由表, 注册数 }
}

/** 建临时日记库 + 临时仓库，写一天聊天。 */
async function 造环境 (chatLines) {
  const root = await mkdtemp(join(tmpdir(), 'xd-root-'))
  const vault = await mkdtemp(join(tmpdir(), 'xd-vault-'))
  await mkdir(join(root, 'entries'), { recursive: true })
  if (chatLines && chatLines.length) {
    await mkdir(join(vault, 'chat', 'private'), { recursive: true })
    const 日期 = new Date().toISOString().slice(0, 10)
    await writeFile(join(vault, 'chat', 'private', `${日期}.txt`), chatLines.join('\n'))
  }
  return { root, vault, 清理: async () => {
    await rm(root, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  } }
}

test('路由：全部注册成功', async () => {
  const env = await 造环境()
  try {
    const h = await 造宿主(env.root, env.vault)
    assert.ok(h.注册数 >= 6, `只注册了 ${h.注册数} 条`)
    for (const p of ['/ping', '/overview', '/candidates', '/candidates/refresh',
      '/candidates/decide', '/entries', '/search']) {
      assert.ok(h.路由表.has(PREFIX + p), `缺路由 ${PREFIX}${p}`)
    }
  } finally { await env.清理() }
})

test('路由：ping 能回', async () => {
  const env = await 造环境()
  try {
    const h = await 造宿主(env.root, env.vault)
    const r = await h.调(`${PREFIX}/ping`)
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.插件, '小鱼日记')
  } finally { await env.清理() }
})

test('路由：没有 webServer 时不抛，返回 0', () => {
  const n = 注册路由({ tools: {} }, { rootDir: () => '/tmp/x', vaultDir: () => '/tmp/y', log: () => {} })
  assert.equal(n, 0)
})

test('取舍：放进去 → 日记里真的多一条', async () => {
  const env = await 造环境([
    '[09:00:00] 主人(p1): 明天下午三点要去医院复查，别忘了带病历',
  ])
  try {
    const h = await 造宿主(env.root, env.vault)
    const 今天 = new Date().toISOString().slice(0, 10)
    const r1 = await h.调(`${PREFIX}/candidates/refresh`, { method: 'POST', body: { 来源: 'private', date: 今天 } })
    assert.equal(r1.body.ok, true)
    assert.ok(r1.body.items.length >= 1, '应该筛出候选')
    const cid = r1.body.items[0].cid

    const r2 = await h.调(`${PREFIX}/candidates/decide`, {
      method: 'POST', body: { 来源: 'private', date: 今天, cid, 状态: 'accepted' },
    })
    assert.equal(r2.body.ok, true)
    assert.equal(r2.body.状态, 'accepted')
    assert.ok(r2.body.条目id, '放进去后应该返回条目 id')

    const r3 = await h.调(`${PREFIX}/entries`, { query: { 来源: 'private', date: 今天 } })
    assert.equal(r3.body.count, 1, '日记里应该有 1 条')
    assert.ok(r3.body.entries[0].text.includes('医院复查'))
  } finally { await env.清理() }
})

test('取舍：不放 → 日记里没有；且撤回已放入的', async () => {
  const env = await 造环境([
    '[09:00:00] 主人(p1): 明天下午三点要去医院复查，别忘了带病历',
  ])
  try {
    const h = await 造宿主(env.root, env.vault)
    const 今天 = new Date().toISOString().slice(0, 10)
    const r1 = await h.调(`${PREFIX}/candidates/refresh`, { method: 'POST', body: { 来源: 'private', date: 今天 } })
    const cid = r1.body.items[0].cid

    // 先放进去
    await h.调(`${PREFIX}/candidates/decide`, { method: 'POST', body: { 来源: 'private', date: 今天, cid, 状态: 'accepted' } })
    let e = await h.调(`${PREFIX}/entries`, { query: { 来源: 'private', date: 今天 } })
    assert.equal(e.body.count, 1)

    // 再改成不放：已写入的那条要撤回
    const r = await h.调(`${PREFIX}/candidates/decide`, {
      method: 'POST', body: { 来源: 'private', date: 今天, cid, 状态: 'rejected' },
    })
    assert.equal(r.body.状态, 'rejected')
    e = await h.调(`${PREFIX}/entries`, { query: { 来源: 'private', date: 今天 } })
    assert.equal(e.body.count, 0, '改成不放后日记里不该还留着')
  } finally { await env.清理() }
})

test('取舍：重复点「放进去」不会写两条', async () => {
  const env = await 造环境([
    '[09:00:00] 主人(p1): 明天下午三点要去医院复查，别忘了带病历',
  ])
  try {
    const h = await 造宿主(env.root, env.vault)
    const 今天 = new Date().toISOString().slice(0, 10)
    const r1 = await h.调(`${PREFIX}/candidates/refresh`, { method: 'POST', body: { 来源: 'private', date: 今天 } })
    const cid = r1.body.items[0].cid
    await h.调(`${PREFIX}/candidates/decide`, { method: 'POST', body: { 来源: 'private', date: 今天, cid, 状态: 'accepted' } })
    await h.调(`${PREFIX}/candidates/decide`, { method: 'POST', body: { 来源: 'private', date: 今天, cid, 状态: 'accepted' } })
    const e = await h.调(`${PREFIX}/entries`, { query: { 来源: 'private', date: 今天 } })
    assert.equal(e.body.count, 1, '幂等：重复点不该重复写')
  } finally { await env.清理() }
})

test('重新提取：已做的取舍不会被冲掉', async () => {
  const env = await 造环境([
    '[09:00:00] 主人(p1): 明天下午三点要去医院复查，别忘了带病历',
    '[09:10:00] 主人(p1): 这个月工资发下来了，决定把服务器的钱先付了',
  ])
  try {
    const h = await 造宿主(env.root, env.vault)
    const 今天 = new Date().toISOString().slice(0, 10)
    const r1 = await h.调(`${PREFIX}/candidates/refresh`, { method: 'POST', body: { 来源: 'private', date: 今天 } })
    assert.ok(r1.body.items.length >= 2)
    const [a, b] = r1.body.items

    // 一条放进去，一条不放
    await h.调(`${PREFIX}/candidates/decide`, { method: 'POST', body: { 来源: 'private', date: 今天, cid: a.cid, 状态: 'accepted' } })
    await h.调(`${PREFIX}/candidates/decide`, { method: 'POST', body: { 来源: 'private', date: 今天, cid: b.cid, 状态: 'rejected' } })

    // 再提取一次
    const r2 = await h.调(`${PREFIX}/candidates/refresh`, { method: 'POST', body: { 来源: 'private', date: 今天 } })
    assert.equal(r2.body.ok, true)
    assert.ok(r2.body.保留 >= 2, `应该保留 2 条已决定，实际 ${r2.body.保留}`)

    const 状态 = Object.fromEntries(r2.body.items.map((x) => [x.内容, x.状态]))
    assert.equal(状态[a.内容], 'accepted', '放进去的状态要保留')
    assert.equal(状态[b.内容], 'rejected', '不放的状态要保留')
  } finally { await env.清理() }
})

test('重新提取：仓库没有聊天记录时不覆盖已有候选', async () => {
  const env = await 造环境() // 不写聊天
  try {
    const h = await 造宿主(env.root, env.vault)
    const 今天 = new Date().toISOString().slice(0, 10)
    // 先手写一份候选（items 里那条 来源: ['手工'] 是「这条候选谁挑出来的」出处字段，
    // 与「日记来自哪个来源」的来源 key 无关，保持原样）
    await store.写候选(env.root, 'private', 今天, {
      来源: ['手工'],
      items: [{ cid: 'c1', 时间: '09:00:00', 昵称: 'x', 内容: '已有候选', 命中: [], 状态: 'accepted', 条目id: 'd1' }],
    })
    const r = await h.调(`${PREFIX}/candidates/refresh`, { method: 'POST', body: { 来源: 'private', date: 今天 } })
    assert.equal(r.body.ok, true)
    assert.equal(r.body.行数, 0)
    assert.ok(r.body.note, '应该说明没有记录')
    assert.equal(r.body.items.length, 1, '原有候选不该被清空')
    assert.equal(r.body.items[0].状态, 'accepted', '原有取舍不该丢')
  } finally { await env.清理() }
})

test('取舍：非法状态被拒', async () => {
  const env = await 造环境()
  try {
    const h = await 造宿主(env.root, env.vault)
    const r = await h.调(`${PREFIX}/candidates/decide`, {
      method: 'POST', body: { 来源: 'private', cid: 'c1', 状态: '乱写的' },
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.ok, false)
  } finally { await env.清理() }
})

test('取舍：不存在的 cid 回 404', async () => {
  const env = await 造环境()
  try {
    const h = await 造宿主(env.root, env.vault)
    const r = await h.调(`${PREFIX}/candidates/decide`, {
      method: 'POST', body: { 来源: 'private', cid: 'c999', 状态: 'accepted' },
    })
    assert.equal(r.status, 404)
    assert.equal(r.body.ok, false)
  } finally { await env.清理() }
})

test('路由：任何异常都回 JSON 而不是抛', async () => {
  // rootDir 指向一个不存在的路径，读取应降级不抛
  const h = await 造宿主('/tmp/绝对不存在的目录-xyz', '/tmp/也不存在-xyz')
  for (const p of [`${PREFIX}/overview`, `${PREFIX}/candidates`, `${PREFIX}/entries`, `${PREFIX}/search`]) {
    // 带上来源：这条测的是「库读不到时降级回 JSON」，不是「缺来源回 400」，
    // 不带来源只会短路成 400，测不到真正的读取路径
    const r = await h.调(p, { query: { 来源: 'private' } })
    assert.ok(r.body, `${p} 应该回 JSON`)
    assert.equal(typeof r.status, 'number')
  }
})

test('概览：能列出有候选的日子', async () => {
  const env = await 造环境()
  try {
    const h = await 造宿主(env.root, env.vault)
    await store.写候选(env.root, 'private', '2026-11-01', {
      items: [
        { cid: 'c1', 时间: '09:00:00', 昵称: 'a', 内容: 'x', 命中: [], 状态: 'pending', 条目id: '' },
        { cid: 'c2', 时间: '09:01:00', 昵称: 'b', 内容: 'y', 命中: [], 状态: 'accepted', 条目id: 'd1' },
      ],
    })
    const r = await h.调(`${PREFIX}/overview`, { query: { 来源: 'private' } })
    assert.equal(r.body.ok, true)
    assert.ok(r.body.今天, '概览返回体里的「今天」还在')
    const day = r.body.候选列表.find((x) => x.date === '2026-11-01')
    assert.ok(day)
    assert.equal(day.待定, 1)
    assert.equal(day.放进去, 1)
  } finally { await env.清理() }
})

test('检索接口能用', async () => {
  const env = await 造环境()
  try {
    const h = await 造宿主(env.root, env.vault)
    await store.追加条目(env.root, 'private', '2026-11-01', { text: '和主人去爬山了', tags: ['出游'] })
    const r = await h.调(`${PREFIX}/search`, { query: { 来源: 'private', q: '爬山' } })
    assert.equal(r.body.ok, true)
    assert.equal(r.body.命中数, 1)
  } finally { await env.清理() }
})

// ── 首次使用（实测踩过）──────────────────────────────────────────────────
//
// 早先的逻辑是「rootDir 不存在就报错」，把首次使用也挡住了：
// 新装插件、第一次记东西，用户看到「日记库根目录不存在」，很费解。
// 现在按父目录区分：父目录在 = 首次使用（创建）；父目录不在 = 配置错误（报错）。

test('首次使用：父目录在但日记库不在时，能自动创建', async () => {
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const storeMod = await import('../lib/store.js')

  const 父 = await mkdtemp(join(tmpdir(), 'first-use-'))
  const 库 = join(父, 'xiaoyu-diary') // 父在，自己不在
  try {
    const e = await storeMod.追加条目(库, 'private', '2026-11-03', { text: '第一次记', tags: [] })
    assert.ok(e.id, '首次使用应该能正常写入')
    const back = await storeMod.读某天(库, 'private', '2026-11-03')
    assert.equal(back.length, 1)
  } finally {
    await rm(父, { recursive: true, force: true })
  }
})

test('配置错误：父目录都不存在时，报错并说清是哪一级', async () => {
  const storeMod = await import('../lib/store.js')
  await assert.rejects(
    () => storeMod.追加条目('/绝对不存在的父目录/子目录', 'private', '2026-11-03', { text: 'x', tags: [] }),
    (err) => {
      // 关键：错误信息要指出是**上级目录**不存在，而不是含糊的"根目录不存在"
      assert.ok(err.message.includes('上级目录'), `应说明上级目录，实际：${err.message}`)
      assert.ok(err.message.includes('配置'), '应提示检查配置')
      return true
    },
  )
})

// ── 作者归属：UI 写入路径必须标「主人手记」（2026-11-03）──────────────────
//
// 主人原话：「这个功能给主人用不是给鱼的」。
// UI 上的大模型通道是主人自己按按钮、逐条点「记进日记」的 ——
// 那是他认可的，必须标 owner；鱼自己整理的才标 xi。两条路不能互相冒充。

test('作者：主人手动挑的 quick-write 写进去是 owner', async () => {
  const env = await 造环境()
  try {
    const h = await 造宿主(env.root, env.vault)
    const r = await h.调(`${PREFIX}/quick-write`, {
      method: 'POST',
      body: JSON.stringify({ 来源: 'private', date: '2026-11-03', text: '大模型筛出来的一条', 出处: '大模型' }),
    })
    assert.equal(r.status, 200, r.raw)
    const 条 = (await store.读某天(env.root, 'private', '2026-11-03'))[0]
    assert.ok(条, '应该写进去一条')
    // ⭐ 2026-11-03 主人定稿：谁发起的筛选就算谁的日记。
    //   自动筛选已关，这条路径只可能是主人手动点的，所以是 owner。
    assert.equal(条.作者, 'owner')
  } finally { await env.清理() }
})

test('作者：鱼自己整理的（xiaoyu_diary_write）默认不是主人', async () => {
  const env = await 造环境()
  try {
    // 直接走 store 写入模拟鱼整理的（不标作者时工具层会补 xi，这里验 store 不会自己塞 owner）
    await store.追加条目(env.root, 'private', '2026-11-03', { text: '鱼整理的', 作者: 'xi' })
    const 条 = (await store.读某天(env.root, 'private', '2026-11-03'))[0]
    assert.equal(条.作者, 'xi')
    assert.notEqual(条.作者, 'owner')
  } finally { await env.清理() }
})


// ── 日记日归属 + 缺来源提示 ────────────────────────────────────────────

test('路由：界面「记一条」按日记日归属（用固定时刻验，不靠跑测试的钟点）', () => {
  // 为什么不用 new Date()：白天跑测试时日历日和日记日完全相同，
  // 把 bug 种回去照样全绿 —— 这种假绿比没测更糟（上一轮真的踩过）。
  assert.equal(归到日记日(new Date('2026-11-04T01:30:00+08:00')), '2026-11-03', '凌晨 1:30 应归前一天')
  assert.equal(归到日记日(new Date('2026-11-04T09:00:00+08:00')), '2026-11-04', '上午 9:00 应归当天')
})

test('路由：缺来源时明确说「缺」，别回一句像报错的空参数', async () => {
  const { 调 } = await 造宿主('/tmp/没有这个目录', '/tmp/也没有这个')
  const r = await 调(`${PREFIX}/overview`)
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
  assert.ok(!/来源参数不合法：\s*（/.test(r.body.error), `缺来源不该复用「参数不合法」，实际：${r.body.error}`)
  assert.ok(r.body.error.includes('缺少来源参数'), `要明说缺什么，实际：${r.body.error}`)
  assert.ok(r.body.error.includes('来源='), `要告诉人怎么补，实际：${r.body.error}`)
})

test('路由：来源写错时报出写错的原文', async () => {
  const { 调 } = await 造宿主('/tmp/没有这个目录', '/tmp/也没有这个')
  const r = await 调(`${PREFIX}/overview`, { query: { 来源: '群聊' } })
  assert.equal(r.status, 400)
  assert.equal(r.body.ok, false)
  assert.ok(r.body.error.includes('群聊'), `要把写错的值回显出来，实际：${r.body.error}`)
  assert.ok(r.body.error.includes('来源参数不合法'), `写错的值走「不合法」这条，实际：${r.body.error}`)
})
