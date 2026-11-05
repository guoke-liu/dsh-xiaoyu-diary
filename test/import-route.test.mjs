// 导入路由单测：POST /local/xiaoyu-diary/import 与 GET /import-formats。
//
// 【守什么】
//   1. 不带来源 → 400（绝不能默认塞进私聊）
//   2. 文件内容为空 → 400
//   3. 正常导入 → 200，条数对，落盘能读回来
//   4. 再导一次 → 新增 0、跳过 N（幂等）
//   5. 字段映射写错键 → 400 且说清楚哪个键不认识
//   6. 导入的条目作者是 owner（主人手记）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 注册路由, PREFIX } from '../lib/routes.js'
import { 读某天 } from '../lib/store.js'

async function 造宿主 () {
  const root = await mkdtemp(join(tmpdir(), 'xd-import-route-'))
  await mkdir(join(root, 'entries'), { recursive: true })
  const 路由表 = new Map()
  const ctx = {
    webServer: { register: ({ path, handler }) => { 路由表.set(path, handler) } },
    effect: (fn) => fn(),
    // 不提供 connection：降级放行，测的是路由本身不是鉴权
    get: () => { throw new Error('no connection service') },
  }
  注册路由(ctx, { rootDir: () => root, vaultDir: () => root, log: () => {} })

  async function 调 (路径, { method = 'GET', body } = {}) {
    const handler = 路由表.get(路径)
    if (!handler) throw new Error(`没有这条路由：${路径}`)
    let status = 200
    let payload = ''
    const req = {
      method,
      url: 路径,
      body,                       // 取body 会优先读 req.body
      async *[Symbol.asyncIterator] () {},
    }
    const res = { writeHead: (c) => { status = c }, end: (b) => { payload = b || '' } }
    await handler(req, res)
    let json = null
    try { json = JSON.parse(payload) } catch { /* 非 JSON */ }
    return { status, raw: payload, json }
  }
  return { 调, root }
}

const 样例 = JSON.stringify([
  { content: '九月那天他第一次喊我主人。', date: '2026-09-01' },
  { content: '十月初他带我去看了海。', date: '2026-10-01' },
])

test('导入路由：不带来源 → 400，且提示里说清楚要带来源', async () => {
  const { 调, root } = await 造宿主()
  try {
    const r = await 调(`${PREFIX}/import`, {
      method: 'POST',
      body: { 内容: 样例, 格式预设: 'generic' },
    })
    assert.equal(r.status, 400)
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /来源/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('导入路由：来源写错 → 400，回显写错的值', async () => {
  const { 调, root } = await 造宿主()
  try {
    const r = await 调(`${PREFIX}/import`, {
      method: 'POST',
      body: { 来源: '群聊', 内容: 样例 },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /群聊/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('导入路由：内容为空 → 400', async () => {
  const { 调, root } = await 造宿主()
  try {
    const r = await 调(`${PREFIX}/import`, {
      method: 'POST',
      body: { 来源: 'private', 内容: '   ' },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /空/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('导入路由：正常导入 → 200，条数与落盘都对', async () => {
  const { 调, root } = await 造宿主()
  try {
    const r = await 调(`${PREFIX}/import`, {
      method: 'POST',
      body: { 来源: 'private', 内容: 样例, 格式预设: 'generic' },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.新增, 2)
    assert.equal(r.json.跳过, 0)
    assert.equal(r.json.来源, 'private')
    // 按日期是数组形式（宿主 schema 限制决定的，不是审美）
    assert.ok(Array.isArray(r.json.按日期))
    assert.deepEqual(r.json.按日期.map((x) => x.日期).sort(), ['2026-09-01', '2026-10-01'])
    // 真的落盘了
    assert.equal((await 读某天(root, 'private', '2026-09-01')).length, 1)
    assert.equal((await 读某天(root, 'private', '2026-10-01')).length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('导入路由：导第二次是幂等的（新增 0，跳过 2）', async () => {
  const { 调, root } = await 造宿主()
  try {
    await 调(`${PREFIX}/import`, {
      method: 'POST',
      body: { 来源: 'private', 内容: 样例, 格式预设: 'generic' },
    })
    const r2 = await 调(`${PREFIX}/import`, {
      method: 'POST',
      body: { 来源: 'private', 内容: 样例, 格式预设: 'generic' },
    })
    assert.equal(r2.json.新增, 0)
    assert.equal(r2.json.跳过, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('导入路由：干跑不写盘', async () => {
  const { 调, root } = await 造宿主()
  try {
    const r = await 调(`${PREFIX}/import`, {
      method: 'POST',
      body: { 来源: 'private', 内容: 样例, 格式预设: 'generic', 干跑: true },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.干跑, true)
    assert.equal((await 读某天(root, 'private', '2026-09-01')).length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('导入路由：字段映射键写错 → 400 且点名哪个键', async () => {
  const { 调, root } = await 造宿主()
  try {
    const r = await 调(`${PREFIX}/import`, {
      method: 'POST',
      body: { 来源: 'private', 内容: 样例, 字段映射: { 正文: 'content' } },
    })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /正文/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('导入路由：字段映射能救回字段名对不上的文件', async () => {
  const { 调, root } = await 造宿主()
  try {
    const 怪格式 = JSON.stringify([{ 我的正文: '字段名很怪的一条', 我的日期: '2026-08-08' }])
    const r = await 调(`${PREFIX}/import`, {
      method: 'POST',
      body: {
        来源: 'private',
        内容: 怪格式,
        字段映射: JSON.stringify({ text: '我的正文', date: '我的日期' }),
      },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.新增, 1)
    const e = (await 读某天(root, 'private', '2026-08-08'))[0]
    assert.equal(e.text, '字段名很怪的一条')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('导入路由：导进来的条目作者是 owner，来源标记是「导入」', async () => {
  const { 调, root } = await 造宿主()
  try {
    await 调(`${PREFIX}/import`, {
      method: 'POST',
      body: { 来源: 'private', 内容: 样例, 格式预设: 'generic' },
    })
    const e = (await 读某天(root, 'private', '2026-09-01'))[0]
    assert.equal(e.作者, 'owner')
    assert.equal(e.来源, '导入')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('导入路由：GET 方法被拒（只接受 POST）', async () => {
  const { 调, root } = await 造宿主()
  try {
    const r = await 调(`${PREFIX}/import`, { method: 'GET' })
    assert.equal(r.status, 405)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('导入格式清单：GET 返回预设列表，auto 排第一', async () => {
  const { 调, root } = await 造宿主()
  try {
    const r = await 调(`${PREFIX}/import-formats`)
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.ok(Array.isArray(r.json.预设))
    assert.ok(r.json.预设.length >= 5)
    assert.equal(r.json.预设[0].名, 'auto')
  } finally { await rm(root, { recursive: true, force: true }) }
})
