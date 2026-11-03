// ============================================================================
// auth.test.mjs —— 锁住「UI 路由必须认宿主的浏览器认证」
//
// 【这条测试防什么】
//   DSH 的 token 栅栏只管首页（dsh-host-frontend-static 里只有 index 走
//   authorizeIndex），**插件注册的路由它一律不验**。DSH 本来只听 127.0.0.1，
//   所以早年没事；一旦经 nginx 把 /dsh/ 反代出去，插件路由就能被任何人裸调。
//   2026-11-03 实测：不带任何 cookie 请求 /dsh/local/xiaoyu-diary/sources → 200。
//   日记是私密数据，不能靠「路径猜不到」来保护。
//
// 【怎么测】
//   宿主的认证器是 ctx.get('connection').browserAuth.isAuthenticated(req, secure)。
//   这里造两种宿主：有认证器（要能拦）和没有认证器（要降级放行）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 注册路由, PREFIX } from '../lib/routes.js'

/** 造宿主；`认证` 决定假认证器怎么判。 */
async function 造宿主 (rootDir, { 有认证器 = true, 放行 = true } = {}) {
  const 路由表 = new Map()
  const 鉴权调用 = []
  const ctx = {
    webServer: { register: ({ path, handler }) => { 路由表.set(path, handler) } },
    effect: (fn) => fn(),
    get: (name) => {
      if (name !== 'connection') return undefined
      if (!有认证器) throw new Error('no connection service')
      return {
        browserAuth: {
          isAuthenticated: (req, secure) => { 鉴权调用.push({ secure }); return 放行 },
        },
      }
    },
  }
  注册路由(ctx, { rootDir: () => rootDir, vaultDir: () => rootDir, log: () => {} })

  async function 调 (路径, { method = 'GET' } = {}) {
    const handler = 路由表.get(路径)
    if (!handler) throw new Error(`没有这条路由：${路径}`)
    let status = 200
    let payload = ''
    const req = {
      method,
      url: 路径,
      async *[Symbol.asyncIterator] () { /* 没有流 */ },
    }
    const res = { writeHead: (c) => { status = c }, end: (b) => { payload = b || '' } }
    await handler(req, res)
    return { status, raw: payload }
  }
  return { 调, 鉴权调用, 路由表 }
}

async function 造目录 () {
  const root = await mkdtemp(join(tmpdir(), 'xd-auth-'))
  await mkdir(join(root, 'entries'), { recursive: true })
  return root
}

test('鉴权：没有有效 cookie 时，路由回 401 且不吐任何数据', async () => {
  const root = await 造目录()
  try {
    const { 调, 鉴权调用 } = await 造宿主(root, { 放行: false })
    const r = await 调(`${PREFIX}/sources`)
    assert.equal(r.status, 401)
    // 关键：**不能**吐 JSON 数据。断言响应体里没有日记内容
    assert.equal(r.raw.includes('来源们'), false, '401 时不该带任何业务数据')
    assert.ok(r.raw.includes('authentication'), '401 文案应说明需要认证')
    assert.equal(鉴权调用.length, 1, '必须真的调过宿主的 isAuthenticated')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('鉴权：所有 16 条路由都过闸门（漏一条就是后门）', async () => {
  const root = await 造目录()
  try {
    const { 调, 路由表 } = await 造宿主(root, { 放行: false })
    // PREFIX 下的每条路由都必须回 401 —— 不允许有例外
    const 路由们 = [...路由表.keys()].filter((p) => p.startsWith(PREFIX))
    assert.ok(路由们.length >= 16, `应有 16 条路由，实际 ${路由们.length}`)
    // 新加的 /version 尤其要盯住：它会把「仓库有哪些版本」吐出去，
    // 而且会代替所有人去访问 GitHub。裸奔的话等于给外人一个免费代理。
    assert.ok(路由们.includes(`${PREFIX}/version`), '版本路由必须在闸门后面')
    for (const p of 路由们) {
      const r = await 调(p)
      assert.equal(r.status, 401, `${p} 没走鉴权闸门，回的是 ${r.status}`)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('鉴权：cookie 有效时正常放行，能拿到数据', async () => {
  const root = await 造目录()
  try {
    const { 调 } = await 造宿主(root, { 放行: true })
    const r = await 调(`${PREFIX}/sources`)
    assert.equal(r.status, 200)
    assert.ok(r.raw.includes('来源们'), '放行后应该回正常 JSON')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('鉴权：宿主没有 connection 服务时降级放行（本地开发/单测不能整块挂掉）', async () => {
  const root = await 造目录()
  try {
    const { 调 } = await 造宿主(root, { 有认证器: false })
    const r = await 调(`${PREFIX}/sources`)
    assert.equal(r.status, 200)
    assert.ok(r.raw.includes('来源们'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('鉴权：HEAD 请求回 401 但不带响应体', async () => {
  const root = await 造目录()
  try {
    const { 调 } = await 造宿主(root, { 放行: false })
    const r = await 调(`${PREFIX}/sources`, { method: 'HEAD' })
    assert.equal(r.status, 401)
    assert.equal(r.raw, '', 'HEAD 不该有 body')
  } finally { await rm(root, { recursive: true, force: true }) }
})
