// ============================================================================
// importer.js —— 把别的日记 App / 笔记导出的文件，导进小鱼日记
//
// 【这个模块负责什么】
//   读一个外部文件（Day One 导出、通用 JSON、JSONL、Markdown/纯文本、
//   Notion / Obsidian 导出），解析成日记条目的形状，再**写进本插件自己的**
//   entries/<来源>/<日期>.json。
//
//   支持的格式见 内置预设()。识别的字段名来自各有名转换器的实现
//   （Day One 的 creationDate 就是这类事实，写错它不报错只是日期全变成今天）。
//
// 【为什么这样设计】
//   · 为什么不像记忆仓库那样写进 imported/ 目录：那边写进 imported 是为了
//     「不冒充另一个插件的库」。这里情况相反 —— 我们**就是**日记插件本身，
//     写进 imported 反而会让日记界面看不到导入的内容。所以直接写 entries/，
//     和手动记的一条走同一套存储、索引、检索。
//
//   · 为什么导入必须显式给来源：日记按来源完全分开存是插件的核心性质。
//     如果导入默认塞进私聊，用户导一堆群聊备份进来就污染了私聊本子，
//     而且事后极难分离（老数据只有 tags 没有群号那次教训）。所以没有默认值。
//
//   · 为什么幂等：用户很可能导完发现映射写错了，改一下再导一遍。第二遍如果
//     全塞一遍，日记就全重复了。所以每条算一个稳定指纹（日期+正文），
//     同一条目在同来源下已有就跳过。
//
//   · 为什么指纹不含来源：同一个文件导进私聊和群里是两次不同的导入，
//     但去重是按「某个来源的内部」做的，指纹里再带来源就是冗余。
//
// 【对外导出】
//   · 内置预设() —— 可选格式预设名与说明
//   · 识别输入形状(数据) —— 'array'|'entries'|'byDate'|'jsonl'|'markdown'|''
//   · 解析成条目(数据, 选项) —— { 形状, 条目, 跳过 }
//   · 条目指纹(条目) —— 幂等去重用的稳定键
//   · 导入文件({文件内容, 文件名, 来源, 预设, 字段映射}) —— 只解析，不落盘
//   · 写入日记({rootDir, 来源, 条目, 干跑, 追加条目, 读某天}) —— 落盘（幂等）
// ============================================================================

import { createHash } from 'node:crypto'

/** 导入条目的版本标记，跟着日记条目结构走。 */
const 版本 = 1

/**
 * 内置格式预设。
 *
 * 【这些字段名不是猜的】
 *   · Day One 官方导出的日期字段叫 `creationDate`，不是 createdAt。
 *     写错它不会报错 —— 日期会全部退回「今天」，时效全失效，只有对比原文才发现。
 *   · Notion 导出是「一篇 md 一个文件」，标题在文件名里。
 *   · Obsidian / Logseq 日记是 Markdown，按日期标题切。
 */
export function 内置预设 () {
  return [
    { 名: 'auto', 说明: '自动识别（默认）：按内容猜形状，字段按常见名逐个找' },
    { 名: 'dayone', 说明: 'Day One 导出 JSON（字段 text / creationDate / uuid）' },
    { 名: 'generic', 说明: '通用 JSON（text/content/body + date/createdAt + tags）' },
    { 名: 'notion', 说明: 'Notion 导出（解压后的 .md，标题用文件名）' },
    { 名: 'obsidian', 说明: 'Obsidian / Logseq 日记（Markdown，按日期标题切）' },
    { 名: 'markdown', 说明: 'Markdown / 纯文本（按日期标题切，没标题就整篇一条）' },
  ]
}

/** 预设名 → 字段映射。空映射 = 走通用探测。 */
function 取映射 (预设) {
  const k = String(预设 || '').trim().toLowerCase()
  if (k === 'dayone') {
    return { text: 'text', date: 'creationDate', id: 'uuid', tags: 'tags', title: '' }
  }
  if (k === 'generic') {
    return { text: 'content', title: 'title', date: 'date', id: 'id', tags: 'tags' }
  }
  // notion / obsidian / markdown / auto 都走候选探测
  return {}
}

/**
 * 条目指纹：幂等去重用的稳定键。
 *
 * 用「日期 + 正文」而不是整个条目 JSON：正文一样、标题改了不该算新条目。
 * 也不含来源 —— 去重是按某个来源内部做的。
 */
export function 条目指纹 (条目) {
  const 原文 = [条目?.日期 || '', String(条目?.text || '').trim()].join('\u0001')
  return createHash('sha1').update(原文).digest('hex').slice(0, 16)
}

/** 识别输入形状。 */
export function 识别输入形状 (数据) {
  if (Array.isArray(数据)) return 'array'
  if (typeof 数据 === 'string') {
    const t = 数据.trim()
    if (!t) return ''
    if (t.startsWith('{') || t.startsWith('[')) {
      const 行们 = t.split('\n').map((x) => x.trim()).filter(Boolean)
      if (行们.length > 1 && 行们.every((l) => l.startsWith('{') && l.endsWith('}'))) {
        return 'jsonl'
      }
      return ''
    }
    return 'markdown'
  }
  if (数据 && typeof 数据 === 'object') {
    for (const k of ['entries', 'items', 'data', 'records', 'list']) {
      if (Array.isArray(数据[k])) return 'entries'
    }
    const 键们 = Object.keys(数据)
    if (键们.length > 0 && 键们.every((k) => /^\d{4}[-/]\d{2}[-/]\d{2}$/.test(k))) return 'byDate'
  }
  return ''
}

/** 从多个候选字段名里取第一个有值的（映射优先）。 */
function 取字段 (obj, 映射, 候选们) {
  const 名们 = 映射 ? [映射, ...候选们] : 候选们
  for (const 名 of 名们) {
    if (名 == null || 名 === '') continue
    const v = obj[名]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/** 把任意东西洗成字符串。 */
function 洗字符串 (v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(洗字符串).filter(Boolean).join(' ')
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return '' }
  }
  return String(v)
}

/** 把日期洗成 YYYY-MM-DD；认不出返回空串。 */
function 洗日期 (v) {
  const s = 洗字符串(v).trim()
  if (!s) return ''
  const m = s.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const t = Date.parse(s)
  if (Number.isFinite(t)) {
    const d = new Date(t)
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${y}-${mo}-${dd}`
  }
  return ''
}

/**
 * 把一条原始记录转成日记条目。转不出正文返回 null。
 *
 * 不返回 at / 来源 这些内部字段 —— 那是进口实现的事，这里只给「记的什么、哪天」。
 */
export function 转条目 (原, 映射 = {}, 默认日期 = '') {
  if (!原 || typeof 原 !== 'object' || Array.isArray(原)) return null
  const 正文 = 洗字符串(取字段(原, 映射.text, [
    'text', 'content', 'body', 'note', '正文', '内容', 'value', 'memo',
  ]))
  if (!正文.trim()) return null
  const 标题 = 洗字符串(取字段(原, 映射.title, ['title', 'name', 'heading', '标题', 'subject']))
  const 标签原 = 取字段(原, 映射.tags, ['tags', 'tag', 'labels', '标签', 'categories'])
  const 标签 = Array.isArray(标签原)
    ? 标签原.map(洗字符串).filter(Boolean)
    : 洗字符串(标签原).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
  const 日期 = 洗日期(取字段(原, 映射.date, [
    'creationDate', 'creation_date', 'createdAt', 'created_at', 'created',
    'date', 'day', 'dayKey', 'time', 'timestamp', 'datetime', '日期', '时间',
  ])) || 默认日期
  return { 日期, 标题, 正文: 正文.trim(), 标签 }
}

/**
 * 把文本日记（Markdown / 纯文本）按日期标题切分成条目。
 *
 * 标题形式：`## 2026-11-03`、`# 2026-11-03 星期二`、`[2026-11-03]`。
 * 没有日期标题就整篇算一条，日期用文件名或今天兜底。
 */
export function 读文本日记 (文本, 选项 = {}) {
  const 串 = String(文本 || '')
  const 默认日期 = 洗日期(选项.默认日期)
  const 最小 = Number.isFinite(Number(选项.最小长度)) ? Number(选项.最小长度) : 4

  const 标记们 = []
  const 正则 = /^[ \t]*(?:#{1,6}[ \t]*)?\[?(\d{4}[-/]\d{2}[-/]\d{2})\]?[^\n]*$/gm
  let m
  while ((m = 正则.exec(串)) !== null) {
    标记们.push({ 起: m.index, 止: m.index + m[0].length, 日期: 洗日期(m[1]) })
  }

  const 条目 = []
  if (标记们.length === 0) {
    const 正文 = 串.trim()
    if (正文.length >= 最小) {
      条目.push({ 日期: 默认日期, 标题: '', 正文, 标签: [] })
    }
    return 条目
  }
  for (let i = 0; i < 标记们.length; i++) {
    const 起 = 标记们[i].止
    const 止 = i + 1 < 标记们.length ? 标记们[i + 1].起 : 串.length
    const 正文 = 串.slice(起, 止).trim()
    if (正文.length < 最小) continue
    条目.push({ 日期: 标记们[i].日期 || 默认日期, 标题: '', 正文, 标签: [] })
  }
  return 条目
}

/**
 * 把任意输入解析成条目数组。
 *
 * @returns {{形状:string, 条目:object[], 跳过:number}}
 */
export function 解析成条目 (数据, 选项 = {}) {
  const 映射 = 选项.映射 && typeof 选项.映射 === 'object' ? 选项.映射 : {}
  const 默认日期 = 洗日期(选项.默认日期)
  const 形状 = 识别输入形状(数据)

  if (形状 === 'markdown') {
    return {
      形状,
      条目: 读文本日记(数据, { 默认日期, 最小长度: 选项.最小长度 }),
      跳过: 0,
    }
  }
  if (形状 === 'jsonl') {
    const 条目 = []
    let 跳过 = 0
    for (const 行 of String(数据).split('\n')) {
      const t = 行.trim()
      if (!t) continue
      let o = null
      try { o = JSON.parse(t) } catch { 跳过 += 1; continue }
      const e = 转条目(o, 映射, 默认日期)
      if (e) 条目.push(e)
      else 跳过 += 1
    }
    return { 形状, 条目, 跳过 }
  }

  let 清单 = []
  if (形状 === 'array') 清单 = 数据
  else if (形状 === 'entries') {
    for (const k of ['entries', 'items', 'data', 'records', 'list']) {
      if (Array.isArray(数据[k])) { 清单 = 数据[k]; break }
    }
  } else if (形状 === 'byDate') {
    for (const [日期, 值] of Object.entries(数据)) {
      const 们 = Array.isArray(值) ? 值 : [值]
      for (const x of 们) {
        if (x && typeof x === 'object' && !Array.isArray(x)) {
          清单.push({ ...x, date: x.date || 日期 })
        } else if (typeof x === 'string') {
          清单.push({ text: x, date: 日期 })
        }
      }
    }
  } else {
    return { 形状: '', 条目: [], 跳过: 0 }
  }

  const 条目 = []
  let 跳过 = 0
  for (const x of 清单) {
    const e = 转条目(x, 映射, 默认日期)
    if (e) 条目.push(e)
    else 跳过 += 1
  }
  return { 形状, 条目, 跳过 }
}

/**
 * 解析一个文件的内容（不落盘）。
 *
 * @param {{内容:string, 文件名?:string, 预设?:string, 字段映射?:object}} 选项
 * @returns {{ok:boolean, 形状?:string, 条目?:object[], 跳过?:number, 错误?:string}}
 */
export function 导入文件 (选项 = {}) {
  const 文本 = String(选项.内容 ?? '')
  if (!文本.trim()) {
    return { ok: false, 错误: '文件是空的，没有可以导入的内容。' }
  }

  // 先试 JSON，失败再当纯文本
  let 数据 = 文本
  let 是JSON = false
  try {
    数据 = JSON.parse(文本)
    是JSON = true
  } catch { /* 当文本处理 */ }

  const 文件名日期 = (String(选项.文件名 || '').match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || ''
  const 映射 = {
    ...取映射(选项.预设),
    ...(选项.字段映射 && typeof 选项.字段映射 === 'object' ? 选项.字段映射 : {}),
  }
  // 预设是 markdown 时强制走文本解析，不看内容像不像 JSON
  const 强制文本 = ['markdown', 'obsidian', 'notion'].includes(String(选项.预设 || '').toLowerCase())
  const 解析 = 解析成条目(强制文本 && 是JSON === false ? 文本 : 数据, {
    映射,
    默认日期: 文件名日期,
  })

  if (!解析.条目.length) {
    return {
      ok: false,
      形状: 解析.形状,
      错误: 是JSON
        ? '没解析出任何条目 —— 可能是字段名对不上。请用「字段映射」指定正文字段名，例如 {"text":"content"}。'
        : '这个文件里没找到任何日记内容。',
    }
  }
  return { ok: true, ...解析 }
}

/**
 * 把解析好的条目写进日记库（幂等）。
 *
 * @param {object} 选项
 * @param {string} 选项.rootDir 日记库根目录
 * @param {string} 选项.来源 已校验过的来源 key（private / group:<群号>）
 * @param {object[]} 选项.条目
 * @param {string} 选项.日期 没有日期的条目归到哪天
 * @param {boolean} [选项.干跑] true 只算不写
 * @param {Function} 选项.追加条目 store.追加条目
 * @param {Function} 选项.读某天 store.读某天
 * @returns {Promise<{新增:number, 跳过:number, 按日期:object, 空日期:number}>}
 */
export async function 写入日记 (选项 = {}) {
  const { rootDir, 来源, 条目, 追加条目, 读某天 } = 选项
  const 干跑 = !!选项.干跑
  const 兜底日期 = 洗日期(选项.日期) || 洗日期(new Date().toISOString().slice(0, 10))

  // 先建「该来源下已有哪些指纹」的集合，按日期分桶读，读一次就够
  const 已有 = new Map()          // 日期 -> Set(指纹)
  const 取已有 = async (日期) => {
    if (!已有.has(日期)) {
      const 们 = await 读某天(rootDir, 来源, 日期)
      const s = new Set()
      for (const e of 们) s.add(条目指纹({ 日期, text: e.text }))
      已有.set(日期, s)
    }
    return 已有.get(日期)
  }

  let 新增 = 0
  let 跳过 = 0
  let 空日期 = 0
  const 按日期 = {}
  for (const 条 of 条目) {
    const 日期 = 洗日期(条.日期) || 兜底日期
    if (!洗日期(条.日期)) 空日期 += 1
    const set = await 取已有(日期)
    const fp = 条目指纹({ 日期, text: 条.正文 })
    if (set.has(fp)) { 跳过 += 1; continue }
    set.add(fp)
    if (!干跑) {
      await 追加条目(rootDir, 来源, 日期, {
        title: 条.标题 || '',
        text: 条.正文,
        tags: Array.isArray(条.标签) && 条.标签.length ? 条.标签 : ['导入'],
        at: new Date().toISOString(),
        来源: '导入',
        作者: 'owner',
        导入: { 版本 },
      })
    }
    新增 += 1
    按日期[日期] = (按日期[日期] || 0) + 1
  }
  return { 新增, 跳过, 按日期, 空日期 }
}
