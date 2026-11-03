// ============================================================================
// store.js —— 小鱼日记的存储层（按来源分开：私聊一套、每个群各一套）
//
// 【这个模块负责什么】
//   目录布局（rootDir 下）：
//   sources.json                      有哪些来源出现过 { version, sources: [...] }
//   entries/<来源>/<YYYY-MM-DD>.json  该来源某天的条目数组
//   index/<来源>.json                 该来源的反向索引：{ version, seq, days, terms }
//   candidates/<来源>/<YYYY-MM-DD>.json 该来源某天的候选及取舍状态
//   bookmark/<来源>.json              该来源书本模式的阅读进度
//
//   来源命名见 source.js：私聊是 'private'，群是 'group:<群号>'。
//   落盘目录名用 来源目录名()：'private' / 'group-730783833'（':' 不适合当目录名）。
//
//   ⚠️ 根目录下还可能有**老版本遗留**的 entries/<日期>.json（不分来源的一天一份）。
//      那是 0.2.x 早期把私聊+群聊混在一起的产物，见 迁移老数据()。
//
// 【为什么这样设计】
//   为什么**按来源彻底分开**（2026-11-03 主人定的「完全分开」）：
//   私聊里是你和特定的人的约定；群聊里可能根本不是你在说话。混在一份日记里，
//   翻的时候分不清哪句是谁说的、检索「上次谁说过」会搜出群友闲聊。
//   代价是每个来源单独维护一套文件与索引 —— 但一天最多几个来源，
//   目录数也就几个，比在一个大文件里打来源字段清楚得多，出问题也只坏一个来源。
//
//   为什么每个来源有**自己的索引与 seq**：
//   索引是个可丢弃的派生物（entries/ 才是唯一真相）。按来源拆开后，
//   重建一个来源的索引不需要读别的来源的文件，速度不随来源数增长。
//   seq 也各自自增：条目 id 只在同来源内唯一就够了，跨来源引用一定带来源。
//
//   为什么一天一个文件而不是一个大 JSON：
//   · 追加一条只重写当天那个文件，不碰其他天，写坏了也只坏一天；
//   · 人可以直接打开某天看，不用跑代码；
//   · 索引丢了能从 entries/ 完整重建。
//
//   为什么候选要单独存一份而不是直接从聊天重算：
//   · 用户挑过的结果（放/不放）必须留存 —— 重算会把「不放」的决定丢掉，
//     同一条候选第二天又冒出来，用户得重新否一次；
//   · 候选带一句「为什么被挑中」，重算要重新跑一遍筛选，UI 每次打开都要重扫全部聊天。
//
//   所有读写都要容错：目录缺失、某个 JSON 损坏都不得抛异常拖垮整个工具。
//
// 【对外导出】
//   · 库根(rootDir, ...rest) —— 库根目录下的子路径拼接
//   · 备好目录(rootDir, 来源?) —— 确保目录存在（父目录不在则抛）
//   · 列出日期(rootDir, 来源) —— 该来源有日记的日期（升序）
//   · 读某天 / 写某天
//   · 读索引 / 写索引 / 空索引 / 重建 / 收录一天 / 撤一天
//   · 追加条目 / 删条目
//   · 候选状态 / 读候选 / 写候选 / 列出候选日期 / 合并候选
//   · 读书签 / 写书签
//   · 读来源清单 / 记下来源 / 列出已知来源 / 迁移老数据
// ============================================================================

import { readdir, readFile, writeFile, mkdir, rename, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import { 切词 } from './search.js'
import { 校验来源, 来源目录名, 比较来源, 私聊, 是私聊, 来源标签 } from './source.js'

/**
 * 索引格式版本。
 *
 * v1：不分来源，根目录下一个 index.json，seq 全局自增。
 * v2：每个来源一个 index/<来源>.json，各自 seq。结构变了就 +1，读到时版本不符直接重建。
 *     老版本的 v1 索引读出来会被判为「版本不符」→ 自动重建，不需要迁移代码。
 */
const 索引版本 = 2

/** 老版本（不分来源）索引的版本号，只用来认出来并忽略。 */
const 老索引版本 = 1

/** 单条日记的稳定 id 前缀。 */
const ID_PREFIX = 'd'

/** 来源清单文件的版本。 */
const 来源清单版本 = 1

/** 目录是否是「已存在且为目录」；不存在或不是目录都返回 false。 */
async function 是目录 (p) {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** 库根目录下的子路径。 */
export function 库根 (rootDir, ...rest) {
  return path.join(rootDir, ...rest)
}

/**
 * 准备目录（必要时创建）。
 *
 * 传了来源时建该来源的目录（entries/<来源>/、index/、candidates/<来源>/、bookmark/），
 * 不传只建根目录本身。
 *
 * 【为什么要区分「首次使用」和「配置写错」】
 * 早先这里只判断「rootDir 存在吗」，不存在就抛错。出发点是好的 ——
 * 配置指错了地方时不该凭空造一棵目录树。但它把**首次使用**也一起挡了：
 * 新装插件、第一次点「记一下」，用户看到的是
 * 「日记库根目录不存在：/root/.dsh/xiaoyu-diary（父目录也不在）」，
 * 而实际上 /root/.dsh 明明在 —— 报错信息本身还是错的，非常费解。
 *
 * 现在按「父目录在不在」区分，两种情形分开对待：
 *   · 父目录在（比如 ~/.dsh 有）→ 说明只是还没建过，属首次使用的正常路径，创建它
 *   · 父目录都不在            → 多半是配置把路径指到了不存在的地方，报错，不凭空造
 *
 * @param {string} rootDir 日记库根目录
 * @param {string} [来源] 来源 key（见 source.js）；不传只保证库根目录在
 * @returns {Promise<string>} 该来源 entries/ 的绝对路径（不传来源则是库根目录）
 * @throws {Error} 仅当父目录都不存在（配置错误）时抛出
 */
export async function 备好目录 (rootDir, 来源) {
  // 库根目录先就位（两种情形都判断一遍，一样先看父目录在不在）
  if (!(await 是目录(rootDir))) {
    if (!(await 是目录(path.dirname(rootDir)))) {
      // 父目录都不在：这不像"首次使用"，更像配置指错了地方。
      // 报清楚是**哪一级**不存在，别让用户去猜。
      throw new Error(
        `日记库路径不可用：${rootDir}\n` +
        `原因：它的上级目录 ${path.dirname(rootDir)} 不存在。请检查配置（rootDir / DIARY_HOME）是否指错了地方。`,
      )
    }
    await mkdir(rootDir)
  }

  const key = 来源 === undefined ? '' : 校验来源(来源)
  if (来源 !== undefined && key === '') {
    throw new Error(`非法的来源：${String(来源)}（只能是 private 或 group:<群号>）`)
  }

  // 库根下的公共子目录：先建一遍，后面的按来源目录 mkdir -p 就不用逐级判断
  await mkdir(库根(rootDir, 'entries'), { recursive: true })
  if (key === '') return rootDir

  const 名 = 来源目录名(key)
  const entries = 库根(rootDir, 'entries', 名)
  await mkdir(entries, { recursive: true })
  await mkdir(库根(rootDir, 'candidates', 名), { recursive: true })
  await mkdir(库根(rootDir, 'index'), { recursive: true })
  await mkdir(库根(rootDir, 'bookmark'), { recursive: true })
  return entries
}

/** 读单个 JSON，失败返回 null（不抛）。 */
async function 读JSON (file) {
  try {
    const raw = await readFile(file, 'utf8')
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/** 读单个 JSON 数组，失败或形状不对都返回 []。 */
async function 读JSON数组 (file) {
  const v = await 读JSON(file)
  return Array.isArray(v) ? v : []
}

/** 原子写：先写 .tmp 再 rename，避免写一半断电留下半个文件。 */
async function 原子写 (file, data) {
  const tmp = `${file}.tmp`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, file)
}

/** 解出并校验来源；不合法抛错 —— 存储层不接受「来源不明」的写入。 */
function 要来源 (来源) {
  const key = 校验来源(来源)
  if (!key) throw new Error(`非法的来源：${String(来源)}（只能是 private 或 group:<群号>）`)
  return key
}

/** 该来源的 entries 目录。 */
function entries目录 (rootDir, 来源) {
  return 库根(rootDir, 'entries', 来源目录名(要来源(来源)))
}

/** 该来源的候选目录。 */
function candidates目录 (rootDir, 来源) {
  return 库根(rootDir, 'candidates', 来源目录名(要来源(来源)))
}

/** 该来源的索引文件。 */
function 索引文件 (rootDir, 来源) {
  return 库根(rootDir, 'index', `${来源目录名(要来源(来源))}.json`)
}

/** 该来源的书签文件。 */
function 书签文件 (rootDir, 来源) {
  return 库根(rootDir, 'bookmark', `${来源目录名(要来源(来源))}.json`)
}

// ── 来源清单 ──────────────────────────────────────────────────────────────
//
// sources.json 是「哪些来源存在过」的登记簿。它有两个用处：
//   1. 概览页的视角下拉框要在**还没写过日记**时也能列出所有群
//      （比如某个群今天零候选，但用户可能想去看它前几天的）；
//   2. 记忆仓库里某个群被删掉后，日记不该跟着消失 ——
//      登记簿只增不减，来源不会因为仓库里没数据就被从 UI 上抹掉。
//
// 它同样是**派生物**：坏了丢了可以靠扫 entries/ 与 candidates/ 的目录名重建。

/** 来源清单文件路径。 */
function 来源清单文件 (rootDir) {
  return 库根(rootDir, 'sources.json')
}

/** 读来源清单，返回合法来源数组（已排序）。坏了返回 []，不抛。 */
export async function 读来源清单 (rootDir) {
  const v = await 读JSON(来源清单文件(rootDir))
  const arr = v && Array.isArray(v.sources) ? v.sources : []
  const 见过 = new Set()
  for (const s of arr) {
    const k = 校验来源(s)
    if (k) 见过.add(k)
  }
  return [...见过].sort(比较来源)
}

/** 写来源清单（原子写）。 */
async function 写来源清单 (rootDir, 来源们) {
  const 去重 = new Set()
  for (const s of 来源们) {
    const k = 校验来源(s)
    if (k) 去重.add(k)
  }
  const payload = { version: 来源清单版本, sources: [...去重].sort(比较来源) }
  await 原子写(来源清单文件(rootDir), JSON.stringify(payload, null, 2))
  return payload.sources
}

/** 把一个来源登记进清单（已在就不动）。返回最新的整个清单。 */
export async function 记下来源 (rootDir, 来源) {
  const key = 要来源(来源)
  const 现有 = await 读来源清单(rootDir)
  if (现有.includes(key)) return 现有
  return 写来源清单(rootDir, [...现有, key])
}

/**
 * 列出磁盘上所有真实存在的来源：清单 ∪ entries/ 下的目录 ∪ candidates/ 下的目录。
 *
 * 为什么要把目录也扫进来：sources.json 丢了、或者用户手工拷了几个日记文件进来，
 * 那些来源不该因为没登记就从界面上消失 —— 文件在就该能读到。
 */
export async function 列出已知来源 (rootDir) {
  const out = new Set((await 读来源清单(rootDir)).map((s) => 校验来源(s)).filter(Boolean))
  // 目录名是 来源目录名() 的结果，要反向认回来源 key
  const 反认 = (名) => {
    if (名 === 'private') return 私聊
    const m = /^group-([A-Za-z0-9_-]{1,64})$/.exec(名)
    return m ? 校验来源(`group:${m[1]}`) : ''
  }
  for (const 父 of ['entries', 'candidates']) {
    let names
    try {
      names = await readdir(库根(rootDir, 父))
    } catch {
      continue
    }
    for (const 名 of names) {
      const k = 反认(名)
      if (!k) continue // 不是来源目录（比如老版本的 entries/2026-11-03.json）直接跳过
      if (await 是目录(库根(rootDir, 父, 名))) out.add(k)
    }
  }
  return [...out].sort(比较来源)
}

/** 列出自有日记的日期（YYYY-MM-DD），升序。不是这个形状的文件名一律不算。 */
export async function 列出日期 (rootDir, 来源) {
  let names
  try {
    names = await readdir(entries目录(rootDir, 来源))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)
    if (m) out.push(m[1])
  }
  return out.sort()
}

/** 读某来源某一天的条目数组，读不到返回 []。条目对象残缺的跳过。 */
export async function 读某天 (rootDir, 来源, date) {
  const v = await 读JSON(path.join(entries目录(rootDir, 来源), `${date}.json`))
  if (!v || !Array.isArray(v.entries)) return []
  return v.entries.filter((e) => e && typeof e === 'object' && typeof e.text === 'string')
}

/** 写某来源的某一天：{ version, date, 来源, entries }。 */
export async function 写某天 (rootDir, 来源, date, entries) {
  const key = 要来源(来源)
  await 备好目录(rootDir, key)
  const payload = { version: 索引版本, date, 来源: key, entries }
  await 原子写(path.join(entries目录(rootDir, key), `${date}.json`), JSON.stringify(payload, null, 2))
  // 写过就说明这个来源真实存在过，登记进清单
  await 记下来源(rootDir, key)
}

/** 读某来源的索引；不存在、损坏、版本不符都返回 null（调用方据此重建）。 */
export async function 读索引 (rootDir, 来源) {
  const v = await 读JSON(索引文件(rootDir, 来源))
  if (!v || v.version !== 索引版本) return null
  if (!v.days || typeof v.days !== 'object') return null
  if (!v.terms || typeof v.terms !== 'object') return null
  return v
}

/** 老版本的根索引（不分来源）。只在 迁移老数据() 里用。 */
async function 读老索引 (rootDir) {
  const v = await 读JSON(库根(rootDir, 'index.json'))
  return v && v.version === 老索引版本 ? v : null
}

/** 写某来源的索引。 */
export async function 写索引 (rootDir, 来源, index) {
  await 备好目录(rootDir, 要来源(来源))
  await 原子写(索引文件(rootDir, 来源), JSON.stringify(index, null, 2))
}

/** 空索引。seq 是自增编号，用来给新条目分配 id（每个来源各自一套）。 */
export function 空索引 () {
  return { version: 索引版本, seq: 0, days: {}, terms: {} }
}

/**
 * 从 entries/<来源>/ 完整重建该来源的索引。
 *
 * 索引是派生物，entries/ 才是唯一真相：任何时候索引丢了/坏了/版本旧了，
 * 都能从日记文件本身原样重建出来，不会丢数据。
 *
 * @returns {{index: object, 重建天数: number, 跳过: string[]}}
 */
export async function 重建 (rootDir, 来源) {
  const index = 空索引()
  const 日期们 = await 列出日期(rootDir, 来源)
  const 跳过 = []
  let 天数 = 0
  for (const date of 日期们) {
    const v = await 读JSON(path.join(entries目录(rootDir, 来源), `${date}.json`))
    if (!v || !Array.isArray(v.entries)) {
      跳过.push(date)
      continue
    }
    for (const e of v.entries) {
      if (!e || typeof e.id !== 'string') continue
      const m = /^d(\d+)$/.exec(e.id)
      if (!m) continue
      const n = Number(m[1])
      if (Number.isFinite(n) && n > index.seq) index.seq = n
    }
    收录一天(index, date, v.entries)
    天数++
  }
  return { index, 重建天数: 天数, 跳过 }
}

/**
 * 把某一天的全部条目登记进索引（先清掉这一天旧的登记，再全量写）。
 *
 * 词表收录的是切词结果的前缀截断版本：每条日记只取前若干词，
 * 避免长篇日记把索引撑爆 —— 检索时宁可多扫一点，也不要索引比正文还大。
 */
export function 收录一天 (index, date, entries) {
  // 先撤掉这一天旧的词映射
  撤一天(index, date)
  const 摘要 = []
  for (const e of entries) {
    const 词 = 切词(`${e.text} ${(e.tags || []).join(' ')} ${e.title || ''}`)
    for (const w of 词.slice(0, 40)) {
      if (!index.terms[w]) index.terms[w] = []
      if (!index.terms[w].includes(date)) index.terms[w].push(date)
    }
    摘要.push({ id: e.id, title: e.title || '', text: e.text, tags: e.tags || [], at: e.at || '' })
  }
  index.days[date] = { count: entries.length, entries: 摘要 }
}

/** 从索引里撤掉某一天。 */
export function 撤一天 (index, date) {
  const old = index.days[date]
  if (old && Array.isArray(old.entries)) {
    for (const e of old.entries) {
      for (const w of 切词(`${e.text} ${(e.tags || []).join(' ')} ${e.title || ''}`).slice(0, 40)) {
        const arr = index.terms[w]
        if (!arr) continue
        const i = arr.indexOf(date)
        if (i >= 0) arr.splice(i, 1)
        if (arr.length === 0) delete index.terms[w]
      }
    }
  }
  delete index.days[date]
}

/** 拿某来源的可用索引：坏了就重建并写回。 */
async function 拿索引 (rootDir, 来源) {
  const idx = await 读索引(rootDir, 来源)
  if (idx) return { index: idx, 重建过: false }
  const r = await 重建(rootDir, 来源)
  return { index: r.index, 重建过: true, 跳过: r.跳过 }
}

/**
 * 追加一条日记。返回写入后的条目（含分配的 id）。
 *
 * 同一来源同一天多次追加会追加到同一个文件；id 在该来源内由 index.seq 自增分配，
 * 索引坏了时先重建再分配，避免撞号。
 */
export async function 追加条目 (rootDir, 来源, date, 条目) {
  const key = 要来源(来源)
  const { index } = await 拿索引(rootDir, key)
  const entries = await 读某天(rootDir, key, date)
  index.seq += 1
  const e = { id: `${ID_PREFIX}${index.seq}`, ...条目 }
  entries.push(e)
  await 写某天(rootDir, key, date, entries)
  收录一天(index, date, entries)
  await 写索引(rootDir, key, index)
  return e
}

/**
 * 删掉一条日记（按 id）。返回 { 删除, 日期, 来源 }。
 *
 * 不传来源时在所有已知来源里找（幂等，找得到就删）；传了只在那个来源里找。
 */
export async function 删条目 (rootDir, id, 来源) {
  const 候选来源们 = 来源 ? [要来源(来源)] : await 列出已知来源(rootDir)
  for (const key of 候选来源们) {
    const 日期们 = await 列出日期(rootDir, key)
    for (const date of 日期们) {
      const entries = await 读某天(rootDir, key, date)
      const i = entries.findIndex((e) => e.id === id)
      if (i < 0) continue
      entries.splice(i, 1)
      await 写某天(rootDir, key, date, entries)
      const { index } = await 拿索引(rootDir, key)
      收录一天(index, date, entries)
      await 写索引(rootDir, key, index)
      return { 删除: true, 日期: date, 来源: key }
    }
  }
  return { 删除: false, 日期: '', 来源: '' }
}

// ── 候选暂存区 ────────────────────────────────────────────────────────────

/** 候选的三种取舍状态。pending = 还没决定。 */
export const 候选状态 = Object.freeze({
  待定: 'pending',
  放进去: 'accepted',
  不放: 'rejected',
})

/**
 * 读某来源某天的候选。
 *
 * 返回 { date, 来源, 生成时间, sources, 总行数, items: [...] }，
 * items 每项：{ cid, 时间, 昵称, 内容, 命中, 状态, 条目id }
 *   · cid  = 当天该来源内的稳定编号（c1、c2…），UI 用它定位
 *   · 条目id = 状态变成 accepted 后，写进日记的那条 id
 *
 * 读不到或坏掉都返回空结构，不抛。
 */
export async function 读候选 (rootDir, 来源, date) {
  const key = 要来源(来源)
  const 空 = { date, 来源: key, 生成时间: '', sources: [], 总行数: 0, items: [] }
  const v = await 读JSON(path.join(candidates目录(rootDir, key), `${date}.json`))
  if (!v || !Array.isArray(v.items)) return 空
  return {
    date: String(v.date || date),
    来源: key,
    生成时间: String(v.生成时间 || ''),
    // 字段名 sources = 「这批候选是从哪些聊天文件来的」（人读清单，用于排障）。
    // 它和 来源（这批候选属于哪个视角）不是一回事，别搞混：
    //   来源 = 'group:730783833'；sources = ['群730783833 2026-11-03(186 行)']
    sources: Array.isArray(v.sources) ? v.sources.map(String) : [],
    总行数: Number(v.总行数) || 0,
    items: v.items.filter((x) => x && typeof x.内容 === 'string'),
  }
}

/** 写某来源某天的候选。 */
export async function 写候选 (rootDir, 来源, date, data) {
  const key = 要来源(来源)
  // 复用 备好目录 的判据：父目录在就允许创建，父目录不在才算配置错误
  await 备好目录(rootDir, key)
  const payload = {
    version: 索引版本,
    date,
    来源: key,
    生成时间: data.生成时间 || new Date().toISOString(),
    sources: Array.isArray(data.sources) ? data.sources : (Array.isArray(data.来源) ? data.来源 : []),
    总行数: Number(data.总行数) || 0,
    items: Array.isArray(data.items) ? data.items : [],
  }
  await 原子写(path.join(candidates目录(rootDir, key), `${date}.json`), JSON.stringify(payload, null, 2))
  await 记下来源(rootDir, key)
  return payload
}

/** 列出某来源有候选的日期。 */
export async function 列出候选日期 (rootDir, 来源) {
  let names
  try {
    names = await readdir(candidates目录(rootDir, 来源))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)
    if (m) out.push(m[1])
  }
  return out.sort()
}

/**
 * 把当天的候选整体换成新筛出来的结果，**保留已有取舍**。
 *
 * 这是关键：重新提取时，已经标成「放进去/不放」的候选要沿用原来的状态，
 * 否则用户挑过的决定会被冲掉 —— 那样「每天自动提取」就变成了每天重做一遍。
 *
 * 身份判据用「时间 + 昵称 + 内容」而不是 cid：cid 按顺序生成，
 * 候选集合一变就全错位，靠它认人会张冠李戴。
 *
 * @returns {{items: object[], 保留: number}}
 */
export function 合并候选 (旧items, 新候选) {
  const 旧表 = new Map()
  for (const it of 旧items || []) {
    旧表.set(`${it.时间}|${it.昵称}|${it.内容}`, it)
  }
  let 保留 = 0
  const items = 新候选.map((c, i) => {
    const key = `${c.时间}|${c.昵称}|${c.内容}`
    const 旧 = 旧表.get(key)
    if (旧 && 旧.状态 && 旧.状态 !== 候选状态.待定) {
      保留++
      return {
        cid: `c${i + 1}`,
        时间: c.时间,
        昵称: c.昵称,
        内容: c.内容,
        命中: c.命中 || [],
        状态: 旧.状态,
        条目id: 旧.条目id || '',
      }
    }
    return {
      cid: `c${i + 1}`,
      时间: c.时间,
      昵称: c.昵称,
      内容: c.内容,
      命中: c.命中 || [],
      状态: 候选状态.待定,
      条目id: '',
    }
  })
  return { items, 保留 }
}

// ── 阅读进度书签 ──────────────────────────────────────────────────────────

/** 书签里的日期只认 YYYY-MM-DD 或空串（空串 = 没有进度）。 */
function 合法书签日期 (s) {
  return s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/**
 * 读某来源的书签。绝不抛异常：文件不存在、JSON 坏了、lastDate 形状不对，
 * 都一律当成「没有进度」返回 { lastDate: '' } ——
 * 书签只是阅读位置，坏了就该从头看，不值得让整个插件报错。
 *
 * 每个来源各有自己的书签：你在私聊日记里读到第 3 页，切到群里不该跳页。
 */
export async function 读书签 (rootDir, 来源) {
  try {
    const v = await 读JSON(书签文件(rootDir, 来源))
    if (v && typeof v.lastDate === 'string' && 合法书签日期(v.lastDate)) {
      return { lastDate: v.lastDate }
    }
  } catch { /* 读JSON 本身不抛，这里兜住意料之外的情况 */ }
  return { lastDate: '' }
}

/**
 * 写某来源的书签。lastDate 必须是 YYYY-MM-DD 或空串，否则抛 Error ——
 * 在写入前拦住脏数据，比读回来再兜底更容易发现调用方的 bug。
 */
export async function 写书签 (rootDir, 来源, lastDate) {
  const key = 要来源(来源)
  const t = String(lastDate || '')
  if (!合法书签日期(t)) {
    throw new Error(`非法的书签日期：${lastDate}（必须是 YYYY-MM-DD 或空串）`)
  }
  // 跟 备好目录 同一套判据：父目录在 = 首次使用（可创建）；父目录不在 = 配置错误（报错）
  await 备好目录(rootDir, key)
  await 原子写(书签文件(rootDir, key), JSON.stringify({
    version: 1,
    来源: key,
    lastDate: t,
    updatedAt: new Date().toISOString(),
  }, null, 2))
  await 记下来源(rootDir, key)
}

// ── 老数据迁移 ────────────────────────────────────────────────────────────
//
// 0.2.x 早期版本把私聊和群聊混成一天一份，落在根目录的 entries/<日期>.json。
// 现在改成按来源分开后，那些文件既不该被当成「某个来源」读出来，也不该被删掉。
//
// 处理策略（保守优先）：
//   · 老文件里没有来源信息，**没法拆开还原**，所以整体归到「私聊」这个视角下 ——
//     私聊目录一定存在、也一定是用户最先会去看的那个；
//   · 只搬不删：搬完把原文件挪进 legacy/entries-<时间戳>/，留个原样备份，
//     用户将来想手工拆也能拆（数据丢了才叫真丢）；
//   · 幂等：没有老文件时什么都不做，重复调用安全；
//   · 老索引（根目录 index.json，v1）直接删掉 —— 它是派生物，
//     新索引会从搬过去的文件重建，留着只会误导。

/**
 * 老日记的「来源标签」→ 来源 key。
 *
 * ⚠️ 这段是 2026-11-03 主人纠正之后才写对的。经过见下，改之前务必读完：
 *
 * 【误判 1】我一开始以为老数据是「一天一个文件、不分来源」，没法拆。
 *   实际上每一条老日记的 tags 里就带着 `私聊` 或 `群聊`，
 *   47 条全部有标签、且没有一条同时带两个 —— **完全可以无损拆开**。
 *
 * 【误判 2】老文件名看着像「已经分好了两个文件」，其实不是。
 *   entries/<日期>.json 是一天一个，私聊和群聊的条目都塞在这一个文件里，
 *   靠 tags[0] 区分。所以「分了两个文件」说的是 tag，不是文件。
 *
 * 老版本的条目长这样（2026-10-29 ~ 11-04 的 6 天数据）：
 *   { id, title, text, tags: ['群聊', 'ds深潜', '端饭'], at }
 *                                       ↑ 第一个元素就是来源
 *
 * 现在的规则：tags 里**恰好一个**来源标签就按它归；
 * 一个都没有、或两个都有（理论上不该发生）的条目，归到私聊并记一条告警 ——
 * 宁可让人事后能查到「这条是我猜的」，也不要静默扔掉或静默塞错。
 */

/** 老条目的标签 → 来源。认不出返回 ''。 */
function 标签定来源 (tags) {
  if (!Array.isArray(tags)) return ''
  const 有私聊 = tags.includes('私聊')
  const 有群聊 = tags.includes('群聊')
  if (有私聊 && !有群聊) return 私聊
  if (有群聊 && !有私聊) return '群聊' // 只表示"这是群聊的"，还不是具体群号
  return ''
}

/**
 * 把老版本「一天一份、靠 tags 区分来源」的数据拆回各来源。
 *
 * 【为什么群聊没法拆回具体是哪个群】
 *   老条目只有 `群聊` 这个标签，**没有记是哪个群**。所以群里的事只能归到一个
 *   统一的群聊视角。如果当时只接过一个群，那它就是准确的；
 *   如果接过多个群，就分不出是哪一个人——这部分信息天然丢了，不是实现偷懒。
 *   归到哪个具体群号由调用方决定（见 routes.js 里挑「第一个群」的说明）。
 *
 * 【为什么不删原件】
 *   先复制到 legacy/entries-<时间戳>/，再从 entries/ 根下删。备份是原样字节，
 *   将来还能人工复核「当初到底有没有拆错」。
 *
 * @param {string} rootDir 日记库根目录
 * @param {{ 群来源?: string }} [选项] 群聊条目归到哪个来源（'group:<群号>'）；
 *   不传或非法时，群聊条目会**跳过不搬**，留给下次（而不是猜一个）。
 * @returns {Promise<{搬了: number, 私聊条: number, 群聊条: number, 跳过: string[],
 *   猜过来源: string[], 备份目录: string}>}
 */
export async function 迁移老数据 (rootDir, 选项 = {}) {
  const 老目录 = 库根(rootDir, 'entries')
  let names = []
  try {
    names = await readdir(老目录)
  } catch {
    return { 搬了: 0, 私聊条: 0, 群聊条: 0, 跳过: [], 猜过来源: [], 备份目录: '', 有群聊没去处: false }
  }
  // 老文件 = 根 entries/ 下直接是 YYYY-MM-DD.json；
  // 新结构的 entries/ 里只有来源目录，不会匹配到这个形状
  const 老文件们 = names.filter((n) => /^(\d{4}-\d{2}-\d{2})\.json$/.test(n)).sort()
  if (老文件们.length === 0) {
    // 没有老数据，但老索引可能还留着（v1），一并清掉免得被误读
    await rm(库根(rootDir, 'index.json'), { force: true })
    return { 搬了: 0, 私聊条: 0, 群聊条: 0, 跳过: [], 猜过来源: [], 备份目录: '', 有群聊没去处: false }
  }

  const 群来源 = 校验来源(选项.群来源)
  const 时间戳 = new Date().toISOString().replace(/[:.]/g, '-')
  const 备份目录 = 库根(rootDir, 'legacy', `entries-${时间戳}`)
  await mkdir(备份目录, { recursive: true })
  // 先把整体备份一份（复制），再往新结构里写。
  // 为什么不直接 rename：rename 到新位置后老文件就没了，
  // 万一写新结构中途失败，两边都不完整。先复制、后删原件更稳。
  for (const n of 老文件们) {
    const raw = await readFile(path.join(老目录, n), 'utf8')
    await writeFile(path.join(备份目录, n), raw, 'utf8')
  }

  await 备好目录(rootDir, 私聊)
  const 跳过 = []
  const 猜过来源 = [] // 没有可辨认来源标签、被归到私聊的条目正文（供人工复核）
  const 按来源 = new Map() // 来源 key → { 日期 → 条目数组 }
  let 私聊条 = 0
  let 群聊条 = 0
  // 老文件里有群聊条目、但这次没给出群来源 → 老文件不能删，留着下次再搬
  let 有群聊没去处 = false

  for (const n of 老文件们) {
    const date = n.slice(0, 10)
    const v = await 读JSON(path.join(老目录, n))
    if (!v || !Array.isArray(v.entries)) { 跳过.push(date); continue }

    for (const e of v.entries) {
      if (!e || typeof e.text !== 'string') continue
      const 标 = 标签定来源(e.tags)
      let 目标 = ''
      if (标 === 私聊) 目标 = 私聊
      else if (标 === '群聊') {
        // 群聊条目：没有具体群号时跳过不搬（宁可留到下次，也不猜）
        if (!群来源) { 有群聊没去处 = true; continue }
        目标 = 群来源
      } else {
        // 认不出来源：归私聊，但记下来让人能查
        目标 = 私聊
        猜过来源.push(`${date} ${e.id || ''}: ${e.text.slice(0, 40)}`)
      }
      if (!按来源.has(目标)) 按来源.set(目标, new Map())
      按来源.get(目标).set(date, [...(按来源.get(目标).get(date) || []), e])
    }
  }

  let 搬了 = 0
  for (const [key, 按天] of 按来源) {
    await 备好目录(rootDir, key)
    for (const [date, 条们] of 按天) {
      // 目标已有数据 → 不覆盖（用户可能已经在新结构下重写过这一天）
      const 已有 = await 读某天(rootDir, key, date)
      if (已有.length > 0) { 跳过.push(`${date}@${key}`); continue }
      await 写某天(rootDir, key, date, 条们)
      搬了++
      if (key === 私聊) 私聊条 += 条们.length
      else 群聊条 += 条们.length
    }
  }

  // 搬完从 entries/ 根下删掉原件（备份里还有一份），否则下次启动会重复搬。
  // ⚠️ 有群聊条目却没给出群来源时**不删**：否则那些群聊条目就永久丢了。
  if (!有群聊没去处) {
    for (const n of 老文件们) {
      await rm(path.join(老目录, n), { force: true })
    }
    // 老索引是 v1、不分来源，已无用且会误导，删掉
    await rm(库根(rootDir, 'index.json'), { force: true })
  }

  // 搬完重建索引，把搬进来的条目登记进去
  for (const key of 按来源.keys()) {
    const r = await 重建(rootDir, key)
    await 写索引(rootDir, key, r.index)
  }

  return { 搬了, 私聊条, 群聊条, 跳过, 猜过来源, 备份目录, 有群聊没去处 }
}

/**
 * 修复「早期迁移把群聊条目塞进了私聊」的数据。
 *
 * 【为什么需要这个】
 *   2026-11-03 第一版迁移误判成「老数据没有来源信息」，把 6 天老日记**整份**
 *   写进了 entries/private/。实际上每条都带 `私聊`/`群聊` 标签，
 *   所以私聊那一本里混进了 34 条群聊内容。这个函数把它们挑出来挪回去。
 *
 * 【怎么判断哪些条目该挪走】
 *   只认 tags 里**恰好**有 `群聊`、且没有 `私聊` 的条目。这条判据和老迁移
 *   用的是同一个函数（标签定来源），所以「当初搬进去的」和「现在挪出来的」
 *   口径一致，不会挪错或漏挪。
 *
 * 【为什么只动私聊那一本】
 *   早期迁移只往私聊写过，别的来源都是新结构之后才有的，一定是干净的。
 *   缩小改动范围 = 少一分误伤的可能。
 *
 * @param {string} rootDir 日记库根目录
 * @param {{ 群来源: string, 样式?: boolean }} 选项 群聊条目挪到哪个来源（必须是 group:<群号>）
 * @returns {Promise<{挪了: number, 日期: string[], 群来源: string}>}
 */
export async function 修复误迁的群聊 (rootDir, { 群来源 } = {}) {
  const key = 校验来源(群来源)
  if (!校验来源(群来源) || 是私聊(key)) {
    throw new Error(`群来源必须是 group:<群号>，收到：${String(群来源)}`)
  }
  const 日期们 = await 列出日期(rootDir, 私聊)
  let 挪了 = 0
  const 动过 = []
  for (const date of 日期们) {
    const 私聊条们 = await 读某天(rootDir, 私聊, date)
    const 该走 = 私聊条们.filter((e) => 标签定来源(e.tags) === '群聊')
    if (该走.length === 0) continue
    const 留下 = 私聊条们.filter((e) => 标签定来源(e.tags) !== '群聊')

    // 先写目标来源（幂等：同 id 已存在就不重复加）
    const 已有群 = await 读某天(rootDir, key, date)
    const 已有id = new Set(已有群.map((e) => e.id))
    const 要加 = 该走.filter((e) => !已有id.has(e.id))
    await 写某天(rootDir, key, date, [...已有群, ...要加])
    // 再改私聊那一本
    await 写某天(rootDir, 私聊, date, 留下)

    挪了 += 该走.length
    动过.push(date)
  }
  // 两本都重建一次索引
  if (动过.length > 0) {
    for (const k of [私聊, key]) {
      const r = await 重建(rootDir, k)
      await 写索引(rootDir, k, r.index)
    }
  }
  return { 挪了, 日期: 动过, 群来源: key }
}

/**
 * 找出「还没归属到具体群的」老日记条目。
 *
 * 【为什么需要这个】
 *   老条目只有 `群聊` 标签、没有群号。迁移时如果仓库里有多个群，
 *   这些条目会被留在原地（见 迁移老数据 的 `有群聊没去处`）。
 *   这个函数把它们列出来，让人看清楚「到底有多少条在等归属、都说了啥」，
 *   再决定归到哪个群 —— 而不是让程序去猜。
 *
 * 【从哪两个地方找】
 *   1. `entries/<日期>.json`  —— 迁移还没动过的老文件
 *   2. `entries/private/`     —— 早期误迁进私聊的那部分
 *   两处都要看：只查一处会漏掉另一处，用户会以为「已经搬完了」。
 *
 * @returns {Promise<{总数: number, 天数: number, 待归属: Array<{日期,来源文件,id,text,tags}>}>}
 */
export async function 列出待归属老条目 (rootDir) {
  const 出 = []
  const 老目录 = 库根(rootDir, 'entries')
  // 1) 老文件（一天一个，躺在 entries/ 根下）
  let names = []
  try { names = await readdir(老目录) } catch { names = [] }
  for (const n of names.filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    const v = await 读JSON(path.join(老目录, n))
    if (!v || !Array.isArray(v.entries)) continue
    for (const e of v.entries) {
      if (!e || typeof e.text !== 'string') continue
      if (标签定来源(e.tags) === '群聊') {
        出.push({ 日期: n.slice(0, 10), 来源文件: `entries/${n}`, id: e.id || '', text: e.text, tags: e.tags || [] })
      }
    }
  }
  // 2) 误迁进私聊的
  for (const date of await 列出日期(rootDir, 私聊)) {
    for (const e of await 读某天(rootDir, 私聊, date)) {
      if (标签定来源(e.tags) === '群聊') {
        出.push({ 日期: date, 来源文件: 'entries/private/', id: e.id || '', text: e.text, tags: e.tags || [] })
      }
    }
  }
  return {
    总数: 出.length,
    天数: new Set(出.map((x) => x.日期)).size,
    待归属: 出,
  }
}

/**
 * 按「群昵称」把待归属的群聊老日记分到各个群。
 *
 * 【依据是什么】
 *   拿老条目 tags 里的人名，去每个群**当前**的成员昵称名单里查：
 *   命中的群加分，最高分的群就是它的归属。
 *
 * 【为什么这个办法只能当线索、不能当真】
 *   2026-11-03 实测：34 条里只有 1 条能匹配上（冥月请风）。
 *   原因是老日记里的昵称是**当时**的，很多人后来退群或改名了：
 *   灰狐、ds深潜、游龙潜吟、路西法、梁圣、放假dog、廾匸 现在都查无此人。
 *
 *   所以本函数**必须**区分三档，不能把低分也当成确定答案：
 *     · 能定   —— 只有一个群有命中，且明显高于其他群
 *     · 判不了 —— 两个群都命中（或都没命中）
 *     · 无依据 —— tags 里一个人名都没匹配上
 *   调用方可以只采纳「能定」的那些，其余交给人。
 *
 * @param {Array} 待归属 列出待归属老条目() 的结果
 * @param {Object<string, string[]>} 群成员 来源 key → 该群成员昵称数组
 * @returns {Array<{日期, id, text, 判定, 依据, 命中: Object, 归属: string}>}
 *   判定是 '能定' / '判不了' / '无依据' 之一；归属只在 '能定' 时非空。
 */
export function 按昵称猜归属 (待归属, 群成员) {
  const 群们 = Object.entries(群成员 || {}).filter(([k]) => 校验来源(k) && !是私聊(k))
  return (待归属 || []).map((x) => {
    // 去掉来源标签和明显的非人名
    const 候选 = (x.tags || []).filter((t) => t && t !== '群聊' && t !== '私聊' && t !== '-')
    const 命中 = {}
    for (const [key, 名单] of 群们) {
      const 集合 = new Set(Array.isArray(名单) ? 名单 : [])
      命中[key] = 候选.filter((t) => 集合.has(t))
    }
    const 有命中的群 = Object.entries(命中).filter(([, v]) => v.length > 0)
    if (有命中的群.length === 0) {
      return { ...x, 判定: '无依据', 依据: 'tags 里的人名在两个群都查不到', 命中, 归属: '' }
    }
    if (有命中的群.length > 1) {
      const 描述 = 有命中的群.map(([k, v]) => `${来源标签(k)}命中 ${v.join('、')}`).join('；')
      return { ...x, 判定: '判不了', 依据: `多个群都有命中：${描述}`, 命中, 归属: '' }
    }
    const [key, 名单] = 有命中的群[0]
    return {
      ...x,
      判定: '能定',
      依据: `${来源标签(key)}里能找到：${名单.join('、')}`,
      命中,
      归属: key,
    }
  })
}

/**
 * 把指定的几批老条目归到指定群（按 `{日期, id}` 精确挑，不靠猜）。
 *
 * 与 修复误迁的群聊 的区别：那个是「所有群聊标签的条目一起挪」，
 * 这个是「只挪点名的这几条」—— 按昵称分群时，能定的和判不了的混在一起，
 * 只能挪能定的那些。
 *
 * 条目可能来自两处（老文件 / 误迁进私聊的），两处都找：
 * 找到就搬到目标群，并把私聊那本里的同 id 删掉（如果是误迁过去的）。
 *
 * @param {string} rootDir 日记库根目录
 * @param {string} 目标群 group:<群号>
 * @param {Array<{日期:string, id:string}>} 清单 要归的条目
 * @returns {Promise<{归入: number, 没找到: Array}>}
 */
export async function 归到指定群 (rootDir, 目标群, 清单) {
  const key = 校验来源(目标群)
  if (!key || 是私聊(key)) throw new Error(`目标群必须是 group:<群号>，收到：${String(目标群)}`)
  const 要 = new Map() // 日期 → Set(id)
  for (const x of 清单 || []) {
    if (!x || !x.日期 || !x.id) continue
    if (!要.has(x.日期)) 要.set(x.日期, new Set())
    要.get(x.日期).add(x.id)
  }
  let 归入 = 0
  const 没找到 = []
  const 动过 = new Set()

  for (const [date, id集] of 要) {
    const 目标们 = await 读某天(rootDir, key, date)
    const 已有id = new Set(目标们.map((e) => e.id))
    const 新加 = []
    const 搬走 = (e) => {
      if (!已有id.has(e.id)) { 新加.push(e); 已有id.add(e.id) }
    }

    // 1) 从私聊那本里找（早期误迁过去的）
    const 私聊条们 = await 读某天(rootDir, 私聊, date)
    const 从私聊拿 = 私聊条们.filter((e) => id集.has(e.id))
    if (从私聊拿.length > 0) {
      从私聊拿.forEach(搬走)
      await 写某天(rootDir, 私聊, date, 私聊条们.filter((e) => !id集.has(e.id)))
      动过.add(私聊)
    }

    // 2) 从老文件里找。老文件可能还装着别的没归位的条目 ——
    //    只把点名的摘掉，剩下的原样留着；摘空了才删文件。
    const 老文件 = 库根(rootDir, 'entries', `${date}.json`)
    const 老 = await 读JSON(老文件)
    if (老 && Array.isArray(老.entries)) {
      const 命中 = 老.entries.filter((e) => e && id集.has(e.id))
      if (命中.length > 0) {
        命中.forEach(搬走)
        const 剩 = 老.entries.filter((e) => !(e && id集.has(e.id)))
        if (剩.length > 0) {
          await 原子写(老文件, JSON.stringify({ ...老, entries: 剩 }, null, 2))
        } else {
          await rm(老文件, { force: true })
        }
      }
    }

    if (新加.length > 0) {
      await 写某天(rootDir, key, date, [...目标们, ...新加])
      动过.add(key)
      归入 += 新加.length
    }
    // 一条都没找到的（哪儿都没有、或本来就在目标群）如实报出来
    for (const id of id集) {
      if (!已有id.has(id)) 没找到.push({ 日期: date, id })
    }
  }

  for (const k of 动过) {
    const r = await 重建(rootDir, k)
    await 写索引(rootDir, k, r.index)
  }
  return { 归入, 没找到 }
}

/** 读 JSON 数组工具的上层导出（routes 概览要用），保留以免调用方自己拼路径。 */
export { 读JSON数组 as 读数组文件 }

/** 索引版本导出：路由与测试要断言「读到的索引是当前版本」。 */
export const 当前索引版本 = 索引版本
