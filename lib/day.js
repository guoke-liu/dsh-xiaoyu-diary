// ============================================================================
// day.js —— 「日记日」：一条日记该算哪一天
//
// 【这个模块负责什么】
//   回答一个问题：**此刻（或某个时间点）记的事，该落进哪一天的日记文件。**
//   同时提供「今天之前 N 天」这类日期算术，供「前情」回看用。
//
// 【为什么需要它（2026-11-04 从云端真实数据里发现的）】
//   原先一条日记算哪天，是直接 `new Date()` 取本地日期拼 YYYY-MM-DD。
//   于是 00:00 一到，本子就翻页。而真实的聊天是**熬夜连续**的：
//   云端私聊 11-03 最后一句是 22:32「那我先睡一会儿」，
//   11-04 第一句是 01:30「宝宝」—— 睡前一小时、醒来第一句，被切进了两个文件。
//   翻日记的人看到的是「昨天聊到 22 点半就断了」，其实中间只隔了三小时。
//
//   所以「一天」不该等于「日历日」，该等于**从醒来到睡着**这一段。
//   这里给了两个可调的口子：
//     · 日记日起点小时（默认 3 点）—— 凌晨 3 点前记的事仍算前一天；
//     · 时区（默认 Asia/Shanghai）—— 服务器是 UTC 时，不显式指定就会按 UTC 算，
//       那 08:00 之前记的统统掉到前一天，比不处理还糟。
//
// 【为什么发版要问 `getParts` 而不是直接用 Intl】
//   旧版 Node 的 Intl 只带 en-US 数据，`zh-CN` 的月份名对不上；而 `formatToParts`
//   出来的又是 `11/4` 这种本地化写法，月份不带前导零。所以这里统一走
//   `en-US` + `hourCycle: 'h23'`（`hour12: false` 在部分 ICU 版本里 0 点会返回 24），
//   再按数字分量自己拼 —— 拼出来的一定是 YYYY-MM-DD。
//
// 【为什么只做「往前推」一种运算】
//   日记是记账，不是日历。「今天之后第几天」在这里没有用途，
//   少一个没用的导出就少一处能写错的地方。
//
// 【对外导出】
//   · 默认日记日起点小时 —— 3
//   · 默认时区 —— 'Asia/Shanghai'
//   · 规范小时数(n) —— 把配置里读出来的乱七八糟值（字符串/负数/NaN/Infinity）夹回 0..23
//   · 取日期分量(日期, 时区) —— { 年, 月, 日 }；时区非法时退回本机时区，绝不抛
//   · 拼日期({年,月,日}) —— 'YYYY-MM-DD'
//   · 日记日(日期, {时区, 起点小时}) —— 这个时间点记的事属于哪一天
//   · 前推天数(日期串, n) —— 往前 n 天（n 可以是负数 = 往后）
//   · 邻近几天(日期串, {之前, 之后}) —— 升序的日期串数组
// ============================================================================

/** 日记日的默认起点：凌晨 3 点之前记的事，仍算前一天。 */
export const 默认日记日起点小时 = 3

/** 默认时区。服务器常是 UTC，必须显式指定，不能指望系统时区对。 */
export const 默认时区 = 'Asia/Shanghai'

/**
 * 把配置里读出来的起点小时夹回 0..23 的整数。
 *
 * 为什么要夹：「起点小时」来自设置文件，人手填的可能有 `'3'`、`-1`、`NaN`、
 *   甚至 `Infinity`。任何一个漏进 `Date` 运算都会得到 Invalid Date，
 *   而 Invalid Date 拼出来的日期串是 `NaN-NaN-NaN` —— 它会静默建成
 *   `entries/private/NaN-NaN-NaN.json` 这种文件，比报错难查得多。
 *
 * @param {unknown} n
 * @returns {number} 0..23 的整数；填得离谱就用默认值
 */
export function 规范小时数 (n) {
  if (n === null || n === undefined || n === '') return 默认日记日起点小时
  const v = Number(n)
  if (!Number.isFinite(v)) return 默认日记日起点小时
  return Math.min(23, Math.max(0, Math.trunc(v)))
}

/**
 * 取某个时间点在指定时区下的日历分量。
 *
 * @param {Date} 日期
 * @param {string} [时区] IANA 时区名；非法或机器缺 ICU 数据时退回本机时区
 * @returns {{年:number, 月:number, 日:number, 时:number}} 月、日从 1 开始
 */
export function 取日期分量 (日期, 时区) {
  const d = 日期 instanceof Date ? 日期 : new Date(日期)
  if (Number.isNaN(d.getTime())) {
    // 不该发生：调用方给的若是非法时间，也退回「现在」，绝不产出 NaN 日期串
    return 取日期分量(new Date(), 时区)
  }
  const tz = typeof 时区 === 'string' && 时区.trim() ? 时区.trim() : ''
  if (tz) {
    try {
      const f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      })
      const 件 = {}
      for (const p of f.formatToParts(d)) 件[p.type] = p.value
      const 年 = Number(件.year)
      const 月 = Number(件.month)
      const 日 = Number(件.day)
      // 缺数据（老 Node 的 en-US 只有部分 ICU）时 formatToParts 拿不到数字分量，
      // 这时不能拿 NaN 往下走 —— 直接退回本机时区重算。
      if ([年, 月, 日].every((x) => Number.isFinite(x) && x > 0)) {
        return { 年, 月, 日, 时: Number(件.hour) || 0 }
      }
    } catch { /* 时区名不认识 → 退回本机时区 */ }
  }
  return { 年: d.getFullYear(), 月: d.getMonth() + 1, 日: d.getDate(), 时: d.getHours() }
}

/** 把日历分量拼成 'YYYY-MM-DD'（补零）。 */
export function 拼日期 ({ 年, 月, 日 }) {
  return `${String(年).padStart(4, '0')}-${String(月).padStart(2, '0')}-${String(日).padStart(2, '0')}`
}

/**
 * 这个时间点记的事，属于哪一天的日记。
 *
 * 规则：取该时区下的「本地日期时间」，若小时 < 起点小时，则算前一天。
 *   起点 3 点时：11-03 22:32 → 11-03；11-04 01:30 → 11-03；11-04 09:00 → 11-04。
 *
 * 为什么用「日历日减一天」而不是「减 3 小时再取日期」：
 *   两者在整数起点下等价，但前者不依赖「一天等于多少毫秒」这个假设 ——
 *   夏令时地区 0 点那小时会变，按日历减天才是对的做法。
 *   （用 `Date` 的 setDate(-1) 在**本机时区**下运算，配合已经算好的本地分量，
 *     夏令时也只在「分量 → 时间戳 → 分量」之间来回一次，不会漂。）
 *
 * @param {Date|number|string} [日期] 默认现在
 * @param {{时区?:string, 起点小时?:number}} [选项]
 * @returns {string} 'YYYY-MM-DD'
 */
export function 日记日 (日期 = new Date(), { 时区, 起点小时 } = {}) {
  const 起点 = 规范小时数(起点小时)
  const 分 = 取日期分量(日期, 时区 ?? 默认时区)
  const 当天 = 拼日期(分)
  if (分.时 >= 起点) return 当天
  return 前推天数(当天, 1)
}

/**
 * 日期串往前推 n 天（n 为负 = 往后）。
 *
 * 用 UTC 构造再取年月日：日期串本身不带时区，拿本地时区跑会遇上
 * 「本地时间 0 点不存在」的夏令时坑；UTC 下每一天都有 24 小时，不会缺日子。
 *
 * @param {string} 日期串 'YYYY-MM-DD'
 * @param {number} n 天
 * @returns {string} 'YYYY-MM-DD'
 */
export function 前推天数 (日期串, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(日期串 || '').trim())
  if (!m) return ''
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (Number.isNaN(d.getTime())) return ''
  d.setUTCDate(d.getUTCDate() - Number(n || 0))
  return 拼日期({ 年: d.getUTCFullYear(), 月: d.getUTCMonth() + 1, 日: d.getUTCDate() })
}

/**
 * 以某天为中心的邻近日期，升序。
 *
 * @param {string} 日期串 'YYYY-MM-DD'
 * @param {{之前?:number, 之后?:number}} [范围] 之前/之后各取几天（0 = 不含自己那侧之外）
 * @returns {string[]} 升序，长度 = 之前 + 之后 + 1
 */
export function 邻近几天 (日期串, { 之前 = 0, 之后 = 0 } = {}) {
  const 头 = 前推天数(日期串, Math.max(0, 之前))
  if (!头) return []
  const 出 = []
  const 总 = Math.max(0, 之前) + Math.max(0, 之后) + 1
  for (let i = 0; i < 总; i++) {
    const d = 前推天数(头, -i)
    if (d) 出.push(d)
  }
  return 出
}
