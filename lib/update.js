// ============================================================================
// update.js —— 更新检查：版本号解析、比较、以及 GitHub 版本查询（带缓存）
//
// 【这个模块负责什么】
//   给 UI 的「更新推送」提供数据：当前版本、仓库最新版本、有没有新版、
//   以及一条人能读懂的更新日志。
//
//   分两半，刻意分开：
//     · 纯函数（本文件上半部分）：解析版本号、比较版本号、整理发布信息。
//       不发网络、不读文件，所以能直接单测 —— test/update.test.mjs 专门守它。
//     · 查询函数（本文件下半部分）：真的去问 GitHub，带缓存和超时。
//
// 【为什么这样设计】
//   1. **只有服务器去问 GitHub，浏览器不直连。**
//      前端的 BASE 是相对路径、走宿主的认证 cookie；如果让浏览器直接
//      fetch('https://api.github.com/...')，会跨域、会暴露用户 IP 给 GitHub，
//      而且拿不到我们自己的缓存。让服务器代问一次、缓存住，最省也最稳。
//
//   2. **必须缓存。** GitHub 匿名 API 每 IP 每小时只有 60 次
//      （实测云端 /rate_limit 返回 limit: 60）。UI 每开一次设置页就问一次的话，
//      用户多点几下就用光了，之后所有人都看到 403。默认缓存 30 分钟。
//
//   3. **只用 api.github.com，不用 raw.githubusercontent.com。**
//      云端实测：api.github.com 200（0.5s），raw.githubusercontent.com 直接超时。
//      所以更新日志只能从 API 里能拿到的字段拼出来（见 整理发布），
//      不能指望去拉 README 或 CHANGELOG 原文。
//
//   4. **绝不让检查更新影响插件本身。** 网络失败、超时、限流、仓库改名、
//      返回结构变了 —— 一律返回 { ok:false, error }，UI 显示一行灰字就完事。
//      检查更新是锦上添花，不能因为它把设置页搞白屏。
//
//   5. **版本比较不能只按字符串比。** 按字符串比 "v0.10.0" < "v0.9.0"（错），
//      而且我们的 tag 带后缀（v0.2.0-test）。所以拆成数字段逐个比，
//      再单独处理预发布后缀：1.0.0-test < 1.0.0（预发布低于正式版）。
//
// 【对外导出】
//   纯函数：
//     · 解析版本(str)          —— 'v0.2.0-test' → { 主:[0,2,0], 原:'v0.2.0-test', 预发布:'test' }
//     · 比较版本(a, b)          —— 返回 -1 / 0 / 1
//     · 是最新版(当前, 最新)    —— 布尔；任何一边解析不了都返回 false（不谎报有新版）
//     · 整理发布(项)            —— GitHub tag/release 的原始对象 → UI 用的扁平结构
//     · 挑最新(项列表)          —— 从 tag 列表里挑版本号最大的那个
//     · 拼更新日志(发布信息)    —— 由能拿到的字段拼一条给人看的说明
//   查询：
//     · 查询最新版本(选项)      —— 带缓存的 GitHub 查询，永不抛
//     · 清缓存()                —— 给测试和「强制刷新」用
//
// 【环境】Node ≥ 20（用到全局 fetch），ESM，零第三方依赖。
// 【许可】MIT，见根目录 LICENSE。
// ============================================================================

/** 默认仓库。给开源用户自己部署时可以在 config 里改。 */
export const 默认仓库 = 'guoke-liu/dsh-xiaoyu-diary'

/** 默认缓存时长：30 分钟。见文件头第 2 条，匿名 API 每小时只有 60 次。 */
export const 默认缓存毫秒 = 30 * 60 * 1000

/** 单次查询超时：8 秒。云端实测 api.github.com 约 0.5s，留足余量。 */
const 默认超时毫秒 = 8000

/** GitHub API 要求的 User-Agent；不带会被拒。 */
const 用户代理 = 'xiaoyu-diary-plugin'

// ── 纯函数：版本号 ──────────────────────────────────────────────────────────

/**
 * 解析版本号字符串。
 *
 * 接受：'0.2.0'、'v0.2.0'、'v0.2.0-test'、'v1.2.3-rc.1'、'release-1.2'。
 * 只取「第一段出现的 数字.数字[.数字]」，前面的前缀（v / release-）忽略，
 * 后面的预发布后缀单独存起来。
 *
 * 为什么要挑出第一段而不是严格校验格式：GitHub 上的 tag 是用户随手起的，
 * 我们只负责尽量读懂；读不懂就返回 { 主:[], 原 }，由调用方决定怎么办。
 *
 * @param {string} 原文
 * @returns {{主:number[], 原:string, 预发布:string, 可解析:boolean}}
 */
export function 解析版本 (原文) {
  const 原 = typeof 原文 === 'string' ? 原文.trim() : ''
  // 前瞻式地找第一段 数字[.数字]*：容忍 v 前缀、release- 之类
  const 匹配 = 原.match(/(\d+(?:\.\d+)*)/)
  if (!匹配) return { 主: [], 原, 预发布: '', 可解析: false }
  const 主 = 匹配[1].split('.').map((s) => {
    const n = Number.parseInt(s, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  })
  // 预发布后缀：匹配段之后的部分，去掉开头的分隔符
  const 后缀 = 原.slice(匹配.index + 匹配[0].length).replace(/^[-_.]/, '').trim()
  return { 主, 原, 预发布: 后缀, 可解析: 主.length > 0 }
}

/**
 * 比较两个版本号。返回 -1（a 旧）/ 0（相同）/ 1（a 新）。
 *
 * 规则：
 *   1. 数字段逐个比，缺的段当 0（'1.2' 与 '1.2.0' 相等）。
 *   2. 数字段全等时再看预发布后缀：**没有后缀的更大**
 *      （1.0.0 > 1.0.0-test，这是 semver 的约定）。
 *   3. 两边都有后缀时按字符串比 —— 够用了，我们只用来排队显示。
 *   4. 任一边解析不了：把「解析不了」的当作更旧，让可解析的那个赢；
 *      两边都解析不了就返回 0。这样不至于因为一个脏 tag 就谎报有新版。
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
export function 比较版本 (a, b) {
  const A = 解析版本(a)
  const B = 解析版本(b)
  if (!A.可解析 && !B.可解析) return 0
  if (!A.可解析) return -1
  if (!B.可解析) return 1
  const 长 = Math.max(A.主.length, B.主.length)
  for (let i = 0; i < 长; i++) {
    const x = A.主[i] || 0
    const y = B.主[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  // 数字段相等，比预发布后缀
  const 有A = A.预发布.length > 0
  const 有B = B.预发布.length > 0
  if (!有A && !有B) return 0
  if (!有A) return 1 // a 是正式版，更大
  if (!有B) return -1 // b 是正式版，更大
  if (A.预发布 === B.预发布) return 0
  return A.预发布 < B.预发布 ? -1 : 1
}

/**
 * 最新版是否比当前版新。
 *
 * 保守原则：**任何一边解析不了都返回 false**。
 * 检查更新宁可漏报（用户以为是最新），也不要误报（用户以为该更新，
 * 结果装了个旧包）。误报会让人白折腾一次，漏报只是少个提示。
 *
 * @param {string} 当前
 * @param {string} 最新
 * @returns {boolean}
 */
export function 是最新版 (当前, 最新) {
  const A = 解析版本(当前)
  const B = 解析版本(最新)
  if (!A.可解析 || !B.可解析) return false
  return 比较版本(最新, 当前) > 0
}

// ── 纯函数：把 GitHub 的返回整理成 UI 要的形状 ───────────────────────────────

/**
 * 整理一条 GitHub tag / release 原始对象。
 *
 * GitHub 两种返回结构差别不小：
 *   tag     → { name, commit: { sha }, zipball_url, ... }        （没有日期！）
 *   release → { tag_name, name, body, published_at, html_url }  （有正文和日期）
 * 我们对两者都兼容：两种都拿得到就用 release 的正文，只有 tag 就用能拼出来的信息。
 *
 * ⚠️ tag 接口**不返回日期**（实测 2026-11-03）。所以「发布时间」这个字段
 *    只有 release 才有，tag 情况下是空串 —— UI 必须能容忍空值，不能显示 Invalid Date。
 *
 * @param {object} 项 GitHub 原始对象
 * @returns {{版本:string, 名称:string, 说明:string, 网址:string, 发布日期:string, 第几次提交:string}|null}
 */
export function 整理发布 (项) {
  if (!项 || typeof 项 !== 'object') return null
  // release 用 tag_name，tag 用 name
  const 版本 = String(项.tag_name || 项.name || '').trim()
  if (!版本) return null
  const 名称 = String(项.name || 项.tag_name || 版本).trim()
  // release 有 body（更新日志正文）；tag 没有
  let 说明 = typeof 项.body === 'string' ? 项.body.trim() : ''
  if (!说明) 说明 = 拼更新日志({ 版本, 名称, 发布日期: 项.published_at || '' })
  return {
    版本,
    名称,
    说明,
    网址: typeof 项.html_url === 'string' ? 项.html_url : '',
    发布日期: typeof 项.published_at === 'string' ? 项.published_at : '',
    第几次提交: String((项.commit && 项.commit.sha) || '').slice(0, 7),
  }
}

/**
 * 从一串 tag（或 release）里挑版本号最大的。
 *
 * 为什么不直接取数组第一个：GitHub 的 tag 列表按**名字**排序不按时间，
 * 而且我们的 tag 有 v0.2.0-test 这种带后缀的，字典序会把 v0.10 排到 v0.9 前面。
 * 老老实实逐个比一遍最稳。
 *
 * @param {Array} 项列表
 * @returns {string} 最大版本号字符串；列表为空或全解析不了返回 ''
 */
export function 挑最新 (项列表) {
  if (!Array.isArray(项列表)) return ''
  let 最好 = ''
  for (const 项 of 项列表) {
    const 版本 = String((项 && (项.tag_name || 项.name)) || '').trim()
    if (!版本) continue
    if (!解析版本(版本).可解析) continue
    if (!最好 || 比较版本(版本, 最好) > 0) 最好 = 版本
  }
  return 最好
}

/**
 * 用能拿到的字段拼一条人能读懂的更新说明。
 *
 * 为什么需要这个：API 只给 tag 名和一个 commit sha，没有 CHANGELOG 原文
 * （raw.githubusercontent.com 在云端超时，见文件头第 3 条）。
 * 与其给用户一个空白框，不如如实说「这一版对应提交 xxx」——
 * 用户想看细节可以点链接过去。**这里绝不编造更新内容。**
 *
 * @param {{版本:string, 名称?:string, 发布日期?:string, 第几次提交?:string}} 信息
 * @returns {string}
 */
export function 拼更新日志 (信息) {
  const 行 = []
  const 版本 = (信息 && 信息.版本) || ''
  if (版本) 行.push(`新版本 ${版本}`)
  if (信息 && 信息.第几次提交) 行.push(`对应提交：${信息.第几次提交}`)
  if (信息 && 信息.发布日期) 行.push(`发布：${信息.发布日期.slice(0, 10)}`)
  if (行.length === 0) return ''
  return 行.join('\n') + '\n\n详细改动请点「打开仓库」查看。'
}

// ── 查询：问 GitHub，带缓存 ────────────────────────────────────────────────

/** 进程内缓存。键是仓库名，值是 { 时间, 数据 }。 */
const 缓存表 = new Map()

/** 清空缓存（测试用；也给「强制刷新」用）。 */
export function 清缓存 () {
  缓存表.clear()
}

/**
 * 查 GitHub 上指定仓库的最新 tag / release。
 *
 * **永不抛异常。** 所有失败路径都返回 { ok:false, error }：
 * 网络不通、超时、限流（403/429）、仓库不存在（404）、返回不是 JSON。
 *
 * 优先问 releases/latest（有正文和日期，信息最全）；它 404 就退到 tags
 * （我们目前就是这种情况：只打了 tag 没建 release，实测 releases/latest 回 404）。
 *
 * @param {{仓库?:string, 超时毫秒?:number, 缓存毫秒?:number, 强制?:boolean, fetchImpl?:Function, 日志?:Function}} [选项]
 * @returns {Promise<{ok:boolean, 仓库:string, 数据?:object, error?:string, 缓存:boolean}>}
 */
export async function 查询最新版本 (选项 = {}) {
  const 仓库 = String(选项.仓库 || 默认仓库).trim() || 默认仓库
  const 缓存毫秒 = Number.isFinite(选项.缓存毫秒) ? 选项.缓存毫秒 : 默认缓存毫秒
  const 超时毫秒 = Number.isFinite(选项.超时毫秒) ? 选项.超时毫秒 : 默认超时毫秒
  const 日志 = typeof 选项.日志 === 'function' ? 选项.日志 : () => {}
  // 测试里注入假 fetch；生产用全局 fetch
  const fetchImpl = typeof 选项.fetchImpl === 'function' ? 选项.fetchImpl : globalThis.fetch

  if (!选项.强制) {
    const 缓存 = 缓存表.get(仓库)
    if (缓存 && Date.now() - 缓存.时间 < 缓存毫秒) {
      return { ok: true, 仓库, 数据: 缓存.数据, 缓存: true }
    }
  }

  if (typeof fetchImpl !== 'function') {
    return { ok: false, 仓库, 缓存: false, error: '当前 Node 没有全局 fetch（需要 Node 18+）' }
  }

  const 请求 = async (路径) => {
    const 控制器 = typeof AbortController === 'function' ? new AbortController() : null
    const 定时器 = 控制器 ? setTimeout(() => 控制器.abort(), 超时毫秒) : null
    try {
      const 响应 = await fetchImpl(`https://api.github.com/repos/${仓库}${路径}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 用户代理 },
        signal: 控制器 ? 控制器.signal : undefined,
      })
      return 响应
    } finally {
      if (定时器) clearTimeout(定时器)
    }
  }

  try {
    // 1) 先问 release，信息最全
    let 响应 = await 请求('/releases/latest')
    if (响应 && 响应.status === 200) {
      const 正文 = await 响应.json()
      const 整理 = 整理发布(正文)
      if (整理) {
        const 数据 = { 来源: 'release', 最新: 整理 }
        缓存表.set(仓库, { 时间: Date.now(), 数据 })
        return { ok: true, 仓库, 数据, 缓存: false }
      }
    }

    // 2) 退到 tags（我们当前就是只有 tag）
    响应 = await 请求('/tags?per_page=20')
    if (!响应 || 响应.status !== 200) {
      const 码 = 响应 && 响应.status
      // 限流单独说清楚，用户才知道是「等一会儿」而不是「插件坏了」
      const 说明 = 码 === 403 || 码 === 429
        ? 'GitHub 限流了（匿名每小时 60 次），过一会儿再试'
        : 码 === 404 ? `仓库不存在：${仓库}` : `GitHub 返回 ${码 || '未知'}`
      日志(`[update] 查询失败：${说明}`)
      return { ok: false, 仓库, 缓存: false, error: 说明 }
    }
    const 列表 = await 响应.json()
    const 最新 = 挑最新(Array.isArray(列表) ? 列表 : [])
    if (!最新) {
      return { ok: false, 仓库, 缓存: false, error: '仓库里还没有可识别的版本 tag' }
    }
    // tags 接口没有日期，只有 sha
    const 命中 = (列表 || []).find((x) => x && (x.tag_name === 最新 || x.name === 最新)) || {}
    const 整理 = 整理发布({ name: 最新, commit: 命中.commit })
    const 数据 = { 来源: 'tag', 最新: 整理, 版本列表: (列表 || []).slice(0, 5).map((x) => String(x && (x.tag_name || x.name) || '')).filter(Boolean) }
    缓存表.set(仓库, { 时间: Date.now(), 数据 })
    return { ok: true, 仓库, 数据, 缓存: false }
  } catch (错误) {
    const 是超时 = 错误 && (错误.name === 'AbortError' || /abort/i.test(String(错误.message || '')))
    const 说明 = 是超时 ? `查询 GitHub 超时（${超时毫秒}ms）` : `查询 GitHub 出错：${(错误 && 错误.message) || 错误}`
    日志(`[update] ${说明}`)
    return { ok: false, 仓库, 缓存: false, error: 说明 }
  }
}
