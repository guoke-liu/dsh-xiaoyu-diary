// 后台挑选任务（llm-pick-async）的测试 —— 2026-11-03 起该功能已关闭。
//
// 主人要求：「关掉自动大模型筛选功能」。异步任务那种"开了就在后台自己跑"的形式
// 正是"自动"的来源，所以 /llm-pick-async 现在直接回 403，不再开任务。
//
// 这里保留一条测试钉住"它确实是关着的"，防止哪天被谁改回去。
// 其余原来测"任务能开、能轮询、能取消"的用例都删了 —— 功能没了，测它没有意义。
// 想恢复这个功能：把 lib/routes.js 里 llm-pick-async 那个 403 守卫删掉，
// 再把这些测试按 git 历史改回来。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 注册路由, PREFIX } from '../lib/routes.js'

async function 造宿主 (rootDir, vaultDir) {
  const 路由表 = new Map()
  const ctx = {
    webServer: { register: ({ path, handler }) => { 路由表.set(path, handler) } },
    effect: (fn) => fn(),
  }
  注册路由(ctx, { rootDir: () => rootDir, vaultDir: () => vaultDir, log: () => {} })
  async function 调 (路径, body) {
    const handler = 路由表.get(路径)
    if (!handler) throw new Error(`没有这条路由：${路径}`)
    let status = 200
    let payload = ''
    const req = {
      method: 'POST',
      url: 路径,
      body: JSON.stringify(body || {}),
      async *[Symbol.asyncIterator] () {},
    }
    const res = { writeHead: (c) => { status = c }, end: (b) => { payload = b || '' } }
    await handler(req, res)
    let json = null
    try { json = JSON.parse(payload) } catch {}
    return { status, body: json }
  }
  return { 调 }
}

test('自动筛选已关闭：llm-pick-async 直接回 403，不开任务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'as-'))
  const vault = await mkdtemp(join(tmpdir(), 'av-'))
  try {
    const h = await 造宿主(root, vault)
    const r = await h.调(PREFIX + '/llm-pick-async', { 来源: 'private', date: '2026-11-03' })
    assert.equal(r.status, 403)
    assert.equal(r.body.已关闭, true)
    assert.ok(!r.body.jobId, '不能返回 jobId —— 返回了就说明任务真开了')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  }
})
