// ============================================================================
// base.test.mjs —— 锁住「插件接口前缀要跟着页面部署路径走」这条规则
//
// 【这条测试防什么】
//   云端 DSH 挂在 nginx 的 /dsh/ 子路径下（/dsh/ → 反代 127.0.0.1:6600/）。
//   前端如果写死 '/local/xiaoyu-diary'，浏览器会请求 http://<host>/local/...，
//   那里是 noVNC 站点、要 Basic 密码 → 401。手机翻书就是这个症状。
//
// 【不要往 nginx 那头改】曾经试过在 nginx 加一条 `location /local/xiaoyu-diary/`
//   直接代理到 DSH，结果发现 DSH 的插件路由**根本不做 token 校验**
//   （只有首页 index 走 authorizeIndex），等于把日记接口裸放到公网、无 cookie 也 200。
//   所以修法必须在「路径带上前缀」这一侧，不能靠 nginx 直通。
//
// 【怎么测】
//   client.js 不是 ESM 模块（挂在 window.__ModuleLoader__ 上），没法 import。
//   这里把 BASE 那段表达式原文抠出来，用假的 document 求值。
//
// ⚠️ 断言必须站在「站点根」看，不能用 new URL(base, 'http://h/dsh/') ——
//   './x' 在 /dsh/ 下本来就解析成 /dsh/x，那种断言什么实现都能过，等于没测。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const 本目录 = dirname(fileURLToPath(import.meta.url))
const 客户端源码 = readFileSync(join(本目录, '..', 'lib', 'client.js'), 'utf8')

/** 从 client.js 里抠出 `const BASE = (() => {...})();` 这段原文。 */
function 取出BASE表达式() {
  const m = 客户端源码.match(/const BASE = \(\(\) => \{[\s\S]*?\}\)\(\);/)
  assert.ok(m, 'client.js 里找不到 const BASE = (() => {...})(); —— 别改成别的写法，测试靠它取值')
  return m[0]
}

/** 在给定的 document 环境下求出 BASE 的值。 */
function 求BASE(document) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', `${取出BASE表达式()}\nreturn BASE;`)
  return fn(document)
}

test('BASE：站点根部署（本机 http://127.0.0.1:3080/）→ 落在 /local/...', () => {
  const base = 求BASE({})
  assert.equal(base, 'local/xiaoyu-diary')
  // 站点根部署时相对路径 == 绝对路径
  assert.equal(new URL(base + '/sources', 'http://127.0.0.1:3080/').pathname, '/local/xiaoyu-diary/sources')
})

test('BASE：子路径部署（云端 http://<host>/dsh/）→ 必须带上 /dsh/ 前缀', () => {
  const base = 求BASE({})
  // 用相对路径，浏览器按「当前目录 http://h/dsh/」解析 → 必须落到 /dsh/local/...
  assert.equal(new URL(base + '/bookmark', 'http://h/dsh/').pathname, '/dsh/local/xiaoyu-diary/bookmark')
  // 用绝对路径（加前导 /），按站点根解析 → 必须落到 /local/...
  assert.equal(new URL('/' + base + '/bookmark', 'http://h/').pathname, '/local/xiaoyu-diary/bookmark')
  // 反证：如果 BASE 是 '../local/...'，在 /dsh/ 下会逃出前缀、跑到 noVNC 上 401
  assert.notEqual(new URL('../local/xiaoyu-diary/bookmark', 'http://h/dsh/').pathname, '/dsh/local/xiaoyu-diary/bookmark')
})

test('BASE：两级子路径部署（/a/b/）也跟着走', () => {
  const base = 求BASE({})
  assert.equal(new URL(base + '/sources', 'http://h/a/b/').pathname, '/a/b/local/xiaoyu-diary/sources')
})

test('BASE：没有 document（纯 node）时退回绝对路径，不抛异常', () => {
  assert.equal(求BASE(undefined), '/local/xiaoyu-diary')
})

test('BASE：源码里不许出现以 / 开头的写死前缀', () => {
  // 防回归：有人图省事改回 const BASE = '/local/xiaoyu-diary';
  assert.equal(
    /const BASE = '\/local\/xiaoyu-diary';/.test(客户端源码),
    false,
    "client.js 里出现了写死的 const BASE = '/local/xiaoyu-diary' —— 子路径部署会 401",
  )
  // 也不许有人为了「修」401 改成 '../local/...' —— 那会跑到站点根的 /local/（noVNC）
  assert.equal(
    /'\.\.\/local\/xiaoyu-diary'/.test(客户端源码),
    false,
    "client.js 里出现了 '../local/xiaoyu-diary' —— 会逃出 /dsh/ 前缀，落到 noVNC 上 401",
  )
})
