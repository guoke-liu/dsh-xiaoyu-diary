// ============================================================================
// tools.js —— 日记插件的工具层
//
// 【这个模块负责什么】
//   把存储层、检索层、提取层、LLM 层包装成 6 个 DSH 原生工具，供模型调用。
//   六个工具：
//   xiaoyu_diary_write    记一条（用户叫记的时候用）
//   xiaoyu_diary_search   按关键词/标签检索
//   xiaoyu_diary_read     读某一天的全部内容
//   xiaoyu_diary_list     列出有记录的日子
//   xiaoyu_diary_extract  从记忆仓库当天的聊天里筛出候选，供模型挑（规则初筛，便宜）
//   xiaoyu_diary_llm_pick 把整天聊天交给大模型挑候选（花钱/慢，只按用户明确要求用）
//
// 【为什么这样设计】
//   【改这个文件前先知道】—— 这几条都是踩过坑的，改回去会直接让模型收不到结果
//   1. parameters 用属性映射 { key:{type,required,description} }，
//      不是 { type:'object', properties:{...} }
//   2. required:true 只能写在**属性上**；标量类型内部不能写 required（0.2.0 拒）
//   3. output.render **必须返回内容块数组**，走 包成文本块()；
//      返回裸字符串 → 宿主 content.some 崩 → 整次调用失败（AGENTS.md §3.6.2）
//   4. 每个工具都必须有 output.schema 和 render，缺一个就注册不上
//   读记忆仓库的聊天不再自己翻文件（那是仓库的实现细节，紧耦合会静默失效），
//   统一走适配器：优先仓库自己的接口，拿不到接口它自己会降级回读文件。
//   llm_pick 是唯一一个**会花钱**的工具（调外部大模型），所以 description 里
//   明确写「只在用户明确要求时用」，避免模型自作主张把日常回顾都走模型通道。
//   密钥安全：llm_pick 的 execute 全程不接触 apiKey 原文展示 —— 配置读自
//   llm.json，传给 llm.js 由其内部脱敏，工具输出（text/事项）只含模型结果。
//
// 【对外导出】
//   · 包成文本块(文本) —— 把字符串包成宿主要求的内容块数组 [{type:'text', text}]
//   · 今天(now) —— 今天是哪一天（按本机时区，YYYY-MM-DD）
//   · 规范日期(s) —— 校验日期形状；不合法返回 null
//   · buildTools({defineTool, rootDir, vaultDir}) —— 构造全部 6 个工具定义
// ============================================================================

import { 切词, 检索 } from './search.js'
import {
  追加条目, 读某天, 列出日期, 读索引, 重建, 写索引, 列出已知来源,
} from './store.js'
// 来源 key：私聊 / group:<群号>。日记按来源完全分开存，所以每个工具都要带来源。
import { 校验来源, 来源标签, 私聊, 比较来源 } from './source.js'
import { 挑候选, 渲染候选 } from './extract.js'
// 读记忆仓库的聊天不再自己翻文件（那是仓库的实现细节，紧耦合会静默失效），
// 统一走适配器：优先仓库自己的接口，拿不到接口它自己会降级回读文件。
import { 探测仓库, 读来源聊天, 列出来源 } from './vault.js'
// 大模型挑选通道：配置持久化 + 挑选一天（内部分批 + 脱敏 + 不抛异常）
import { 挑选一天 } from './llm.js'
import { 读配置, 配置是否完整 } from './settings.js'

/**
 * ⚠️ 宿主要求 output.render 返回**内容块数组**（[{type:'text', text}]），不是裸字符串。
 *    返回字符串会让宿主在 result.content.some(...) 处炸：
 *    「content.some is not a function」——这个错会让整次工具调用失败。
 */
export function 包成文本块 (文本) {
  const t = String(文本 ?? '')
  return [{ type: 'text', text: t }]
}

/**
 * `来源` 参数的说明文字，6 个工具共用一份。
 *
 * 为什么抽成常量：日记按来源完全分开存之后，每个工具都要解释一遍「来源是什么」。
 * 各写一份的话措辞迟早会分叉，模型在不同工具里看到两种说法会犯迷糊。
 * 抽成一份还有个实际好处：改一次就全改了，改的时候不容易漏掉某一个工具。
 */
const 来源说明 =
  '来源：必填。日记按来源完全分开存 —— private（私聊）或 group:<群号>。' +
  '不确定就先用 xiaoyu_diary_list 看有哪些来源。'

/** 今天是哪一天（按本机时区，YYYY-MM-DD）。 */
export function 今天 (now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 校验日期形状；不合法返回 null。 */
export function 规范日期 (s) {
  const t = String(s || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null
  const d = new Date(`${t}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  return 今天(d) === t ? t : null
}

/** 把索引里的所有条目摊平成数组（带上日期）。 */
function 摊平 (index) {
  const out = []
  for (const [date, day] of Object.entries(index.days || {})) {
    for (const e of day.entries || []) out.push({ ...e, date })
  }
  return out
}

/** 拿到某来源的可用索引：坏了就重建。 */
async function 拿索引 (rootDir, 来源) {
  const idx = await 读索引(rootDir, 来源)
  if (idx) return { index: idx, 重建过: false }
  const r = await 重建(rootDir, 来源)
  return { index: r.index, 重建过: true, 跳过: r.跳过 }
}

/**
 * 解析工具参数里的来源。
 *
 * 为什么不给默认值「全都返回」：日记按来源分开之后，「不传来源」如果默认合并，
 * 就等于把刚拆开的东西又混回去 —— 用户问「昨天记了什么」时，你没法说清
 * 回答的是哪个来源的日记。所以这里**必须明确**：不传就报错并列出可选来源，
 * 让模型自己选一次，比猜一个好。
 *
 * @returns {Promise<{ok:true, 来源:string} | {ok:false, text:string}>}
 */
async function 解析来源参数 (raw, rootDir, vaultDir) {
  const t = String(raw ?? '').trim()
  if (!t) {
    const 可选 = await 可选来源清单(rootDir, vaultDir)
    return {
      ok: false,
      text: `缺少来源参数。日记按来源分开保存（私聊一份、每个群各一份），` +
        `调用时必须说明看哪个来源。可选：${可选.join('、') || '（还没探测到任何来源）'}。`,
    }
  }
  const key = 校验来源(t)
  if (!key) {
    return { ok: false, text: `来源格式不对：${t}。只能是 private（私聊）或 group:<群号>。` }
  }
  return { ok: true, 来源: key }
}

/**
 * 可选来源清单：日记库里已有的 ∪ 记忆仓库里有的。
 *
 * 两边都要：日记库有 = 记过东西的来源；仓库有 = 现在还能读的来源。
 * 只查日记库的话，新装插件、还没记过任何东西时列表是空的，用户不知道填什么。
 */
async function 可选来源清单 (rootDir, vaultDir, 适配器) {
  const 集 = new Set(await 列出已知来源(rootDir))
  try {
    for (const s of await 列出来源(vaultDir, 适配器)) 集.add(s.来源)
  } catch { /* 仓库读不到就只报日记库里的 */ }
  return [...集].sort(比较来源).map((k) => `${k}（${来源标签(k)}）`)
}

/**
 * 构造全部工具定义。
 *
 * @param {object} deps
 * @param {Function} deps.defineTool 宿主提供的 defineTool
 * @param {() => string} deps.rootDir 日记库根目录
 * @param {() => string} deps.vaultDir 记忆仓库根目录（只读）
 * @returns {Array<object>}
 */
export function buildTools ({ defineTool, rootDir, vaultDir }) {
  const tools = []
  const push = (spec) => tools.push(defineTool(spec))

  // ── 记忆仓库适配器：只探测一次，之后复用 ─────────────────────────────
  // 探测要遍历多个基准目录 + 动态 import 仓库模块，开销不小，
  // 每读一天都重探会明显变慢，所以这里做惰性缓存。
  // 放在 buildTools 内部而不是模块顶层：每次 buildTools 调用各有一份，
  // 跟着这次注入的 rootDir/vaultDir 走，不跨实例共享状态。
  let 适配器缓存 = null
  async function 拿适配器 () {
    if (!适配器缓存) 适配器缓存 = await 探测仓库((m) => { /* 静默 */ })
    return 适配器缓存
  }

  // ── 1. 记一条 ──────────────────────────────────────────────────────────
  push({
    name: 'xiaoyu_diary_write',
    description:
      '往日记里记一条。**只在用户明确叫你记的时候用**（「记一下」「记下来」「别忘了」），' +
      '或用户刚说的某件事明显值得长期记住时。不要自作主张把普通闲聊记成日记。' +
      '一天可以记多条；同一来源同一天的内容会追加到同一个日期文件里。' +
      '日记按来源分开存，**必须明确指定来源**：私聊的事填 private，群里的填 group:<群号>。' +
      '来源不给就直接报错，不会被默认塞进私聊 —— 忘了带来源时宁可失败，也不能把群里的闲话混进私聊本子。',
    parameters: {
      来源: {
        type: 'string',
        required: true,
        description: '必填。记到哪个来源：private（私聊）或 group:<群号>。不给会报错。',
      },
      text: {
        type: 'string',
        required: true,
        description: '要记的内容。写清楚「谁、什么事、结果或约定」，别只写「聊了天」这种没信息量的话。',
      },
      title: {
        type: 'string',
        description: '一句话标题（选填）。当天回顾时先看到标题，建议写。',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '标签数组（选填），比如 ["约定","工作"]。检索时可以按标签过滤。',
      },
      date: {
        type: 'string',
        description: '记到哪一天，YYYY-MM-DD。不填就是今天。补记以前的事时才填。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true, description: '是否写入成功' },
          id: { type: 'string', required: true, description: '这条日记的编号' },
          日期: { type: 'string', required: true, description: '记到了哪一天' },
          来源: { type: 'string', required: true, description: '记到了哪个来源（private / group:<群号>）' },
          当天条数: { type: 'number', required: true, description: '这一天现在一共几条' },
          text: { type: 'string', required: true, description: '给模型看的摘要' },
        },
        additionalProperties: false,
      },
      render: (_args, v) => 包成文本块(v ? v.text : ''),
    },
    async execute (args) {
      const 日期 = args.date ? 规范日期(args.date) : 今天()
      if (!日期) {
        return { ok: false, id: '', 日期: '', 当天条数: 0, text: `日期格式不对：${args.date}（要 YYYY-MM-DD）` }
      }
      const 文本 = String(args.text || '').trim()
      if (!文本) return { ok: false, id: '', 日期, 当天条数: 0, 来源: '', text: '内容不能为空' }
      // 【为什么不给默认值（2026-11-03 按迟迟的评审改）】
      //   早先这里是 `校验来源(args.来源) || 私聊`：不传来源就静默记进私聊。
      //   而 search / read / list 三个工具不传来源都是**报错**的。
      //   同一个参数形状两种行为，最要命的是它不报错 —— 模型哪天漏了来源，
      //   一句群里的闲话就悄悄落进私聊那本，而且事后没人看得出来。
      //   宁可这次记失败让人发现，也不要记错地方还查不到。
      const 来源 = 校验来源(args.来源)
      if (!来源) {
        const 有 = await 列出已知来源(rootDir()).catch(() => [])
        const 提示 = 有.length ? `现有来源：${有.map((x) => `${来源标签(x)}（${x}）`).join('、')}` : '还没有任何来源，先用 group:<群号> 或 private 记第一条'
        return {
          ok: false, id: '', 日期, 来源: '', 当天条数: 0,
          text: `没有指定来源，这条没有记下来。请明确写出来源：私聊的事用 "private"，群里的事用 "group:<群号>"。${提示}`,
        }
      }
      const 标签 = Array.isArray(args.tags) ? args.tags.map((t) => String(t).trim()).filter(Boolean) : []
      const e = await 追加条目(rootDir(), 来源, 日期, {
        title: String(args.title || '').trim(),
        text: 文本,
        tags: 标签,
        at: new Date().toISOString(),
        来源: 来源标签(来源),
      })
      const 当天 = await 读某天(rootDir(), 来源, 日期)
      return {
        ok: true,
        id: e.id,
        日期,
        来源,
        当天条数: 当天.length,
        text: `已记下（${来源标签(来源)} ${日期} ${e.id}）：${e.title || 文本.slice(0, 30)}。这个来源这一天现在共 ${当天.length} 条。`,
      }
    },
  })

  // ── 2. 检索 ────────────────────────────────────────────────────────────
  push({
    name: 'xiaoyu_diary_search',
    description:
      '在日记里按关键词检索，找回「以前记过的事」。' +
      '中文按 2 字滑窗切词，所以搜「猫」能命中「橘猫」；标签命中权重更高。' +
      '适合用户问「我之前说过什么」「上次那个事怎么定的」「关于 X 我记过啥」。' +
      '日记按来源分开存，必须指定搜索哪个来源（私聊 / 某个群），不会跨来源混搜。',
    parameters: {
      来源: { type: 'string', required: true, description: 来源说明 },
      query: { type: 'string', description: '关键词。可以留空，配合 tag 或只看最近记录。' },
      tag: { type: 'string', description: '按标签过滤（选填）' },
      limit: { type: 'number', description: '最多返回几条，默认 20，最大 100' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          找到: { type: 'boolean', required: true, description: '是否命中至少一条' },
          命中数: { type: 'number', required: true, description: '真正命中的条数（可能多于返回条数）' },
          结果: {
            type: 'array',
            required: true,
            description: '返回的条目',
            items: {
              type: 'object',
              properties: {
                日期: { type: 'string', required: true },
                id: { type: 'string', required: true },
                标题: { type: 'string', required: true },
                内容: { type: 'string', required: true },
                标签: { type: 'array', required: true, items: { type: 'string' } },
                相关度: { type: 'number', required: true },
              },
              additionalProperties: false,
            },
          },
          text: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, v) => 包成文本块(v ? v.text : ''),
    },
    async execute (args) {
      const 选 = await 解析来源参数(args.来源, rootDir(), vaultDir())
      if (!选.ok) return { 找到: false, 命中数: 0, 结果: [], text: 选.text }
      const { index } = await 拿索引(rootDir(), 选.来源)
      const { 结果, 命中数 } = 检索(摊平(index), args.query, {
        limit: args.limit,
        tag: args.tag,
      })
      const 头 = `【${来源标签(选.来源)}】`
      if (结果.length === 0) {
        return { 找到: false, 命中数: 0, 结果: [], text: `${头}日记里没找到相符的记录。` }
      }
      const lines = [`${头}命中 ${命中数} 条，显示 ${结果.length} 条：`]
      for (const r of 结果) {
        const 标签 = r.标签.length ? ` [${r.标签.join(',')}]` : ''
        lines.push(`· ${r.日期} ${r.id}${标签} ${r.标题 || ''}`)
        lines.push(`  ${r.内容}`)
      }
      return { 找到: true, 命中数, 结果, text: lines.join('\n') }
    },
  })

  // ── 3. 读某天 ──────────────────────────────────────────────────────────
  push({
    name: 'xiaoyu_diary_read',
    description: '读某一天某个来源日记的全部内容。date 不填就是今天。适合「我昨天记了啥」这种回顾。' +
      '日记按来源分开存，不指定来源就没法回答 —— 私聊和群里的记事是两份不同的日记。',
    parameters: {
      来源: { type: 'string', required: true, description: 来源说明 },
      date: { type: 'string', description: 'YYYY-MM-DD，不填就是今天' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          找到: { type: 'boolean', required: true },
          日期: { type: 'string', required: true },
          条数: { type: 'number', required: true },
          text: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, v) => 包成文本块(v ? v.text : ''),
    },
    async execute (args) {
      const 选 = await 解析来源参数(args.来源, rootDir(), vaultDir())
      if (!选.ok) return { 找到: false, 日期: '', 来源: '', 条数: 0, text: 选.text }
      const 日期 = args.date ? 规范日期(args.date) : 今天()
      if (!日期) return { 找到: false, 日期: '', 来源: 选.来源, 条数: 0, text: `日期格式不对：${args.date}` }
      const entries = await 读某天(rootDir(), 选.来源, 日期)
      if (entries.length === 0) {
        return { 找到: false, 日期, 来源: 选.来源, 条数: 0, text: `${来源标签(选.来源)} ${日期} 没有日记。` }
      }
      const lines = [`【${来源标签(选.来源)}】${日期} 共 ${entries.length} 条：`]
      for (const e of entries) {
        const 标签 = (e.tags || []).length ? ` [${e.tags.join(',')}]` : ''
        lines.push(`· ${e.id}${标签} ${e.title || ''}`)
        lines.push(`  ${e.text}`)
      }
      return { 找到: true, 日期, 来源: 选.来源, 条数: entries.length, text: lines.join('\n') }
    },
  })

  // ── 4. 列出日子 ────────────────────────────────────────────────────────
  push({
    name: 'xiaoyu_diary_list',
    description: '列出日记里有哪些来源（私聊 / 各个群），以及每个来源有哪些天有记录、每天几条。' +
      '用来知道日记攒了多少、从哪天开始的，也是「我不知道该看哪个来源」时的入口。',
    parameters: {
      来源: { type: 'string', description: '只看某个来源（private / group:<群号>）。不填则列出全部来源的汇总。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          天数: { type: 'number', required: true },
          总条数: { type: 'number', required: true },
          来源们: {
            type: 'array',
            required: true,
            description: '每个来源各有几天、几条',
            items: {
              type: 'object',
              properties: {
                来源: { type: 'string', required: true },
                标签: { type: 'string', required: true },
                天数: { type: 'number', required: true },
                总条数: { type: 'number', required: true },
              },
              additionalProperties: false,
            },
          },
          列表: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                来源: { type: 'string', required: true },
                日期: { type: 'string', required: true },
                条数: { type: 'number', required: true },
              },
              additionalProperties: false,
            },
          },
          text: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, v) => 包成文本块(v ? v.text : ''),
    },
    async execute (args) {
      // 来源不填 = 列全部来源的汇总（这恰恰是「有哪些来源」的答案，所以要允许）
      const 指定 = String((args && args.来源) || '').trim()
      if (指定 && !校验来源(指定)) {
        return { 天数: 0, 总条数: 0, 来源们: [], 列表: [], text: `来源格式不对：${指定}。只能是 private 或 group:<群号>。` }
      }
      let 来源们 = await 列出已知来源(rootDir())
      if (指定) 来源们 = 来源们.filter((k) => k === 校验来源(指定))
      // 日记库里还没有任何来源时，退到记忆仓库看看有哪些可读的来源 ——
      // 否则用户第一次问「有哪些来源」只会得到「空的」，什么也做不了
      if (来源们.length === 0 && !指定) {
        try {
          const 仓 = await 列出来源(vaultDir(), await 拿适配器())
          来源们 = 仓.map((x) => x.来源)
        } catch { /* 仓库读不到就真的没有 */ }
      }
      if (来源们.length === 0) {
        return { 天数: 0, 总条数: 0, 来源们: [], 列表: [], text: '日记还是空的，记忆仓库里也没找到可读的来源。' }
      }

      const 汇总 = []
      const 列表 = []
      let 总天数 = 0
      let 总数 = 0
      for (const key of 来源们) {
        const 日期们 = await 列出日期(rootDir(), key)
        let 小计 = 0
        for (const d of 日期们) {
          const n = (await 读某天(rootDir(), key, d)).length
          小计 += n
          列表.push({ 来源: key, 日期: d, 条数: n })
        }
        汇总.push({ 来源: key, 标签: 来源标签(key), 天数: 日期们.length, 总条数: 小计 })
        总天数 += 日期们.length
        总数 += 小计
      }

      const lines = [`共 ${来源们.length} 个来源、${总天数} 天、${总数} 条：`]
      for (const s of 汇总) {
        lines.push(`· ${s.标签}（${s.来源}）：${s.天数} 天 ${s.总条数} 条`)
      }
      const 最近 = 列表.slice(-30)
      if (最近.length > 0) {
        lines.push('', '最近记录：')
        for (const r of 最近) lines.push(`· ${来源标签(r.来源)} ${r.日期}  ${r.条数} 条`)
      }
      if (列表.length > 30) lines.push(`…只显示最近 30 条（共 ${列表.length} 条）`)
      return { 天数: 总天数, 总条数: 总数, 来源们: 汇总, 列表, text: lines.join('\n') }
    },
  })

  // ── 5. 从记忆仓库提取候选 ──────────────────────────────────────────────
  push({
    name: 'xiaoyu_diary_extract',
    description:
      '从记忆仓库当天的聊天记录里筛出「可能值得记进日记」的候选，供你判断后再用 xiaoyu_diary_write 记下来。' +
      '本工具**只筛不写**：它按规则挑出带信号的句子（承诺、决定、重要信息、情绪、未解决的问题），' +
      '但判断不了哪条真重要，所以要你看候选做取舍。' +
      '适合每天固定回顾当天、或用户问「今天有什么值得记的」。' +
      '只看一个来源：私聊和群里的聊天分开筛，绝不混在一起。',
    parameters: {
      来源: { type: 'string', required: true, description: 来源说明 },
      date: { type: 'string', description: '筛哪一天，YYYY-MM-DD，不填就是今天' },
      上限: { type: 'number', description: '最多返回多少条候选，默认 80' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          日期: { type: 'string', required: true },
          来源: { type: 'string', required: true, description: '筛的是哪个来源' },
          总行数: { type: 'number', required: true, description: '该来源当天聊天总行数' },
          候选数: { type: 'number', required: true },
          sources: { type: 'array', required: true, items: { type: 'string' }, description: '读了哪些聊天文件' },
          text: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, v) => 包成文本块(v ? v.text : ''),
    },
    async execute (args) {
      const 选 = await 解析来源参数(args.来源, rootDir(), vaultDir())
      if (!选.ok) return { 日期: '', 来源: '', 总行数: 0, 候选数: 0, sources: [], text: 选.text }
      const 日期 = args.date ? 规范日期(args.date) : 今天()
      if (!日期) return { 日期: '', 来源: 选.来源, 总行数: 0, 候选数: 0, sources: [], text: `日期格式不对：${args.date}` }
      const 适配器 = await 拿适配器()
      const { 行们, sources } = await 读来源聊天(vaultDir(), 选.来源, 日期, 适配器)
      const 标签 = 来源标签(选.来源)
      if (行们.length === 0) {
        return {
          日期,
          来源: 选.来源,
          总行数: 0,
          候选数: 0,
          sources,
          text: `${标签} ${日期} 在记忆仓库里没有聊天记录（记忆仓库：${vaultDir()}）。`,
        }
      }
      const { 候选, 总行数 } = 挑候选(行们, { 上限: args.上限 })
      const 正文 = 渲染候选(候选, { 日期, 总行数, 来源: 选.来源 })
      const 头 = sources.length ? `聊天文件：${sources.join('；')}\n\n` : ''
      return {
        日期,
        来源: 选.来源,
        总行数,
        候选数: 候选.length,
        sources,
        text: `${头}${正文}\n\n提示：挑出真正值得记的，用 xiaoyu_diary_write 记（来源填 ${选.来源}）；拿不准的宁可不记。`,
      }
    },
  })

  // ── 6. 交给大模型挑（花钱/慢，手动通道）──────────────────────────────
  // 与第 5 个工具的区别：规则初筛（extract）不花钱、秒回，但只认词面信号；
  // 这里把整天聊天交给模型，语义判断，质量高但按 token 计费且要几十秒，
  // 所以 description 里明确「只在用户明确要求时用」。
  // 本工具**只返回候选，不写日记**：写不写由模型拿到候选后与用户确认，
  // 再调 xiaoyu_diary_write（quick-write 路由是 UI 用的，工具侧仍走 write）。
  push({
    name: 'xiaoyu_diary_llm_pick',
    description:
      '把某天的全部聊天交给大模型，让模型挑出真正值得记进日记的事。**花钱/慢**，' +
      '只在用户明确要求时用。返回模型挑出的候选，不直接写入日记 —— 用户确认后要再用 xiaoyu_diary_write 记。' +
      '一次只挑一个来源（私聊或某个群），不会跨来源混挑。',
    parameters: {
      来源: { type: 'string', required: true, description: 来源说明 },
      date: {
        type: 'string',
        description: '哪一天，YYYY-MM-DD，不填就是今天',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', required: true, description: '本次挑选是否完整成功' },
          日期: { type: 'string', required: true, description: '挑的是哪一天' },
          来源: { type: 'string', required: true, description: '挑的是哪个来源' },
          行数: { type: 'number', required: true, description: '该来源当天聊天总行数' },
          事项: {
            type: 'array',
            required: true,
            description: '模型挑出的候选（不含已写入日记的重复项）',
            items: {
              type: 'object',
              properties: {
                内容: { type: 'string', required: true },
                理由: { type: 'string', required: true },
                来源: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
          },
          已有条数: { type: 'number', required: true, description: '当天日记里已有的条数（候选里剔除的重复项数见 text）' },
          text: { type: 'string', required: true, description: '给模型看的摘要' },
        },
        additionalProperties: false,
      },
      render: (_args, v) => 包成文本块(v ? v.text : ''),
    },
    async execute (args) {
      const 选 = await 解析来源参数(args.来源, rootDir(), vaultDir())
      if (!选.ok) {
        return { ok: false, 日期: '', 来源: '', 行数: 0, 事项: [], 已有条数: 0, text: 选.text }
      }
      const 日期 = args.date ? 规范日期(args.date) : 今天()
      if (!日期) {
        return { ok: false, 日期: '', 来源: 选.来源, 行数: 0, 事项: [], 已有条数: 0, text: `日期格式不对：${args.date}（要 YYYY-MM-DD）` }
      }
      const 标签 = 来源标签(选.来源)

      // 1. 读 LLM 配置并校验；缺东西就直说缺什么，别发注定失败的请求
      const 配置 = await 读配置(rootDir())
      const 校验 = 配置是否完整(配置)
      if (!校验.ok) {
        return {
          ok: false,
          日期,
          来源: 选.来源,
          行数: 0,
          事项: [],
          已有条数: 0,
          text: `大模型配置不完整，缺少：${校验.缺.join('、')}。请先到「小鱼日记」设置页配置区填好 baseURL / apiKey / model 再试。`,
        }
      }

      // 2. 拿该来源当天的聊天（仓库适配器缓存复用）。
      //    ⚠️ 只读这一个来源：私聊和群里的聊天绝不合并交给模型，
      //    否则模型分不清说话的人是不是你（0.2.x 的混合做法已废弃）。
      const 适配器 = await 拿适配器()
      const { 行们, sources } = await 读来源聊天(vaultDir(), 选.来源, 日期, 适配器)
      if (行们.length === 0) {
        return {
          ok: false,
          日期,
          来源: 选.来源,
          行数: 0,
          事项: [],
          已有条数: 0,
          text: `${标签} ${日期} 这天没有聊天记录（找过：${(sources || []).join('；') || '未探测到仓库'}），没法交给模型挑。`,
        }
      }

      // 3. 先读当天该来源已记内容，再调模型 —— 顺序很重要：
      //    要把「已经记过什么」作为上下文交给模型，让它**自己避开**重复。
      //    （事后用文本相似度去重不可靠，实际措辞差异 2-gram 相似度只有 0.22。）
      //    只拿同一来源的已记：群里的日记不该挡住私聊该记的事。
      const 当天 = await 读某天(rootDir(), 选.来源, 日期)
      const 已记 = 当天.map((e) => String(e.text || '').trim()).filter(Boolean)
      const 结果 = await 挑选一天(
        配置,
        行们,
        { date: 日期, 来源标签: 标签, 每批行数: 配置.每批行数 || 400, timeoutMs: 配置.timeoutMs, 已记 },
      )

      // 4. 再兜一层：模型仍可能没避开，用「规范化 + 双向包含」补漏。
      //    两重保险 —— 模型侧避开是主力，这一层只捡漏。
      const 规范化 = (s) => String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
      const 已写 = 已记.map(规范化).filter((s) => s.length >= 6)
      const 是重复 = (内容) => {
        const 键 = 规范化(内容)
        if (键.length < 6) return false // 太短不做包含判断，避免误杀
        return 已写.some((旧) => 旧 === 键 || 旧.includes(键) || 键.includes(旧))
      }
      const 新增 = (结果.事项 || []).filter((m) => !是重复(m.内容))
      const 重复数 = (结果.事项 || []).length - 新增.length

      // 5. 渲染人类可读清单
      const 行们清单 = []
      for (const m of 新增) {
        行们清单.push(`· ${m.内容}`)
        if (m.理由) 行们清单.push(`  理由：${m.理由}`)
        if (m.来源) 行们清单.push(`  来源：${m.来源}`)
      }
      const 头 = [
        `【${标签}】${日期} 共 ${行们.length} 行聊天，分 ${结果.批数} 批交给模型`,
      ]
      if (结果.失败批数 > 0) 头.push(`（${结果.失败批数} 批失败：${结果.错误}）`)
      const 尾 = []
      if (重复数 > 0) 尾.push(`已过滤 ${重复数} 条与当天日记重复的内容`)
      if (新增.length === 0 && 重复数 === 0) 尾.push('模型认为这天没有新的事值得记（可能已记过或确实没有）')
      if (新增.length > 0) 尾.push(`如需写入日记，请和用户确认后再用 xiaoyu_diary_write（来源填 ${选.来源}）。`)

      const text = [
        头.join('\n'),
        ...行们清单,
        ...尾,
      ].join('\n')

      return {
        ok: 结果.ok,
        日期,
        来源: 选.来源,
        行数: 行们.length,
        事项: 新增,
        已有条数: 当天.length,
        text,
      }
    },
  })

  return tools
}
