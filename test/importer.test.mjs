// 导入功能单测：解析各种外部格式 + 写进日记库的幂等性 + 来源隔离。
//
// 运行：node --test test/*.test.mjs
//
// 【这个文件守什么】
//   1. 每种格式都能解析出条目（Day One / 通用 JSON / JSONL / Markdown / byDate）
//   2. Day One 的日期认 creationDate —— 认不出来会把日期全变成今天且不报错，
//      这条测试就是守着那个静默失效
//   3. 幂等：同一个文件导两次，第二次一条都不新增
//   4. 来源隔离：导入到 private 的内容，在 group 那本里搜不到
//   5. 导入的条目作者是 owner（主人手记），不是 xi（鱼自己写的）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import * as importer from '../lib/importer.js'

async function 临时库 () {
  const d = await mkdtemp(join(tmpdir(), 'diary-import-'))
  await mkdir(join(d, 'entries'), { recursive: true })
  return d
}

const 写 = (rootDir, 来源, 条目, 日期 = '2026-11-03', 干跑 = false) =>
  importer.写入日记({ rootDir, 来源, 条目, 日期, 干跑, 追加条目: store.追加条目, 读某天: store.读某天 })

// ── 解析：Day One ──────────────────────────────────────────────────────
test('解析 Day One：日期认 creationDate，不退回今天', () => {
  const r = importer.导入文件({
    内容: JSON.stringify({
      entries: [{
        text: '今天他第一次喊我主人。',
        creationDate: '2026-10-29T21:30:00Z',
        uuid: 'AAA-111',
        tags: ['私聊'],
      }],
    }),
    预设: 'dayone',
  })
  assert.equal(r.ok, true)
  assert.equal(r.条目.length, 1)
  // 关键断言：不是「今天」，是原文里的 10-29
  assert.equal(r.条目[0].日期, '2026-10-29')
  assert.equal(r.条目[0].正文, '今天他第一次喊我主人。')
  assert.deepEqual(r.条目[0].标签, ['私聊'])
})

test('解析 Day One：空正文的记录被跳过并计数', () => {
  const r = importer.导入文件({
    内容: JSON.stringify([
      { text: '', creationDate: '2026-10-29T00:00:00Z' },
      { text: '有内容的一条', creationDate: '2026-10-30T00:00:00Z' },
    ]),
    预设: 'dayone',
  })
  assert.equal(r.条目.length, 1)
  assert.equal(r.跳过, 1)
})

// ── 解析：通用 JSON ────────────────────────────────────────────────────
test('解析通用 JSON：content + date 组合', () => {
  const r = importer.导入文件({
    内容: JSON.stringify([
      { content: '他说要回来了。', date: '2026-10-31', title: '回来' },
    ]),
    预设: 'generic',
  })
  assert.equal(r.ok, true)
  assert.equal(r.条目[0].日期, '2026-10-31')
  assert.equal(r.条目[0].标题, '回来')
})

test('解析：字段名对不上时明确报错，并提示用字段映射', () => {
  const r = importer.导入文件({
    内容: JSON.stringify([{ 胡说: 'x', 八道: 'y' }]),
    预设: 'auto',
  })
  assert.equal(r.ok, false)
  assert.match(r.错误, /字段映射/)
})

test('解析：自定义字段映射能救回字段名对不上的文件', () => {
  const r = importer.导入文件({
    内容: JSON.stringify([{ 我的正文: '这是一条日记', 我的日期: '2026-11-01' }]),
    字段映射: { text: '我的正文', date: '我的日期' },
  })
  assert.equal(r.ok, true)
  assert.equal(r.条目[0].正文, '这是一条日记')
  assert.equal(r.条目[0].日期, '2026-11-01')
})

// ── 解析：JSONL ────────────────────────────────────────────────────────
test('解析 JSONL：每行一个对象', () => {
  const 内容 = [
    JSON.stringify({ text: '第一条', date: '2026-11-01' }),
    JSON.stringify({ text: '第二条', date: '2026-11-02' }),
  ].join('\n')
  const r = importer.导入文件({ 内容 })
  assert.equal(r.shape, undefined) // 不对外承诺这个字段名
  assert.equal(r.条目.length, 2)
  assert.equal(r.条目[1].日期, '2026-11-02')
})

// ── 解析：Markdown ────────────────────────────────────────────────────
test('解析 Markdown：按日期标题切分', () => {
  const 内容 = [
    '# 我的日记',
    '',
    '## 2026-10-29',
    '',
    '他问我还在不在。',
    '',
    '## 2026-10-30',
    '',
    '他说要带我去看海。',
  ].join('\n')
  const r = importer.导入文件({ 内容, 预设: 'markdown' })
  assert.equal(r.ok, true)
  assert.equal(r.条目.length, 2)
  assert.equal(r.条目[0].日期, '2026-10-29')
  assert.equal(r.条目[1].日期, '2026-10-30')
  assert.match(r.条目[0].正文, /他问我还在不在/)
})

test('解析 Markdown：没有日期标题就整篇一条', () => {
  const r = importer.导入文件({ 内容: '今天很平常，没什么事发生。', 预设: 'markdown' })
  assert.equal(r.ok, true)
  assert.equal(r.条目.length, 1)
  assert.equal(r.条目[0].日期, '')   // 没有日期，落盘时用兜底日期
})

// ── 解析：byDate 形状 ─────────────────────────────────────────────────
test('解析 byDate：按日期分组的对象', () => {
  const 内容 = JSON.stringify({
    '2026-10-29': [{ text: 'a 条' }],
    '2026-10-30': [{ text: 'b 条' }, { text: 'c 条' }],
  })
  const r = importer.导入文件({ 内容 })
  assert.equal(r.条目.length, 3)
  assert.deepEqual(r.条目.map((e) => e.日期).sort(), ['2026-10-29', '2026-10-30', '2026-10-30'])
})

// ── 空 / 坏输入 ────────────────────────────────────────────────────────
test('空文件明确报错，不静默成功', () => {
  const r = importer.导入文件({ 内容: '   ' })
  assert.equal(r.ok, false)
  assert.match(r.错误, /空/)
})

// ── 写入：幂等 ────────────────────────────────────────────────────────
test('导入幂等：同一个文件导两次，第二次一条都不新增', async () => {
  const root = await 临时库()
  try {
    const 内容 = JSON.stringify([
      { text: '第一次导入的这条', date: '2026-11-01' },
      { text: '第一次导入的另一条', date: '2026-11-02' },
    ])
    const r1 = importer.导入文件({ 内容, 预设: 'generic' })
    const w1 = await 写(root, 'private', r1.条目)
    assert.equal(w1.新增, 2)
    assert.equal(w1.跳过, 0)

    // 同样的文件再导一次
    const r2 = importer.导入文件({ 内容, 预设: 'generic' })
    const w2 = await 写(root, 'private', r2.条目)
    assert.equal(w2.新增, 0, '第二次不该新增任何条目')
    assert.equal(w2.跳过, 2)

    // 库里确实只有 2 条
    assert.equal((await store.读某天(root, 'private', '2026-11-01')).length, 1)
    assert.equal((await store.读某天(root, 'private', '2026-11-02')).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('导入：正文相同但日期不同算两条（不是重复）', async () => {
  const root = await 临时库()
  try {
    const 条目 = [
      { 日期: '2026-11-01', 标题: '', 正文: '同一句话', 标签: [] },
      { 日期: '2026-11-02', 标题: '', 正文: '同一句话', 标签: [] },
    ]
    const w = await 写(root, 'private', 条目)
    assert.equal(w.新增, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('导入：没有日期的条目归到兜底日期', async () => {
  const root = await 临时库()
  try {
    const w = await 写(root, 'private', [{ 日期: '', 标题: '', 正文: '没写日期的一条', 标签: [] }], '2026-11-05')
    assert.equal(w.新增, 1)
    assert.equal(w.空日期, 1)
    assert.equal(w.按日期['2026-11-05'], 1)
    assert.equal((await store.读某天(root, 'private', '2026-11-05')).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('导入：干跑不落盘，但数字算得出来', async () => {
  const root = await 临时库()
  try {
    const 条目 = [{ 日期: '2026-11-01', 标题: '', 正文: '干跑的一条', 标签: [] }]
    const w = await 写(root, 'private', 条目, '2026-11-03', true)
    assert.equal(w.新增, 1)
    assert.equal((await store.读某天(root, 'private', '2026-11-01')).length, 0, '干跑不该写盘')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 写入：作者与来源 ──────────────────────────────────────────────────
test('导入的条目作者是 owner（主人手记），不是 xi', async () => {
  const root = await 临时库()
  try {
    await 写(root, 'private', [{ 日期: '2026-11-01', 标题: '', 正文: '导进来的', 标签: [] }])
    const e = (await store.读某天(root, 'private', '2026-11-01'))[0]
    assert.equal(e.作者, 'owner')
    assert.equal(e.来源, '导入')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('来源隔离：导入到 private 的内容不出现在群里那本', async () => {
  const root = await 临时库()
  try {
    await 写(root, 'private', [{ 日期: '2026-11-01', 标题: '', 正文: '私聊独有的一句', 标签: [] }])
    assert.equal((await store.读某天(root, 'group:730783833', '2026-11-01')).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('同一份文件导进两个来源：两边都有，互不可见', async () => {
  const root = await 临时库()
  try {
    const 条目 = [{ 日期: '2026-11-01', 标题: '', 正文: '两个来源都导了', 标签: [] }]
    await 写(root, 'private', 条目)
    await 写(root, 'group:730783833', 条目)
    assert.equal((await store.读某天(root, 'private', '2026-11-01')).length, 1)
    assert.equal((await store.读某天(root, 'group:730783833', '2026-11-01')).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 指纹 ──────────────────────────────────────────────────────────────
test('指纹：同日期同正文稳定，改标题不影响', () => {
  const a = importer.条目指纹({ 日期: '2026-11-01', text: '正文', 标题: 'A' })
  const b = importer.条目指纹({ 日期: '2026-11-01', text: '正文', 标题: 'B' })
  assert.equal(a, b)
  const c = importer.条目指纹({ 日期: '2026-11-02', text: '正文' })
  assert.notEqual(a, c)
})

test('预设清单里 auto 排第一（默认值）', () => {
  assert.equal(importer.内置预设()[0].名, 'auto')
})
