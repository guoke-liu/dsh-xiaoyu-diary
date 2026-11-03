// ============================================================================
// settings.js —— LLM 配置的读写（lib/llm.js 的配置层）
//
// 【这个模块负责什么】
//   把 llm.js 需要的 { baseURL, apiKey, model, 额外参数, 每批行数, timeoutMs }
//   持久化到 <rootDir>/llm.json，并提供脱敏出口，供 UI 路由与模型工具使用。
//
//   配置文件位置是日记库根目录（rootDir）下的 llm.json —— 不放系统目录：
//   用户换机器迁移时跟日记一起走，也方便删库时一键清掉密钥。
//
// 【为什么这样设计】
//   1. 密钥安全是第一优先级：llm.json 里存着 apiKey，所以
//      · 写出来的文件 chmod 600（owner 读写，其他用户无权限）；
//      · 任何函数（包括错误信息）都不得把 apiKey 原文带出去。
//
//   2. 读配置绝不抛：文件不存在、JSON 损坏、字段类型错，一律返回空结构。
//      配置只是「有没有」的问题，不是「崩不崩」的问题 —— 调用方（工具/路由）
//      拿到空配置后自己报「配置不完整」就行，不该把配置层异常炸到调用链顶端。
//
//   3. 写配置用原子写（先 .tmp 再 rename），跟 store.js 里的 原子写 写法一致：
//      写一半断电不会留下半个 JSON。但**不 import store.js 的私有函数**
//      （原子写 没导出，且 settings.js 不该依赖 store.js 的内部实现），
//      自己在本文件实现一份小的。
//
//   4. 写配置只做局部更新：传入什么字段改什么字段，没传的保留原值。
//      这对 API key 很关键 —— UI 展示的是脱敏值 ***，用户没改 key 时
//      提交的 body 里 apiKey 是空串或 ***，绝不能把存好的真 key 冲掉。
//      （「保留」的判定逻辑放在 routes.js 的 POST 处理器里做，本文件只按
//      传入值合并；routes 会保证不传 *** 进来。）
//
// 【对外导出】
//   · 读配置(rootDir) —— 读 llm.json，不存在/损坏返回空结构（绝不抛）
//   · 写配置(rootDir, 部分) —— 局部更新并原子写，chmod 600
//   · 配置是否完整(配置) —— { ok, 缺:[...] }，校验 baseURL/apiKey/model
//   · 脱敏配置(配置) —— 副本，apiKey 换成 '***'（有值）或 ''（没值）
//
// 【环境】Node ≥ 20，ESM，零第三方依赖。
// 【许可】MIT，见根目录 LICENSE。
// ============================================================================

import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 配置文件名。 */
const 文件名 = 'llm.json'

/** 配置文件结构版本。 */
const 配置版本 = 1

/** 默认每批行数，与 llm.js 的默认值保持一致。 */
const 默认每批行数 = 400

/** 默认单批超时（毫秒）。 */
const 默认超时毫秒 = 120000

/** 空配置骨架：所有字段都给出安全默认值。 */
function 空配置 () {
  return {
    version: 配置版本,
    baseURL: '',
    apiKey: '',
    model: '',
    额外参数: {},
    每批行数: 默认每批行数,
    timeoutMs: 默认超时毫秒,
  }
}

/** 配置文件在 rootDir 下的路径。 */
function 配置路径 (rootDir) {
  return path.join(String(rootDir || ''), 文件名)
}

/** 把读出来的未知 JSON 值归一成配置对象；字段缺失/类型错都回填默认值。 */
function 归一 (v) {
  const 基 = 空配置()
  if (!v || typeof v !== 'object') return 基
  基.baseURL = typeof v.baseURL === 'string' ? v.baseURL : ''
  基.apiKey = typeof v.apiKey === 'string' ? v.apiKey : ''
  基.model = typeof v.model === 'string' ? v.model : ''
  基.额外参数 = v.额外参数 && typeof v.额外参数 === 'object' && !Array.isArray(v.额外参数)
    ? v.额外参数
    : {}
  const n1 = Number(v.每批行数)
  基.每批行数 = Number.isFinite(n1) && n1 > 0 ? Math.floor(n1) : 默认每批行数
  const n2 = Number(v.timeoutMs)
  基.timeoutMs = Number.isFinite(n2) && n2 > 0 ? Math.floor(n2) : 默认超时毫秒
  return 基
}

/** 目录是否存在。 */
async function 目录在 (p) {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 读配置。
 *
 * 不存在、目录不在、JSON 损坏、根类型不对 —— 全部返回空配置，绝不抛。
 *
 * @param {string} rootDir 日记库根目录
 * @returns {Promise<object>} 归一后的配置（apiKey 是原文，展示前必须过 脱敏配置）
 */
export async function 读配置 (rootDir) {
  try {
    const raw = await readFile(配置路径(rootDir), 'utf8')
    return 归一(JSON.parse(raw))
  } catch {
    // 文件不存在 / 读失败 / JSON 坏了：一律当空配置
    return 空配置()
  }
}

/**
 * 写配置：局部更新 + 原子写（先 .tmp 再 rename）+ chmod 600。
 *
 * 传入 部分 里出现的**可写字段**才覆盖现值，没传的保留读回来的值 ——
 * 这样「只改 model」不会把 baseURL/apiKey 冲没。
 * rootDir 可能还没建（全新安装）：先备好父目录再写。
 * chmod 600 的原因：文件里有 apiKey，默认 umask 下其他用户可能可读。
 *
 * @param {string} rootDir 日记库根目录
 * @param {object} 部分 要更新的字段子集（baseURL/apiKey/model/额外参数/每批行数/timeoutMs）
 * @returns {Promise<object>} 写回后的完整配置（apiKey 是原文，展示前必须脱敏）
 */
export async function 写配置 (rootDir, 部分) {
  const 当前 = await 读配置(rootDir)
  if (部分 && typeof 部分 === 'object') {
    if (typeof 部分.baseURL === 'string') 当前.baseURL = 部分.baseURL
    // apiKey 允许写空串（用户想清空）；非字符串一律不收
    if (typeof 部分.apiKey === 'string') 当前.apiKey = 部分.apiKey
    if (typeof 部分.model === 'string') 当前.model = 部分.model
    if (部分.额外参数 && typeof 部分.额外参数 === 'object' && !Array.isArray(部分.额外参数)) {
      当前.额外参数 = 部分.额外参数
    }
    const n1 = Number(部分.每批行数)
    if (Number.isFinite(n1) && n1 > 0) 当前.每批行数 = Math.floor(n1)
    const n2 = Number(部分.timeoutMs)
    if (Number.isFinite(n2) && n2 > 0) 当前.timeoutMs = Math.floor(n2)
  }
  当前.version = 配置版本
  // 原子写：写 .tmp 再 rename，写一半断电不会留下半个 JSON
  const file = 配置路径(rootDir)
  if (!(await 目录在(rootDir))) {
    await mkdir(rootDir, { recursive: true })
  }
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(当前, null, 2), 'utf8')
  try {
    await chmod(tmp, 0o600)
  } catch {
    // chmod 失败（某些文件系统不支持）不阻断主流程，文件本身已写入
  }
  await rename(tmp, file)
  return 当前
}

/**
 * 校验配置是否齐了（llm.js 的 缺失配置 同款判断，返回 UI 友好形状）。
 *
 * @param {object} [配置]
 * @returns {{ok: boolean, 缺: string[]}} 缺 = 缺的字段名列表（baseURL/apiKey/model 的子集）
 */
export function 配置是否完整 (配置) {
  const 检查项 = [
    ['baseURL', 配置 && 配置.baseURL],
    ['apiKey', 配置 && 配置.apiKey],
    ['model', 配置 && 配置.model],
  ]
  const 缺 = 检查项
    .filter(([, 值]) => 值 == null || String(值).trim() === '')
    .map(([名]) => 名)
  return { ok: 缺.length === 0, 缺 }
}

/**
 * 脱敏配置：返回一份**副本**，apiKey 替换为掩码。
 *
 * 规则：有值 → '***'（提示「这里有密钥，原文不展示」）；没值 → ''。
 * 绝不返回原值。任何要把配置展示给 UI 的路径都必须过这里。
 *
 * @param {object} [配置]
 * @returns {object} 脱敏后的配置副本
 */
export function 脱敏配置 (配置) {
  const v = 归一(配置)
  v.apiKey = v.apiKey !== '' ? '***' : ''
  return v
}
