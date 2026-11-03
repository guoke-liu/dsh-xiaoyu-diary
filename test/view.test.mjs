// 浏览器端 UI 纯计算逻辑的测试（lib/view.js）。
//
// 这些函数原来散在 client.js 的 React 组件里，坏了没有任何报警 ——
// 进度条长度不对、第一页还能往上翻、百分比出现「117%」，全靠肉眼才能发现。
// 抽成纯函数后在这里锁死，重点盯三类最容易悄悄坏掉的点：
//   1. 边界：第一页/最后一页/只有一页、0% 与 100%
//   2. 容错：pages 或当前日期传空值时，必须返回可渲染的结果而不是抛异常
//   3. 文本进度条长度必须恰好 20 个字符（渲染对齐的硬前提）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { 选起始页, 翻页状态, 进度百分比, 进度条文本, 校验跳转 } from '../lib/view.js'

// ── 选起始页 ──────────────────────────────────────────────────────────────

test('选起始页：书签还有效就翻回书签那一页', () => {
  const 页 = ['2026-11-01', '2026-11-02', '2026-11-03']
  assert.equal(选起始页(页, '2026-11-02'), '2026-11-02')
})

test('选起始页：书签失效（那天日记被清了）落到最后一页', () => {
  const 页 = ['2026-11-01', '2026-11-02', '2026-11-03']
  assert.equal(选起始页(页, '2026-10-01'), '2026-11-03')
})

test('选起始页：空书签（从没存过）也落到最后一页', () => {
  assert.equal(选起始页(['2026-11-01', '2026-11-02'], ''), '2026-11-02')
})

test('选起始页：pages 为空或 null 都返回空串，不炸', () => {
  assert.equal(选起始页([], '2026-11-01'), '')
  assert.equal(选起始页(null, '2026-11-01'), '')
  assert.equal(选起始页(undefined, ''), '')
})

// ── 翻页状态 ──────────────────────────────────────────────────────────────

test('翻页状态：第一页只能往下翻', () => {
  const s = 翻页状态(['a', 'b', 'c'], 'a')
  assert.equal(s.页码, 1)
  assert.equal(s.总页数, 3)
  assert.equal(s.下标, 0)
  assert.equal(s.能上一页, false)
  assert.equal(s.能下一页, true)
})

test('翻页状态：最后一页只能往上翻', () => {
  const s = 翻页状态(['a', 'b', 'c'], 'c')
  assert.equal(s.页码, 3)
  assert.equal(s.总页数, 3)
  assert.equal(s.下标, 2)
  assert.equal(s.能上一页, true)
  assert.equal(s.能下一页, false)
})

test('翻页状态：中间页上下都能翻', () => {
  const s = 翻页状态(['a', 'b', 'c'], 'b')
  assert.equal(s.页码, 2)
  assert.equal(s.能上一页, true)
  assert.equal(s.能下一页, true)
})

test('翻页状态：只有一页时上下都不能翻', () => {
  const s = 翻页状态(['a'], 'a')
  assert.equal(s.页码, 1)
  assert.equal(s.总页数, 1)
  assert.equal(s.能上一页, false)
  assert.equal(s.能下一页, false)
})

test('翻页状态：当前日期不在 pages 里 → 页码 0、下标 -1、两向都翻不了', () => {
  const s = 翻页状态(['a', 'b'], '2020-01-01')
  assert.equal(s.下标, -1)
  assert.equal(s.页码, 0)
  assert.equal(s.能上一页, false)
  assert.equal(s.能下一页, false)
})

test('翻页状态：pages 为空 → 总页数 0；传 null 也一样（容错）', () => {
  const s = 翻页状态([], 'a')
  assert.equal(s.总页数, 0)
  assert.equal(s.页码, 0)
  const n = 翻页状态(null, 'a')
  assert.equal(n.总页数, 0)
  assert.equal(n.下标, -1)
})

// ── 进度百分比 ────────────────────────────────────────────────────────────

test('进度百分比：整比例直接换算', () => {
  assert.equal(进度百分比(3, 6), 50)
  assert.equal(进度百分比(0, 6), 0)
  assert.equal(进度百分比(6, 6), 100)
})

test('进度百分比：总批数为 0（任务刚开还没出分片）返回 0，不能除零', () => {
  assert.equal(进度百分比(3, 0), 0)
  assert.equal(进度百分比(0, 0), 0)
})

test('进度百分比：已完成超过总批数（后端预估偏差）夹到 100', () => {
  assert.equal(进度百分比(7, 6), 100)
  assert.equal(进度百分比(99, 6), 100)
})

test('进度百分比：小数四舍五入取整', () => {
  assert.equal(进度百分比(1, 3), 33) // 33.33 → 33
  assert.equal(进度百分比(2, 3), 67) // 66.67 → 67
})

// ── 进度条文本 ────────────────────────────────────────────────────────────
// 长度恰好 20 是渲染对齐的硬前提，每个用例都单独断言一遍。

test('进度条文本：0% 全是空格，长度恰好 20', () => {
  const t = 进度条文本(0)
  assert.equal(t, '─'.repeat(20))
  assert.equal(t.length, 20)
})

test('进度条文本：100% 全是满格，长度恰好 20', () => {
  const t = 进度条文本(100)
  assert.equal(t, '═'.repeat(20))
  assert.equal(t.length, 20)
})

test('进度条文本：50% 一半满格一半空格，长度恰好 20', () => {
  const t = 进度条文本(50)
  assert.equal(t, '═'.repeat(10) + '─'.repeat(10))
  assert.equal(t.length, 20)
})

test('进度条文本：非整格的百分比向下取格，长度仍然恰好 20', () => {
  for (const p of [1, 4, 5, 7, 19, 24, 99]) {
    const t = 进度条文本(p)
    const 满 = Math.floor(p / 5)
    assert.equal(t, '═'.repeat(满) + '─'.repeat(20 - 满), `百分比 ${p} 应为 ${满} 格满格`)
    assert.equal(t.length, 20, `百分比 ${p} 的条长度必须是 20`)
  }
})

// ── 校验跳转 ──────────────────────────────────────────────────────────────

test('校验跳转：空串是「没选日期」，不跳也不报错（无提示）', () => {
  assert.deepEqual(校验跳转(['a', 'b'], ''), { 可跳: false, 提示: '' })
})

test('校验跳转：那天没有日记 → 不跳，提示一句', () => {
  const v = 校验跳转(['2026-11-01', '2026-11-02'], '2026-10-31')
  assert.equal(v.可跳, false)
  assert.equal(v.提示, '那天没有日记')
})

test('校验跳转：在 pages 里 → 可跳、无提示', () => {
  const v = 校验跳转(['2026-11-01', '2026-11-02'], '2026-11-02')
  assert.equal(v.可跳, true)
  assert.equal(v.提示, '')
})

test('校验跳转：pages 为 null/undefined 时任何非空日期都不可跳（容错）', () => {
  assert.equal(校验跳转(null, '2026-11-01').可跳, false)
  assert.equal(校验跳转(undefined, '2026-11-01').提示, '那天没有日记')
})

// ── 副本一致性 ─────────────────────────────────────────────────────────
//
// view.js 的逻辑在 client.js 里有一份内联副本（浏览器端无法 import）。
// 两份漂移是最隐蔽的 bug：单测测的是 view.js，用户跑的是 client.js 那份，
// 测了等于白测。所以这里直接读两个文件的源码做比对，漂移就红。

test('副本一致性：client.js 里的内联副本必须与 view.js 完全一致', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const 本目录 = path.dirname(fileURLToPath(import.meta.url))
  const view = readFileSync(path.join(本目录, '..', 'lib', 'view.js'), 'utf8')
  const client = readFileSync(path.join(本目录, '..', 'lib', 'client.js'), 'utf8')

  /** 从源码里抠出一个 function 的完整源码（按花括号配平）。 */
  function 取函数 (src, 名) {
    const i = src.indexOf('function ' + 名)
    if (i < 0) return null
    let 深 = 0
    for (let k = i; k < src.length; k++) {
      if (src[k] === '{') 深++
      else if (src[k] === '}') { 深--; if (深 === 0) return src.slice(i, k + 1) }
    }
    return null
  }
  // 顺序很重要：先去注释，再去空白。
  // 反过来做的话，注释里的文字会被当成代码留下，导致误判"不一致"。
  const 规范化 = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n').replace(/\s+/g, '')

  for (const 名 of ['选起始页', '翻页状态', '进度百分比', '进度条文本', '校验跳转']) {
    const a = 取函数(view, 名)
    const b = 取函数(client, 名)
    assert.ok(a, `view.js 里应该有 ${名}`)
    assert.ok(b, `client.js 里应该有 ${名} 的内联副本`)
    assert.equal(规范化(b), 规范化(a),
      `${名} 在两份实现里不一致 —— 改了 view.js 就要同步改 client.js（反之亦然）`)
  }
})
