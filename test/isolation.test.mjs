// 来源隔离的测试：验「私聊和每个群的日记完全不串台」这件事真的成立。
//
// 【为什么单独一个文件】
//   「完全分开」是 2026-11-03 主人明确要求的核心性质。它的失效方式很隐蔽 ——
//   合并了也能跑、界面也能显示、测试也可能全绿，只是数据悄悄混在一起，
//   用户翻日记时分不清哪句话是群友说的。所以必须有**专门的**隔离测试，
//   而且每一条都要是「合并了就必然失败」那种断言。
//
// 【每条测试都在防什么】
//   1. store 层      —— 同一日期两个来源各写一条，互相读不到、索引也互不影响
//   2. 来源校验      —— 非法来源必须被拒（它会拼进文件路径，漏放行就是目录穿越）
//   3. 书签          —— 每个来源各自记进度，不共享页码
//   4. vault 层      —— 读某来源时不会顺带把别的来源的聊天读进来
//   5. 路由层        —— 不带来源回 400；带 A 来源不会返回 B 来源的数据
//   6. 候选          —— 同一 cid 在两个来源里各指各的，改一个不影响另一个
//   7. 老数据迁移    —— 一天一份的老文件搬进私聊，且有原样备份
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import * as source from '../lib/source.js'
import { 读来源聊天, 列出来源 } from '../lib/vault.js'
import { 注册路由, PREFIX } from '../lib/routes.js'

const 私聊 = 'private'
const 群A = 'group:730783833'
const 群B = 'group:859310353'

// ── source.js 本身 ───────────────────────────────────────────────────────

test('来源：校验只认 private 与 group:<群号>', () => {
  assert.equal(source.校验来源('private'), 'private')
  assert.equal(source.校验来源(' group:730783833 '), 'group:730783833')
  assert.equal(source.校验来源('group:'), '', '空群号不该合法')
  assert.equal(source.校验来源('group:../etc'), '', '带 / 的群号必须拒绝（会拼进文件路径）')
  assert.equal(source.校验来源('group:..'), '', '带 . 的群号必须拒绝')
  assert.equal(source.校验来源('群'), '')
  assert.equal(source.校验来源(null), '')
  assert.equal(source.校验来源(undefined), '')
})

test('来源：标签与目录名可读且不撞', () => {
  assert.equal(source.来源标签(私聊), '私聊')
  assert.equal(source.来源标签(群A), '群 730783833')
  assert.equal(source.来源目录名(私聊), 'private')
  assert.equal(source.来源目录名(群A), 'group-730783833')
  // 目录名里不能出现 ':'，否则在部分文件系统上直接建不出来
  assert.ok(!source.来源目录名(群A).includes(':'))
})

test('来源：排序让私聊永远第一，群按数字序', () => {
  const 乱序 = [群B, 私聊, 群A]
  const 排好 = [...乱序].sort(source.比较来源)
  assert.deepEqual(排好, [私聊, 群A, 群B])
})

// ── 存储隔离 ─────────────────────────────────────────────────────────────

test('隔离：同一日期两个来源各写一条，互不可见', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iso-'))
  try {
    const date = '2026-11-03'
    await store.追加条目(root, 私聊, date, { text: '私聊里说好的事' })
    await store.追加条目(root, 群A, date, { text: '群里说的另一件事' })

    const 私 = (await store.读某天(root, 私聊, date)).map((e) => e.text)
    const 群 = (await store.读某天(root, 群A, date)).map((e) => e.text)
    assert.deepEqual(私, ['私聊里说好的事'], '私聊不该看到群里的内容')
    assert.deepEqual(群, ['群里说的另一件事'], '群不该看到私聊的内容')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('隔离：两个来源的索引与 seq 各自独立', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iso-'))
  try {
    const date = '2026-11-03'
    // 各写两条：如果 seq 是全局共享的，第二个来源的第一条 id 会变成 d3
    await store.追加条目(root, 私聊, date, { text: '私聊一' })
    await store.追加条目(root, 私聊, date, { text: '私聊二' })
    await store.追加条目(root, 群A, date, { text: '群一' })

    const 私 = await store.读某天(root, 私聊, date)
    const 群 = await store.读某天(root, 群A, date)
    assert.deepEqual(私.map((e) => e.id), ['d1', 'd2'])
    assert.deepEqual(群.map((e) => e.id), ['d1'], 'seq 必须按来源各自从 1 开始')

    // 索引也是各一份：重建一个来源不该看见另一个来源的词
    await store.写索引(root, 私聊, (await store.重建(root, 私聊)).index)
    await store.写索引(root, 群A, (await store.重建(root, 群A)).index)
    const 私索引 = await store.读索引(root, 私聊)
    const 群索引 = await store.读索引(root, 群A)
    assert.ok(私索引.days[date], '私聊索引里应有这一天')
    assert.equal(私索引.days[date].entries.length, 2)
    assert.equal(群索引.days[date].entries.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('隔离：删条目只删指定来源里的那条', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iso-'))
  try {
    const date = '2026-11-03'
    // 两个来源都从 d1 开始，所以「按 id 删」如果不带来源就会删错人
    const a = await store.追加条目(root, 私聊, date, { text: '私聊的内容' })
    const b = await store.追加条目(root, 群A, date, { text: '群里的内容' })
    assert.equal(a.id, b.id, '前提：两个来源的 id 会撞（这正是风险所在）')

    const r = await store.删条目(root, b.id, 群A)
    assert.equal(r.删除, true)
    assert.equal(r.来源, 群A)

    const 私 = await store.读某天(root, 私聊, date)
    const 群 = await store.读某天(root, 群A, date)
    assert.equal(私.length, 1, '私聊那条必须还在 —— 只删了群里的')
    assert.equal(群.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('隔离：非法来源一律拒绝，不写到磁盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iso-'))
  try {
    await assert.rejects(
      () => store.追加条目(root, 'group:../坏东西', '2026-11-03', { text: 'x' }),
      /非法的来源/,
    )
    await assert.rejects(
      () => store.读某天(root, '', '2026-11-03'),
      /非法的来源/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('隔离：书签每个来源各记各的', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iso-'))
  try {
    await store.写书签(root, 私聊, '2026-11-02')
    await store.写书签(root, 群A, '2026-11-01')

    assert.equal((await store.读书签(root, 私聊)).lastDate, '2026-11-02')
    assert.equal((await store.读书签(root, 群A)).lastDate, '2026-11-01')
    // 没读过的来源不该被别的来源的进度影响
    assert.equal((await store.读书签(root, 群B)).lastDate, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('隔离：来源清单会记下写过的来源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iso-'))
  try {
    await store.追加条目(root, 私聊, '2026-11-03', { text: 'a' })
    await store.追加条目(root, 群A, '2026-11-03', { text: 'b' })
    const 已知 = await store.列出已知来源(root)
    assert.deepEqual(已知, [私聊, 群A])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 记忆仓库按来源读 ─────────────────────────────────────────────────────

test('仓库：读某来源只拿到那个来源的聊天', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'iso-vault-'))
  try {
    const date = '2026-11-03'
    await mkdir(join(vault, 'chat', 'private'), { recursive: true })
    await mkdir(join(vault, 'chat', 'group', '730783833'), { recursive: true })
    await mkdir(join(vault, 'chat', 'group', '859310353'), { recursive: true })
    await writeFile(join(vault, 'chat', 'private', `${date}.txt`),
      '[10:00:00] 小鱼儿(p1): 私聊里的话\n')
    await writeFile(join(vault, 'chat', 'group', '730783833', `${date}.txt`),
      '[11:00:00] 群友(p2): 群A里的话\n')
    await writeFile(join(vault, 'chat', 'group', '859310353', `${date}.txt`),
      '[12:00:00] 另一个人(p3): 群B里的话\n')

    // 来源清单要能同时认出三个
    const 列表 = await 列出来源(vault, null)
    assert.deepEqual(列表.map((x) => x.来源), [私聊, 群A, 群B])

    const a = await 读来源聊天(vault, 群A, date, null)
    assert.equal(a.行数, 1, `群A 应当只有 1 行，实际 ${a.行数} 行（合并了就会变多）`)
    assert.equal(a.行们[0].内容, '群A里的话')
    assert.equal(a.行们[0].来源, 群A, '每一行都要标来源')

    const p = await 读来源聊天(vault, 私聊, date, null)
    assert.equal(p.行数, 1)
    assert.equal(p.行们[0].内容, '私聊里的话')
  } finally {
    await rm(vault, { recursive: true, force: true })
  }
})

// ── 路由层 ───────────────────────────────────────────────────────────────

/** 造一个假宿主：收集注册的路由，提供直接调用的入口。 */
async function 造宿主 (rootDir, vaultDir) {
  const 路由表 = new Map()
  const ctx = {
    webServer: { register: ({ path, handler }) => { 路由表.set(path, handler) } },
    effect: (fn) => fn(),
  }
  const n = 注册路由(ctx, { rootDir: () => rootDir, vaultDir: () => vaultDir, log: () => {} })
  if (n === 0) throw new Error('路由一条都没注册上')

  async function 调 (路径, { method = 'GET', body, query } = {}) {
    const handler = 路由表.get(路径)
    if (!handler) throw new Error(`没有这条路由：${路径}`)
    let status = 200
    let payload = ''
    const req = { method, url: 路径, query, body, async *[Symbol.asyncIterator] () {} }
    const res = { writeHead: (c) => { status = c }, end: (b) => { payload = b || '' } }
    await handler(req, res)
    let json = null
    try { json = JSON.parse(payload) } catch { json = null }
    return { status, body: json }
  }
  return { 调, 路由表 }
}

test('路由：sources 路由能列出仓库里的私聊与各群', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iso-r-'))
  const vault = await mkdtemp(join(tmpdir(), 'iso-rv-'))
  try {
    await mkdir(join(vault, 'chat', 'private'), { recursive: true })
    await mkdir(join(vault, 'chat', 'group', '730783833'), { recursive: true })
    const h = await 造宿主(root, vault)
    const r = await h.调(`${PREFIX}/sources`)
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    const keys = r.body.来源们.map((x) => x.来源)
    assert.deepEqual(keys, [私聊, 群A])
    assert.equal(r.body.来源们[0].标签, '私聊')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  }
})

test('路由：不带来源的参数一律 400，不猜默认值', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iso-r-'))
  const vault = await mkdtemp(join(tmpdir(), 'iso-rv-'))
  try {
    const h = await 造宿主(root, vault)
    // 每一条都必须是 400：默默按私聊算的话，用户在看群时点刷新会被静默刷错
    const 要来源的 = [
      [`${PREFIX}/overview`, {}],
      [`${PREFIX}/candidates`, {}],
      [`${PREFIX}/entries`, {}],
      [`${PREFIX}/search`, { query: { q: 'x' } }],
      [`${PREFIX}/bookmark`, {}],
    ]
    for (const [p, opt] of 要来源的) {
      const r = await h.调(p, opt)
      assert.equal(r.status, 400, `${p} 不带来源应当 400，实际 ${r.status}`)
      assert.equal(r.body.ok, false)
    }
    // POST 的几条也一样
    const 要来源的post = [
      `${PREFIX}/candidates/refresh`,
      `${PREFIX}/candidates/decide`,
      `${PREFIX}/llm-pick-async`,
      `${PREFIX}/quick-write`,
    ]
    for (const p of 要来源的post) {
      const r = await h.调(p, { method: 'POST', body: { date: '2026-11-03', cid: 'c1', 状态: 'pending', text: 'x' } })
      assert.equal(r.status, 400, `${p} 不带来源应当 400，实际 ${r.status}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  }
})

test('路由：entries/overview 带 A 来源不会返回 B 来源的数据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iso-r-'))
  const vault = await mkdtemp(join(tmpdir(), 'iso-rv-'))
  try {
    const date = '2026-11-03'
    await store.追加条目(root, 私聊, date, { text: '私聊的' })
    await store.追加条目(root, 群A, date, { text: '群A的' })
    const h = await 造宿主(root, vault)

    const a = await h.调(`${PREFIX}/entries`, { query: { 来源: 群A, date } })
    assert.equal(a.status, 200)
    assert.deepEqual(a.body.entries.map((e) => e.text), ['群A的'])
    assert.equal(a.body.来源, 群A)

    const p = await h.调(`${PREFIX}/entries`, { query: { 来源: 私聊, date } })
    assert.deepEqual(p.body.entries.map((e) => e.text), ['私聊的'])

    // overview 也必须只算当前来源
    const o = await h.调(`${PREFIX}/overview`, { query: { 来源: 群A } })
    assert.equal(o.status, 200)
    assert.equal(o.body.来源, 群A)
    const 天 = o.body.日记列表.find((x) => x.date === date)
    assert.equal(天.count, 1, '群A 的概览里这一天应当只有 1 条')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  }
})

test('路由：同一 cid 在两个来源里各指各的', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iso-r-'))
  const vault = await mkdtemp(join(tmpdir(), 'iso-rv-'))
  try {
    const date = '2026-11-03'
    // 两个来源各有一条 cid 叫 c1 的候选
    await store.写候选(root, 私聊, date, {
      sources: ['私聊.txt'],
      总行数: 1,
      items: [{ cid: 'c1', 时间: '10:00:00', 昵称: '小鱼儿', 内容: '私聊候选', 命中: [], 状态: 'pending', 条目id: '' }],
    })
    await store.写候选(root, 群A, date, {
      sources: ['群730783833.txt'],
      总行数: 1,
      items: [{ cid: 'c1', 时间: '11:00:00', 昵称: '群友', 内容: '群候选', 命中: [], 状态: 'pending', 条目id: '' }],
    })
    const h = await 造宿主(root, vault)

    // 对群A的 c1 点「放进去」
    const r = await h.调(`${PREFIX}/candidates/decide`, {
      method: 'POST', body: { 来源: 群A, date, cid: 'c1', 状态: 'accepted' },
    })
    assert.equal(r.body.ok, true)

    // 群A 的日记多了一条，私聊的一条都没有
    assert.equal((await store.读某天(root, 群A, date)).length, 1)
    assert.equal((await store.读某天(root, 私聊, date)).length, 0, '私聊不该因为群的操作多出条目')

    // 私聊那条候选仍是待定，没被改动
    const 私候选 = await store.读候选(root, 私聊, date)
    assert.equal(私候选.items[0].状态, 'pending')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  }
})

// ── 老数据迁移 ───────────────────────────────────────────────────────────
//
// ⚠️ 这一节曾经写错过，改之前务必读这段：
//    第一版以为老数据「一天一份、不分来源、没法拆」，于是整份塞进了私聊。
//    实际上**每条老日记的 tags[0] 就是 `私聊` 或 `群聊`**，47 条全部有标签、
//    没有一条同时带两个 —— 完全可以无损拆开。下面每条测试都在钉住这件事。

/** 造一条老格式的条目：tags 第一个元素是来源。 */
function 老条目 (id, 来源标签, 文本) {
  return { id, title: '', text: 文本, tags: [来源标签, '杂项'], at: '' }
}

test('迁移：按 tags 的 私聊/群聊 拆成两本，一条不丢不重', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mig-'))
  try {
    const date = '2026-10-29'
    await mkdir(join(root, 'entries'), { recursive: true })
    const 老内容 = {
      version: 1,
      date,
      entries: [
        老条目('d1', '私聊', '她问我还要不要叫她管理员'),
        老条目('d2', '群聊', '冥月请风拿人情世故考我'),
        老条目('d3', '私聊', '她说怎么私聊群聊性格差距有点大'),
        老条目('d4', '群聊', '灰狐问我你会做什么'),
      ],
    }
    await writeFile(join(root, 'entries', `${date}.json`), JSON.stringify(老内容, null, 2))

    const r = await store.迁移老数据(root, { 群来源: 群A })
    assert.equal(r.私聊条, 2, `私聊应当 2 条，实际 ${r.私聊条}`)
    assert.equal(r.群聊条, 2, `群聊应当 2 条，实际 ${r.群聊条}`)
    assert.equal(r.有群聊没去处, false)

    const 私 = (await store.读某天(root, 私聊, date)).map((e) => e.text)
    const 群 = (await store.读某天(root, 群A, date)).map((e) => e.text)
    assert.deepEqual(私.sort(), ['她问我还要不要叫她管理员', '她说怎么私聊群聊性格差距有点大'].sort())
    assert.deepEqual(群.sort(), ['冥月请风拿人情世故考我', '灰狐问我你会做什么'].sort(),
      '群聊条目绝不能留在私聊那本里')

    // 原文原样备份
    assert.deepEqual(JSON.parse(await readFile(join(r.备份目录, `${date}.json`), 'utf8')), 老内容)

    // 老文件搬走后删掉，幂等
    await assert.rejects(() => stat(join(root, 'entries', `${date}.json`)))
    assert.equal((await store.迁移老数据(root, { 群来源: 群A })).搬了, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('迁移：没给群来源时群聊条目留着不搬，老文件也不删', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mig-'))
  try {
    const date = '2026-10-29'
    await mkdir(join(root, 'entries'), { recursive: true })
    await writeFile(join(root, 'entries', `${date}.json`), JSON.stringify({
      version: 1, date, entries: [老条目('d1', '私聊', '私聊的事'), 老条目('d2', '群聊', '群里的事')],
    }))

    const r = await store.迁移老数据(root, {})
    assert.equal(r.私聊条, 1)
    assert.equal(r.群聊条, 0)
    assert.equal(r.有群聊没去处, true, '应当报告「有群聊没去处」')
    // 关键：老文件必须还在，否则群里那条就永久丢了
    assert.ok(await stat(join(root, 'entries', `${date}.json`)), '老文件必须保留')
    // 私聊那本只拿到私聊那条
    assert.deepEqual((await store.读某天(root, 私聊, date)).map((e) => e.text), ['私聊的事'])
    // 群里那本不该被凭空造出来
    assert.deepEqual(await store.列出日期(root, 群A), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('迁移：没有来源标签的条目归私聊，但记进「猜过来源」供复核', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mig-'))
  try {
    const date = '2026-11-01'
    await mkdir(join(root, 'entries'), { recursive: true })
    await writeFile(join(root, 'entries', `${date}.json`), JSON.stringify({
      version: 1, date, entries: [{ id: 'd1', title: '', text: '没打标签的一条', tags: ['杂项'], at: '' }],
    }))
    const r = await store.迁移老数据(root, { 群来源: 群A })
    assert.equal(r.私聊条, 1)
    assert.equal(r.猜过来源.length, 1, '要记下来让人能查')
    assert.match(r.猜过来源[0], /没打标签的一条/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('修复：早期误塞进私聊的群聊条目能被挑回群里', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fix-'))
  try {
    const date = '2026-10-29'
    // 模拟第一版迁移的错误结果：私聊那本混进了群聊条目
    await store.写某天(root, 私聊, date, [
      { id: 'd1', text: '私聊的事', tags: ['私聊'], at: '' },
      { id: 'd2', text: '群里的事', tags: ['群聊'], at: '' },
    ])
    const r = await store.修复误迁的群聊(root, { 群来源: 群A })
    assert.equal(r.挪了, 1)
    assert.deepEqual((await store.读某天(root, 私聊, date)).map((e) => e.text), ['私聊的事'])
    assert.deepEqual((await store.读某天(root, 群A, date)).map((e) => e.text), ['群里的事'])

    // 幂等：再跑一次什么都不挪
    assert.equal((await store.修复误迁的群聊(root, { 群来源: 群A })).挪了, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('修复：群来源不合法时直接拒绝，不动任何数据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fix-'))
  try {
    await assert.rejects(() => store.修复误迁的群聊(root, { 群来源: 'private' }), /必须是 group:/)
    await assert.rejects(() => store.修复误迁的群聊(root, {}), /必须是 group:/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('迁移：私聊视角已有同一天数据时不覆盖老文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mig-'))
  try {
    const date = '2026-11-01'
    await store.追加条目(root, 私聊, date, { text: '新结构里已经有的' })
    await mkdir(join(root, 'entries'), { recursive: true })
    await writeFile(join(root, 'entries', `${date}.json`), JSON.stringify({
      version: 1, date, entries: [老条目('d1', '私聊', '老版本的内容')],
    }))

    const r = await store.迁移老数据(root, { 群来源: 群A })
    assert.ok(r.跳过.length > 0, '应当跳过这一天而不是覆盖')
    assert.deepEqual((await store.读某天(root, 私聊, date)).map((e) => e.text),
      ['新结构里已经有的'], '新数据优先，老数据不覆盖')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('待归属清单：同时看老文件和误迁进私聊的两处', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pend-'))
  try {
    // 1) 老文件里有一条群聊
    await mkdir(join(root, 'entries'), { recursive: true })
    await writeFile(join(root, 'entries', '2026-10-29.json'), JSON.stringify({
      version: 1, date: '2026-10-29',
      entries: [老条目('d1', '私聊', '私聊的'), 老条目('d2', '群聊', '老文件里的群聊')],
    }))
    // 2) 私聊那本里也误塞了一条群聊
    await store.写某天(root, 私聊, '2026-11-01', [
      { id: 'd3', text: '误迁进私聊的群聊', tags: ['群聊'], at: '' },
    ])

    const r = await store.列出待归属老条目(root)
    assert.equal(r.总数, 2, `两处都要看到，实际 ${r.总数}`)
    assert.equal(r.天数, 2)
    const 文本 = r.待归属.map((x) => x.text).sort()
    assert.deepEqual(文本, ['老文件里的群聊', '误迁进私聊的群聊'].sort())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('待归属清单：全归位后归零', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pend-'))
  try {
    await mkdir(join(root, 'entries'), { recursive: true })
    await writeFile(join(root, 'entries', '2026-10-29.json'), JSON.stringify({
      version: 1, date: '2026-10-29', entries: [老条目('d1', '群聊', '群里的事')],
    }))
    assert.equal((await store.列出待归属老条目(root)).总数, 1)

    await store.迁移老数据(root, { 群来源: 群A })
    assert.equal((await store.列出待归属老条目(root)).总数, 0, '迁移指定群后应当归零')
    assert.deepEqual((await store.读某天(root, 群A, '2026-10-29')).map((e) => e.text), ['群里的事'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 按群昵称分群 ─────────────────────────────────────────────────────────
//
// ⚠️ 这个功能的分母很大、分子很小，测试必须钉住「不确定就不硬塞」这一条：
//    真实数据 34 条里只有 1 条能判，如果实现把低分也当成答案，
//    32 条会被塞进错误的群，而且用户看不出来。

test('昵称分群：只有一个群命中才判「能定」', () => {
  const 待 = [{ 日期: '2026-10-29', id: 'd1', text: '冥月请风拿人情世故考我', tags: ['群聊', '冥月请风', '人情世故'] }]
  const r = store.按昵称猜归属(待, {
    [群A]: ['冥月请风', '灰狐', '龙娘'],
    [群B]: ['借老婆下局还', '远航'],
  })
  assert.equal(r[0].判定, '能定')
  assert.equal(r[0].归属, 群A)
  assert.match(r[0].依据, /冥月请风/)
})

test('昵称分群：两个群都有命中时判「判不了」，不硬塞', () => {
  const 待 = [{ 日期: '2026-11-01', id: 'd2', text: '过客家的小鱼儿说的话', tags: ['群聊', '过客家的小鱼儿'] }]
  const r = store.按昵称猜归属(待, {
    [群A]: ['过客家的小鱼儿'],
    [群B]: ['过客家的小鱼儿'], // 这个名字两个群都有
  })
  assert.equal(r[0].判定, '判不了')
  assert.equal(r[0].归属, '', '判不了时绝不能给归属')
  assert.match(r[0].依据, /多个群/)
})

test('昵称分群：人名都查不到时判「无依据」', () => {
  const 待 = [{ 日期: '2026-10-30', id: 'd3', text: '灰狐问我', tags: ['群聊', '灰狐', '问答'] }]
  const r = store.按昵称猜归属(待, {
    [群A]: ['龙娘', '迟迟'],
    [群B]: ['远航'],
  })
  assert.equal(r[0].判定, '无依据')
  assert.equal(r[0].归属, '')
})

test('昵称分群：「群聊」标签本身不算人名，不会被误判成命中', () => {
  const 待 = [{ 日期: '2026-10-30', id: 'd4', text: 'x', tags: ['群聊', '-'] }]
  // 万一某个群真有个成员叫「群聊」或「-」，也不该靠这个判定
  const r = store.按昵称猜归属(待, { [群A]: ['群聊', '-'] })
  assert.equal(r[0].判定, '无依据')
})

test('归到指定群：只挪点名的那几条，老文件里其余的原样留着', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asg-'))
  try {
    const date = '2026-10-29'
    await mkdir(join(root, 'entries'), { recursive: true })
    await writeFile(join(root, 'entries', `${date}.json`), JSON.stringify({
      version: 1, date,
      entries: [
        老条目('d1', '群聊', '能定的那条'),
        老条目('d2', '群聊', '判不了的那条'),
        老条目('d3', '私聊', '私聊的'),
      ],
    }))

    const r = await store.归到指定群(root, 群A, [{ 日期: date, id: 'd1' }])
    assert.equal(r.归入, 1)
    assert.deepEqual((await store.读某天(root, 群A, date)).map((e) => e.text), ['能定的那条'])

    // 老文件还在（因为还有 d2/d3 没归位），且那两条一条没少
    const 老 = JSON.parse(await readFile(join(root, 'entries', `${date}.json`), 'utf8'))
    assert.deepEqual(老.entries.map((e) => e.id).sort(), ['d2', 'd3'], '没点名的必须还在')

    // 再跑一次不会重复加
    const r2 = await store.归到指定群(root, 群A, [{ 日期: date, id: 'd1' }])
    assert.equal(r2.归入, 0)
    assert.equal((await store.读某天(root, 群A, date)).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('归到指定群：也能把误迁进私聊的那条挪走', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asg-'))
  try {
    const date = '2026-11-01'
    await store.写某天(root, 私聊, date, [
      { id: 'd9', text: '误迁进私聊的群聊', tags: ['群聊'], at: '' },
      { id: 'd10', text: '真正的私聊', tags: ['私聊'], at: '' },
    ])
    const r = await store.归到指定群(root, 群A, [{ 日期: date, id: 'd9' }])
    assert.equal(r.归入, 1)
    assert.deepEqual((await store.读某天(root, 私聊, date)).map((e) => e.text), ['真正的私聊'])
    assert.deepEqual((await store.读某天(root, 群A, date)).map((e) => e.text), ['误迁进私聊的群聊'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('归到指定群：目标群不合法时直接拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asg-'))
  try {
    await assert.rejects(() => store.归到指定群(root, 'private', []), /必须是 group:/)
    await assert.rejects(() => store.归到指定群(root, '瞎写', []), /必须是 group:/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
