// ============================================================================
// vault.js —— 记忆仓库适配器（小鱼日记）
//
// 【这个模块负责什么】
//   这个模块解决什么问题：
//   小鱼日记每天要从「记忆仓库」（另一个插件 dsh-memory-vault）当天的聊天记录里
//   提取候选。过去它**直接读仓库的文件布局**（chat/private/<日期>.txt、
//   chat/group/<群号>/<日期>.txt、行格式 `[HH:MM] 昵称(pid): 内容`），
//   见 lib/tools.js、lib/routes.js 里的 读仓库当天()。
//   这是**紧耦合**：仓库一旦改目录结构、行格式或接口，我们这边就会静默失效
//   （读不到文件 → 当天没有候选 → 鱼以为自己"什么都没发生"），而且很难排查。
//
// 【为什么这样设计】
//   为什么不能继续直接读文件：
//   目录布局是仓库的**实现细节**，不是它的**契约**。两个插件独立演进、
//   独立发版：我们不能假设仓库永远长这样。正确的依赖关系是：我们依赖仓库
//   **对外声明的接口**（它自己的 lib 导出的函数），仓库的内部布局怎么变，
//   只要接口不变，我们就跟着不变。这就是"松耦合"。
//
//   适配器的三档降级策略：
//   拿接口这件事本身也可能失败（仓库没装、装的是不完整构建产物、路径变了）。
//   所以我们按"从最松耦合到最兜底"的顺序试，每一档失败都记下原因、进下一档：
//
//     档 A  包名解析（最松耦合）：用 require.resolve('dsh-memory-vault/package.json')
//            从若干基准目录找包的真实安装目录，再动态 import 它的 lib/tools.js。
//            这是"最正确"的拿法 —— 我们不关心它装在哪、怎么装的。
//
//     档 B  直接路径：已知仓库在本机的固定位置 /opt/dsh-plugins/dsh-memory-vault，
//            直接 import 它的 lib/tools.js。这是 A 的兜底（A 的 resolve 失败时，
//            比如装法是手工放的、不进 npm 解析链，但我们知道物理路径）。
//
//     档 C  降级读文件：接口根本拿不到（A、B 都失败，或拿到的构建产物缺函数）。
//            此时退回直接扫 chat/ 目录 + 复用 extract.js 的行解析。
//            这是"保证功能不中断"的最后防线 —— 仓库接口断了，日记候选不能断。
//
//   关键取舍：**档 C 不是首选，是保底。** 一旦拿到接口就优先走接口；
//   只有拿不到接口，才退到直接读文件。所以 列表/读聊天 两个业务函数会先看
//   适配器里的 列日期 / 搜聊天 是不是可用，是就走接口，否则走兜底。
//
// 【对外导出】
//   · 探测仓库(提示) —— 按 档A→档B→档C 顺序探测记忆仓库接口，返回可用接口 + 失败原因
//   · 列出有记录的日期(rootDir, 适配器) —— 列出有聊天记录的日期（优先接口，兜底扫目录）
//   · 读当天聊天(rootDir, date, 适配器) —— 读某天全部聊天（优先接口，兜底读文件）
// ============================================================================

import { createRequire } from 'node:module'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

// 复用项目里已有的行解析器，**不重写**。
// extract.js 的 解析聊天 已经把"不是 `[HH:MM:SS] 昵称(pid): 内容` 格式的行直接丢弃"
// 做好了；兜底读文件时直接喂给它，保证降级路径和接口路径拿到的是同一种行结构。
import { 解析聊天 } from './extract.js'
// 来源 key 的定义与校验（私聊 / group:<群号>）。
// 按来源分开读时，返回的每一行都标 .来源，下游不必再猜这句话是谁说的。
import { 私聊, 群前缀, 校验来源, 群号, 来源标签, 比较来源 } from './source.js'

/** 档 A 用的 require（基于本文件位置解析，比 process.cwd() 更稳：插件装哪就解析哪）。 */
const req = createRequire(import.meta.url)

/** 档 B 的固定物理路径：本机已查证仓库就克隆在这个位置。 */
const 直接路径 = '/opt/dsh-plugins/dsh-memory-vault/lib/tools.js'

/**
 * 档 A：要试的基准目录。
 * 为什么列这几个：仓库既可能作为 npm 包装进某个 profile 的 node_modules，
 * 也可能被手工放进 /opt/dsh-plugins。用 { paths: [base] } 逐个探，
 * 命中哪个就算哪个 —— 这正是不关心"它装在哪"的体现。
 */
const 基准目录们 = [
  '/opt/dsh-plugins',
  // ⚠️ 不能写死 /root/.dsh —— 开源用户可能不是 root，DSH_HOME 也可能在别处。
  //    早先这里硬编码了 /root/.dsh/profiles/{feiyu,web}/node_modules，
  //    在别人机器上必然探不到，插件会「静默失效」（读不到记忆仓库却不说明原因）。
  //    改成按 DSH_HOME / os.homedir() 现算，本机和别人的机器都能命中。
  ...(() => {
    const 家 = (() => { try { return os.homedir() } catch { return '' } })()
    const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim()
      ? process.env.DSH_HOME.trim()
      : (家 ? path.join(家, '.dsh') : '')
    const 出 = []
    if (dshHome) {
      for (const profile of ['default', 'web', 'feiyu']) {
        出.push(path.join(dshHome, 'profiles', profile, 'node_modules'))
      }
    }
    return 出
  })(),
  process.cwd(),
]

/**
 * 把模块动态 import 的结果规整成适配器期望的形状。
 *
 * 为什么单独抽出来：tools.js 可能以两种形态出现 ——
 *   · 标准形态：直接 export 出 搜聊天 / 聊天日期 / 包成文本块（我们依赖的契约）
 *   · 旧形态（本机现在这份构建产物就是这样）：只有 default export（宿主 setup 函数），
 *     没有我们要的那三个命名函数。
 * 两种都要能接住，缺什么就在 reason 里写清楚，让排障的人一眼看出"接口形态对不上"。
 *
 * @param {{ 搜聊天?: Function, 聊天日期?: Function, 包成文本块?: Function }} 模
 * @returns {{ 列日期: Function|null, 搜聊天: Function|null, 原因: string }}
 */
/**
 * 从包根加载记忆仓库的接口函数。
 *
 * 为什么要加载**两个**文件：
 *   · `lib/tools.js`   —— 导出 搜聊天、聊天日期（面向模型的检索工具）
 *   · `lib/chatlog.js` —— 导出 读某天（按日期取全天聊天）
 * 日记最需要的是「某一天的全部聊天」，只有 chatlog.js 的 读某天 能提供；
 * tools.js 的 搜聊天 是**内容关键词**搜索，拿日期当关键词永远搜不到（实测过）。
 *
 * 两个文件任一加载失败都不抛，把能拿到的合在一起交给 规整接口 判断缺什么。
 *
 * @param {string} 包根 记忆仓库的包根目录
 * @returns {Promise<object>} 合并后的模块导出对象
 */
async function 取接口 (包根) {
  const 合并 = {}
  for (const 文件 of ['tools.js', 'chatlog.js']) {
    try {
      const 模 = await import(pathToFileURL(path.join(包根, 'lib', 文件)).href)
      Object.assign(合并, 模)
    } catch {
      // 这个文件拿不到不影响另一个；缺什么由 规整接口 统一报出来
    }
  }
  return 合并
}

function 规整接口 (模) {
  const 缺 = []
  const 搜聊天 = typeof 模.搜聊天 === 'function' ? 模.搜聊天 : null
  const 列日期 = typeof 模.聊天日期 === 'function' ? 模.聊天日期 : null
  // 按日期读全天 —— 这是日记要用的主力接口。
  // 为什么不能拿 搜聊天 顶替：搜聊天 是**内容关键词**搜索，
  // 把日期当关键词传进去永远 0 命中（实测过）。要"某一天的全部聊天"只能用 读某天。
  const 按天读 = typeof 模.读某天 === 'function' ? 模.读某天 : null
  if (!搜聊天) 缺.push('搜聊天')
  if (!列日期) 缺.push('聊天日期')
  if (!按天读) 缺.push('读某天')
  if (缺.length > 0) {
    return {
      列日期,
      搜聊天,
      按天读,
      原因: `模块加载成功但缺少接口：${缺.join('、')}`,
    }
  }
  return { 列日期, 搜聊天, 按天读, 原因: '' }
}

/**
 * 探测并返回记忆仓库的适配器。
 *
 * 按 档A（包名解析）→ 档B（直接路径）→ 档C（降级） 的顺序试，每一档 try/catch，
 * 失败记下原因、进下一档，**整个函数绝不抛异常**。成功返回可用接口，
 * 全失败返回 { ok:false, 列日期:null, 搜聊天:null, 原因:'...' }。
 *
 * 接口契约（来自 dsh-memory-vault 的 lib/tools.js）：
 *   · 搜聊天(rootDir, query, { chatType, groupId, person, limit }) → { 命中数, 结果:[] }
 *   · 聊天日期(rootDir, { chatType, groupId }) → 日期数组（升序 YYYY-MM-DD）
 *   · 包成文本块(文本) → 给模型读用的文本块
 *
 * @param {(msg: string) => void} [提示] 可选日志回调；不传则不打日志。
 *   传入后，每一档的尝试与失败都会走它 —— 方便宿主把排障信息记进运行日志。
 * @returns {Promise<{ ok: boolean, via: string, 版本: string, 原因: string,
 *   列日期: Function|null, 搜聊天: Function|null }>}
 *   · ok：是否拿到**可用**接口（A 或 B 档命中且接口齐全）。
 *   · via：命中的档位名（'包名解析' / '直接路径' / '降级'）。
 *   · 版本：命中包的 version 字段；拿不到就是空串。
 *   · 原因：失败/缺口的逐项说明（成功且全齐时为空串）。
 *   · 列日期 / 搜聊天：可直接调用的函数；拿不到为 null。
 *
 * 何时会失败：
 *   · 仓库没装，或没装进列出的任何一个基准目录的解析链 → 档 A 全部 MODULE_NOT_FOUND
 *   · 装的是不完整构建产物（只有 setup 默认导出，缺命名接口）→ 档 B 能加载但规整不出函数
 *   · 物理路径被搬走 → 档 B ENOENT
 *   任一档失败都不会抛出去，只折进 原因 字段。
 */
export async function 探测仓库 (提示) {
  const 日志 = typeof 提示 === 'function' ? 提示 : () => {}
  /** 每一档失败的原因，最后拼进 原因 字段方便排障。 */
  const 失败们 = []

  /**
   * 档 A：包名解析。
   * 从每个基准目录试 require.resolve('dsh-memory-vault/package.json')，
   * 命中任意一个就拿到包根，再动态 import 它的 lib/tools.js。
   * 为什么用 package.json 而不是裸包名：有些包的 exports 里没暴露 './package.json'，
   * 但包根目录一定存在 —— 用 package.json 能稳定定位包根而不依赖包的出口声明。
   */
  for (const base of 基准目录们) {
    let 包根
    try {
      const pkgPath = req.resolve('dsh-memory-vault/package.json', { paths: [base] })
      包根 = path.dirname(pkgPath)
    } catch (e) {
      // 这个基准目录解析不到，记下原因，试下一个（不是整档失败，是"这一条没命中"）
      失败们.push(`包名解析(${base}): ${e.code || '错误'}`)
      continue
    }
    try {
      // 拿 version（可能没有，容错）
      let 版本 = ''
      try {
        const pkg = JSON.parse(await readFile(path.join(包根, 'package.json'), 'utf8'))
        版本 = pkg.version || ''
      } catch { /* 没有 version 不影响取函数 */ }

      const 模 = await 取接口(包根)
      const 规 = 规整接口(模)
      if (规.搜聊天 && 规.列日期 && 规.按天读) {
        日志(`[vault] 探测成功：包名解析 ${包根}`)
        return {
          ok: true,
          via: '包名解析',
          版本,
          原因: '',
          列日期: 规.列日期,
          搜聊天: 规.搜聊天,
          按天读: 规.按天读,
        }
      }
      // 能 import 但接口不齐全（本机这份构建产物就是这样）：记原因，进档 B
      失败们.push(`包名解析(${包根}): ${规.原因}`)
      continue
    } catch (e) {
      失败们.push(`包名解析(${包根}): ${e.code || e.message}`)
      continue
    }
  }

  /**
   * 档 B：直接路径。
   * A 全部落空（包没进 npm 解析链）时，靠已知的固定物理路径兜底。
   * 物理路径可能已不存在（仓库被搬走 / 换目录）→ ENOENT，进档 C。
   */
  try {
    let 版本 = ''
    const 包根 = path.dirname(path.dirname(直接路径)) // .../lib/tools.js → 包根
    try {
      const pkg = JSON.parse(await readFile(path.join(包根, 'package.json'), 'utf8'))
      版本 = pkg.version || ''
    } catch { /* 容错 */ }
    const 模 = await 取接口(包根)
    const 规 = 规整接口(模)
    if (规.搜聊天 && 规.列日期 && 规.按天读) {
      日志(`[vault] 探测成功：直接路径 ${直接路径}`)
      return {
        ok: true,
        via: '直接路径',
        版本,
        原因: '',
        列日期: 规.列日期,
        搜聊天: 规.搜聊天,
        按天读: 规.按天读,
      }
    }
    失败们.push(`直接路径(${直接路径}): ${规.原因}`)
  } catch (e) {
    失败们.push(`直接路径(${直接路径}): ${e.code || e.message}`)
  }

  /**
   * 档 C：降级。
   * A、B 都失败 → 拿不到接口，退回直接读文件。
   * 注意：这里**不返回 列日期 / 搜聊天 的包装**（没有接口可包），
   * 只如实报告 ok:false + via:'降级' + 原因。是否走兜底读文件，
   * 由 列表/读聊天 两个业务函数根据 适配器.搜聊天 是不是 null 自己判断。
   * 这样 探测仓库 的职责是"找接口"，业务函数的职责是"有接口用接口、没有就用兜底"，
   * 两者边界清晰。
   */
  const 原因 = 失败们.length > 0 ? 失败们.join('; ') : '未尝试任何档位'
  日志(`[vault] 探测失败，走降级：${原因}`)
  return {
    ok: false,
    via: '降级',
    版本: '',
    原因,
    列日期: null,
    搜聊天: null,
  }
}

/**
 * 兜底：直接扫仓库 chat/ 目录列出所有有聊天记录的日期（升序）。
 *
 * 为什么单独抽出来：这是档 C 的核心能力，被 列出有记录的日期 直接调用，
 * 也让"接口不可用 → 直接读文件"这条退化路径只有一处实现，不会散落在两个函数里。
 *
 * 目录布局（仓库的当前约定，也是降级路径唯一能依赖的契约）：
 *   <rootDir>/chat/private/<YYYY-MM-DD>.txt
 *   <rootDir>/chat/group/<群号>/<YYYY-MM-DD>.txt
 * 只认 .txt、且文件名形如 YYYY-MM-DD 的才算"有记录的那天"。
 *
 * @param {string} rootDir 仓库根目录
 * @returns {Promise<string[]>} 升序日期数组；目录不存在时返回 []（不抛）。
 */
/**
 * 列出记忆仓库里有哪些群号。
 *
 * 为什么要读目录而不是问接口：记忆仓库没有导出「列群号」的接口。
 * 这里只读目录名（`chat/group/<群号>/`），不读任何文件内容 ——
 * 目录布局是这个仓库对外最稳定的约定（数据文件格式会变，群号目录不会）。
 * 目录不存在时返回空数组，不抛。
 */
async function 列群号 (rootDir) {
  let 群们
  try { 群们 = await readdir(path.join(rootDir, 'chat', 'group')) } catch { return [] }
  const 出 = []
  for (const gid of 群们) {
    try {
      const st = await stat(path.join(rootDir, 'chat', 'group', gid))
      if (st.isDirectory()) 出.push(gid)
    } catch { /* 取不到就跳过 */ }
  }
  return 出.sort()
}

async function 兜底列日期 (rootDir) {
  const 日期们 = new Set()
  /** 扫一个目录里所有 YYYY-MM-DD.txt，把日期收进集合。目录不存在则静默返回。 */
  const 收 = async (dir) => {
    let 名们
    try { 名们 = await readdir(dir) } catch { return }
    for (const 名 of 名们) {
      if (!/^\d{4}-\d{2}-\d{2}\.txt$/.test(名)) continue
      日期们.add(名.replace(/\.txt$/, ''))
    }
  }
  await 收(path.join(rootDir, 'chat', 'private'))
  // 群聊：先列群号目录，再进每个群号收当天文件
  let 群们
  try { 群们 = await readdir(path.join(rootDir, 'chat', 'group')) } catch { 群们 = [] }
  for (const gid of 群们) {
    let st
    try { st = await stat(path.join(rootDir, 'chat', 'group', gid)) } catch { continue }
    if (!st.isDirectory()) continue
    await 收(path.join(rootDir, 'chat', 'group', gid))
  }
  return [...日期们].sort()
}

/**
 * 兜底：直接读仓库 chat/ 目录里某一天的所有聊天（私聊 + 各群）。
 *
 * 为什么用 extract.js 的 解析聊天 而不是自己写正则：行格式解析在 extract.js
 * 里已经有过一份、且踩过坑（哪些格式算"不是聊天行直接丢"），复用能确保
 * 接口路径与兜底路径拿到的是**同一种行结构**（{ 时间, 昵称, pid, 内容 }），
 * 下游 挑候选/渲染候选 不用关心数据从哪条路来。
 *
 * @param {string} rootDir 仓库根目录
 * @param {string} date 日期 YYYY-MM-DD
 * @returns {Promise<{ 行们: Array<{时间,昵称,pid,内容,群}>, 来源: string[] }>}
 *   · 行们：解析后的聊天行；该天没有任何记录时为空数组（不抛）。
 *   · 来源：人可读的"数据从哪些文件来"清单，格式沿用 tools.js 的 读仓库当天：
 *     私聊 `YYYY-MM-DD.txt(私聊, N 行)`、群聊 `群<号>/YYYY-MM-DD.txt (N 行)`。
 */
async function 兜底读当天 (rootDir, date) {
  const 行们 = []
  const 来源 = []

  // 私聊：chat/private/<date>.txt
  const pfile = path.join(rootDir, 'chat', 'private', `${date}.txt`)
  try {
    const raw = await readFile(pfile, 'utf8')
    const 行 = 解析聊天(raw)
    行们.push(...行)
    来源.push(`${date}.txt(私聊, ${行.length} 行)`)
  } catch {
    // 没有私聊文件 / 没有私聊目录 —— 不算错，只是这天没有私聊记录
  }

  // 群聊：chat/group/<群号>/<date>.txt
  const gdir = path.join(rootDir, 'chat', 'group')
  let 群们
  try { 群们 = await readdir(gdir) } catch { 群们 = [] }
  for (const gid of 群们) {
    let st
    try { st = await stat(path.join(gdir, gid)) } catch { continue }
    if (!st.isDirectory()) continue
    try {
      const raw = await readFile(path.join(gdir, gid, `${date}.txt`), 'utf8')
      const 行 = 解析聊天(raw)
      for (const r of 行) r.群 = gid
      行们.push(...行)
      来源.push(`群${gid}/${date}.txt (${行.length} 行)`)
    } catch {
      // 这个群当天没有记录 —— 正常情况，不算错
    }
  }

  return { 行们, 来源 }
}

/**
 * 列出记忆仓库有聊天记录的日期（升序）。
 *
 * 优先走适配器接口 聊天日期（仓库自己告诉我们它有哪些天 —— 仓库改布局也不受影响）；
 * 适配器不可用（搜索/日期函数是 null）时，退回直接扫 chat/ 目录（兜底，
 * 保证仓库接口断了这天日记候选也不会断）。
 *
 * @param {string} rootDir 仓库根目录
 * @param {{ 列日期?: Function|null }} [适配器] 探测仓库 的返回；缺列日期则走兜底。
 * @returns {Promise<string[]>} 升序日期数组（YYYY-MM-DD）。
 *   接口抛错或目录不存在时返回 []（不向上抛 —— 列日期失败不应中断"挑日记"主流程）。
 */
export async function 列出有记录的日期 (rootDir, 适配器) {
  const 列日期 = 适配器?.列日期
  if (typeof 列日期 === 'function') {
    try {
      // ⚠️ 接口契约（实测踩过的坑）：记忆仓库的 聊天日期() 只认 chatType='private'
      //    或 'group'；不传会返回空数组，而不是"全都返回"。
      //    曾经传 {} 导致永远拿到 []，表现为「仓库明明有记录却列不出日期」。
      //    所以两类各问一遍再合并去重。
      const 私聊 = await 列日期(rootDir, { chatType: 'private' })
      const 群聊 = await 列日期(rootDir, { chatType: 'group' })
      const 合并 = new Set([
        ...(Array.isArray(私聊) ? 私聊 : []),
        ...(Array.isArray(群聊) ? 群聊 : []),
      ])
      // 接口返回的是降序（最新在前）；本模块对外承诺升序，统一排一遍
      return [...合并].sort()
    } catch {
      // 接口调用失败 → 落到兜底，保证功能不中断
    }
  }
  try {
    return await 兜底列日期(rootDir)
  } catch {
    return []
  }
}

/**
 * 搜记忆仓库某一天的聊天。
 *
 * 优先走适配器接口 搜聊天：关键词传"日期"本身（让仓库自己去过滤当天），
 * chatType **不传** —— 表示私聊、群聊都要，正好覆盖"当天所有聊天"。
 *
 * ⚠️ 接口返回的每项是 `{ 日期, 类型, 群号, 内容 }`，**没有把时间/昵称/pid 拆出来** ——
 *    它们都还包在 `内容` 那个整行字符串里（形如 `[09:00:00] 昵称(p1): 说了什么`）。
 *    所以这里要复用 extract.js 的 解析聊天 把整行再拆一次，
 *    否则下游拿到的时间、昵称全是空字符串（实测踩过一次）。
 *
 * 接口不可用时，退回 兜底读当天（直接读 chat/ 目录当天 .txt + 解析聊天），
 * 这是"仓库接口断了，日记候选也不能断"的保底路径。
 *
 * @param {string} rootDir 仓库根目录
 * @param {string} date 日期 YYYY-MM-DD
 * @param {{ 搜聊天?: Function|null }} [适配器] 探测仓库 的返回；缺搜聊天则走兜底。
 * @returns {Promise<{ 行数: number, 来源: string[], 行们: Array<{时间,昵称,pid,内容,群}> }>}
 *   · 行数：当天解析出的聊天行总数。
 *   · 来源：数据从哪来（人可读清单）：接口路径为 `['仓库接口: 搜聊天']`，
 *     兜底路径沿用 tools.js 的文件清单。
 *   · 行们：统一结构；当天没有记录时为空数组。
 *
 * 何时会拿不到数据（都不抛）：仓库没这一天记录、接口不可用且目录也不存在。
 */
export async function 读当天聊天 (rootDir, date, 适配器) {
  const 按天读 = 适配器?.按天读
  if (typeof 按天读 === 'function') {
    const 行们 = []
    const 来源 = []
    // 记录「接口到底有没有成功应答过」。这是降级判据的核心：
    //   · 接口成功应答但没数据 → 这天真没聊过，直接回空，不必翻文件
    //   · 接口**一次都没成功**（全抛错）→ 必须退回读文件，否则日记会静默变空
    // 曾经这里每个 try/catch 都直接吞错，接口全炸时 行们 是空的，
    // 就当成「这天没聊过」return 了，永远走不到降级 —— 日志里一点痕迹都没有（已修）。
    let 接口成功过 = false

    // 群号从目录拿：记忆仓库没有导出「列群号」的接口，
    // 目录名是它最稳定的约定（数据格式会变，群号目录不会）。
    let 群号们 = []
    try { 群号们 = await 列群号(rootDir) } catch { 群号们 = [] }

    // 1) 私聊当天
    try {
      const 私聊 = await 按天读(rootDir, { chatType: 'private', date })
      接口成功过 = true
      const 行s = 规整行(私聊, null)
      if (行s.length > 0) { 行们.push(...行s); 来源.push(`私聊 ${date}(${行s.length} 行)`) }
    } catch { /* 这次失败；是否降级由下面的 接口成功过 统一判断 */ }

    // 2) 每个群当天
    for (const 群号 of 群号们) {
      try {
        const 群 = await 按天读(rootDir, { chatType: 'group', groupId: 群号, date })
        接口成功过 = true
        const 行s = 规整行(群, 群号)
        if (行s.length > 0) { 行们.push(...行s); 来源.push(`群${群号} ${date}(${行s.length} 行)`) }
      } catch { /* 该群这次失败 */ }
    }

    if (行们.length > 0) {
      return { 行数: 行们.length, 来源: 来源.length ? 来源 : ['仓库接口: 读某天'], 行们 }
    }
    // 有数据就返回；没数据时只有「接口确实成功应答过」才能认定这天真没聊，
    // 否则说明接口不可用，必须降级读文件
    if (接口成功过) {
      return { 行数: 0, 来源: ['仓库接口: 读某天'], 行们: [] }
    }
    // 走到这里 = 接口一次都没成功 → 落到下面的兜底
  }

  const 出 = await 兜底读当天(rootDir, date)
  return { 行数: 出.行们.length, 来源: 出.来源, 行们: 出.行们 }
}

/**
 * 把接口返回的行统一成 { 时间, 昵称, pid, 内容, 群 }。
 *
 * 记忆仓库的 读某天 返回的是**整行字符串数组**（形如 `[09:00:00] 昵称(p1): 说了什么`），
 * 不是结构化对象，所以这里复用 extract.js 的 解析聊天 拆行。
 * 拆不出来的（格式变了）保留整行，不让记录凭空消失。
 */
function 规整行 (原始, 群号) {
  const 行们 = []
  for (const r of Array.isArray(原始) ? 原始 : []) {
    const 原文 = typeof r === 'string' ? r : (r && typeof r.内容 === 'string' ? r.内容 : '')
    if (!原文) continue
    const 拆 = 解析聊天(原文)
    if (拆.length > 0) {
      行们.push(...拆.map((x) => ({ ...x, 群: 群号 })))
    } else {
      行们.push({ 时间: '', 昵称: '', pid: '', 内容: 原文, 群: 群号 })
    }
  }
  return 行们
}

// ── 按来源分开读（2026-11-03「完全分开」之后的主路径）─────────────────────
//
// 【为什么要有这一组函数】
//   上面那组（列出有记录的日期 / 读当天聊天）是 0.2.x 的旧接口，**把私聊和
//   所有群合并成一个流**：一天 429 行里分不清哪句是私聊、哪句是群友说的。
//   主人 2026-11-03 定「完全分开」之后，日记按来源各存一份，所以读取也要
//   按来源各读一次。
//
//   ⚠️ 旧函数保留没删：一是兼容手动调用它的脚本，二是它们里面沉淀了两条
//      实测出来的仓库接口坑（聊天日期 必须分别传 private/group；搜聊天 拿日期
//      当关键词必然 0 条）。新函数复用同样的判据，不要另起炉灶。
//
//   【关键约定】任何按来源读的函数，返回的每一行都带 .来源 = 该来源 key，
//   这样下游（挑候选、渲染批次、写日记条目）不用再猜这句话是谁说的。

/**
 * 列出记忆仓库里有哪些来源（私聊 + 每个群号）。
 *
 * 只用目录名判断「有没有这个群」：记忆仓库没有导出「列群号」的接口，
 * 而 chat/group/<群号>/ 的目录结构是它对外最稳定的约定。
 *
 * 私聊只有在 chat/private/ 目录存在（或接口能列出私聊日期）时才返回，
 * 免得在一个根本没有私聊记录的仓库里凭空造出一个空的「私聊」视角。
 *
 * @param {string} rootDir 仓库根目录
 * @param {{ 列日期?: Function|null }} [适配器] 探测仓库 的返回
 * @returns {Promise<Array<{ 来源: string, 标签: string, 群号: string, 有记录: boolean }>>}
 *   已按「私聊优先、群按群号序」排好；仓库不存在时返回 []（不抛）。
 */
export async function 列出来源 (rootDir, 适配器) {
  const 出 = []
  const 见过 = new Set()

  // 私聊：目录在就算（空目录也认，因为可能只是今天没聊）
  let 有私聊 = false
  try {
    const st = await stat(path.join(rootDir, 'chat', 'private'))
    有私聊 = st.isDirectory()
  } catch { /* 没有就是没有 */ }
  // 接口说有私聊日期，也算
  if (!有私聊 && typeof 适配器?.列日期 === 'function') {
    try {
      const ds = await 适配器.列日期(rootDir, { chatType: 'private' })
      if (Array.isArray(ds) && ds.length > 0) 有私聊 = true
    } catch { /* 接口失败不影响列出群 */ }
  }
  if (有私聊) {
    见过.add(私聊)
    出.push({ 来源: 私聊, 标签: 来源标签(私聊), 群号: '', 有记录: true })
  }

  // 群：读 chat/group/<群号> 目录
  let 群号们 = []
  try { 群号们 = await 列群号(rootDir) } catch { 群号们 = [] }
  for (const gid of 群号们) {
    const key = 校验来源(群前缀 + gid)
    if (!key || 见过.has(key)) continue
    见过.add(key)
    出.push({ 来源: key, 标签: 来源标签(key), 群号: gid, 有记录: true })
  }

  return 出.sort((a, b) => 比较来源(a.来源, b.来源))
}

/**
 * 读某**一个来源**某一天的聊天。
 *
 * 与 读当天聊天 的区别：只要一个来源，绝不合并。调用方对每个来源各调一次。
 *
 * 降级判据与旧函数完全一致（那条「接口全炸时静默返回 0 行」的坑已经踩过）：
 * 接口**一次都没成功应答**才退回读文件；接口成功应答但没数据 = 这天真没聊。
 *
 * @param {string} rootDir 仓库根目录
 * @param {string} 来源 key（'private' 或 'group:<群号>'）
 * @param {string} date YYYY-MM-DD
 * @param {{ 按天读?: Function|null }} [适配器] 探测仓库 的返回
 * @returns {Promise<{ 来源: string, 行数: number, sources: string[], 行们: Array }>}
 *   行们 每行都带 .来源，群聊行另带 .群 = 群号。
 */
export async function 读来源聊天 (rootDir, 来源, date, 适配器) {
  const key = 校验来源(来源)
  if (!key) return { 来源: '', 行数: 0, sources: [], 行们: [] }
  const gid = 群号(key)

  const 按天读 = 适配器?.按天读
  if (typeof 按天读 === 'function') {
    try {
      const 原始 = gid
        ? await 按天读(rootDir, { chatType: 'group', groupId: gid, date })
        : await 按天读(rootDir, { chatType: 'private', date })
      // 接口成功应答了：不管有没有行，都以它为准（这天真没聊 = 空，不必翻文件）
      const 行s = 规整行(原始, gid || null).map((r) => ({ ...r, 来源: key }))
      const 人读 = gid ? `群${gid}/${date}.txt (${行s.length} 行)` : `${date}.txt(私聊, ${行s.length} 行)`
      return { 来源: key, 行数: 行s.length, sources: [人读], 行们: 行s }
    } catch { /* 接口这次失败 → 落到下面读文件 */ }
  }

  // 兜底：直接读这类来源的当天文件
  const 行们 = []
  const sources = []
  if (gid) {
    const file = path.join(rootDir, 'chat', 'group', gid, `${date}.txt`)
    try {
      const raw = await readFile(file, 'utf8')
      const 行 = 解析聊天(raw)
      for (const r of 行) r.群 = gid
      行们.push(...行.map((r) => ({ ...r, 来源: key })))
      sources.push(`群${gid}/${date}.txt (${行.length} 行)`)
    } catch { /* 这天没聊 */ }
  } else {
    const file = path.join(rootDir, 'chat', 'private', `${date}.txt`)
    try {
      const raw = await readFile(file, 'utf8')
      const 行 = 解析聊天(raw)
      行们.push(...行.map((r) => ({ ...r, 来源: key })))
      sources.push(`${date}.txt(私聊, ${行.length} 行)`)
    } catch { /* 这天没聊 */ }
  }
  return { 来源: key, 行数: 行们.length, sources, 行们 }
}

/**
 * 读**某一天的所有来源**，但保持分开：返回一个数组，每项一个来源。
 *
 * 这是 UI「挑候选」页真正要的东西 —— 一次拿全，但绝不预处理成混合流。
 * 空来源（当天没聊）也会返回，行数为 0，这样 UI 能显示「这个群今天没聊」
 * 而不是干脆不列出它（不列出会让人以为群没接上）。
 *
 * @returns {Promise<Array<{ 来源: string, 标签: string, 群号: string, 行数: number, sources: string[], 行们: Array }>>}
 */
export async function 读全部来源 (rootDir, date, 适配器) {
  const 来源们 = await 列出来源(rootDir, 适配器)
  const 出 = []
  for (const s of 来源们) {
    const r = await 读来源聊天(rootDir, s.来源, date, 适配器)
    出.push({ ...s, 行数: r.行数, sources: r.sources, 行们: r.行们 })
  }
  return 出
}
