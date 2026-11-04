// ============================================================================
// recall.js —— 跨来源日记检索核心：切词 + 同义词展开 + 重点加权 + 汇总渲染
//
// 【这个模块负责什么】
//   给「小鱼日记」的跨来源检索当纯函数核心。输入摊平后的日记条目
//   （{ 来源, 日期, id, title, text, tags, at }），输出按相关度排序的
//   命中结果和一段给模型看的文本汇总。切词与打分和插件的 lib/search.js
//   同源，在它之上加了三件事：
//   · 跨来源 —— 一次查询同时搜 private 和各个群，来源只是个可选过滤条件；
//   · 同义词 —— 搜「机器」也能命中只写了「服务器」的条目；
//   · 重点加权 —— 没打标签的条目总分乘以权重，不让它在排序里吃亏。
//
// 【为什么这样设计】
//   · 零依赖纯函数：检索是最常被调的路径，必须不花 LLM 钱、不读盘、
//     不发请求 —— 谁手里有这批条目，谁就能搜。也故意不 import 插件自身
//     的模块（比如 source.js）：这个文件要能被任何地方单独拿走复用，
//     来源标签/排序键这种十行小函数就地重写一份，比拖一串依赖划算。
//     代价是两处规则必须人肉保持同步（切词、来源排序），自测里有对拍。
//   · 2 字滑窗照抄 search.js：搜「猫」命中「橘猫」、搜「服务」命中
//     「服务器」在这个库里已被验证够用；换分词器收益小、回归风险大。
//   · 同义词按「组」生效，不是单向映射：表里 服务器: ['机器',…] 的意思是
//     这几个词是一组近义表达，命中任何一个都把整组拉进来。只认 key 不认
//     别名的话，搜「机器」永远到不了「服务器」，词表只剩半边有用。
//     另外多字 key 必须拿原串补一刀：'记忆仓库' 过 2 字滑窗只会剩下
//     记忆/忆仓/仓库，永远变不回整词，不看原串这组就永远点不着。
//   · 重点加权乘在总分上而不是给无标签条目另加固定分：日记条目本身是
//     主人筛过才记下的重点，标签只是可选的辅助分类；没标签的条目天生
//     拿不到「标签 +3」，固定加分会让「有没有标签」和「内容多相关」
//     混在一口锅里算不清，乘法让差距保持成比例。
//   · 同分排序 日期 → 来源：近期的事通常更要紧；再同分时 private 在前、
//     群按群号数字序，和插件 source.js 的排序键同一套规矩，UI 和检索
//     两边排出来的顺序才不会各排各的。
//
// 【对外导出】
//   · 切词(text) —— 极简中文分词，规则与 search.js 完全一致
//   · 展开同义词(query, 同义词表) —— 基础词在前、扩展词在后
//   · 打分(条目, 查询词, 选项) —— search.js 的打分 + 无标签条目重点加权
//   · 检索(全部, query, 选项) —— 跨来源检索，返回 {结果, 命中数, 用到的词}
//   · 汇总(结果) —— 把检索结果渲染成给模型看的文本
//   · 来源标签(s) —— 'private' → '私聊'，'group:x' → '群 x'，其它原样
//   · 默认同义词表 —— 贴合本项目（DSH 插件 / QQ / B站 / 腾讯云）的默认词表
// ============================================================================

/**
 * 极简中文分词：标点/空白切开后，对连续汉字做 2 字滑窗。
 * 规则与插件的 lib/search.js 逐字一致 —— 两边必须产出同形的词，
 * 打分结果才有可比性，所以照抄不改。
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
  // 连续汉字段：整段取出后做 2 字滑窗；≤2 字整段收
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
 * 把查询串展开成「基础词 + 同义词」的词表。
 *
 * 表的形状：{ 服务器: ['机器','主机','vps'], 记忆仓库: ['记忆库','vault'] }，
 * 值也可以直接是字符串（当单个别名算）。
 *
 * 一组词被「点名」的条件（满足其一即可）：
 *   · 某个基础词落在 key 或任一别名的切词结果里 —— 同义词是对称的，
 *     搜别名（机器）要能找到正主（服务器），搜正主也要能找到别名；
 *   · key 原样出现在查询串里 —— 补 2 字滑窗的刀：多字 key 会被滑窗
 *     拆碎（'记忆仓库' → 记忆/忆仓/仓库），不看原串这组永远点不着。
 *
 * 命中就把该 key 与全部别名各自切词后加进来。key/别名都过切词是为了
 * 和基础词保持同形（小写、≤2 字窗）：打分是拿词去 substring 小写化的
 * 正文，'B站' 这种混写 key 不归一成 'b站' 的形态就对不上。
 *
 * @param {string} query
 * @param {Record<string, string[]|string>} [同义词表]
 * @returns {string[]} 去重后的词；基础词在前，扩展词在后；空查询返回 []
 */
export function 展开同义词 (query, 同义词表) {
  const 串 = String(query || '')
  const 基础词 = 切词(串)
  if (基础词.length === 0) return []
  const 表 = (同义词表 && typeof 同义词表 === 'object') ? 同义词表 : {}
  const 小串 = 串.toLowerCase()
  const 扩展 = new Set()
  for (const [key, 值] of Object.entries(表)) {
    const k = String(key || '').toLowerCase()
    if (!k) continue
    const 组 = Array.isArray(值) ? 值 : [值]
    // 这一组的全部词形：key 的切词 + 每个别名的切词
    const 词形 = new Set(切词(k))
    for (const a of 组) {
      for (const w of 切词(a)) 词形.add(w)
    }
    const 被点名 = 基础词.some((w) => 词形.has(w)) || 小串.includes(k)
    if (!被点名) continue
    for (const w of 词形) 扩展.add(w)
  }
  // 基础词永远排前面：打分时它们才是主人真正想搜的，扩展词只是兜底
  const 全部 = []
  const 见过 = new Set()
  for (const w of [... 基础词, ... 扩展]) {
    if (见过.has(w)) continue
    见过.add(w)
    全部.push(w)
  }
  return 全部
}

/**
 * 来源排序键：私聊 [0,0,'']，群 [1, 群号数字, 群号]，认不出的跟在群后面。
 * 规则与插件 source.js 的排序键一致 —— 私聊的事通常比群里的更要紧，
 * 群按数字序而不是字典序（'9' < '10' 的字典序是反的）。
 *
 * @param {unknown} s
 * @returns {[number, number, string]}
 */
function 来源排序键 (s) {
  const t = String(s ?? '')
  if (t === 'private') return [0, 0, '']
  if (t.startsWith('group:')) {
    const 群号 = t.slice('group:'.length)
    const n = /^\d+$/.test(群号) ? Number(群号) : Number.MAX_SAFE_INTEGER
    return [1, n, 群号]
  }
  return [1, Number.MAX_SAFE_INTEGER, '']
}

/** 来源比较函数，配合 Array.prototype.sort 用。 */
function 比较来源 (a, b) {
  const ka = 来源排序键(a)
  const kb = 来源排序键(b)
  if (ka[0] !== kb[0]) return ka[0] - kb[0]
  if (ka[1] !== kb[1]) return ka[1] - kb[1]
  return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0
}

/**
 * 给一条日记按查询词打分。基础规则与 search.js 的打分完全一致：
 *   · 长词命中（≥2 字）记 2 分，单字记 1 分；
 *   · 标题命中额外 ×2 —— 标题是这条日记的自我概括，比正文杂句更相关；
 *   · 标签命中 +3 —— 标签是人手工打的，比正文里偶然出现的词可信；
 *   · 每个查询词只算一次分（调用方给的词表本身该是去重的），
 *     各字段分别累加的方式保持原样。
 * 在此之上的增强是重点加权：tags 为空数组或缺失的条目，最后总分乘以
 * 重点权重（默认 1.5）。日记条目是主人筛过才记下来的，没打标签往往
 * 意味着「懒得分类的干脆手记」而不是「不重要」；不加权的话这类条目
 * 天生少一份「标签 +3」可拿，同一句话记两遍，有标签的那条会永远压着
 * 没标签的那条。
 *
 * @param {{title?:string, text?:string, tags?:string[]}} 条目
 * @param {string[]} 查询词
 * @param {{重点权重?:number}} [选项]
 * @returns {number} 可能带小数（乘过权重），排序够用
 */
export function 打分 (条目, 查询词, { 重点权重 = 1.5 } = {}) {
  const 标题 = String(条目.title || '').toLowerCase()
  const 正文 = String(条目.text || '').toLowerCase()
  const 标签 = (条目.tags || []).map((t) => String(t).toLowerCase())
  let 分 = 0
  for (const w of 查询词) {
    const 权重 = w.length >= 2 ? 2 : 1
    if (正文.includes(w)) 分 += 权重
    if (标题.includes(w)) 分 += 权重 * 2
    if (标签.some((t) => t === w || t.includes(w))) 分 += 3
  }
  // 权重只认正的有限数：0/负数/非数字多半是调用方笔误，回退默认；
  // 传 1 是合法的「明确关掉加权」。0 分的条目乘完还是 0，不产生假命中
  const 权 = Number(重点权重)
  const 有效权 = Number.isFinite(权) && 权 > 0 ? 权 : 1.5
  if ((条目.tags || []).length === 0) 分 = 分 * 有效权
  return 分
}

/**
 * 跨来源检索。
 *
 * 选项：
 *   · limit —— 返回条数，夹在 1..100；0/空串/非数字一律按 20（与 search.js 同式）
 *   · tag —— 标签子串过滤，不分大小写
 *   · 来源 —— 一个来源 key 或 key 数组；不传/空 = 不过滤（跨来源的关键）
 *   · 同义词表 —— 不传（undefined）就用 默认同义词表；显式传 {} 可关掉
 *     同义词。默认开着是因为同义词是这个模块的主功能，调用方忘了传就
 *     静默失效这种事，在这个项目里吃过大亏
 *   · 重点权重 —— 透传给 打分，不传用 1.5
 *
 * 查询词为空（空串或切不出词）时是列举模式：不算分、全部分入、
 * 按 at || 日期 倒序；有查询词时丢掉 0 分的。
 *
 * @param {Array<{来源:string, 日期:string, id:string, title?:string, text:string, tags?:string[], at?:string}>} 全部
 * @param {string} query
 * @param {{limit?:number, tag?:string, 来源?:string|string[], 同义词表?:Record<string,string[]|string>, 重点权重?:number}} [选项]
 * @returns {{结果: object[], 命中数: number, 用到的词: string[]}}
 */
export function 检索 (全部, query, 选项 = {}) {
  const { limit = 20, tag, 来源, 同义词表, 重点权重 } = 选项 || {}
  let 候选 = Array.isArray(全部) ? 全部 : []
  // tag 过滤：子串、小写，和 search.js 一个规矩
  if (tag) {
    const t = String(tag).toLowerCase().trim()
    if (t) 候选 = 候选.filter((e) => (e.tags || []).some((x) => String(x).toLowerCase().includes(t)))
  }
  // 来源过滤：一个 key 或一组 key；空串/空数组都算「没给」
  const 来源组 = Array.isArray(来源) ? 来源.filter(Boolean).map(String) : (来源 ? [String(来源)] : [])
  if (来源组.length > 0) {
    候选 = 候选.filter((e) => 来源组.includes(String(e.来源 ?? '')))
  }
  const 表 = 同义词表 === undefined ? 默认同义词表 : 同义词表
  const 查询词 = 展开同义词(query, 表)
  let 打分过
  if (查询词.length === 0) {
    // 没有关键词：列举模式，不算分，全部分入，按时间倒序
    打分过 = 候选.map((e) => ({ 条目: e, 分: 0 }))
  } else {
    打分过 = 候选
      .map((e) => ({ 条目: e, 分: 打分(e, 查询词, { 重点权重 }) }))
      .filter((x) => x.分 > 0)
  }
  // 分高的在前；同分时日期新的在前；再同分时 private 在前、群按群号序
  打分过.sort((a, b) => {
    if (b.分 !== a.分) return b.分 - a.分
    const da = a.条目.at || a.条目.日期 || ''
    const db = b.条目.at || b.条目.日期 || ''
    if (db !== da) return db < da ? -1 : 1
    return 比较来源(a.条目.来源, b.条目.来源)
  })
  const 上限 = Math.max(1, Math.min(Number(limit) || 20, 100))
  const 结果 = 打分过.slice(0, 上限).map((x) => ({
    来源: x.条目.来源,
    日期: x.条目.日期,
    id: x.条目.id,
    标题: x.条目.title || '',
    内容: x.条目.text,
    标签: x.条目.tags || [],
    时间: x.条目.at || '',
    相关度: x.分,
  }))
  return { 结果, 命中数: 打分过.length, 用到的词: 查询词 }
}

/**
 * 把检索结果渲染成给模型看的文本。
 *
 * 入参两种都认：
 *   · 检索() 返回的整个对象 —— 用它的 命中数 当总命中数，
 *     「命中 40 条、显示 20 条」这种截断才说得清；
 *   · 裸的结果数组（检索().结果）—— 总数按数组长度算，两个数相同。
 *
 * 条目行各段用单空格拼，空段（无标签、无标题）整段丢弃，
 * 保证不会出现连续空格；正文为空就不输出正文行。
 * 首行括号里的来源分布数的是「显示的这批」—— 未显示的条目拿不到
 * 来源信息，想统计它们只能靠调用方把 limit 开大；截断时总数
 * （命中数）与分布口径不同是有意为之，不是 bug。
 *
 * @param {Array<{来源:string, 日期:string, id:string, 标题?:string, 内容?:string, 标签?:string[]}>|{结果:object[], 命中数?:number}} 结果
 * @returns {string}
 */
export function 汇总 (结果) {
  const 列表 = Array.isArray(结果) ? 结果 : (结果 && Array.isArray(结果.结果) ? 结果.结果 : [])
  if (列表.length === 0) return '日记里没找到相符的记录。'
  const 声明数 = (!Array.isArray(结果) && 结果 && Number.isFinite(Number(结果.命中数)))
    ? Number(结果.命中数)
    : 列表.length
  // 来源分布按 排序键 摆：私聊在最前、群按群号序，和列表排序一个规矩
  const 分布 = new Map()
  for (const r of 列表) {
    const k = String((r && r.来源) ?? '')
    分布.set(k, (分布.get(k) || 0) + 1)
  }
  const 分布文本 = [... 分布.entries()]
    .sort((a, b) => 比较来源(a[0], b[0]))
    .map(([k, n]) => `${来源标签(k)} ${n}`)
    .join(' / ')
  const 行 = [`跨来源命中 ${声明数} 条（${分布文本}），显示 ${列表.length} 条：`]
  for (const r of 列表) {
    const 条 = r || {}
    const 标签段 = (条.标签 && 条.标签.length > 0) ? `[${条.标签.join(',')}]` : ''
    const 来源段 = 条.来源 ? `[${来源标签(条.来源)}]` : ''
    const 头 = ['·', 来源段, String(条.日期 || ''), String(条.id || ''), 标签段, String(条.标题 || '')]
      .filter((s) => s !== '')
      .join(' ')
    行.push(头)
    const 正文 = String(条.内容 ?? '')
    if (正文.length > 0) 行.push(`  ${正文}`)
  }
  return 行.join('\n')
}

/**
 * 来源 key 的人读标签。说法与插件 source.js 保持一致，UI 和给模型的
 * 文本各处才不会一个叫「群聊」一个叫「群」。
 * 'private' → '私聊'，'group:730783833' → '群 730783833'，其它原样返回
 * （没见过的来源不猜，猜错比原样显示更难排查）。
 *
 * @param {unknown} s
 * @returns {string}
 */
export function 来源标签 (s) {
  const t = String(s ?? '')
  if (t === 'private') return '私聊'
  if (t.startsWith('group:')) return `群 ${t.slice('group:'.length)}`
  return t
}

/**
 * 默认同义词表。检索() 的 同义词表 选项不传时就用它。
 * 收词标准：主人真的会混着说的词才收（做 DSH 插件、玩 QQ 机器人、
 * 刷 B站、用腾讯云）；生僻的书面变体不收 —— 词表膨胀后扩展词会把
 * 不相关的条目顶上来。别名尽量取 ≤2 字的整词，3 字以上的别名会被
 * 滑窗拆出边角碎词（如「群消息」拆出「消息」），容易带进假命中。
 *
 * @type {Record<string, string[]>}
 */
export const 默认同义词表 = {
  服务器: ['机器', '主机', 'vps', '云主机'],
  记忆仓库: ['记忆库', 'vault'],
  日记: ['手记', '流水账', '备忘'],
  插件: ['扩展', 'plugin', '模块'],
  QQ: ['企鹅', '扣扣'],
  B站: ['bilibili', '哔哩哔哩', '小破站'],
  部署: ['上线', '发布', '搭建'],
  报错: ['出错', '异常', '崩了', '炸了'],
  token: ['令牌', '凭证'],
  群聊: ['群', '群里'],
  // 下面是自补的近义组：都是日常聊天里真实会混用的说法
  腾讯云: ['qcloud', '轻量'],
  密钥: ['secret', '密匙', '密码'],
  域名: ['domain', '网址'],
  机器人: ['bot'],
  命令: ['指令', 'cmd', '命令行'],
  备份: ['backup', '快照'],
  密码: ['password', 'passwd'],
}
