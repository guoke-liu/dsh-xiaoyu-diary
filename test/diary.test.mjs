// 日记插件单测：覆盖存储、检索、提取三层，以及「宿主真实消费」的完整链。
// 运行：node --test test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as store from '../lib/store.js'
import * as search from '../lib/search.js'
import * as extract from '../lib/extract.js'
import * as toolsMod from '../lib/tools.js'
import { 日记日, 前推天数, 默认时区, 默认日记日起点小时 } from '../lib/day.js'

/** 建一个临时库目录。 */
async function 临时库 () {
  const d = await mkdtemp(join(tmpdir(), 'diary-test-'))
  await mkdir(join(d, 'entries'))
  return d
}

// ── 切词 ────────────────────────────────────────────────────────────────
test('切词：2 字滑窗 + 英文整词', () => {
  const w = search.切词('腾讯云轻量服务器')
  assert.ok(w.includes('腾讯'))
  assert.ok(w.includes('服务'))
  assert.ok(w.includes('务器'))
  assert.ok(search.切词('abc def').includes('abc'))
})

test('切词：短词原样保留', () => {
  assert.deepEqual(search.切词('猫').sort(), ['猫'])
})

// ── 打分 ────────────────────────────────────────────────────────────────
test('打分：标题命中权重高于正文', () => {
  const 标题命中 = search.打分({ title: '猫的事情', text: '无关内容' }, ['猫'])
  const 正文命中 = search.打分({ title: '', text: '无关内容猫' }, ['猫'])
  assert.ok(标题命中 > 正文命中, `标题=${标题命中} 正文=${正文命中}`)
})

test('打分：标签精确命中权重最高', () => {
  const 标签 = search.打分({ title: '', text: '', tags: ['猫'] }, ['猫'])
  const 正文 = search.打分({ title: '', text: '猫', tags: [] }, ['猫'])
  assert.ok(标签 > 正文)
})

test('打分：无命中为 0', () => {
  assert.equal(search.打分({ text: '完全无关' }, ['猫']), 0)
})

// ── 检索 ────────────────────────────────────────────────────────────────
test('检索：按相关度排序，同分新的在前', () => {
  const 全部 = [
    { date: '2026-01-01', id: 'd1', text: '猫', tags: [] },
    { date: '2026-02-01', id: 'd2', text: '猫', tags: [] },
    { date: '2026-03-01', id: 'd3', text: '无关', tags: [] },
  ]
  const { 结果, 命中数 } = search.检索(全部, '猫')
  assert.equal(命中数, 2)
  assert.equal(结果[0].id, 'd2', '同分时新的在前')
})

test('检索：tag 过滤', () => {
  const 全部 = [
    { date: '2026-01-01', id: 'd1', text: '猫', tags: ['宠物'] },
    { date: '2026-01-02', id: 'd2', text: '猫', tags: ['工作'] },
  ]
  const { 结果 } = search.检索(全部, '', { tag: '宠物' })
  assert.equal(结果.length, 1)
  assert.equal(结果[0].id, 'd1')
})

test('检索：limit 上限生效', () => {
  const 全部 = Array.from({ length: 50 }, (_, i) => ({
    date: '2026-01-01', id: `d${i}`, text: '猫', tags: [],
  }))
  assert.equal(search.检索(全部, '猫', { limit: 5 }).结果.length, 5)
  // 超过 100 被夹到 100
  assert.equal(search.检索(全部, '猫', { limit: 999 }).结果.length, 50)
})

// ── 存储 ────────────────────────────────────────────────────────────────
test('存储：追加后能读回，id 自增', async () => {
  const root = await 临时库()
  try {
    const a = await store.追加条目(root, 'private', '2026-11-02', { text: '第一件事', tags: [] })
    const b = await store.追加条目(root, 'private', '2026-11-02', { text: '第二件事', tags: [] })
    assert.equal(a.id, 'private-d1')
    assert.equal(b.id, 'private-d2')
    const back = await store.读某天(root, 'private', '2026-11-02')
    assert.equal(back.length, 2)
    assert.equal(back[1].text, '第二件事')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('存储：索引能重建且结果一致', async () => {
  const root = await 临时库()
  try {
    await store.追加条目(root, 'private', '2026-11-01', { text: '昨天的猫', tags: ['宠物'] })
    await store.追加条目(root, 'private', '2026-11-02', { text: '今天的事', tags: [] })
    const 原 = await store.读索引(root, 'private')
    // 删掉索引模拟丢失（索引现在按来源分开：index/<来源目录名>.json）
    await rm(join(root, 'index', 'private.json'))
    const r = await store.重建(root, 'private')
    assert.equal(r.重建天数, 2)
    assert.equal(r.index.seq, 原.seq, 'seq 要能从条目 id 恢复')
    assert.deepEqual(Object.keys(r.index.days).sort(), ['2026-11-01', '2026-11-02'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('存储：损坏的日期文件不影响其他天', async () => {
  const root = await 临时库()
  try {
    await store.追加条目(root, 'private', '2026-11-01', { text: '好的那天', tags: [] })
    // 日期文件现在按来源分目录：entries/private/<日期>.json
    await writeFile(join(root, 'entries', 'private', '2026-11-02.json'), '{ 坏掉的 JSON')
    const r = await store.重建(root, 'private')
    assert.equal(r.重建天数, 1)
    assert.deepEqual(r.跳过, ['2026-11-02'])
    assert.ok(r.index.days['2026-11-01'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('存储：删条目后索引里也查不到', async () => {
  const root = await 临时库()
  try {
    const e = await store.追加条目(root, 'private', '2026-11-02', { text: '要删掉的猫', tags: [] })
    const r = await store.删条目(root, e.id, 'private')
    assert.equal(r.删除, true)
    const idx = await store.读索引(root, 'private')
    const 全部 = Object.values(idx.days).flatMap((d) => d.entries)
    assert.equal(全部.filter((x) => x.id === e.id).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('存储：列出日期只认 YYYY-MM-DD.json', async () => {
  const root = await 临时库()
  try {
    await store.追加条目(root, 'private', '2026-11-01', { text: 'a', tags: [] })
    // 垃圾文件放进该来源自己的 entries 目录，不该被当成日记
    await writeFile(join(root, 'entries', 'private', 'notes.txt'), 'x')
    await writeFile(join(root, 'entries', 'private', '2026-11-02.json.tmp'), '{}')
    assert.deepEqual(await store.列出日期(root, 'private'), ['2026-11-01'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 提取 ────────────────────────────────────────────────────────────────
test('提取：解析聊天行', () => {
  const raw = '[10:23:45] 小鱼儿(p1): 明天要交报告\n[10:24:00] 阿强(p2): 嗯\n不是这个格式的行'
  const rows = extract.解析聊天(raw)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].时间, '10:23:45')
  assert.equal(rows[0].昵称, '小鱼儿')
  assert.equal(rows[0].pid, 'p1')
  assert.equal(rows[0].内容, '明天要交报告')
})

test('提取：承诺和重要信息能被挑中', () => {
  const rows = extract.解析聊天(
    '[10:00:00] 甲(p1): 明天三点在老地方见面，别迟到\n' +
    '[10:01:00] 乙(p2): 好\n',
  )
  const { 候选 } = extract.挑候选(rows)
  assert.equal(候选.length, 1)
  assert.equal(候选[0].内容.includes('明天'), true)
  assert.ok(候选[0].命中.some((h) => h.includes('承诺计划')))
})

test('提取：无信号的话不被挑中', () => {
  const rows = extract.解析聊天('[10:00:00] 甲(p1): 哈哈哈哈好的没问题')
  const { 候选 } = extract.挑候选(rows)
  assert.equal(候选.length, 0)
})

// 真实数据回归：云端 2026-11-03 群聊里画图指令极多，
// 「安排」「换成」「改成」「一会儿」曾让 222 行筛出 23 条几乎全是垃圾的候选。
// 词表收紧后同样的行不该再被当成候选 —— 这条测试防止以后又把泛动词加回去。
test('提取：画图指令类的泛动词不再触发候选', () => {
  const rows = extract.解析聊天(
    '[00:03:06] 龙娘(p83): 安排，中分背带鸡上场运球。\n' +
    '[00:16:01] 企鹅(p82): 把这个运动员换成科比·布莱恩特\n' +
    '[00:19:50] 企鹅(p82): 球衣要康师傅冰红茶配色，logo也要改成康师傅的\n' +
    '[00:30:00] 甲(p1): 待会再说一会儿聊\n',
  )
  const { 候选 } = extract.挑候选(rows)
  assert.equal(候选.length, 0, `画图指令不该出候选，实际出了 ${候选.length} 条：${候选.map((c) => c.内容).join(' | ')}`)
})

test('提取：真正值得记的话仍然能被挑中（收紧后不能误伤）', () => {
  const rows = extract.解析聊天(
    '[01:03:34] 小鱼儿(p1): 刚才那盘推到 136，卡住了，正想歇一歇。\n' +
    '[02:28:37] 小鱼儿(p1): 那就快去睡，我等你明天回来叫我的那一声。\n',
  )
  const { 候选 } = extract.挑候选(rows)
  assert.equal(候选.length, 2, '「卡住」「明天」这类信号不该被误伤')
  assert.ok(候选.some((c) => c.内容.includes('卡住')))
  assert.ok(候选.some((c) => c.内容.includes('明天')))
})

// 真实数据回归：没有信号词的长句**不能**靠"长度"混进候选。
// 2026-11-03 真实数据里曾混进 2 条（搬家公告、URL），根因是长度分独立生效。
test('提取：没有信号词的长句不算候选（长度不能自己造候选）', () => {
  const 长废话 = '翻完了，最近的都在：10-29 到 10-30 最热闹，一天十几条；10-31 只有一条；11-01 六条，11-02 三条'
  const rows = extract.解析聊天(`[02:09:54] 小鱼儿(p1): ${长废话}`)
  const { 候选 } = extract.挑候选(rows)
  assert.equal(候选.length, 0, `长句无信号不该进候选，实际：${候选.map((c) => c.内容).join(' | ')}`)
  // 直接验打分函数：无信号时长度再长也是 0 分
  assert.equal(extract.给行打分({ 内容: 长废话 }).分, 0)
})

// 真实数据回归：「开心/高兴」这类日常寒暄不该霸占候选名额。
// 2026-11-03 的 7 条候选里有 4 条是「开心/高兴」的闲聊。
test('提取：日常寒暄式情绪词不再触发候选', () => {
  const rows = extract.解析聊天(
    '[02:45:52] 小鱼儿(p1): 不好意思，我又没等你，一高兴就自己走了，224 了。\n' +
    '[02:46:26] 小鱼儿(p1): 你玩的开心就好\n' +
    '[02:46:31] 小鱼儿(p1): 开心啊，跟你轮着走，比我一个人戳有意思多了。\n',
  )
  const { 候选 } = extract.挑候选(rows)
  assert.equal(候选.length, 0, `日常「开心/高兴」不该进候选，实际：${候选.length} 条`)
  // 但强度明显的情绪词仍然要能命中
  const 强情绪 = extract.解析聊天('[02:50:00] 小鱼儿(p1): 那次真的崩溃了，哭了一晚上')
  assert.equal(extract.挑候选(强情绪).候选.length, 1, '「崩溃」这类强情绪不该被误伤')
})

// 真实数据回归：「记得」单字面太宽 —— 「你还记得…吗」是提问，不是承诺。
test('提取：提问式的「记得吗」不算承诺', () => {
  const rows = extract.解析聊天(
    '[10:00:00] 甲(p1): 小鱼儿你还记得你人设怎么来的吗\n' +
    '[10:01:00] 乙(p2): 记得。那次你说把卡换了\n',
  )
  const { 候选 } = extract.挑候选(rows)
  assert.equal(候选.length, 0, `「你还记得…吗」是问句不该进候选，实际：${候选.length} 条`)
  // 真正的承诺仍然要能命中
  const 真承诺 = extract.解析聊天('[10:05:00] 甲(p1): 我记得明天要交报告')
  assert.equal(extract.挑候选(真承诺).候选.length, 1, '「我记得…」是真承诺，不该被误伤')
})

test('提取：重复刷屏只留一条', () => {
  const rows = extract.解析聊天(
    '[10:00:00] 甲(p1): 明天下午三点老地方见，别忘了\n'.repeat(5),
  )
  const { 候选 } = extract.挑候选(rows)
  assert.equal(候选.length, 1, '同一人同一句重复刷屏只留一条')
})

test('提取：候选按时间升序输出（便于读上下文）', () => {
  const rows = extract.解析聊天(
    '[09:00:00] 甲(p1): 明天要开会\n[08:00:00] 乙(p2): 决定改成周五\n',
  )
  const { 候选 } = extract.挑候选(rows)
  assert.equal(候选[0].时间, '08:00:00')
  assert.equal(候选[1].时间, '09:00:00')
})

test('提取：渲染带提醒语', () => {
  const rows = extract.解析聊天('[09:00:00] 甲(p1): 明天要开会')
  const { 候选 } = extract.挑候选(rows)
  const t = extract.渲染候选(候选, { 日期: '2026-11-02', 总行数: 1 })
  assert.ok(t.includes('2026-11-02'))
  assert.ok(t.includes('不懂语义'))
})

// ── 工具层完整链（AGENTS.md §3.6.2 四步）────────────────────────────────

/**
 * 找 dsh 运行时里的 dsh-tools。
 *
 * 不能写死路径：本机是 /opt/dshapp/runtime/node_modules，云端全局装在
 * /usr/lib/node_modules。写死会让测试在另一台机器上整批失败 ——
 * 那是测试不可移植，不是插件坏了（云端实测踩过一次）。
 *
 * 顺序：先按常见安装点找，再退回 require.resolve 让 node 自己找。
 */
async function 造宿主 () {
  const { createRequire } = await import('node:module')
  const { existsSync } = await import('node:fs')
  const req = createRequire(import.meta.url)
  const candidates = [
    '/opt/dshapp/runtime/node_modules',
    '/usr/lib/node_modules',
    // 云端 tarball 安装把依赖嵌在 dsh 包自己的 node_modules 里（实测位置）
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules',
    '/usr/local/lib/node_modules',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules',
  ]
  for (const base of candidates) {
    let p
    try {
      p = req.resolve('@deepseek-ai/dsh-tools', { paths: [base] })
    } catch {
      continue
    }
    if (existsSync(p)) {
      const mod = await import(pathToFileURL(p).href)
      if (typeof mod.defineTool === 'function') return mod.defineTool
    }
  }
  // 最后退回裸包名（插件从自己的父目录链能解析到时才有效）
  const mod = await import('@deepseek-ai/dsh-tools')
  return mod.defineTool
}

test('工具：9 个工具全部构造成功', async () => {
  const defineTool = await 造宿主()
  const root = await 临时库()
  try {
    const tools = toolsMod.buildTools({
      defineTool,
      rootDir: () => root,
      vaultDir: () => join(root, 'nope'),
    })
    // 数量从 7 改成 8（2026-11-04）：补进 xiaoyu_diary_recall（跨来源检索）。
    // 这个工具在线上跑了一整轮，但代码一直没进仓库 —— 所以这条断言在仓库里
    // 一直是按 7 写的，等于「线上和仓库是两套东西」没人发现。
    // 数量从 8 改成 9（2026-11-05）：新增 xiaoyu_diary_import（导入外部日记）。
    assert.equal(tools.length, 9)
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['xiaoyu_diary_extract', 'xiaoyu_diary_import', 'xiaoyu_diary_list', 'xiaoyu_diary_llm_pick', 'xiaoyu_diary_owner_note', 'xiaoyu_diary_read', 'xiaoyu_diary_recall', 'xiaoyu_diary_search', 'xiaoyu_diary_write'],
    )
    for (const t of tools) {
      assert.equal(typeof t.execute, 'function')
      assert.equal(typeof t.output.render, 'function')
      assert.ok(t.parameters, `${t.name} 缺 parameters`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工具：写入 → 检索 端到端，render 返回内容块数组', async () => {
  const defineTool = await 造宿主()
  const root = await 临时库()
  try {
    const tools = toolsMod.buildTools({
      defineTool,
      rootDir: () => root,
      vaultDir: () => join(root, 'nope'),
    })
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

    const w = await byName.xiaoyu_diary_write.execute({ 来源: 'private', text: '今天和主人约好明天去爬山', tags: ['约定'] })
    assert.equal(w.ok, true)
    // render 必须是内容块数组
    const blocks = byName.xiaoyu_diary_write.output.render({}, w)
    assert.ok(Array.isArray(blocks))
    assert.ok(blocks.every((b) => b && typeof b.type === 'string'))

    const s = await byName.xiaoyu_diary_search.execute({ 来源: 'private', query: '爬山', 来源: 'private' })
    assert.equal(s.找到, true)
    assert.equal(s.命中数, 1)
    const sBlocks = byName.xiaoyu_diary_search.output.render({}, s)
    assert.ok(Array.isArray(sBlocks))
    assert.ok(sBlocks.every((b) => typeof b.type === 'string'))

    // 模拟宿主消费：content.some 不能炸
    assert.doesNotThrow(() => sBlocks.some((b) => b.type === 'image'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工具：每个工具的 render 在各种失败路径下也返回数组', async () => {
  const defineTool = await 造宿主()
  const root = await 临时库()
  try {
    const tools = toolsMod.buildTools({
      defineTool,
      rootDir: () => root,
      vaultDir: () => join(root, 'nope'),
    })
    for (const t of tools) {
      // 空库 + 各工具的典型失败入参（read/search/extract/llm_pick 现在必须带来源，
      // 不带本身就是一种失败路径 —— 第一组 {} 正好覆盖它）
      const 各种入参 = [{}, { 来源: 'private', query: '没有' }, { 来源: 'private', date: '坏日期' }, { 来源: 'private', text: '' }]
      for (const args of 各种入参) {
        let out
        try {
          out = await t.execute(args)
        } catch {
          continue // 参数校验抛错由宿主负责，不算 render 问题
        }
        const r = t.output.render(args, out)
        assert.ok(Array.isArray(r), `${t.name} render 返回了非数组`)
        assert.ok(r.every((b) => b && typeof b.type === 'string'), `${t.name} render 块缺 type`)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工具：xiaoyu_diary_extract 从假的仓库目录能筛出候选', async () => {
  const defineTool = await 造宿主()
  const root = await 临时库()
  const vault = await mkdtemp(join(tmpdir(), 'vault-test-'))
  const 日期 = toolsMod.今天()
  try {
    await mkdir(join(vault, 'chat', 'private'), { recursive: true })
    await mkdir(join(vault, 'chat', 'group', '123'), { recursive: true })
    await writeFile(
      join(vault, 'chat', 'private', `${日期}.txt`),
      '[10:00:00] 主人(p1): 明天记得交报告\n',
    )
    await writeFile(
      join(vault, 'chat', 'group', '123', `${日期}.txt`),
      '[11:00:00] 阿强(p2): 我们决定下周改方案\n',
    )
    const tools = toolsMod.buildTools({
      defineTool,
      rootDir: () => root,
      vaultDir: () => vault,
    })
    const ex = tools.find((t) => t.name === 'xiaoyu_diary_extract')
    // 新设计：extract 一次只读一个来源，私聊和群各筛各的，绝不合并。
    // （原断言「一次调用读全、out.来源.length === 2」是旧的不分来源行为，
    //   已按「完全分开」的新行为改为各来源各调一次、各自只读到自己的聊天。）
    const 私 = await ex.execute({ 来源: 'private',  来源: 'private' })
    assert.equal(私.来源, 'private')
    assert.equal(私.总行数, 1, '私聊只读私聊的聊天文件')
    assert.equal(私.候选数, 1)
    assert.ok(私.text.includes('交报告'))

    const 群 = await ex.execute({ 来源: 'private',  来源: 'group:123' })
    assert.equal(群.来源, 'group:123')
    assert.equal(群.总行数, 1, '群只读该群的聊天文件')
    assert.equal(群.候选数, 1)
    assert.ok(群.text.includes('改方案'))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  }
})

test('工具：仓库目录不存在时如实报没有记录，不编造', async () => {
  const defineTool = await 造宿主()
  const root = await 临时库()
  try {
    const tools = toolsMod.buildTools({
      defineTool,
      rootDir: () => root,
      vaultDir: () => join(root, '根本没有这个目录'),
    })
    const ex = tools.find((t) => t.name === 'xiaoyu_diary_extract')
    const out = await ex.execute({ 来源: 'private',  来源: 'private' })
    assert.equal(out.总行数, 0)
    assert.equal(out.候选数, 0)
    assert.ok(out.text.includes('没有聊天记录'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工具：日期不规范被拒', async () => {
  const defineTool = await 造宿主()
  const root = await 临时库()
  try {
    const tools = toolsMod.buildTools({
      defineTool,
      rootDir: () => root,
      vaultDir: () => join(root, 'nope'),
    })
    const w = tools.find((t) => t.name === 'xiaoyu_diary_write')
    const out = await w.execute({ 来源: 'private', text: 'x', date: '2026-13-45' })
    assert.equal(out.ok, false)
    assert.ok(out.text.includes('日期格式不对'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工具：xiaoyu_diary_list 汇总天数与条数', async () => {
  const defineTool = await 造宿主()
  const root = await 临时库()
  try {
    const tools = toolsMod.buildTools({
      defineTool,
      rootDir: () => root,
      vaultDir: () => join(root, 'nope'),
    })
    await tools.find((t) => t.name === 'xiaoyu_diary_write').execute({ 来源: 'private', text: 'a', date: '2026-11-01' })
    await tools.find((t) => t.name === 'xiaoyu_diary_write').execute({ 来源: 'private', text: 'b', date: '2026-11-01' })
    await tools.find((t) => t.name === 'xiaoyu_diary_write').execute({ 来源: 'private', text: 'c', date: '2026-11-02' })
    const out = await tools.find((t) => t.name === 'xiaoyu_diary_list').execute({ 来源: 'private',  来源: 'private' })
    assert.equal(out.天数, 2)
    assert.equal(out.总条数, 3)
    // 返回体新增 来源们：每项 { 来源, 标签, 天数, 总条数 }
    assert.ok(Array.isArray(out.来源们) && out.来源们.length === 1, '应有且只有 private 一个来源')
    assert.equal(out.来源们[0].来源, 'private')
    assert.equal(out.来源们[0].标签, '私聊')
    assert.equal(out.来源们[0].天数, 2)
    assert.equal(out.来源们[0].总条数, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── 作者区分：主人手记 vs 小鱼记的（2026-11-03）──────────────────────────
//
// 需求来自主人：「加上主人写的和自己写的」。
// 背景：迟迟不肯装，因为他自己有本手写的 diary，怕插件写的混进去冒充他。
// 所以每条日记必须带作者，读的时候也一定标出来。

test('作者：owner_note 记下的是「主人手记」，原话一个字不改', async () => {
  const defineTool = await 造宿主()
  const root = await 临时库()
  try {
    const tools = toolsMod.buildTools({ defineTool, rootDir: () => root, vaultDir: () => join(root, 'nope') })
    const 工具 = tools.find((t) => t.name === 'xiaoyu_diary_owner_note')
    assert.ok(工具, '必须有 xiaoyu_diary_owner_note 这个工具')

    // 故意留着口语、错别字、多余空格，验证不会被"润色"
    const 原话 = '  今天累死了  不想写代码  '
    const out = await 工具.execute({ 来源: 'private', text: 原话 })
    assert.equal(out.ok, true)

    const 条 = (await store.读某天(root, 'private', out.日期))[0]
    assert.equal(条.作者, 'owner')
    assert.equal(条.text, '今天累死了  不想写代码', '只 trim，中间的空格也不能动')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('作者：write 不传作者时默认是「小鱼记的」(xi)，不会冒充主人', async () => {
  const defineTool = await 造宿主()
  const root = await 临时库()
  try {
    const tools = toolsMod.buildTools({ defineTool, rootDir: () => root, vaultDir: () => join(root, 'nope') })
    const 写 = tools.find((t) => t.name === 'xiaoyu_diary_write')
    const out = await 写.execute({ 来源: 'private', text: '从聊天里整理的一条' })
    const 条 = (await store.读某天(root, 'private', out.日期))[0]
    assert.equal(条.作者, 'xi')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('作者：write 也可以显式标 owner（主人亲口讲的事）', async () => {
  const defineTool = await 造宿主()
  const root = await 临时库()
  try {
    const tools = toolsMod.buildTools({ defineTool, rootDir: () => root, vaultDir: () => join(root, 'nope') })
    const 写 = tools.find((t) => t.name === 'xiaoyu_diary_write')
    const out = await 写.execute({ 来源: 'private', 作者: 'owner', text: '主人说他明天去医院' })
    const 条 = (await store.读某天(root, 'private', out.日期))[0]
    assert.equal(条.作者, 'owner')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('作者：读出来一定带标签，主人手记和小鱼记的分得清', async () => {
  const defineTool = await 造宿主()
  const root = await 临时库()
  try {
    const tools = toolsMod.buildTools({ defineTool, rootDir: () => root, vaultDir: () => join(root, 'nope') })
    const 手记 = tools.find((t) => t.name === 'xiaoyu_diary_owner_note')
    const 写 = tools.find((t) => t.name === 'xiaoyu_diary_write')
    const 读 = tools.find((t) => t.name === 'xiaoyu_diary_read')

    const a = await 手记.execute({ 来源: 'private', text: '主人亲手写的' })
    await 写.execute({ 来源: 'private', text: '鱼整理出来的', date: a.日期 })

    const r = await 读.execute({ 来源: 'private', date: a.日期 })
    assert.match(r.text, /主人手记/)
    assert.match(r.text, /小鱼记的/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('作者：老条目没有作者字段时不瞎标（空串，不是硬塞成某个作者）', async () => {
  const defineTool = await 造宿主()
  const root = await 临时库()
  try {
    const 日期 = '2026-10-01'
    // 直接写一条老格式（没有 作者 字段）
    await store.追加条目(root, 'private', 日期, { title: '老格式', text: '没有作者字段' })
    const tools = toolsMod.buildTools({ defineTool, rootDir: () => root, vaultDir: () => join(root, 'nope') })
    const 读 = tools.find((t) => t.name === 'xiaoyu_diary_read')
    const r = await 读.execute({ 来源: 'private', date: 日期 })
    assert.ok(r.text.includes('没有作者字段'))
    assert.ok(!r.text.includes('（小鱼记的）'), '老条目不该被硬标成别人')
    assert.ok(!r.text.includes('（主人手记）'), '老条目不该被硬标成主人')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


// ── 跨天连贯 + 输出契约 ────────────────────────────────────────────────
//
// 【为什么要「前情」】原先每个工具只认一天，问「上次那事后来怎么定了」，
//   模型只能靠猜关键词。跨天接得上不该指望模型想办法，工具得递到手上。
// 【为什么要有契约测试】2026-11-04 线上翻车：search 结果里的 `时间`、read 返回的
//   `来源` 都没在 output.schema 里声明，宿主 additionalProperties:false 把整次调用
//   判失败 —— read 从头到尾一次都没成功过。当时全量测试全绿，因为**没有一条**
//   验过「返回值 vs 声明的 schema」。这里用宿主自己的校验器对拍，不自写规则。

/** 加载宿主的 JSON Schema 校验器；拿不到就跳过（本机可能没装宿主运行时）。 */
async function 拿宿主机 () {
  const 候选 = [
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
    '/opt/dshapp/runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  ]
  for (const p of 候选) {
    try {
      const m = await import(p)
      if (typeof m.validateJsonSchemaValue === 'function' && typeof m.defineTool === 'function') return m
    } catch { /* 换下一个 */ }
  }
  return null
}

test('输出契约：每个工具在成功/失败分支上的返回都符合自己声明的 schema', async () => {
  const H = await 拿宿主机()
  if (!H) return // 本机没装宿主运行时，这条跳过
  const root = await mkdtemp(join(tmpdir(), 'diary-schema-'))
  await store.追加条目(root, 'private', '2026-11-04', { title: '今天', text: '聊了服务器搬家', tags: ['运维'], at: '2026-11-04T05:00:00.000Z', 来源: '私聊' })
  await store.追加条目(root, 'private', '2026-11-03', { title: '昨天', text: '聊过别的', tags: [], at: '2026-11-03T05:00:00.000Z', 来源: '私聊' })
  const tools = toolsMod.buildTools({
    defineTool: H.defineTool,
    rootDir: () => root,
    vaultDir: () => root,
    config: {},
  })
  const 表 = Object.fromEntries(tools.map((t) => [t.name, t]))

  const 用例 = [
    ['xiaoyu_diary_write', { 来源: 'private', text: '记一条', contextDays: 1 }],
    ['xiaoyu_diary_write', { 来源: 'private', text: '日期坏了', date: '不是日期' }],
    ['xiaoyu_diary_write', { 来源: 'private', text: '' }],
    ['xiaoyu_diary_owner_note', { 来源: 'private', text: '主人手记' }],
    ['xiaoyu_diary_owner_note', { 来源: 'private', text: '日期坏了', date: '不是日期' }],
    ['xiaoyu_diary_search', { 来源: 'private', query: '服务器' }],
    ['xiaoyu_diary_search', { 来源: 'private', query: '完全不存在zzz' }],
    ['xiaoyu_diary_read', { 来源: 'private', date: '2026-11-04' }],
    ['xiaoyu_diary_read', { 来源: 'private', date: '坏日期' }],
    ['xiaoyu_diary_recall', { query: '服务器' }],
    ['xiaoyu_diary_recall', { query: '完全不存在zzz' }],
    ['xiaoyu_diary_list', {}],
  ]
  for (const [名, 参] of 用例) {
    const t = 表[名]
    assert.ok(t, `工具不存在：${名}`)
    const out = await t.execute(参)
    const 问题 = H.validateJsonSchemaValue(t.output.schema, out)
    assert.deepEqual(问题, [], `${名}(${JSON.stringify(参)}) 的返回对不上 schema：${问题.join('；')}`)
    const blocks = t.output.render(参, out)
    assert.ok(Array.isArray(blocks) && blocks.every((b) => b && typeof b.type === 'string'),
      `${名} 的 render 必须返回内容块数组`)
  }
})

test('输出契约：search 结果条目里的字段全都在 schema 里声明过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diary-schema2-'))
  await store.追加条目(root, 'private', '2026-11-04', { title: '搬家', text: '服务器搬家了', tags: [], at: '2026-11-04T05:00:00.000Z', 来源: '私聊' })
  const tools = toolsMod.buildTools({ defineTool: (x) => x, rootDir: () => root, vaultDir: () => root, config: {} })
  const t = tools.find((x) => x.name === 'xiaoyu_diary_search')
  const out = await t.execute({ 来源: 'private', query: '服务器' })
  assert.ok(out.结果.length > 0, '应该搜到一条')
  const 声明 = Object.keys(t.output.schema.properties.结果.items.properties)
  for (const k of Object.keys(out.结果[0])) {
    assert.ok(声明.includes(k), `结果条目里的 ${k} 没在 schema 声明 —— 宿主会判整次调用失败`)
  }
})

test('输出契约：write / owner_note 失败时不返回伪装成成功的空串 id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diary-schema3-'))
  const tools = toolsMod.buildTools({ defineTool: (x) => x, rootDir: () => root, vaultDir: () => root, config: {} })
  for (const 名 of ['xiaoyu_diary_write', 'xiaoyu_diary_owner_note']) {
    const t = tools.find((x) => x.name === 名)
    const out = await t.execute({ 来源: 'private', text: '' })
    assert.equal(out.ok, false, `${名} 空内容应该失败`)
    assert.equal(out.id, null, `${名} 失败时 id 应该是 null，空串会让人以为记成功了`)
  }
})

test('前情：write 写完后带回最近几天的条目，contextDays=0 时不带', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diary-qianqing-'))
  await store.追加条目(root, 'private', '2026-11-03', { title: '昨天的约定', text: '说好一起看云', tags: [], at: '2026-11-03T05:00:00.000Z', 来源: '私聊' })
  const tools = toolsMod.buildTools({ defineTool: (x) => x, rootDir: () => root, vaultDir: () => root, config: {} })
  const w = tools.find((x) => x.name === 'xiaoyu_diary_write')

  const 带 = await w.execute({ 来源: 'private', text: '今天记一条', date: '2026-11-04' })
  assert.match(带.text, /这条之前 \d+ 天/, `默认应该带前情，实际：${带.text}`)
  assert.ok(带.text.includes('昨天的约定'), `前情里应该有昨天那条的标题，实际：${带.text}`)

  const 不带 = await w.execute({ 来源: 'private', text: '今天再记一条', date: '2026-11-04', contextDays: 0 })
  assert.ok(!/这条之前/.test(不带.text), `contextDays=0 不该带前情，实际：${不带.text}`)
})

test('前情：search 没命中时也带回前情（不能说一句没找到就完了）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diary-qianqing2-'))
  // search 的前情窗口锚在「此刻」（它没有 date 入参），所以这里造的数据必须跟着真实时钟走。
  // 【踩过的坑】原先写死 '2026-11-03'：11-05 之前窗口（今天往前 2 天）盖得住它，
  // 到 11-06 窗口滑过 11-03 就变红了 —— 功能没坏，是测试绑死了日期。
  const 昨天 = 前推天数(日记日(new Date(), { 时区: 默认时区, 起点小时: 默认日记日起点小时 }), 1)
  await store.追加条目(root, 'private', 昨天, { title: '随便记的', text: '那天天气不错', tags: [], at: `${昨天}T05:00:00.000Z`, 来源: '私聊' })
  const tools = toolsMod.buildTools({ defineTool: (x) => x, rootDir: () => root, vaultDir: () => root, config: {} })
  const s = tools.find((x) => x.name === 'xiaoyu_diary_search')
  const out = await s.execute({ 来源: 'private', query: '完全不存在zzz' })
  assert.equal(out.找到, false)
  assert.match(out.text, /最近 \d+ 天的前情/, `没命中也要带前情，实际：${out.text}`)
})

test('前情：群来源的前情不会混进私聊', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diary-qianqing3-'))
  await store.追加条目(root, 'private', '2026-11-03', { title: '私聊的事', text: '私密的', tags: [], at: '2026-11-03T05:00:00.000Z', 来源: '私聊' })
  await store.追加条目(root, 'group:999', '2026-11-03', { title: '群里的闲聊', text: '公开的', tags: [], at: '2026-11-03T05:00:00.000Z', 来源: '群' })
  const tools = toolsMod.buildTools({ defineTool: (x) => x, rootDir: () => root, vaultDir: () => root, config: {} })
  const w = tools.find((x) => x.name === 'xiaoyu_diary_write')
  const out = await w.execute({ 来源: 'group:999', text: '群里记一条', date: '2026-11-04' })
  assert.ok(!out.text.includes('私聊的事'), `群的前情里混进了私聊，实际：${out.text}`)
  assert.ok(out.text.includes('群里的闲聊'), `群的前情应该有自己的，实际：${out.text}`)
})

test('read：附前后一天的标题，跨天的事能看出接在哪天', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diary-linju-'))
  await store.追加条目(root, 'private', '2026-11-03', { title: '前一天的事', text: 'x', tags: [], at: '2026-11-03T05:00:00.000Z', 来源: '私聊' })
  await store.追加条目(root, 'private', '2026-11-04', { title: '当天的事', text: 'y', tags: [], at: '2026-11-04T05:00:00.000Z', 来源: '私聊' })
  await store.追加条目(root, 'private', '2026-11-05', { title: '后一天的事', text: 'z', tags: [], at: '2026-11-05T05:00:00.000Z', 来源: '私聊' })
  const tools = toolsMod.buildTools({ defineTool: (x) => x, rootDir: () => root, vaultDir: () => root, config: {} })
  const r = tools.find((x) => x.name === 'xiaoyu_diary_read')
  const out = await r.execute({ 来源: 'private', date: '2026-11-04' })
  assert.ok(out.text.includes('前后一天'), `应该附前后一天，实际：${out.text}`)
  assert.ok(out.text.includes('前一天的事'), '前一天标题应该在')
  assert.ok(out.text.includes('后一天的事'), '后一天标题应该在')
})
