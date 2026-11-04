/**
 * recall.js（跨来源检索）的测试。
 *
 * 这个模块 2026-11-04 才补进仓库 —— 它在线上已经跑了一整轮，代码却一直
 * 只存在于服务器上。补进来时顺手把关键行为钉住，免得以后又「线上能跑、
 * 仓库里的版本没人验」。
 *
 * 它自称「零依赖纯函数，切词和 search.js 逐字一致」，所以测两类：
 *   1. 自包含行为：切词、同义词展开、跨来源检索、汇总渲染
 *   2. 对拍：它的 切词 必须和 lib/search.js 的切词 产出一致的词
 *      （文件头写着「两处规则必须人肉保持同步，自测里有对拍」——
 *       这条就是那个对拍，以前没有）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { 切词, 展开同义词, 检索, 汇总, 来源标签, 默认同义词表 } from '../lib/recall.js'
import { 切词 as search切词 } from '../lib/search.js'

test('切词：2 字滑窗，搜「猫」能命中「橘猫」', () => {
  const 词 = 切词('橘猫')
  assert.ok(词.includes('橘猫'), '「橘猫」应该切出自己')
  // 单字不切成词，但 2 字滑窗让「猫」相关的双字词能命中
  assert.ok(切词('我家的橘猫').includes('橘猫'), '长句里也要能切出「橘猫」')
})

test('切词：英文和数字整词保留', () => {
  const 词 = 切词('DSH 插件 v1.6 版本')
  assert.ok(词.includes('dsh'), '英文应转小写后保留整词')
  assert.ok(词.some((w) => w.includes('版本')), '中文部分照常切')
})

test('切词：和 lib/search.js 的切词产出一致（文件头承诺的对拍）', () => {
  // recall.js 文件头写着「切词、来源排序两处规则必须人肉保持同步，自测里有对拍」。
  // 这条就是把那份承诺落成断言 —— 谁改了 search.js 的切词忘了同步，这里会红。
  const 样本们 = [
    '腾讯云轻量服务器',
    '橘猫日记',
    'DSH 插件的 v1.6 版本',
    '关于 记忆仓库 和 QQ 机器人',
    '服务器搬家了',
  ]
  for (const s of 样本们) {
    assert.deepEqual(
      [...切词(s)].sort(),
      [...search切词(s)].sort(),
      `切词结果和 search.js 不一致：${s}`,
    )
  }
})

test('展开同义词：命中组里任一个词，整组都拉进来', () => {
  // 表里 服务器: ['机器', '主机', ...]。搜「机器」要能扩到这一组。
  //
  // ⚠️ 注意扩出来的不是整词「服务器」，而是它的切词碎片（服务/务器）。
  //    这是**正确**的：检索时正文也会被切词，词表对词表才比得上；
  //    扩出整词「服务器」反而匹配不到任何东西（正文里存的是碎片）。
  //    我第一版断言写成「扩出服务器」，测出来才发现想错了。
  const 词 = 展开同义词('机器', 默认同义词表)
  assert.ok(词.includes('机器'), '原词必须在')
  assert.ok(词.includes('主机'), '同组的别名「主机」应该被拉进来（说明整组生效了）')
  assert.ok(词.length > 1, '应该不止原词一个')
})

test('展开同义词：扩出的碎片能命中正文里写的整词', () => {
  // 上一条说「扩出的是碎片」，这条证明碎片确实能搜到东西 ——
  // 搜「机器」，正文里写的是「服务器」的那条也该被搜出来。
  const 条目 = [
    { 来源: 'private', 日期: '2026-11-01', id: 'a', text: '腾讯云的服务器搬家了', tags: [], at: '' },
    { 来源: 'private', 日期: '2026-11-02', id: 'b', text: '今天天气不错', tags: [], at: '' },
  ]
  const r = 检索(条目, '机器')
  assert.equal(r.命中数, 1, '搜「机器」应该命中写了「服务器」的那条')
  assert.equal(r.结果[0].id, 'a')
})

test('展开同义词：空查询返回空表，不抛', () => {
  assert.deepEqual(展开同义词('', 默认同义词表), [])
  assert.deepEqual(展开同义词(null, 默认同义词表), [])
})

test('检索：跨来源一次搜到，来源可过滤', () => {
  const 条目 = [
    { 来源: 'private', 日期: '2026-11-01', id: 'a1', text: '服务器搬家了，新地址在腾讯云', tags: [], at: '' },
    { 来源: 'group:100', 日期: '2026-11-02', id: 'b1', text: '服务器又挂了', tags: [], at: '' },
  ]
  // 不传来源 = 全都搜
  const 全 = 检索(条目, '服务器')
  assert.equal(全.命中数, 2, '跨来源应该两条都命中')

  // 指定来源只搜那一本
  const 仅私聊 = 检索(条目, '服务器', { 来源: 'private' })
  assert.equal(仅私聊.命中数, 1, '指定 private 后只应命中 1 条')
  assert.equal(仅私聊.结果[0].来源, 'private')
})

test('检索：空查询是列举模式，按时间倒序', () => {
  const 条目 = [
    { 来源: 'private', 日期: '2026-10-01', id: 'a', text: '早的事', tags: [], at: '' },
    { 来源: 'private', 日期: '2026-11-01', id: 'b', text: '晚的事', tags: [], at: '' },
  ]
  const r = 检索(条目, '')
  assert.equal(r.命中数, 2, '空查询应该列出全部')
  assert.equal(r.结果[0].日期, '2026-11-01', '新的在前')
})

test('检索：结果每条都带 schema 要求的全部字段', () => {
  // tools.js 里 xiaoyu_diary_recall 的 schema 是 additionalProperties:false，
  // 少一个字段或多一个字段都会让整次调用判 INVALID_TOOL_OUTPUT。
  const 条目 = [{ 来源: 'private', 日期: '2026-11-01', id: 'a', text: '服务器', tags: ['运维'], at: '05:00' }]
  const r = 检索(条目, '服务器')
  const 要 = ['来源', '日期', 'id', '标题', '内容', '标签', '时间', '相关度']
  for (const k of 要) {
    assert.ok(k in r.结果[0], `结果条目缺字段：${k}`)
  }
  assert.deepEqual(Object.keys(r.结果[0]).sort(), [...要].sort(), '结果条目不能有 schema 未声明的字段')
})

test('来源标签：private → 私聊，group:x → 群 x', () => {
  assert.equal(来源标签('private'), '私聊')
  assert.ok(来源标签('group:123').includes('123'), '群号应该出现在标签里')
})

test('汇总：把结果渲染成给模型看的文本，不抛', () => {
  const 条目 = [{ 来源: 'private', 日期: '2026-11-01', id: 'a', text: '服务器搬家', tags: [], at: '' }]
  const r = 检索(条目, '服务器')
  const 文本 = 汇总(r)
  assert.equal(typeof 文本, 'string')
  assert.ok(文本.length > 0, '汇总不该是空串')
})
