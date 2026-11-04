// ============================================================================
// index.js —— 插件入口：解析配置目录、注册 5 个工具、注册 8 条 UI 路由
//
// 【这个模块负责什么】
//   宿主 loader 加载本包时调用 apply(ctx, config)，做三件事：
//     1. 解析配置：日记库根目录（config.rootDir / DIARY_HOME / 默认 ~/.dsh/xiaoyu-diary）
//        与记忆仓库根目录（config.vaultDir / VAULT_HOME / 默认 ~/.dsh/memory-vault）
//     2. 注册 5 个 DSH 原生工具（xiaoyu_diary_write / search / read / list / extract）
//     3. 注册 8 条 UI HTTP 路由（/local/xiaoyu-diary/*），挂在 ctx.webServer 上
//
// 【为什么这样设计】
//   · webServer 必须写进 inject（见 export const inject）：cordis 在没有声明 inject
//     的情况下访问 ctx.webServer 会直接抛 "cannot get property "webServer" without
//     inject"，路由一条都注册不上，且这个错只在真正启动服务时才暴露，配置树看不出来。
//   · inject 是强制清单：列在其中的服务缺失时整个插件都不会 apply。所以路由层
//     （routes.js）自己再判一次 webServer 是否可用，是防「服务在但 register 方法
//     没有」，不是防 inject。
//   · dsh-tools 的解析基准写死多个目录（本目录 / cwd / /opt/dshapp/runtime /
//     /usr/lib/node_modules 等）：本包随 profile 复制进沙盒，而 dsh-tools 装在
//     dsh 自己的 runtime 树里，两棵目录树谁也不包着谁，只从本文件位置解析
//     必然 MODULE_NOT_FOUND。process.argv[1] 在被当库调用时指向调用方脚本，
//     拿它当唯一基准会全部落空（踩过）。
//   · 拿不到 defineTool 时只向 stderr 报一句并返回，不抛异常：装载失败不该
//     拖垮整个 dsh 进程；UI 路由与工具是两条独立通路，路由挂了不连带工具。
//
// 【对外导出】
//   · name —— 包名常量 '@local/xiaoyu-diary'
//   · inject —— 宿主服务清单 ['tools', 'webServer']
//   · 取日记目录(config) —— 解析日记库根目录（config → env → 默认）
//   · 取仓库目录(config) —— 解析记忆仓库根目录（config → env → 默认）
//   · registerTools(defineTool, ctx, config) —— 注册 5 个工具，返回注册数
//   · apply(ctx, config) —— 入口：注册路由 + 取 defineTool + 注册工具
//   · acquireDefineTool() —— 多基准目录解析 dsh-tools，返回 { defineTool, stage, ... }
// ============================================================================
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { buildTools } from './tools.js'
import { 注册路由 } from './routes.js'

/** Stable cordis plugin name - must equal the package name. */
export const name = '@local/xiaoyu-diary'

/**
 * 需要 tools 服务（注册工具）与 webServer 服务（挂 UI 路由）。
 *
 * ⚠️ webServer 必须写进 inject：cordis 在没有声明 inject 的情况下访问
 *    `ctx.webServer` 会直接抛 “cannot get property "webServer" without inject”，
 *    路由一条都注册不上 —— 这个错只在真正启动服务时才暴露，配置树看不出来。
 *
 * 注意 cordis 的 inject 是**强制清单**，没有「可选」写法：列在这里的服务缺失时
 * 整个插件都不会 apply。所以路由层自己再判一次 webServer 是否可用（见 routes.js），
 * 那是为了防「服务在但 register 方法没有」，不是防 inject。
 */
export const inject = ['tools', 'webServer']

/** dsh 侧 tools 模块的包名。 */
const TOOLS_MODULE = '@deepseek-ai/dsh-tools'

const 未找到 = '未找到 dsh-tools，日记工具未注册'

/** 本文件在 ESM 下没有 __dirname，自己算一个。 */
const 本目录 = path.dirname(new URL(import.meta.url).pathname)

/**
 * `require.resolve` 的候选基准目录。
 *
 * 本包随 profile 复制进沙盒，而 dsh-tools 装在 dsh 自己的 runtime 树里：
 * 两棵目录树谁也不包着谁，只从本文件位置解析必然 MODULE_NOT_FOUND。
 *
 * 除了自身与 cwd，还要显式覆盖 dsh 运行时的几个已知安装点：
 *   · /opt/dshapp/runtime/node_modules       —— 本机 dsh 的实际位置；
 *   · /usr/lib/node_modules                  —— 云端全局安装位置；
 *   · /usr/lib/node_modules/@deepseek-ai/dsh/node_modules
 *                                            —— 云端 tarball 安装把依赖嵌在 dsh 包内部，
 *                                               这一档是实测出来的（云端测试曾整批失败）。
 * 写死是刻意的：`process.argv[1]` 在「被当库调用」「用脚本冒烟」时指向调用方脚本，
 * 拿它当唯一基准会全部落空（这个坑踩过）。
 */
function resolveBases () {
  const bases = [
    本目录,
    process.cwd(),
    '/opt/dshapp/runtime/node_modules',
    '/opt/dshapp/runtime/node_modules/.bin',
    '/usr/lib/node_modules',
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules',
    '/usr/local/lib/node_modules',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules',
  ]
  if (process.argv[1]) bases.push(path.dirname(process.argv[1]))
  if (process.execPath) bases.push(path.dirname(process.execPath))
  return [...new Set(bases)].filter((p) => typeof p === 'string' && p.length > 0)
}

/** 取 defineTool，返回 { defineTool, stage, resolvedPaths, attempts }。 */
function acquireDefineTool () {
  const req = createRequire(import.meta.url)
  const attempts = []
  const resolvedPaths = []
  for (const base of resolveBases()) {
    let resolvedPath = null
    try {
      resolvedPath = req.resolve(TOOLS_MODULE, { paths: [base] })
    } catch (error) {
      attempts.push({ base, stage: 'resolve', code: error && error.code })
      continue
    }
    resolvedPaths.push(resolvedPath)
    try {
      const defineTool = req(resolvedPath).defineTool
      if (typeof defineTool === 'function') {
        return { defineTool, stage: 'require', resolvedPath, resolvedPaths, attempts }
      }
      attempts.push({ base, stage: 'shape', resolvedPath })
    } catch (error) {
      attempts.push({ base, stage: 'require', resolvedPath, code: error && error.code })
    }
  }
  return { defineTool: null, stage: 'resolve', resolvedPaths, attempts }
}

/** require 走不通时按已解析到的绝对路径动态 import。 */
async function importDefineTool (resolvedPaths) {
  for (const resolvedPath of [...new Set(resolvedPaths || [])]) {
    try {
      const mod = await import(pathToFileURL(resolvedPath).href)
      if (typeof mod.defineTool === 'function') return { defineTool: mod.defineTool, via: resolvedPath }
    } catch {
      // 下一条
    }
  }
  return { defineTool: null }
}

function report (message) {
  try {
    process.stderr.write(`${name}: ${message}\n`)
  } catch {
    // 无控制台时放弃报告
  }
}

/** 把开头的 ~ 展开成 home。 */
function 展开 (p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * 日记库根目录。
 *
 * 优先级：config.rootDir → 环境变量 DIARY_HOME → ~/.dsh/diary。
 * 默认放 ~/.dsh/diary 而不是工作区：日记是私事，不该混在代码仓库里被误提交。
 */
export function 取日记目录 (config) {
  if (config && typeof config.rootDir === 'string' && config.rootDir.trim()) {
    return 展开(config.rootDir.trim())
  }
  if (process.env.DIARY_HOME && process.env.DIARY_HOME.trim()) {
    return 展开(process.env.DIARY_HOME.trim())
  }
  return path.join(os.homedir(), '.dsh', 'xiaoyu-diary')
}

/**
 * 记忆仓库根目录（只读）。默认 ~/.dsh/memory-vault，
 * 与本机既有部署一致；找不到时 xiaoyu_diary_extract 会如实报「没有记录」而不是编。
 */
export function 取仓库目录 (config) {
  if (config && typeof config.vaultDir === 'string' && config.vaultDir.trim()) {
    return 展开(config.vaultDir.trim())
  }
  if (process.env.VAULT_HOME && process.env.VAULT_HOME.trim()) {
    return 展开(process.env.VAULT_HOME.trim())
  }
  return path.join(os.homedir(), '.dsh', 'memory-vault')
}

/** 逐项注册；第 N 项失败时点名已注册的几项，不吞掉。 */
export function registerTools (defineTool, ctx, config) {
  const tools = buildTools({
    defineTool,
    rootDir: () => 取日记目录(config),
    vaultDir: () => 取仓库目录(config),
    // config 要传进去：时区、日记日起点小时都从这儿读。
    // 漏传不会报错，只会静默用默认值 —— 云端机器是 UTC，
    // 那样早上 8 点前记的东西会算错天，而且看起来一切正常。
    config,
  })
  const registered = []
  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      report(
        `PARTIAL_REGISTRATION: registered=[${registered.join(', ')}] failed=${tool.name} (${(error && error.message) || error})`,
      )
      return registered.length
    }
    registered.push(tool.name)
  }
  return registered.length
}

export function apply (ctx, config) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    report('宿主未提供 tools 服务，日记工具未注册')
    return undefined
  }
  // UI 路由与工具是两条独立通路：路由挂了不该连带工具注册不上
  try {
    注册路由(ctx, {
      rootDir: () => 取日记目录(config),
      vaultDir: () => 取仓库目录(config),
      log: report,
    })
  } catch (error) {
    report(`UI 路由注册抛错（工具不受影响）：${(error && error.message) || error}`)
  }
  const acquired = acquireDefineTool()
  if (acquired.defineTool) {
    registerTools(acquired.defineTool, ctx, config)
    return undefined
  }
  return importDefineTool(acquired.resolvedPaths).then((loaded) => {
    if (!loaded.defineTool) {
      report(`${未找到}（已试过 ${acquired.attempts.length} 个基准目录）`)
      return undefined
    }
    registerTools(loaded.defineTool, ctx, config)
    return undefined
  })
}

export { acquireDefineTool }
