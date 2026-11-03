// LLM 挑选模块的测试 —— 全部用假 fetch，不发真实请求、不用任何 API key。
//
// 这里锁住的是三条用真实 API 踩出来的经验：
//   1. 思考模型会吃光 max_tokens，错误提示必须告诉用户怎么办
//   2. 措辞每次不同，去重不能靠文本相似度，必须把已记内容交给模型
//   3. apiKey 绝不能出现在任何输出里
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { 渲染批次, 挑一批, 挑选一天 } from '../lib/llm.js'

const 配置 = { baseURL: 'http://fake', apiKey: 'sk-super-secret-key-123', model: 'fake-model' }

/** 装一个假 fetch，返回指定 JSON 体。 */
function 装假Fetch (响应体, { 状态 = 200, 调用记录 = null } = {}) {
  globalThis.fetch = async (url, opts) => {
    if (调用记录) 调用记录.push({ url: String(url), body: JSON.parse((opts && opts.body) || '{}') })
    return {
      ok: 状态 >= 200 && 状态 < 300,
      status: 状态,
      text: async () => (typeof 响应体 === 'string' ? 响应体 : JSON.stringify(响应体)),
    }
  }
}

/** 造一个「模型返回若干事项」的响应体。 */
function 模型回 (内容文本, { 输入 = 100, 输出 = 20, 思考 = '' } = {}) {
  const message = { content: 内容文本 }
  if (思考) message.reasoning_content = 思考
  return { choices: [{ message }], usage: { prompt_tokens: 输入, completion_tokens: 输出 } }
}

test('llm：渲染批次格式正确', () => {
  const t = 渲染批次([
    { 时间: '09:00:00', 昵称: '某人', 内容: '明天见' },
    { 时间: '09:01:00', 昵称: '某人', 内容: '好' },
  ])
  assert.equal(t, '[09:00:00] 某人: 明天见\n[09:01:00] 某人: 好')
})

test('llm：配置不完整时直接返回，不发请求', async () => {
  let 发过 = false
  globalThis.fetch = async () => { 发过 = true; throw new Error('不该发请求') }
  const r = await 挑选一天({}, [{ 时间: '09:00:00', 昵称: 'a', 内容: 'x' }])
  assert.equal(r.ok, false)
  assert.equal(发过, false, '配置不全时绝不能发请求')
  assert.ok(r.错误.includes('配置不完整'))
})

test('llm：能解析被 markdown 代码块包裹的 JSON', async () => {
  装假Fetch(模型回('好的：\n```json\n{"事项":[{"内容":"约了明天复查","理由":"有约定","来源":"09:00:00 某人"}]}\n```'))
  const r = await 挑一批(配置, [{ 时间: '09:00:00', 昵称: '某人', 内容: '明天复查' }])
  assert.equal(r.ok, true)
  assert.equal(r.事项.length, 1)
  assert.equal(r.事项[0].内容, '约了明天复查')
})

test('llm：思考模型返回空正文时，错误提示要告诉用户调大 max_tokens', async () => {
  // 复现真实场景：content 为空、reasoning_content 有内容（思考吃光了预算）
  装假Fetch(模型回('', { 思考: '让我想想…（很长很长的思考过程）', 输出: 3000 }))
  const r = await 挑一批(配置, [{ 时间: '09:00:00', 昵称: '某人', 内容: '明天复查' }])
  assert.equal(r.ok, false)
  assert.ok(r.错误.includes('思考模型'), `错误里应点明是思考模型，实际：${r.错误}`)
  assert.ok(r.错误.includes('max_tokens'), '错误里应告诉用户调大 max_tokens')
  assert.ok(r.错误.includes('6000'), '应给出具体建议值')
})

test('llm：把已记内容交给模型（去重靠模型避开，不靠事后比对）', async () => {
  const 记录 = []
  装假Fetch(模型回('{"事项":[]}'), { 调用记录: 记录 })
  await 挑选一天(配置, [{ 时间: '09:00:00', 昵称: '某人', 内容: 'x' }], {
    已记: ['过客决定给某人重做日记插件'],
  })
  const 用户消息 = 记录[0].body.messages.find((m) => m.role === 'user').content
  assert.ok(用户消息.includes('已经记进日记'), '提示词里要带上已记清单')
  assert.ok(用户消息.includes('过客决定给某人重做日记插件'), '已记内容要在提示词里')
})

test('llm：没有已记内容时不出现那段提示', async () => {
  const 记录 = []
  装假Fetch(模型回('{"事项":[]}'), { 调用记录: 记录 })
  await 挑选一天(配置, [{ 时间: '09:00:00', 昵称: '某人', 内容: 'x' }])
  const 用户消息 = 记录[0].body.messages.find((m) => m.role === 'user').content
  assert.ok(!用户消息.includes('已经记进日记'))
})

test('llm：700 行按默认每批 400 切成 2 批', async () => {
  let 次数 = 0
  装假Fetch(模型回('{"事项":[]}'), { 调用记录: { push: () => { 次数++ } } })
  const 行们 = Array.from({ length: 700 }, (_, i) => ({ 时间: '09:00:00', 昵称: 'a', 内容: `第${i}行` }))
  const r = await 挑选一天(配置, 行们)
  assert.equal(r.批数, 2)
  assert.equal(次数, 2)
})

test('llm：分批合并后按内容去重', async () => {
  装假Fetch(模型回('{"事项":[{"内容":"明天复查","理由":"a","来源":"x"}]}'))
  const 行们 = Array.from({ length: 800 }, (_, i) => ({ 时间: '09:00:00', 昵称: 'a', 内容: `第${i}行` }))
  const r = await 挑选一天(配置, 行们)
  assert.equal(r.事项.length, 1, '两批返回同一件事，应只留一条')
})

test('llm：某一批失败不中断，其余批次结果仍可用', async () => {
  let 第几次 = 0
  globalThis.fetch = async () => {
    第几次++
    if (第几次 === 1) throw new Error('ECONNREFUSED')
    return { ok: true, status: 200, text: async () => JSON.stringify(模型回('{"事项":[{"内容":"第二件事","理由":"b","来源":"y"}]}')) }
  }
  const 行们 = Array.from({ length: 800 }, (_, i) => ({ 时间: '09:00:00', 昵称: 'a', 内容: `第${i}行` }))
  const r = await 挑选一天(配置, 行们)
  assert.equal(r.ok, false, '有失败批时整体 ok=false')
  assert.equal(r.失败批数, 1)
  assert.equal(r.事项.length, 1, '成功批次的结果不该丢')
})

test('llm：服务端回显 apiKey 时必须脱敏', async () => {
  装假Fetch('error: invalid key sk-super-secret-key-123', { 状态: 401 })
  const r = await 挑一批(配置, [{ 时间: '09:00:00', 昵称: 'a', 内容: 'x' }])
  assert.equal(r.ok, false)
  assert.ok(!r.错误.includes('sk-super-secret-key-123'), `错误里不能出现 apiKey 原文：${r.错误}`)
  assert.ok(r.错误.includes('[已隐藏]'), '应该替换成 [已隐藏]')
})

test('llm：模型返回非 JSON 时给出可读错误', async () => {
  装假Fetch(模型回('今天没什么事'))
  const r = await 挑一批(配置, [{ 时间: '09:00:00', 昵称: 'a', 内容: 'x' }])
  assert.equal(r.ok, false)
  assert.ok(r.错误.includes('不是合法 JSON'))
})

test('llm：额外参数会合并进请求体（用于思考模型）', async () => {
  const 记录 = []
  装假Fetch(模型回('{"事项":[]}'), { 调用记录: 记录 })
  await 挑一批({ ...配置, 额外参数: { thinking: { type: 'enabled' }, max_tokens: 6000 } },
    [{ 时间: '09:00:00', 昵称: 'a', 内容: 'x' }])
  assert.deepEqual(记录[0].body.thinking, { type: 'enabled' })
  assert.equal(记录[0].body.max_tokens, 6000, '额外参数要能覆盖默认 max_tokens')
})

// ── 限流重试（实测教训：免费通道 4 批全 429）────────────────────────────
//
// 没有这段时，一次限流 = 整天的挑选全废，用户只看到一串「第 N 批失败」。

test('llm：429 限流会自动重试，第二次成功就拿到结果', async () => {
  let 次 = 0
  globalThis.fetch = async () => {
    次++
    if (次 === 1) {
      return { ok: false, status: 429, text: async () => '{"error":{"message":"您已达到免费用户的 API 速率限制"}}' }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(模型回('{"事项":[{"内容":"约定明天复查","理由":"有约定","来源":"x"}]}')) }
  }
  const r = await 挑选一天(配置, [{ 时间: '09:00:00', 昵称: 'a', 内容: '明天复查' }])
  assert.equal(r.ok, true, '重试后应成功')
  assert.equal(r.事项.length, 1)
  assert.equal(次, 2, '第一次 429、第二次成功，共 2 次请求')
})

test('llm：重试用尽后仍失败，如实报失败批数', async () => {
  let 次 = 0
  globalThis.fetch = async () => {
    次++
    return { ok: false, status: 429, text: async () => '{"error":{"message":"速率限制"}}' }
  }
  const r = await 挑选一天(配置, [{ 时间: '09:00:00', 昵称: 'a', 内容: '明天复查' }])
  assert.equal(r.ok, false)
  assert.equal(r.失败批数, 1)
  assert.equal(次, 3, '1 次原始 + 2 次重试 = 3 次')
})

test('llm：不可重试的错误不浪费时间重试', async () => {
  let 次 = 0
  globalThis.fetch = async () => {
    次++
    return { ok: false, status: 401, text: async () => '{"error":"invalid api key"}' }
  }
  const r = await 挑选一天(配置, [{ 时间: '09:00:00', 昵称: 'a', 内容: '明天复查' }])
  assert.equal(r.ok, false)
  assert.equal(次, 1, '401 鉴权错误重试也没用，应只请求 1 次')
})

test('llm：模型返回非 JSON 也不重试（重试还是同样的输出）', async () => {
  let 次 = 0
  globalThis.fetch = async () => {
    次++
    return { ok: true, status: 200, text: async () => JSON.stringify(模型回('今天没什么事')) }
  }
  const r = await 挑选一天(配置, [{ 时间: '09:00:00', 昵称: 'a', 内容: '明天复查' }])
  assert.equal(r.ok, false)
  assert.equal(次, 1, '非 JSON 是模型输出问题，重试无意义')
})

// ── 提示词回归（实测翻车换来的教训）──────────────────────────────────────
//
// 写过一版 1131 字的提示词，里面有一句「返回空数组是正常且合格的结果」。
// 小模型拿它当退出口：100 行真实聊天只输出 6 个 token 的 {"事项":[]}，直接交白卷。
// 换成 491 字、去掉退出口的版本后，同一天正常挑出 3 条。
// 下面两条守住这个边界，防止有人再把提示词堆长、把退出口加回去。

test('提示词：不包含"返回空数组是合格结果"这类退出口', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const 本目录 = path.dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(path.join(本目录, '..', 'lib', 'llm.js'), 'utf8')
  const m = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`\n/)
  assert.ok(m, '应该能找到 SYSTEM_PROMPT')
  const p = m[1]
  // 这些句式等于告诉模型"交白卷也行"，小模型会照做
  assert.ok(!/空数组是正常|空数组是合格|返回空数组.{0,6}合格/.test(p),
    '提示词里不能让"返回空数组"显得合格 —— 小模型会拿它当退出口')
  // 注意：允许出现 「{"事项":[]}」这种格式说明，那只是 JSON 语法提示；
  // 禁止的是把它描述成"正常/合格的结果"。
})

test('提示词：长度不超过 700 字（太长了小模型会交白卷）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const 本目录 = path.dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(path.join(本目录, '..', 'lib', 'llm.js'), 'utf8')
  const m = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`\n/)
  const p = m[1]
  assert.ok(p.length <= 700,
    `提示词 ${p.length} 字，超过 700 —— 实测 1131 字时小模型只回 {"事项":[]} 交白卷`)
})
