// ============================================================================
// update.test.mjs —— 更新检查的护栏
//
// 【守什么】
//   1. 版本比较：字符串比较是错的（'0.10.0' < '0.9.0' 在字典序下成立），
//      数字段比较才对。这条最容易写错，也最容易没人发现。
//   2. 预发布后缀：1.0.0-test < 1.0.0（semver 约定）。
//   3. 保守原则：解析不了就返回 false，绝不误报「有新版」。
//   4. 挑最新：GitHub tag 列表按名字排序，字典序会把 v0.10 排到 v0.9 前。
//   5. 缓存：匿名 API 每小时 60 次，UI 每开一次页面问一次必然打爆。
//   6. 全部失败路径都返回 { ok:false } 而不是抛 —— 检查更新不能把设置页搞白屏。
//   7. 超时真的会中断（AbortController 生效）。
//
// 【怎么跑】node --test test/*.test.mjs
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  解析版本, 比较版本, 是最新版, 整理发布, 挑最新, 拼更新日志,
  查询最新版本, 清缓存, 默认仓库, 默认缓存毫秒,
} from '../lib/update.js'

// ── 解析版本 ───────────────────────────────────────────────────────────────

test('解析版本：常见写法', () => {
  assert.deepEqual(解析版本('v0.2.0').主, [0, 2, 0])
  assert.deepEqual(解析版本('0.2.0').主, [0, 2, 0])
  assert.deepEqual(解析版本('v0.2.0-test').主, [0, 2, 0])
  assert.equal(解析版本('v0.2.0-test').预发布, 'test')
  assert.equal(解析版本('v0.2.0').预发布, '')
  assert.equal(解析版本('v0.2.0').可解析, true)
})

test('解析版本：容忍奇怪前缀和空格', () => {
  assert.deepEqual(解析版本('  release-1.2  ').主, [1, 2])
  assert.deepEqual(解析版本('Release/v3.4.5').主, [3, 4, 5])
})

test('解析版本：解析不了的不抛，返回可解析=false', () => {
  assert.equal(解析版本('').可解析, false)
  assert.equal(解析版本('nightly').可解析, false)
  assert.equal(解析版本(null).可解析, false)
  assert.equal(解析版本(undefined).可解析, false)
  assert.equal(解析版本(123).可解析, false) // 非字符串
})

// ── 比较版本 ───────────────────────────────────────────────────────────────

test('比较版本：数字段逐个比，不是字符串比', () => {
  // 这条是关键：字符串比较下 '0.10.0' < '0.9.0'，但版本号上 0.10.0 更新
  assert.equal(比较版本('0.10.0', '0.9.0'), 1)
  assert.equal(比较版本('v0.10.0', 'v0.9.0'), 1)
  assert.equal(比较版本('0.9.0', '0.10.0'), -1)
  assert.equal(比较版本('1.0.0', '1.0.0'), 0)
  assert.equal(比较版本('1.0.1', '1.0.0'), 1)
  assert.equal(比较版本('2.0.0', '1.99.99'), 1)
})

test('比较版本：缺的段当 0', () => {
  assert.equal(比较版本('1.2', '1.2.0'), 0)
  assert.equal(比较版本('1.2.1', '1.2'), 1)
  assert.equal(比较版本('1', '1.0.0'), 0)
})

test('比较版本：正式版大于预发布版（semver 约定）', () => {
  assert.equal(比较版本('1.0.0', '1.0.0-test'), 1)
  assert.equal(比较版本('1.0.0-test', '1.0.0'), -1)
  // 数字段不同的预发布，仍按数字段决胜负
  assert.equal(比较版本('1.1.0-test', '1.0.0'), 1)
})

test('比较版本：解析不了的当作更旧', () => {
  assert.equal(比较版本('1.0.0', 'nightly'), 1)
  assert.equal(比较版本('nightly', '1.0.0'), -1)
  assert.equal(比较版本('nightly', 'garbage'), 0)
})

// ── 是最新版（保守原则）────────────────────────────────────────────────────

test('是最新版：新就是新，一样就不是', () => {
  assert.equal(是最新版('0.2.0', '0.3.0'), true)
  assert.equal(是最新版('0.2.0', '0.2.0'), false)
  assert.equal(是最新版('0.2.0', '0.1.9'), false)
  assert.equal(是最新版('0.2.0', 'v0.3.0'), true) // v 前缀不影响
})

test('是最新版：正式版 > 同号预发布', () => {
  assert.equal(是最新版('0.2.0-test', '0.2.0'), true)
  assert.equal(是最新版('0.2.0', '0.2.0-test'), false)
})

test('是最新版：任何一边解析不了都返回 false（宁漏报不误报）', () => {
  // 误报会让用户白装一次；漏报只是少个提示
  assert.equal(是最新版('nightly', '0.3.0'), false)
  assert.equal(是最新版('0.2.0', 'nightly'), false)
  assert.equal(是最新版('', ''), false)
})

// ── 挑最新 ─────────────────────────────────────────────────────────────────

test('挑最新：字典序会把 v0.10 排到 v0.9 前，这里按版本比', () => {
  const 列表 = [{ name: 'v0.9.0' }, { name: 'v0.10.0' }, { name: 'v0.2.0' }]
  assert.equal(挑最新(列表), 'v0.10.0')
})

test('挑最新：兼容 release 的 tag_name 字段', () => {
  assert.equal(挑最新([{ tag_name: 'v1.0.0' }, { tag_name: 'v2.0.0' }]), 'v2.0.0')
})

test('挑最新：跳过解析不了的项；全不行返回空串', () => {
  assert.equal(挑最新([{ name: 'nightly' }, { name: 'v0.3.0' }]), 'v0.3.0')
  assert.equal(挑最新([{ name: 'nightly' }]), '')
  assert.equal(挑最新([]), '')
  assert.equal(挑最新(null), '')
})

// ── 整理发布 ───────────────────────────────────────────────────────────────

test('整理发布：tag（没有日期和正文）也要能出结果', () => {
  const r = 整理发布({ name: 'v0.2.0-test', commit: { sha: '9f1784c64bf2d37f0998e169509abb9fa9ab6ee7' } })
  assert.equal(r.版本, 'v0.2.0-test')
  assert.equal(r.发布日期, '') // tags 接口没有日期
  assert.equal(r.第几次提交, '9f1784c')
  // 没有正文时用拼出来的说明，且**不编造内容**
  assert.match(r.说明, /v0\.2\.0-test/)
})

test('整理发布：release 有正文就用正文', () => {
  const r = 整理发布({
    tag_name: 'v1.0.0', name: '正式版', body: '- 修了翻页\n- 加了更新检查',
    published_at: '2026-11-03T10:00:00Z', html_url: 'https://example.com/r',
  })
  assert.equal(r.版本, 'v1.0.0')
  assert.equal(r.说明, '- 修了翻页\n- 加了更新检查')
  assert.equal(r.发布日期, '2026-11-03T10:00:00Z')
  assert.equal(r.网址, 'https://example.com/r')
})

test('整理发布：坏输入返回 null 不抛', () => {
  assert.equal(整理发布(null), null)
  assert.equal(整理发布({}), null)
  assert.equal(整理发布({ name: '   ' }), null)
})

test('拼更新日志：空信息返回空串，不含编造内容', () => {
  assert.equal(拼更新日志(null), '')
  assert.equal(拼更新日志({}), '')
  const s = 拼更新日志({ 版本: 'v9.9.9' })
  assert.match(s, /v9\.9\.9/)
  // 没有任何「修了 X / 新增 Y」这类我们拿不到的内容
  assert.doesNotMatch(s, /修复|新增|优化/)
})

// ── 查询（假 fetch，不真的联网）──────────────────────────────────────────────

/** 造一个假 fetch，按顺序返回给定响应。 */
function 假fetch (响应列表) {
  let i = 0
  const 调用 = []
  const fn = async (url, init) => {
    调用.push({ url, init })
    const r = 响应列表[i++] || 响应列表[响应列表.length - 1]
    if (typeof r === 'function') return r(url, init)
    return {
      status: r.status,
      json: async () => r.body,
    }
  }
  fn.调用 = 调用
  return fn
}

test('查询：只有 tag 没有 release 时退到 tags（我们会走这条路）', async () => {
  清缓存()
  const f = 假fetch([
    { status: 404, body: { message: 'Not Found' } }, // releases/latest
    { status: 200, body: [{ name: 'v0.2.0-test', commit: { sha: '9f1784c64bf2' } }] }, // tags
  ])
  const r = await 查询最新版本({ fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.数据.来源, 'tag')
  assert.equal(r.数据.最新.版本, 'v0.2.0-test')
  assert.equal(f.调用.length, 2)
})

test('查询：有 release 就优先用 release（信息更全）', async () => {
  清缓存()
  const f = 假fetch([
    { status: 200, body: { tag_name: 'v1.0.0', body: '正文', published_at: '2026-11-03T00:00:00Z' } },
  ])
  const r = await 查询最新版本({ fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.数据.来源, 'release')
  assert.equal(r.数据.最新.说明, '正文')
  assert.equal(f.调用.length, 1) // 不该再问 tags
})

test('查询：缓存生效，第二次不再打网络', async () => {
  清缓存()
  const f = 假fetch([{ status: 200, body: { tag_name: 'v1.0.0' } }])
  await 查询最新版本({ fetchImpl: f })
  const 次 = await 查询最新版本({ fetchImpl: f })
  assert.equal(次.缓存, true)
  assert.equal(f.调用.length, 1) // 关键：只打过一次
})

test('查询：强制刷新绕过缓存', async () => {
  清缓存()
  const f = 假fetch([{ status: 200, body: { tag_name: 'v1.0.0' } }])
  await 查询最新版本({ fetchImpl: f })
  const 次 = await 查询最新版本({ fetchImpl: f, 强制: true })
  assert.equal(次.缓存, false)
  assert.equal(f.调用.length, 2)
})

test('查询：限流单独说清楚，且不缓存（下次还能重试）', async () => {
  清缓存()
  const f = 假fetch([{ status: 403, body: {} }])
  const r = await 查询最新版本({ fetchImpl: f })
  assert.equal(r.ok, false)
  assert.match(r.error, /限流/)
  // 不缓存 = 下次还会真的去打网络。如果用「缓存命中」占位住，
  // 用户会一直看到限流错误直到缓存过期，而实际上马上就能重试成功。
  const 次 = await 查询最新版本({ fetchImpl: f })
  assert.equal(次.缓存, false, '失败的结果不该被缓存')
  assert.equal(f.调用.length, 4, '失败不缓存：两次调用各打两次网络')
})

test('查询：仓库不存在 / 空 tag 列表 都不抛', async () => {
  清缓存()
  const f404 = 假fetch([{ status: 404, body: {} }])
  const r1 = await 查询最新版本({ fetchImpl: f404 })
  assert.equal(r1.ok, false)
  assert.match(r1.error, /不存在/)

  清缓存()
  const f空 = 假fetch([{ status: 404, body: {} }, { status: 200, body: [] }])
  const r2 = await 查询最新版本({ fetchImpl: f空 })
  assert.equal(r2.ok, false)
  assert.match(r2.error, /没有可识别的版本/)
})

test('查询：网络抛错变成 { ok:false } 而不是冒泡', async () => {
  清缓存()
  const f = 假fetch([() => { throw new Error('ECONNREFUSED') }])
  const r = await 查询最新版本({ fetchImpl: f })
  assert.equal(r.ok, false)
  assert.match(r.error, /ECONNREFUSED/)
})

test('查询：超时真的中断（AbortController 生效）', async () => {
  清缓存()
  // 永不 resolve 的 fetch，只对 abort 有反应 —— 模拟卡死的连接
  const f = (url, init) => new Promise((resolve, reject) => {
    if (init && init.signal) {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      })
    }
  })
  const 起 = Date.now()
  const r = await 查询最新版本({ fetchImpl: f, 超时毫秒: 60 })
  assert.equal(r.ok, false)
  assert.match(r.error, /超时/)
  assert.ok(Date.now() - 起 < 2000, '超时应该很快返回，不该一直挂着')
})

test('查询：没有 fetch 时如实报错，不抛', async () => {
  清缓存()
  // ⚠️ 这里必须把全局 fetch 也临时拿掉。传 fetchImpl: null 会被理解成
  //    「没指定，用全局的」，于是测试真的去打了 api.github.com ——
  //    整套测试从此依赖外网、还会烧掉匿名配额（实测踩过）。
  const 原fetch = globalThis.fetch
  try {
    globalThis.fetch = undefined
    const r = await 查询最新版本({ fetchImpl: null })
    assert.equal(r.ok, false)
    assert.match(r.error, /fetch/)
  } finally {
    globalThis.fetch = 原fetch
  }
})

test('查询：带正确的 User-Agent（GitHub 不带会拒）', async () => {
  清缓存()
  const f = 假fetch([{ status: 200, body: { tag_name: 'v1.0.0' } }])
  await 查询最新版本({ fetchImpl: f })
  const ua = f.调用[0].init.headers['user-agent']
  assert.ok(ua && ua.length > 0)
  assert.match(f.调用[0].url, /^https:\/\/api\.github\.com\/repos\//)
})

test('查询：默认仓库与缓存时长是常量，可被覆盖', async () => {
  assert.equal(默认仓库, 'guoke-liu/dsh-xiaoyu-diary')
  assert.equal(默认缓存毫秒, 30 * 60 * 1000)
  清缓存()
  const f = 假fetch([{ status: 200, body: { tag_name: 'v1.0.0' } }])
  await 查询最新版本({ fetchImpl: f, 仓库: 'someone/else' })
  assert.match(f.调用[0].url, /someone\/else/)
})
