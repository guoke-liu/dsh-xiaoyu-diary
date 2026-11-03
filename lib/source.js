// ============================================================================
// source.js —— 「来源」：日记到底是哪段聊天里记下来的
//
// 【这个模块负责什么】
//   把「私聊」「某个群」统一成一种**字符串 key**，全插件只认这一种形状：
//     · 'private'        → 私聊（和某个人一对一）
//     · 'group:<群号>'   → 某个群，群号是记忆仓库里的目录名
//   并提供三件事：校验、人读标签、目录名映射。
//
// 【为什么这样设计】
//   私聊和群聊的「重要的事」性质完全不同：
//   · 私聊里是你和特定的人的约定，翻日记时要能一眼找到；
//   · 群聊里可能根本不是你在说话，混进私聊日记会让人以为是约定；
//   · 检索「上次谁说过要给我带东西」时，混在一起会搜出群友的闲聊。
//   所以本插件的策略是**完全分开**：每个来源各有一套日记、候选、书签、索引。
//
//   为什么用字符串 key 而不是 {type, id} 对象：
//   · 它要当目录名、当路由参数、当 JSON 字段、当 Map 的键 —— 字符串最省事；
//   · 传进 URL / 前端 state 时不用担心对象被序列化后再也认不出来；
//   · 目录名直接用 key，人能一眼看懂 `entries/group-730783833/2026-11-03.json`
//     是哪个群的日记，不用回来查代码。
//
//   为什么群号单独拆出来叫 'group:<群号>' 而不是直接 '730783833'：
//   光看一串数字分不清是群号还是别的什么东西；带前缀还能校验、能防目录穿越。
//
// 【对外导出】
//   · 私聊 —— 'private' 常量
//   · 群前缀 —— 'group:' 常量
//   · 校验来源(s) —— 合法返回规范化后的 key，不合法返回 ''
//   · 是私聊(s) —— 是否私聊
//   · 群号(s) —— 群来源返回群号，否则 ''
//   · 做来源(chatType, groupId) —— 由仓库的 chatType/群号拼出 key，拼不出返回 ''
//   · 来源标签(s) —— 人读文本（'私聊' / '群 730783833'），未知来源原样返回
//   · 来源目录名(s) —— 存磁盘用的目录名（'private' / 'group-730783833'）
//   · 排序键(s) —— 私聊排前面，群按群号数字序；供 UI 稳定排序
// ============================================================================

/** 私聊的来源 key。 */
export const 私聊 = 'private'

/** 群来源的前缀，后面跟群号。 */
export const 群前缀 = 'group:'

/**
 * 校验并规范化一个来源 key。
 *
 * 群号只允许字母数字下划线连字符（记忆仓库的群目录名就是 QQ 群号，全是数字，
 * 但机器人的其他实现可能用别的形态）。**故意不接受 `.` 和 `/`** ——
 * 这个 key 会直接拼进文件路径，放行它们就等于开了目录穿越的口子。
 *
 * @param {unknown} s
 * @returns {string} 规范化后的 key；不合法返回 ''
 */
export function 校验来源 (s) {
  const t = String(s ?? '').trim()
  if (t === 私聊) return 私聊
  if (!t.startsWith(群前缀)) return ''
  const 群号 = t.slice(群前缀.length)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(群号)) return ''
  return 群前缀 + 群号
}

/** 是不是私聊。 */
export function 是私聊 (s) {
  return 校验来源(s) === 私聊
}

/** 群来源返回群号，其他返回 ''。 */
export function 群号 (s) {
  const t = 校验来源(s)
  return t.startsWith(群前缀) ? t.slice(群前缀.length) : ''
}

/**
 * 由记忆仓库的 chatType / groupId 拼出来源 key。
 * 仓库里只有 'private' 和 'group' 两种，其他一律返回 ''（不认识就不猜）。
 */
export function 做来源 (chatType, groupId) {
  const t = String(chatType ?? '').trim()
  if (t === 'private') return 私聊
  if (t === 'group') {
    return 校验来源(群前缀 + String(groupId ?? '').trim())
  }
  return ''
}

/** 人读标签。UI、工具输出、README 都用它，保证各处说法一致。 */
export function 来源标签 (s) {
  const t = 校验来源(s)
  if (t === 私聊) return '私聊'
  if (t.startsWith(群前缀)) return `群 ${t.slice(群前缀.length)}`
  return String(s ?? '')
}

/**
 * 存磁盘用的目录名。
 *
 * 为什么不直接用 key：Windows / 某些文件系统不接受 `:` 的目录名，
 * 而且 `group:` 这种名字在 shell 里还要转义。映射规则保持一一可逆：
 *   'private'          → 'private'
 *   'group:730783833'  → 'group-730783833'
 */
export function 来源目录名 (s) {
  const t = 校验来源(s)
  if (t === 私聊) return 'private'
  if (t.startsWith(群前缀)) return 'group-' + t.slice(群前缀.length)
  return ''
}

/**
 * 排序键：私聊永远排第一个，群按群号的自然序（纯数字按大小，否则按字典序）。
 * 让 UI 的来源下拉框、概览列表每次都是同一个顺序，不会因为 Map 遍历顺序乱跳。
 */
export function 排序键 (s) {
  const t = 校验来源(s)
  if (t === 私聊) return [0, 0, '']
  const id = 群号(t)
  const n = /^\d+$/.test(id) ? Number(id) : Number.MAX_SAFE_INTEGER
  return [1, n, id]
}

/** 比较函数：配合 Array.prototype.sort 用。 */
export function 比较来源 (a, b) {
  const ka = 排序键(a)
  const kb = 排序键(b)
  if (ka[0] !== kb[0]) return ka[0] - kb[0]
  if (ka[1] !== kb[1]) return ka[1] - kb[1]
  return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0
}
