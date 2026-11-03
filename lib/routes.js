// ============================================================================
// routes.js —— 后端 HTTP 路由（UI 和外部调用都走这里）
//
// 【这个模块负责什么】
//   注册 15 条 UI HTTP 路由（前缀 /local/xiaoyu-diary），供浏览器端 UI 和外部调用使用。
//   （注册按路径去重：llm-config / bookmark 的 GET+POST 合在同一条路径里分流。）
//   14 条路由：
//     GET  /local/xiaoyu-diary/ping                    → 探活
//     GET  /local/xiaoyu-diary/overview                → 有日记/候选的日期列表
//     GET  /local/xiaoyu-diary/candidates?date=        → 某天的候选
//     POST /local/xiaoyu-diary/candidates/refresh      → 重新提取（保留已有取舍）
//     POST /local/xiaoyu-diary/candidates/decide       → 放进去 / 不放 / 恢复待定
//     GET  /local/xiaoyu-diary/entries?date=           → 某天日记
//     GET  /local/xiaoyu-diary/search?q=               → 检索
//     GET+POST /local/xiaoyu-diary/bookmark             → 读/写阅读进度书签
//     GET+POST /local/xiaoyu-diary/llm-config           → 读（脱敏）/保存 LLM 配置，apiKey 绝不回原文
//     POST /local/xiaoyu-diary/llm-pick                → 把某天聊天交给大模型挑（同步，工具调用在用）
//     POST /local/xiaoyu-diary/llm-pick-async          → 开后台挑选任务，立刻回 jobId
//     GET  /local/xiaoyu-diary/llm-pick-progress?jobId= → 查后台任务进度 / 结果
//     POST /local/xiaoyu-diary/llm-pick-cancel         → 取消后台任务（标记失败，不强杀）
//     POST /local/xiaoyu-diary/quick-write             → 直接写一条日记（模型候选 UI 用）
//     GET  /local/xiaoyu-diary/sources                  → 有哪些来源（私聊/各群），既取日记库也取记忆仓库
//
//   ⚠️ 除 ping / sources / llm-config 外，每条路由都必须带 来源 参数
//      （'private' 或 'group:<群号>'）。日记按来源完全分开存，不带来源就 400：
//      如果默认某个来源，用户在看群的时候点刷新会静默刷成别的来源，很难发现。
//
// 【为什么这样设计】
//   ⚠️ 宿主真实签名（对照 dsh-memory-vault/lib/routes.js 跑通的写法）：
//   ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))
//   —— 是 kind: 'exact' 而不是 method；必须包在 ctx.effect 里，
//      否则插件卸载时路由不会被回收，重载会报 duplicate route。
//   响应要自己写 head + end，不能只 return 对象。
//
//   容错：webServer 缺失 / 没有 register → 直接 return，不抛错。
//   llm-pick / quick-write 的错误出口都过 包() 兜底，任何异常回 500 JSON，不白屏。
//
//   【权限】这是「给大肥鱼读取修改的权限」的落点：路由本身不做鉴权，
//   访问控制靠宿主的登录态与网络边界（127.0.0.1 / 内网）。要收紧就在这里加。
//
// 【密钥安全】llm-config 的 GET 永远只回脱敏配置（apiKey 是 *** 或 ''）；
//   POST 的 body 里 apiKey 是空串或 *** 表示「没改」，此时保留磁盘上已有的真值，
//   任何响应都不带 apiKey 原文。
//
// 【对外导出】
//   · 注册路由(ctx, {rootDir, vaultDir, log}) —— 注册全部 15 条路由，返回注册数
//     （含 sources；迁移老数据在注册末尾异步发起，不阻塞）
//   · PREFIX —— 路由前缀常量 '/local/xiaoyu-diary'
// ============================================================================

import { readFileSync } from 'node:fs'
import {
  读某天, 列出日期, 读索引, 重建, 删条目, 追加条目,
  读候选, 写候选, 列出候选日期, 合并候选, 候选状态,
  读书签, 写书签, 列出已知来源, 迁移老数据,
} from './store.js'
import { 挑候选 } from './extract.js'
import { 检索 } from './search.js'
// 来源 key：私聊 / group:<群号>。日记按来源完全分开存，所有路由都要带来源。
import { 校验来源, 来源标签, 私聊, 比较来源 } from './source.js'
// 读记忆仓库的聊天不再自己翻文件（那是仓库的实现细节，紧耦合会静默失效），
// 统一走适配器：优先仓库自己的接口，拿不到接口它自己会降级回读文件。
// ⚠️ 只用「按来源分开」的那组：读来源聊天 / 列出来源。
//    旧的 读当天聊天 会把私聊和各群合并成一个流，正是现在要去掉的东西。
import { 探测仓库, 读来源聊天, 列出来源 } from './vault.js'
// 大模型挑选通道与 LLM 配置层
import { 挑选一天 } from './llm.js'
import { 读配置, 写配置, 配置是否完整, 脱敏配置 } from './settings.js'
// 更新检查：版本比较是纯函数，查询带缓存（见 update.js 文件头）
import { 查询最新版本, 是最新版, 解析版本, 默认仓库 } from './update.js'

// ── 插件身份：版本号从 package.json 读，不在这里写死 ──────────────────────
//
// 【为什么不写死】版本号写死就会出现两份对不上的副本：package.json 里是
//   0.2.0、路由里写着 0.1.0，用户看到的和装的不是一回事。所以唯一真相是
//   package.json，这里在模块加载时读一次。
//   读失败（打包时漏了文件、被外面的工具裁剪）不能让插件起不来 ——
//   退成 '0.0.0'，UI 会显示「未知版本」，但功能照常。
const 包信息 = (() => {
  try {
    const 地址 = new URL('../package.json', import.meta.url)
    return JSON.parse(readFileSync(地址, 'utf8'))
  } catch {
    return {}
  }
})()
const 插件版本 = 包信息.version || '0.0.0'
// 当前版本号去掉了 v 前缀和预发布后缀，用于和 GitHub tag 比较
const 当前版本号 = 解析版本(插件版本).可解析 ? 插件版本 : ''
// 更新检查默认看官方仓库；用户自己 fork 部署可以在 config 里换（见 index.js）
const 更新仓库 = 包信息.dsh && 包信息.dsh.updateRepo ? 包信息.dsh.updateRepo : 默认仓库

const PREFIX = '/local/xiaoyu-diary'

/** 统一回 JSON。
 *
 * 说明：JSON.stringify 会把非 ASCII 转成 \uXXXX。这不影响正确性 ——
 * 浏览器 fetch().json() 解析后中文完全正常（已实测）。这里保持默认转义，
 * 因为它是 JSON 规范允许的等价编码，且不会带来任何额外的编码风险。
 */
function 回JSON (res, obj, code = 200) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读请求体，任何异常都当空对象。 */
async function 取body (req) {
  try {
    if (req && typeof req.json === 'function') return await req.json()
    if (req && req.body !== undefined) {
      return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** 从 URL 取 query 参数。兼容 req.url 与 req.query 两种形状。 */
function 取query (req) {
  if (req && req.query && typeof req.query === 'object') return req.query
  const url = String((req && req.url) || '')
  const i = url.indexOf('?')
  if (i < 0) return {}
  const out = {}
  for (const [k, v] of new URLSearchParams(url.slice(i + 1))) out[k] = v
  return out
}

/** 只认 YYYY-MM-DD。 */
function 规范日期 (s) {
  const t = String(s || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : ''
}

/** 今天（本机时区）。 */
function 今天 () {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 注册全部路由。
 *
 * @param {object} ctx 宿主上下文（需要 ctx.webServer 与 ctx.effect）
 * @param {{rootDir:()=>string, vaultDir:()=>string, log?:(m:string)=>void}} deps
 * @returns {number} 注册成功的路由数
 */
export function 注册路由 (ctx, deps) {
  const { rootDir, vaultDir } = deps
  const log = typeof deps.log === 'function' ? deps.log : () => {}

  // ── 记忆仓库适配器：只探测一次，之后复用 ─────────────────────────────
  // 探测要遍历多个基准目录 + 动态 import 仓库模块，开销不小，
  // 每读一天都重探会让 refresh 明显变慢，所以这里做惰性缓存。
  // 放在 注册路由 内部而不是模块顶层：每次注册各有一份，跟着这次的 deps 走。
  // 要放在 log 定义之后，因为探测日志要复用现成的 log 出口。
  let 适配器缓存 = null
  async function 拿适配器 () {
    if (!适配器缓存) 适配器缓存 = await 探测仓库((m) => log(m))
    return 适配器缓存
  }

  const webServer = ctx && ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    log('webServer 不可用，UI 路由未注册（工具不受影响）')
    return 0
  }
  const effect = typeof ctx.effect === 'function' ? ctx.effect : (fn) => fn()
  let 注册数 = 0

  /** 注册一条 exact 路由。 */
  const reg = (p, handler) => {
    try {
      effect(() => webServer.register({ kind: 'exact', path: p, handler }))
      注册数++
    } catch (e) {
      log(`路由注册失败 ${p}: ${(e && e.message) || e}`)
    }
  }

  /** 包一层：任何未捕获异常都回 500 JSON，不让页面白屏。 */
  const 包 = (fn) => async (req, res) => {
    // ── 鉴权闸门 ───────────────────────────────────────────────────────
    // 【为什么在这加】DSH 的 token 栅栏只管首页（dsh-host-frontend-static 里
    //   只有 index 走 authorizeIndex），**插件注册的路由它一律不验**。
    //   本来这没问题：DSH 只听 127.0.0.1。但一旦经 nginx 反代出去，
    //   /dsh/local/xiaoyu-diary/* 就能被任何拿到域名的人裸调（实测无 cookie 也 200）。
    //   日记是私密数据，不能靠「别人猜不到路径」来保护。
    // 【怎么验】复用宿主自己的 BrowserAuth.isAuthenticated(req, secure) ——
    //   和首页同一个签名 cookie、同一个 authority 校验，不自己造一套。
    //   拿不到 connection 服务时**放行**并记一次日志：本地开发/单测环境没有它，
    //   而且此时 DSH 通常没对外暴露；宁可 degraded 也不要整块功能挂掉。
    if (!已鉴权(req)) {
      try {
        res.writeHead(401, {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
        })
        res.end(String((req && req.method) || 'GET').toUpperCase() === 'HEAD'
          ? undefined
          : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
      } catch { /* 响应已断开 */ }
      return
    }
    try {
      await fn(req, res)
    } catch (e) {
      try {
        回JSON(res, { ok: false, error: String((e && e.message) || e) }, 500)
      } catch { /* 响应已发出 */ }
    }
  }

  /** 取宿主的浏览器认证器；拿不到时返回 null（记为降级）。 */
  let 认证器_未就绪已记 = false
  function 取认证器 () {
    try {
      const conn = ctx && typeof ctx.get === 'function' ? ctx.get('connection') : ctx && ctx.connection
      const auth = conn && conn.browserAuth
      if (auth && typeof auth.isAuthenticated === 'function') return auth
    } catch { /* 宿主结构变了，走降级 */ }
    if (!认证器_未就绪已记) {
      认证器_未就绪已记 = true
      log('拿不到宿主的 BrowserAuth，UI 路由将不做额外鉴权（仅建议用于本机）')
    }
    return null
  }

  /** 鉴权判定：宿主没有认证器时放行，让它自己决定信任边界。 */
  function 已鉴权 (req) {
    const auth = 取认证器()
    if (!auth) return true
    try {
      const secure = webServer && webServer.protocol === 'https:'
      return auth.isAuthenticated(req, secure) === true
    } catch {
      return false
    }
  }

  // ── 来源：日记按来源完全分开（私聊一份、每个群各一份）────────────────
  //
  // 【为什么单独一条路由】前端每次打开面板都得先知道「有哪些来源可选」：
  // 只从日记库看是不够的 —— 新装插件还没记过任何东西时，日记库是空的，
  // 但记忆仓库里已经有几个群可以读。所以这里取两边的并集：
  //   日记库里有（记过） ∪ 记忆仓库里有（能读） ∪ 老数据迁移过的私聊
  //
  // 【为什么不用 GET /overview 的返回顺带】两者语义不同：overview 是「哪天有几条」，
  // sources 是「有哪些视角」。分开之后前端可以先取来源、再按来源取概览，
  // 逻辑清楚，也方便外部脚本只查来源列表。

  /** 取全部来源：日记库 ∪ 记忆仓库，已排序。 */
  async function 全部来源 () {
    const 集 = new Set(await 列出已知来源(rootDir()))
    try {
      const 适配器 = await 拿适配器()
      for (const s of await 列出来源(vaultDir(), 适配器)) 集.add(s.来源)
    } catch { /* 仓库读不到就只报日记库里的 */ }
    return [...集].sort(比较来源).map((k) => ({ 来源: k, 标签: 来源标签(k) }))
  }

  /**
   * 记忆仓库里**唯一**的群来源；没有群或有多个群都返回 ''。
   *
   * 只给老数据迁移用：老条目只有 `群聊` 标签、没记群号，
   * 只有在「有且仅有一个群」时才能确定它属于哪个群。多个群时返回空，
   * 迁移会把群聊条目留着不搬（见 迁移老数据 的说明）。
   */
  async function 唯一群来源 () {
    try {
      const 适配器 = await 拿适配器()
      const 群们 = (await 列出来源(vaultDir(), 适配器)).filter((x) => x.群号)
      return 群们.length === 1 ? 群们[0].来源 : ''
    } catch {
      return ''
    }
  }

  /**
   * 从请求里取来源（query 或 body 都认），校验不过就回 400 并返回 ''。
   *
   * 为什么不给默认值：日记按来源分开后，「不说来源」若默认私聊，
   * 用户在看群里的时候点刷新会静默刷成私聊的候选，非常容易搞错。
   * 前端每次都会带上，外部脚本漏传时宁可报错让他补。
   */
  const 取来源 = (来源值, res) => {
    const key = 校验来源(来源值)
    if (!key) {
      回JSON(res, {
        ok: false,
        error: `来源参数不合法：${String(来源值 ?? '')}（只能是 private 或 group:<群号>）`,
      }, 400)
      return ''
    }
    return key
  }

  // ── 概览：某来源哪天有日记 / 哪天有候选 ──────────────────────────────
  // 不带 date 就是「这个来源的全部」；前端切换来源时重新拉一次。
  reg(`${PREFIX}/overview`, 包(async (req, res) => {
    const q = 取query(req)
    const key = 取来源(q.来源 || q.source, res)
    if (!key) return
    const 日记天 = await 列出日期(rootDir(), key)
    const 候选天 = await 列出候选日期(rootDir(), key)
    const 日记列表 = []
    for (const d of 日记天.slice(-60)) {
      日记列表.push({ date: d, count: (await 读某天(rootDir(), key, d)).length })
    }
    const 候选列表 = []
    for (const d of 候选天.slice(-60)) {
      const c = await 读候选(rootDir(), key, d)
      const 待定 = c.items.filter((x) => x.状态 === 候选状态.待定).length
      const 放 = c.items.filter((x) => x.状态 === 候选状态.放进去).length
      const 不放 = c.items.filter((x) => x.状态 === 候选状态.不放).length
      候选列表.push({ date: d, 总数: c.items.length, 待定, 放进去: 放, 不放 })
    }
    回JSON(res, {
      ok: true,
      今天: 今天(),
      来源: key,
      标签: 来源标签(key),
      日记列表,
      候选列表,
    })
  }))

  // ── 来源列表 ─────────────────────────────────────────────────────────
  reg(`${PREFIX}/sources`, 包(async (req, res) => {
    const 来源们 = await 全部来源()
    回JSON(res, { ok: true, 今天: 今天(), 来源们 })
  }))

  // ── 取某天的候选 ─────────────────────────────────────────────────────
  reg(`${PREFIX}/candidates`, 包(async (req, res) => {
    const q = 取query(req)
    const key = 取来源(q.来源 || q.source, res)
    if (!key) return
    const date = 规范日期(q.date) || 今天()
    const data = await 读候选(rootDir(), key, date)
    回JSON(res, { ok: true, 标签: 来源标签(key), ...data })
  }))

  // ── 重新提取某来源某天的候选（保留已有取舍）──────────────────────────
  reg(`${PREFIX}/candidates/refresh`, 包(async (req, res) => {
    const body = await 取body(req)
    const key = 取来源(body.来源 || body.source, res)
    if (!key) return
    const date = 规范日期(body.date) || 今天()
    const 标签 = 来源标签(key)
    const 适配器 = await 拿适配器()
    // ⚠️ 只读这一个来源。0.2.x 这里读的是「当天所有聊天」（私聊+各群合并），
    //    正是「完全分开」要去掉的：合并后模型分不清哪句来自哪个群。
    const { 行们, sources } = await 读来源聊天(vaultDir(), key, date, 适配器)
    const 旧 = await 读候选(rootDir(), key, date)
    if (行们.length === 0) {
      // 没有聊天记录：不要覆盖掉已有的候选与取舍，如实回 0
      回JSON(res, {
        ok: true,
        date,
        来源: key,
        行数: 0,
        新增: 0,
        保留: 0,
        items: 旧.items,
        note: `${标签} ${date} 在记忆仓库里没有聊天记录，已保留原有候选`,
      })
      return
    }
    const { 候选, 总行数 } = 挑候选(行们, { 上限: Number(body.上限) || 80 })
    const 合并 = 合并候选(旧.items, 候选)
    await 写候选(rootDir(), key, date, {
      sources,
      总行数,
      items: 合并.items,
    })
    回JSON(res, {
      ok: true,
      date,
      来源: key,
      行数: 总行数,
      新增: 合并.items.filter((x) => x.状态 === 候选状态.待定).length,
      保留: 合并.保留,
      items: 合并.items,
    })
  }))

  // ── 对某条候选做取舍：放进去 / 不放 / 恢复待定 ────────────────────────
  reg(`${PREFIX}/candidates/decide`, 包(async (req, res) => {
    const body = await 取body(req)
    const key = 取来源(body.来源 || body.source, res)
    if (!key) return
    const date = 规范日期(body.date) || 今天()
    const cid = String(body.cid || '')
    const 动作 = String(body.状态 || '')
    if (!['pending', 'accepted', 'rejected'].includes(动作)) {
      回JSON(res, { ok: false, error: `状态只能是 pending / accepted / rejected，收到：${动作}` }, 400)
      return
    }
    const data = await 读候选(rootDir(), key, date)
    const it = data.items.find((x) => x.cid === cid)
    if (!it) {
      回JSON(res, { ok: false, error: `没有这条候选：${cid}` }, 404)
      return
    }

    if (动作 === 候选状态.放进去) {
      // 放进去 = 写进当天日记。已有条目id 就不重复写。
      if (!it.条目id) {
        const e = await 追加条目(rootDir(), key, date, {
          title: '',
          text: it.内容,
          tags: ['自动提取'],
          at: new Date().toISOString(),
          来源: `聊天 ${it.时间} ${it.昵称}`,
        })
        it.条目id = e.id
      }
      it.状态 = 候选状态.放进去
    } else if (动作 === 候选状态.不放) {
      it.状态 = 候选状态.不放
      // 已写进日记的要撤回，否则「不放」名不副实
      if (it.条目id) {
        await 删条目(rootDir(), it.条目id, key)
        it.条目id = ''
      }
    } else {
      // 恢复待定：同样要撤回已写入的条目
      if (it.条目id) {
        await 删条目(rootDir(), it.条目id, key)
        it.条目id = ''
      }
      it.状态 = 候选状态.待定
    }

    await 写候选(rootDir(), key, date, data)
    回JSON(res, { ok: true, date, 来源: key, cid, 状态: it.状态, 条目id: it.条目id })
  }))

  // ── 读某天日记 ───────────────────────────────────────────────────────
  reg(`${PREFIX}/entries`, 包(async (req, res) => {
    const q = 取query(req)
    const key = 取来源(q.来源 || q.source, res)
    if (!key) return
    const date = 规范日期(q.date) || 今天()
    const entries = await 读某天(rootDir(), key, date)
    回JSON(res, { ok: true, date, 来源: key, 标签: 来源标签(key), count: entries.length, entries })
  }))

  // ── 全局检索 ─────────────────────────────────────────────────────────
  reg(`${PREFIX}/search`, 包(async (req, res) => {
    const q = 取query(req)
    const key = 取来源(q.来源 || q.source, res)
    if (!key) return
    let index = await 读索引(rootDir(), key)
    if (!index) index = (await 重建(rootDir(), key)).index
    const 全部 = []
    for (const [date, day] of Object.entries(index.days || {})) {
      for (const e of day.entries || []) 全部.push({ ...e, date })
    }
    const r = 检索(全部, q.q || q.query || '', {
      limit: Number(q.limit) || 20,
      tag: q.tag,
    })
    回JSON(res, { ok: true, 来源: key, 标签: 来源标签(key), ...r })
  }))

  // ── 阅读进度书签：GET 读进度 + 可读日期，POST 写进度 ─────────────────
  // 路由按路径注册不分 method，所以同一条 handler 里自己分流；
  // pages 给的是「所有有日记的日期」，前端拿它做目录跳转，书签只是记住停在哪儿。
  // 书签按来源分开：在私聊日记里读到第 3 页，切到群里不该跳到第 3 页 ——
  // 那是两本完全不同的书，页码没有可类比性。
  reg(`${PREFIX}/bookmark`, 包(async (req, res) => {
    if (String((req && req.method) || 'GET').toUpperCase() === 'POST') {
      const body = await 取body(req)
      const key = 取来源(body.来源 || body.source, res)
      if (!key) return
      const lastDate = String(body.lastDate || '')
      // 先在门口拦形状，别把脏数据一路传到存储层
      if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) {
        回JSON(res, { ok: false, error: `lastDate 必须是 YYYY-MM-DD，收到：${lastDate}` }, 400)
        return
      }
      try {
        await 写书签(rootDir(), key, lastDate)
      } catch (e) {
        // 库目录不存在是调用方的配置问题，归 400 说清楚，不该让它变成 500
        回JSON(res, { ok: false, error: String((e && e.message) || e) }, 400)
        return
      }
      回JSON(res, { ok: true, 来源: key, lastDate })
      return
    }
    const q = 取query(req)
    const key = 取来源(q.来源 || q.source, res)
    if (!key) return
    const bm = await 读书签(rootDir(), key)
    const pages = await 列出日期(rootDir(), key)
    回JSON(res, { ok: true, 来源: key, 标签: 来源标签(key), lastDate: bm.lastDate, pages })
  }))

  // ── LLM 配置：GET 读（脱敏）/ POST 保存（同一条路径，handler 内分流）─────
  // 宿主的 register 按 path 去重：同一 path 的 GET/POST 注册两次，第二条会被
  // 宿主拒绝（见 bookmark 的既有做法），所以读/写合并成一条 handler、
  // 按 req.method 分流。
  // GET 永远只回脱敏配置（apiKey 是 *** 或 ''）：UI 拿到 *** 就知道
  // 「这里存着 key」，但拿不到原文。
  reg(`${PREFIX}/llm-config`, 包(async (req, res) => {
    const m = String((req && req.method) || 'GET').toUpperCase()
    if (m === 'POST') {
      const body = await 取body(req)
      const 原 = await 读配置(rootDir())
      // 决定这次要写的 apiKey：body 里是空串或 ***（UI 回显脱敏值的情况）
      // 都算「没改」，保留磁盘上的真值；只有传了新的非空串才覆盖。
      // 判断必须在写之前做 —— 一旦把原值读出来丢掉，*** 就会把真 key 冲没。
      let 新apiKey = 原.apiKey
      if (typeof body.apiKey === 'string' && body.apiKey !== '' && body.apiKey !== '***') {
        新apiKey = body.apiKey
      }
      const 部分 = {
        baseURL: body.baseURL,
        model: body.model,
        额外参数: body.额外参数,
        每批行数: body.每批行数,
        timeoutMs: body.timeoutMs,
        apiKey: 新apiKey,
      }
      const 保存后 = await 写配置(rootDir(), 部分)
      const 校验 = 配置是否完整(保存后)
      回JSON(res, {
        ok: true,
        配置: 脱敏配置(保存后),
        完整: 校验.ok,
        缺: 校验.缺,
      })
      return
    }
    const 配置 = await 读配置(rootDir())
    const 校验 = 配置是否完整(配置)
    回JSON(res, {
      ok: true,
      配置: 脱敏配置(配置),
      完整: 校验.ok,
      缺: 校验.缺,
    })
  }))

  // ── 让大模型挑某天的候选（花钱/慢，手动通道）──────────────────────────
  // 错误出口：配置缺、没聊天、模型失败 —— 都回 JSON 不抛，前端降级显示。
  // 超时交给 挑选一天 内部处理（单批 AbortController），路由层不再包一层。
  reg(`${PREFIX}/llm-pick`, 包(async (req, res) => {
    const body = await 取body(req)
    const key = 取来源(body.来源 || body.source, res)
    if (!key) return
    const 日期 = 规范日期(body.date) || 今天()
    const 标签 = 来源标签(key)
    const 配置 = await 读配置(rootDir())
    const 校验 = 配置是否完整(配置)
    if (!校验.ok) {
      回JSON(res, {
        ok: false,
        错误: `大模型配置不完整，缺少：${校验.缺.join('、')}。请到设置页配置区补齐后再试。`,
        缺: 校验.缺,
      }, 400)
      return
    }
    const 适配器 = await 拿适配器()
    const { 行们, sources } = await 读来源聊天(vaultDir(), key, 日期, 适配器)
    if (行们.length === 0) {
      回JSON(res, {
        ok: false,
        日期,
        来源: key,
        行数: 0,
        事项: [],
        已有条数: 0,
        错误: `${标签} ${日期} 这天没有聊天记录（找过：${(sources || []).join('；') || '未探测到仓库'}）`,
      })
      return
    }
    // 先读当天该来源已记内容，作为上下文交给模型让它自己避开重复 —— 顺序不能反：
    // 事后靠文本相似度去重不可靠（实测措辞差异下 2-gram 相似度仅 0.22）。
    // 只取同一来源：群里的日记不该挡住私聊该记的事。
    const 当天 = await 读某天(rootDir(), key, 日期)
    const 已记 = 当天.map((e) => String(e.text || '').trim()).filter(Boolean)
    const 结果 = await 挑选一天(
      配置,
      行们,
      { date: 日期, 来源标签: 标签, 每批行数: 配置.每批行数 || 400, timeoutMs: 配置.timeoutMs, 已记 },
    )
    // 再兜一层：模型仍可能没避开，用「规范化 + 双向包含」补漏。
    // 判据与 lib/tools.js 保持一致，否则工具和 UI 会给出不同结果。
    const 规范化 = (s) => String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
    const 已写 = 已记.map(规范化).filter((s) => s.length >= 6)
    const 是重复 = (内容) => {
      const 键 = 规范化(内容)
      if (键.length < 6) return false
      return 已写.some((旧) => 旧 === 键 || 旧.includes(键) || 键.includes(旧))
    }
    const 事项 = (结果.事项 || []).filter((m) => !是重复(m.内容))
    回JSON(res, {
      ok: 结果.ok,
      日期,
      来源: key,
      行数: 行们.length,
      事项,
      已有条数: 当天.length,
      已过滤: (结果.事项 || []).length - 事项.length,
      usage: 结果.usage || { 输入: 0, 输出: 0 },
      批数: 结果.批数,
      失败批数: 结果.失败批数,
      错误: 结果.失败批数 > 0 ? 结果.错误 : '',
    })
  }))

  // ── 大模型挑选 · 后台任务版：开任务 → 轮询进度 → 可取消 ────────────────
  // 同步的 /llm-pick 一次要等几分钟（一天可能分 6 批，思考模型每批 40-60 秒），
  // 前端全程只知道"在挑"，用户会以为卡死了。这条通道把「跑」和「等」拆开：
  // POST llm-pick-async 立刻回 jobId，任务在后台跑；前端拿 jobId 轮询
  // llm-pick-progress 刷进度条；不想等了 POST llm-pick-cancel 叫停。
  // 同步路由原样保留给工具调用（xiaoyu_diary_llm_pick）和自动化场景 ——
  // 那边不需要进度，一次调用拿全量结果反而简单。
  //
  // 任务表：jobId → 任务对象。字段：状态('running'|'done'|'failed')、已完成、
  // 总批数、事项、结果、错误、开始时间、结束时间、已过滤、日期。
  // （结束时间不在最初设计里，是清理策略需要的：没有它就不知道"完成多久了"。）
  // 放在 注册路由 内部而不是模块顶层：同一进程可能以不同 profile 各注册一次
  // 路由（各自 rootDir/vaultDir 不同），任务表跟着各次的 deps 走才不会串台；
  // 放顶层的话几份实例共享同一张表，A 的 jobId 能在 B 查到进度，还会互相干扰防重复。
  const 任务表 = new Map()

  /** 完结任务在内存里保留多久（毫秒）：给前端留足来取结果的时间。 */
  const 完结保留毫秒 = 10 * 60 * 1000
  /** 任务表容量上限：超过就淘汰，防长期运行内存泄漏。 */
  const 任务上限 = 20

  /** 清旧任务：完结超过 10 分钟的删掉；总量超上限时从最旧的开始淘汰。 */
  function 清理任务表 () {
    const 现在 = Date.now()
    for (const [id, t] of 任务表) {
      if (t.状态 !== 'running' && t.结束时间 > 0 && 现在 - t.结束时间 > 完结保留毫秒) {
        任务表.delete(id)
      }
    }
    // 容量淘汰从表头（最早创建的）开始 —— Map 保持插入序，头上一定最旧。
    // 正在跑的任务不能拿容量淘汰开刀：删了它，后台执行体还在烧模型的钱，
    // 但进度查询和取消都再也够不着它了。只有表里清一色是 running（极端情况，
    // 比如自动化同时挑二十多天）才退回「删最旧的」硬保上限 —— 内存红线优先。
    while (任务表.size > 任务上限) {
      let 目标 = null
      for (const [id, t] of 任务表) {
        if (t.状态 !== 'running') { 目标 = id; break }
      }
      if (目标 === null) 目标 = 任务表.keys().next().value
      任务表.delete(目标)
    }
  }

  // ── 开后台挑选任务 ───────────────────────────────────────────────────
  reg(`${PREFIX}/llm-pick-async`, 包(async (req, res) => {
    if (String((req && req.method) || 'POST').toUpperCase() !== 'POST') {
      回JSON(res, { ok: false, 错误: 'llm-pick-async 只接受 POST' }, 405)
      return
    }
    const body = await 取body(req)
    const key = 取来源(body.来源 || body.source, res)
    if (!key) return
    const 日期 = 规范日期(body.date) || 今天()
    const 标签 = 来源标签(key)

    // —— 同步校验全部做完才允许开任务 ——
    // 配置缺、没聊天这类「注定失败」的情况在这里就回掉，不产生任务记录：
    // 前端不用先轮询一次才发现失败，任务表也不会堆一堆秒失败的垃圾任务。
    const 配置 = await 读配置(rootDir())
    const 校验 = 配置是否完整(配置)
    if (!校验.ok) {
      回JSON(res, {
        ok: false,
        错误: `大模型配置不完整，缺少：${校验.缺.join('、')}。请到设置页配置区补齐后再试。`,
        缺: 校验.缺,
      }, 400)
      return
    }
    const 适配器 = await 拿适配器()
    const { 行们, sources } = await 读来源聊天(vaultDir(), key, 日期, 适配器)
    if (行们.length === 0) {
      回JSON(res, {
        ok: false,
        日期,
        来源: key,
        行数: 0,
        错误: `${标签} ${日期} 这天没有聊天记录（找过：${(sources || []).join('；') || '未探测到仓库'}）`,
      })
      return
    }

    // —— 防重复：同一来源同一天只允许一个 running 任务 ——
    // 用户狂点按钮时如果每次点击都真开一个任务，就是 6 批 × N 份的模型开销；
    // 同一天跑两份结果还会互相踩。已经在跑就把已有 jobId 还回去（复用:true），
    // 前端拿它继续轮询即可，无感。
    // ⚠️ 判重必须带来源：私聊和群是两份独立任务，只按日期判会
    //    让「刚点了私聊，再点群」被误判成重复点击，直接复用私聊那个任务的 jobId。
    for (const [id, t] of 任务表) {
      if (t.日期 === 日期 && t.来源 === key && t.状态 === 'running') {
        回JSON(res, { ok: true, jobId: id, 复用: true, 日期, 来源: key, 行数: 行们.length })
        return
      }
    }

    // 先读当天该来源已记内容：一份给模型当上下文让它自己避开重复，一份留给完工后的
    // 兜底过滤。与同步路由同口径：开工前读一次快照，中途新写进日记的不管。
    const 当天 = await 读某天(rootDir(), key, 日期)
    const 已记 = 当天.map((e) => String(e.text || '').trim()).filter(Boolean)

    // 开新任务前顺手清一轮旧任务（只在创建时清，无常驻定时器 —— 这个插件
    // 开任务的频率很低，挂个 interval 纯属浪费）
    清理任务表()

    // jobId：时间戳（36 进制，短且趋势递增）+ 随机串（防同毫秒碰撞）
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    const 任务 = {
      状态: 'running',
      已完成: 0,
      // 总批数先按行数预估，让 UI 一开始就有进度分母可画；
      // 首批进度回调回来后会被 挑选一天 报告的真实值覆盖
      总批数: Math.max(1, Math.ceil(行们.length / Math.max(1, Number(配置.每批行数) || 400))),
      事项: [],
      结果: null,
      错误: '',
      已过滤: 0,
      开始时间: Date.now(),
      结束时间: 0,
      日期,
      来源: key,
      标签,
    }
    任务表.set(jobId, 任务)

    // 响应先发：回JSON 同步写完 head + end，字节已经交给 socket，然后才启动
    // 后台执行 —— 用户立刻拿到 jobId，不用陪模型等几分钟
    回JSON(res, { ok: true, jobId, 日期, 来源: key, 行数: 行们.length })

    // 后台执行体。刻意不 await（也绝不能 await）：一旦 await，这条 HTTP 响应
    // 就得陪模型跑完几分钟才发得出去，两步式设计就白做了。
    // 它没有调用方接异常，所以内部必须全 catch —— 冒泡出去会把整个进程带崩。
    ;(async () => {
      try {
        const 结果 = await 挑选一天(配置, 行们, {
          date: 日期,
          来源标签: 标签,
          每批行数: 配置.每批行数 || 400,
          timeoutMs: 配置.timeoutMs,
          已记,
          进度回调: (p) => {
            任务.已完成 = p.已完成
            任务.总批数 = p.总批数
            // 这里是「每批开始前」检查取消的唯一位置：进度回调在每批做完时触发，
            // 正好卡在下一批开始之前。发现被取消（状态被标成 failed）就把这份
            // 任务私有配置的 baseURL 抹掉 —— 挑选一天 没有中断口子（批次在进
            // 循环前就已切好、回调抛错也会被它吞掉），但 挑一批 每批都会重新
            // 校验配置：baseURL 一空，后续批在那儿立即失败返回，一个网络请求
            // 都不会发出去，等效于停止后续批次。配置是本次请求从 读配置() 新读
            // 出来的对象，只归这个任务用，改它不外泄、不影响别的调用方。
            if (任务.状态 === 'failed') 配置.baseURL = ''
          },
        })

        // 跑完发现已被取消：保持取消时的 failed 与「已取消」信息，结果丢弃
        if (任务.状态 !== 'running') return

        // —— 完工后兜底过滤：判据与同步路由 /llm-pick 完全一致（同款代码抄过来的，
        //    两处不一致的话 UI 和工具会给用户两种答案）——
        const 规范化 = (s) => String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
        const 已写 = 已记.map(规范化).filter((s) => s.length >= 6)
        const 是重复 = (内容) => {
          const 键 = 规范化(内容)
          if (键.length < 6) return false
          return 已写.some((旧) => 旧 === 键 || 旧.includes(键) || 键.includes(旧))
        }
        const 事项 = (结果.事项 || []).filter((m) => !是重复(m.内容))

        // 错误文本最后一道脱敏：挑选一天 内部已脱敏过，这里再把本任务的
        // apiKey 字面量过一遍 —— 任务表里的任何字段都绝不能带出密钥原文
        const 掩密 = (文本) => {
          const s = String(文本 ?? '')
          return (typeof 配置.apiKey === 'string' && 配置.apiKey !== '')
            ? s.split(配置.apiKey).join('[已隐藏]')
            : s
        }

        任务.事项 = 事项
        任务.已过滤 = (结果.事项 || []).length - 事项.length
        任务.结果 = {
          ok: 结果.ok,
          批数: 结果.批数,
          失败批数: 结果.失败批数,
          usage: 结果.usage || { 输入: 0, 输出: 0 },
        }
        // 部分批次失败不算任务失败：任务本身跑完了，结果照常给前端，
        // 失败详情放进 错误 由 UI 决定怎么提示；只有异常/取消才置 failed
        任务.错误 = 结果.失败批数 > 0 ? 掩密(结果.错误) : ''
        任务.状态 = 'done'
        任务.结束时间 = Date.now()
      } catch (e) {
        // 后台任务没人接异常，这里是最后的闸。取消导致的中断也落在这里：
        // 保持取消时的 failed 原状，不覆盖「已取消」信息。
        if (任务.状态 !== 'running') return
        const 消息 = String((e && e.message) || e)
        任务.状态 = 'failed'
        任务.错误 = (typeof 配置.apiKey === 'string' && 配置.apiKey !== '')
          ? 消息.split(配置.apiKey).join('[已隐藏]')
          : 消息
        任务.结束时间 = Date.now()
      }
    })()
  }))

  // ── 查后台任务进度 / 结果 ────────────────────────────────────────────
  // 前端拿到 jobId 后每隔一两秒来问一次。running 时事项恒为空数组：
  // 半成品不放出去，免得前端把中间态当成最终结果写进日记。
  reg(`${PREFIX}/llm-pick-progress`, 包(async (req, res) => {
    const q = 取query(req)
    const jobId = String((q && q.jobId) || '').trim()
    if (!jobId) {
      回JSON(res, { ok: false, 错误: '缺少 jobId' }, 400)
      return
    }
    const 任务 = 任务表.get(jobId)
    if (!任务) {
      // 过期被清、进程重启都会走到这：如实说找不到，前端据此回到初始态
      回JSON(res, { ok: false, jobId, 错误: '任务不存在或已过期' }, 404)
      return
    }
    回JSON(res, {
      ok: true,
      jobId,
      状态: 任务.状态,
      日期: 任务.日期,
      来源: 任务.来源,
      标签: 任务.标签,
      已完成: 任务.已完成,
      总批数: 任务.总批数,
      事项: 任务.事项,
      ...(任务.结果 ? { 结果: 任务.结果 } : {}),
      错误: 任务.错误,
      已过滤: 任务.已过滤,
    })
  }))

  // ── 取消后台任务 ─────────────────────────────────────────────────────
  // 只做「标记 failed + 让后续批次不再发请求」，不强杀正在路上的 fetch ——
  // fetch 没有 killswitch，硬断会留下悬挂请求和半截响应；让它自然跑完当前
  // 这一批（顶多浪费这一批的 token），下一批起就被进度回调里的取消检查拦住了。
  reg(`${PREFIX}/llm-pick-cancel`, 包(async (req, res) => {
    if (String((req && req.method) || 'POST').toUpperCase() !== 'POST') {
      回JSON(res, { ok: false, 错误: 'llm-pick-cancel 只接受 POST' }, 405)
      return
    }
    const body = await 取body(req)
    const jobId = String(body.jobId || '').trim()
    if (!jobId) {
      回JSON(res, { ok: false, 错误: '缺少 jobId' }, 400)
      return
    }
    const 任务 = 任务表.get(jobId)
    if (!任务) {
      回JSON(res, { ok: false, jobId, 错误: '任务不存在或已过期' }, 404)
      return
    }
    // 已经完结的任务没什么可取消的：如实回 已取消:false，不当作错误
    if (任务.状态 !== 'running') {
      回JSON(res, { ok: true, 已取消: false })
      return
    }
    任务.状态 = 'failed'
    任务.错误 = '已取消'
    任务.结束时间 = Date.now()
    回JSON(res, { ok: true, 已取消: true })
  }))

  // ── 快速写一条日记（模型候选 UI 的「记进日记」按钮走这里）────────────
  // 与 candidates/decide 不同：decide 操作的是候选暂存区（带 cid 的条目），
  // quick-write 是用户从模型候选直接写一条新日记，不经过候选存储。
  // 内部走 追加条目，与 xiaoyu_diary_write 工具同一条路径。
  reg(`${PREFIX}/quick-write`, 包(async (req, res) => {
    if (String((req && req.method) || 'POST').toUpperCase() !== 'POST') {
      回JSON(res, { ok: false, error: 'quick-write 只接受 POST' }, 405)
      return
    }
    const body = await 取body(req)
    const key = 取来源(body.来源 || body.source, res)
    if (!key) return
    const 日期 = 规范日期(body.date) || 今天()
    const 文本 = String(body.text || '').trim()
    if (!文本) {
      回JSON(res, { ok: false, 日期, 错误: 'text 不能为空' }, 400)
      return
    }
    // 这一层不叫「来源」是因为 body 里的 来源 字段一直是「这条是谁挑出来的」
    // （比如 '大模型'），和本路由的 来源（哪个视角）撞名。所以叫 出处。
    const 出处 = body.出处 ? String(body.出处) : (body.来源 ? String(body.来源) : '')
    const e = await 追加条目(rootDir(), key, 日期, {
      title: '',
      text: 文本,
      tags: ['大模型'],
      at: new Date().toISOString(),
      来源: 出处,
    })
    const 当天 = await 读某天(rootDir(), key, 日期)
    回JSON(res, {
      ok: true,
      日期,
      来源: key,
      id: e.id,
      当天条数: 当天.length,
      text: `已记入（${来源标签(key)} ${日期} ${e.id}）`,
    })
  }))

  // ── 版本与更新检查（UI 顶部的版本条走这里）─────────────────────────────
  //
  // 【为什么由服务器代问 GitHub，而不是浏览器直连】
  //   1. 浏览器直连要跨域，还得把用户的 IP 暴露给 GitHub；
  //   2. 匿名 API 每 IP 每小时只有 60 次，浏览器每次开设置页问一次必然打爆；
  //   3. 我们自己的缓存能兜住这些重复请求（update.js 里 30 分钟缓存）。
  //   云端实测：api.github.com 通（0.5s），raw.githubusercontent.com 超时，
  //   所以只问 API。
  //
  // 【为什么 ?force=1 是显式参数而不是默认】
  //   默认读缓存，只有用户主动点「重新检查」才穿透缓存 —— 不然有人狂点
  //   就把配额点光了，之后所有人看到的都是限流错误。
  //
  // 【失败怎么办】永远回 200 + { 检查结果: { ok:false, error } }。
  //   检查更新是锦上添花，网络挂了也不能让版本条变成报错红字 ——
  //   UI 那边只看 检查结果.ok 决定显示「有新版本」还是「暂时查不到」。
  reg(`${PREFIX}/version`, 包(async (req, res) => {
    const 地址 = new URL(req.url || '/', 'http://localhost')
    const 强制 = 地址.searchParams.get('force') === '1'
    // 测试/离线环境可以彻底关掉外呼：XIAOYU_NO_UPDATE_CHECK=1
    if (process.env.XIAOYU_NO_UPDATE_CHECK === '1') {
      回JSON(res, {
        ok: true,
        当前版本: 插件版本,
        当前版本号: 当前版本号,
        仓库: 更新仓库,
        仓库地址: `https://github.com/${更新仓库}`,
        检查结果: { ok: false, error: '更新检查已被 XIAOYU_NO_UPDATE_CHECK 关闭', 缓存: false },
        有新版本: false,
      })
      return
    }
    const 结果 = await 查询最新版本({ 仓库: 更新仓库, 强制, 日志: log })
    const 最新 = (结果.ok && 结果.数据 && 结果.数据.最新) || null
    const 最新版本 = (最新 && 最新.版本) || ''
    回JSON(res, {
      ok: true,
      当前版本: 插件版本,
      当前版本号: 当前版本号,
      仓库: 更新仓库,
      仓库地址: `https://github.com/${更新仓库}`,
      // 检查失败时如实说，不谎报「已是最新」
      检查结果: 结果,
      最新版本,
      有新版本: 结果.ok && 是最新版(当前版本号, 最新版本),
      更新说明: (最新 && 最新.说明) || '',
    })
  }))

  // ── 健康检查（UI 启动时探活）─────────────────────────────────────────
  reg(`${PREFIX}/ping`, 包(async (req, res) => {
    // 带上 来源们，让外部脚本一次请求就能知道「有哪些来源、各叫什么名字」
    回JSON(res, {
      ok: true,
      插件: '小鱼日记',
      今天: 今天(),
      来源们: await 全部来源(),
    })
  }))

  // ── 老数据迁移：按 tags 里的 私聊/群聊 拆回各来源 ────────────────────
  // 放在注册末尾、不 await：迁移可能涉及几十个文件，不该拖慢插件启动。
  // 失败只记日志 —— 迁移失败不该让插件起不来，老文件原样留在原地。
  //
  // ⚠️ 群聊条目只有 `群聊` 标签、**没有具体群号**（老版本没记）。所以：
  //    记忆仓库里恰好只有一个群 → 就归给它，这是唯一有把握的情况；
  //    有多个群 → 分不清是哪一个，群聊条目**暂不搬**、老文件也不删，
  //    等有人明确指定后再来（宁可留着，也不要猜错塞进某个群）。
  迁移老数据(rootDir(), { 群来源: 唯一群来源 }).then((r) => {
    if (r.搬了 > 0) {
      log(`老日记已按标签拆开：私聊 ${r.私聊条} 条、群聊 ${r.群聊条} 条（原文件备份在 ${r.备份目录}）`)
    }
    if (r.有群聊没去处) {
      log('老文件里还有群聊条目，但记忆仓库里有多个群、无法确定归属，这些条目暂未迁移（老文件已保留）')
    }
    if (r.猜过来源.length > 0) {
      log(`有 ${r.猜过来源.length} 条老日记没有可辨认的来源标签，已归到私聊（备份里可复核）`)
    }
    if (r.跳过.length > 0) {
      log(`迁移时跳过 ${r.跳过.length} 项（目标已有同一天数据，未覆盖）：${r.跳过.join(', ')}`)
    }
  }).catch((e) => {
    log(`老数据迁移失败（不影响使用）：${(e && e.message) || e}`)
  })

  log(`UI 路由已注册 ${注册数} 条（前缀 ${PREFIX}）`)
  return 注册数
}

export { PREFIX }
