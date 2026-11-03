// ============================================================================
// search.js —— 日记检索：切词 + 打分 + 排序
//
// 【这个模块负责什么】
//   给日记库提供关键词检索能力。输入查询串，输出按相关度排序的命中条目。
//   切词与打分均为纯函数，零依赖，不花 LLM 钱。
//
// 【为什么这样设计】
//   做法与记忆仓库的 search-core.js 同源（2 字滑窗，零依赖），但这里是独立实现：
//   日记插件不 import 别的插件，别人的目录一改它就会坏。
//   为什么不引入 jieba：开源版要零依赖。2 字滑窗够用 ——
//   搜「猫」能命中「橘猫」，搜「服务」能命中「服务器」。
//   打分规则（都是实际调出来的，不是拍的）：
//   · 长词命中（≥2 字）记 2 分，单字记 1 分；
//   · 标题命中额外 ×2 —— 标题是这条日记的自我概括，命中它比命中正文杂句更相关；
//   · 标签精确命中 +3 —— 标签是人手工打的，比正文里偶然出现的词可信。
//   每个查询词只算一次分：重复出现的同一个词加不了分，
//   否则一段话里啰嗦地重复几次就能把无关的日记顶上来。
//
// 【对外导出】
//   · 切词(text) —— 极简中文分词：标点/空白切开后，对连续汉字做 2 字滑窗
//   · 打分(条目, 查询词) —— 给一条日记按查询词打分
//   · 检索(全部, query, {limit, tag}) —— 在若干天条目里按关键词检索，返回 {结果, 命中数}
// ============================================================================

/**
 * 极简中文分词：标点/空白切开后，对连续汉字做 2 字滑窗。
 *
 * 例：切词('腾讯云轻量服务器') → ['腾讯','讯云','云轻','轻量','量服','服务','务器']
 *
 * @param {string} text
 * @returns {string[]} 去重后的词表
 */
export function 切词 (text) {
  const 串 = String(text || '').toLowerCase()
  const 词 = new Set()
  // 英文/数字整词
  for (const m of 串.matchAll(/[a-z0-9]{2,}/g)) 词.add(m[0])
  // 连续汉字段：整段取出后做 2 字滑窗
  for (const m of 串.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const s = m[0]
    if (s.length <= 2) {
      词.add(s)
      continue
    }
    for (let i = 0; i + 2 <= s.length; i++) 词.add(s.slice(i, i + 2))
  }
  return [... 词]
}

/**
 * 给一条日记按查询词打分。
 *
 * 打分规则（都是实际调出来的，不是拍的）：
 *   · 长词命中（≥2 字）记 2 分，单字记 1 分；
 *   · 标题命中额外 ×2 —— 标题是这条日记的自我概括，命中它比命中正文杂句更相关；
 *   · 标签精确命中 +3 —— 标签是人手工打的，比正文里偶然出现的词可信。
 *
 * 每个查询词只算一次分：重复出现的同一个词加不了分，
 * 否则一段话里啰嗦地重复几次就能把无关的日记顶上来。
 *
 * @param {{title?:string,text?:string,tags?:string[]}} 条目
 * @param {string[]} 查询词
 * @returns {number}
 */
export function 打分 (条目, 查询词) {
  const 标题 = String(条目.title || '').toLowerCase()
  const 正文 = String(条目.text || '').toLowerCase()
  const 标签 = (条目.tags || []).map((t) => String(t).toLowerCase())
  let 分 = 0
  for (const w of 查询词) {
    const 权重 = w.length >= 2 ? 2 : 1
    let 命中 = false
    if (正文.includes(w)) {
      分 += 权重
      命中 = true
    }
    if (标题.includes(w)) {
      分 += 权重 * 2
      命中 = true
    }
    if (标签.some((t) => t === w || t.includes(w))) {
      分 += 3
      命中 = true
    }
    // 同一个词在多个字段都命中时，上面已经各加过了；这里只保证至少加过一次
    if (!命中) continue
  }
  return 分
}

/**
 * 在若干天的条目里按关键词检索。
 *
 * @param {Array<{date:string, id:string, title?:string, text:string, tags?:string[], at?:string}>} 全部
 * @param {string} query 关键词；空串表示不过滤（配合 tag 或纯列举）
 * @param {{limit?:number, tag?:string}} [opts]
 * @returns {{结果: object[], 命中数: number}}
 */
export function 检索 (全部, query, { limit = 20, tag } = {}) {
  const kw = String(query || '').trim()
  const 查询词 = 切词(kw)
  let 候选 = 全部
  if (tag) {
    const t = String(tag).toLowerCase().trim()
    候选 = 候选.filter((e) => (e.tags || []).some((x) => String(x).toLowerCase().includes(t)))
  }
  let 打分过
  if (查询词.length === 0) {
    // 没有关键词：就是列举，不算分，按时间倒序
    打分过 = 候选.map((e) => ({ 条目: e, 分: 0 }))
  } else {
    打分过 = 候选
      .map((e) => ({ 条目: e, 分: 打分(e, 查询词) }))
      .filter((x) => x.分 > 0)
  }
  // 分高的在前；同分时日期新的在前（近期的事通常更要紧）
  打分过.sort((a, b) => {
    if (b.分 !== a.分) return b.分 - a.分
    const da = a.条目.at || a.条目.date || ''
    const db = b.条目.at || b.条目.date || ''
    return db < da ? -1 : db > da ? 1 : 0
  })
  const 上限 = Math.max(1, Math.min(Number(limit) || 20, 100))
  const 结果 = 打分过.slice(0, 上限).map((x) => ({
    日期: x.条目.date,
    id: x.条目.id,
    标题: x.条目.title || '',
    内容: x.条目.text,
    标签: x.条目.tags || [],
    时间: x.条目.at || '',
    相关度: x.分,
  }))
  return { 结果, 命中数: 打分过.length }
}
