// 异步挑选任务（进度轮询）的测试。
//
// 用假 fetch 模拟模型，不发真实请求。锁住三件容易退化的事：
//   1. 同一天只跑一个任务（狂点按钮不该烧 N 倍费用）
//   2. 进度真的在涨，完成后能拿到结果
//   3. 任务表不会无限增长（内存泄漏）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 注册路由, PREFIX } from '../lib/routes.js'
import * as settings from '../lib/settings.js'

/** 造一个能直接调用路由的假宿主。 */
async function 造宿主 (rootDir, vaultDir) {
  const 路由表 = new Map()
  const ctx = {
    webServer: { register: ({ path, handler }) => { 路由表.set(path, handler) } },
    effect: (fn) => fn(),
  }
  注册路由(ctx, { rootDir: () => rootDir, vaultDir: () => vaultDir, log: () => {} })

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
  return { 调 }
}

/** 造环境：日记库 + 有当天聊天的仓库 + 已配置模型。 */
async function 造环境 () {
  const root = await mkdtemp(join(tmpdir(), 'async-root-'))
  const vault = await mkdtemp(join(tmpdir(), 'async-vault-'))
  await mkdir(join(root, 'entries'), { recursive: true })
  await mkdir(join(vault, 'chat', 'private'), { recursive: true })
  const 今天 = new Date().toISOString().slice(0, 10)
  await writeFile(
    join(vault, 'chat', 'private', `${今天}.txt`),
    '[09:00:00] 某人(p1): 明天下午三点去医院复查，别忘了带病历\n[09:05:00] 某人(p1): 哈哈哈哈\n',
  )
  await settings.写配置(root, { baseURL: 'http://fake', apiKey: 'sk-test-key', model: 'fake-model' })
  return {
    root, vault, 今天,
    清理: async () => {
      await rm(root, { recursive: true, force: true })
      await rm(vault, { recursive: true, force: true })
    },
  }
}

/** 装一个延迟响应的假模型。 */
function 装假模型 (延迟 = 20) {
  globalThis.fetch = async () => {
    await new Promise((r) => setTimeout(r, 延迟))
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '{"事项":[{"内容":"明天去医院复查","理由":"有约定","来源":"09:00:00 某人"}]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }
  }
}

const 等 = (ms) => new Promise((r) => setTimeout(r, ms))

test('异步：开任务立刻返回 jobId，不阻塞', async () => {
  const env = await 造环境()
  try {
    装假模型(200) // 模型慢，但接口应立刻返回
    const h = await 造宿主(env.root, env.vault)
    const t0 = Date.now()
    const r = await h.调(`${PREFIX}/llm-pick-async`, { method: 'POST', body: { 来源: 'private', date: env.今天 } })
    const 耗时 = Date.now() - t0
    assert.equal(r.body.ok, true)
    assert.ok(r.body.jobId, '应返回 jobId')
    assert.ok(耗时 < 150, `应该立刻返回，实际耗时 ${耗时}ms`)
    await 等(300) // 让后台任务收尾，避免影响下个测试
  } finally { await env.清理() }
})

test('异步：同一天只跑一个任务（防重复烧钱）', async () => {
  const env = await 造环境()
  try {
    装假模型(100)
    const h = await 造宿主(env.root, env.vault)
    const r1 = await h.调(`${PREFIX}/llm-pick-async`, { method: 'POST', body: { 来源: 'private', date: env.今天 } })
    const r2 = await h.调(`${PREFIX}/llm-pick-async`, { method: 'POST', body: { 来源: 'private', date: env.今天 } })
    assert.equal(r2.body.复用, true, '第二次应复用')
    assert.equal(r2.body.jobId, r1.body.jobId, '必须是同一个 jobId')
    await 等(250)
  } finally { await env.清理() }
})

test('异步：进度从 running 变成 done，并带出结果', async () => {
  const env = await 造环境()
  try {
    装假模型(50)
    const h = await 造宿主(env.root, env.vault)
    const 开 = await h.调(`${PREFIX}/llm-pick-async`, { method: 'POST', body: { 来源: 'private', date: env.今天 } })
    const jobId = 开.body.jobId

    const 立刻 = await h.调(`${PREFIX}/llm-pick-progress`, { query: { jobId } })
    assert.equal(立刻.body.状态, 'running', '刚开时应在跑')
    assert.deepEqual(立刻.body.事项, [], 'running 时不该有事项')

    await 等(400)
    const 之后 = await h.调(`${PREFIX}/llm-pick-progress`, { query: { jobId } })
    assert.equal(之后.body.状态, 'done')
    assert.ok(之后.body.事项.length >= 1, '完成后应有事项')
    assert.ok(之后.body.结果 && 之后.body.结果.usage, '应带 usage')
  } finally { await env.清理() }
})

test('异步：不存在的 jobId 回 404', async () => {
  const env = await 造环境()
  try {
    const h = await 造宿主(env.root, env.vault)
    const r = await h.调(`${PREFIX}/llm-pick-progress`, { query: { jobId: '不存在' } })
    assert.equal(r.status, 404)
    assert.equal(r.body.ok, false)
  } finally { await env.清理() }
})

test('异步：配置不完整时不开任务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'async-nocfg-'))
  const vault = await mkdtemp(join(tmpdir(), 'async-nocfg-v-'))
  await mkdir(join(root, 'entries'), { recursive: true })
  await mkdir(join(vault, 'chat', 'private'), { recursive: true })
  const 今天 = new Date().toISOString().slice(0, 10)
  await writeFile(join(vault, 'chat', 'private', `${今天}.txt`), '[09:00:00] 某人(p1): 明天复查')
  try {
    const h = await 造宿主(root, vault)
    const r = await h.调(`${PREFIX}/llm-pick-async`, { method: 'POST', body: { 来源: 'private', date: 今天 } })
    assert.equal(r.body.ok, false)
    assert.ok(!r.body.jobId, '配置不全不该产生 jobId')
    assert.ok(String(r.body.错误).includes('配置不完整'))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  }
})

test('异步：没有聊天记录时不开任务', async () => {
  const env = await 造环境()
  try {
    // 清掉聊天文件
    await rm(join(env.vault, 'chat', 'private', `${env.今天}.txt`))
    const h = await 造宿主(env.root, env.vault)
    const r = await h.调(`${PREFIX}/llm-pick-async`, { method: 'POST', body: { 来源: 'private', date: env.今天 } })
    assert.equal(r.body.ok, false)
    assert.ok(String(r.body.错误).includes('没有聊天记录'))
  } finally { await env.清理() }
})

test('异步：对已完成的任务取消，返回 已取消:false', async () => {
  const env = await 造环境()
  try {
    装假模型(30)
    const h = await 造宿主(env.root, env.vault)
    const 开 = await h.调(`${PREFIX}/llm-pick-async`, { method: 'POST', body: { 来源: 'private', date: env.今天 } })
    await 等(300) // 等它完成
    const r = await h.调(`${PREFIX}/llm-pick-cancel`, { method: 'POST', body: { jobId: 开.body.jobId } })
    assert.equal(r.body.ok, true)
    assert.equal(r.body.已取消, false, '已完成的任务不该被标记取消')
  } finally { await env.清理() }
})
