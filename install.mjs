#!/usr/bin/env node
// ============================================================================
// install.mjs —— 把小鱼日记装进一个 DSH profile（Windows / macOS / Linux 通用）
//
// 用法：
//   node install.mjs               # 自动找 profile（只有一个时）
//   node install.mjs myprofile     # 指定 profile 名
//   node install.mjs --dry         # 只打印要做什么，不落盘
//
// 为什么有这一份：install.sh 要 bash，Windows 用户得先装 Git Bash / WSL 才能跑 ——
//   首次安装最烦的就是这个。改成 Node 之后，只要机器上有 DSH（必然有 Node ≥ 22），
//   三个系统一条命令都能装。install.sh 现在只是转调这里，保留是为了老习惯。
//
// 它做三件事，都是 DSH 官方的插件安装流程（不手工改配置树）：
//   1. 在 profile 的 package.json 里加一条 link: 依赖
//   2. 把插件名加进 dsh.profile.bundles
//   3. 跑 dsh plugin install，让 pnpm 建好链接
//
// ⚠️ 不要手写 cordis.patch.yml —— 本包自带 dsh.bundle.patch，
//    装依赖时 DSH 会自动应用，手加会重复注册。
// ⚠️ 装完要重启 DSH 才生效，但**重启会让当前会话中断**（这是预期）：
//    让人手动重启，或让 agent 把重启放到本轮之外，别在同一轮里等自己重启完。
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_NAME = '@local/xiaoyu-diary'
const HERE = dirname(fileURLToPath(import.meta.url))
const WIN = process.platform === 'win32'

const say = (s = '') => console.log(s)
const die = (s) => { console.error('❌ ' + s); process.exit(1) }

// ── 参数 ─────────────────────────────────────────────────────────────────
let dry = false
let profile = ''
for (const a of process.argv.slice(2)) {
  if (a === '--dry') dry = true
  else if (a === '-h' || a === '--help') {
    console.log('用法：node install.mjs [--dry] [profile]')
    process.exit(0)
  } else if (a.startsWith('-')) die(`未知参数：${a}`)
  else if (!profile) profile = a
  else die(`多给了参数：${a}（只接受一个 profile 名）`)
}

// ── Node 版本：本插件 engines 要 >= 22 ───────────────────────────────────
const major = Number(process.versions.node.split('.')[0])
if (major < 22) {
  die(`Node 版本太低：现在是 v${process.versions.node}，本插件要求 >= 22。升级 Node 后再跑一次。`)
}
say(`✅ node v${process.versions.node}`)

// ── 找 dsh ───────────────────────────────────────────────────────────────
function which(cmd) {
  const probe = spawnSync(WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' })
  if (probe.status !== 0) return ''
  const first = String(probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  return first || ''
}

function findDsh() {
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN
  const cands = [
    which('dsh'),
    join(homedir(), '.dsh', 'bin', WIN ? 'dsh.cmd' : 'dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
    '/opt/dshapp/runtime/node_modules/.bin/dsh',
  ].filter(Boolean)
  for (const c of cands) if (existsSync(c)) return c
  return ''
}

const dsh = findDsh()
if (!dsh) {
  die(`找不到 dsh 命令。请先安装 DeepSeek Harness，或把 dsh 加进 PATH。
   试过：PATH / DSH_BIN / ~/.dsh/bin / /usr/local/bin / /usr/bin / /opt/dshapp/runtime/node_modules/.bin
   实在找不到就设环境变量：DSH_BIN=/你的/dsh 路径 node install.mjs`)
}
say(`✅ dsh: ${dsh}`)

// ── 找 profile 目录 ──────────────────────────────────────────────────────
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILES_DIR = join(DSH_HOME, 'profiles')
if (!existsSync(PROFILES_DIR)) {
  die(`找不到 profile 目录：${PROFILES_DIR}
   （DSH_HOME 现在是 ${DSH_HOME}；装到别处就先把 DSH_HOME 指过去再跑）`)
}

if (!profile) {
  const cands = []
  const { readdirSync } = await import('node:fs')
  for (const d of readdirSync(PROFILES_DIR)) {
    if (existsSync(join(PROFILES_DIR, d, 'package.json'))) cands.push(d)
  }
  if (cands.length === 0) die(`在 ${PROFILES_DIR} 下没有任何 profile（没有带 package.json 的目录）`)
  if (cands.length === 1) { profile = cands[0]; say(`ℹ️  自动选中唯一的 profile：${profile}`) }
  else die(`有多个 profile，请指定一个：${cands.join(' ')}
   例如：node install.mjs ${cands[0]}`)
}

const PROFILE_DIR = join(PROFILES_DIR, profile)
if (!existsSync(join(PROFILE_DIR, 'package.json'))) die(`profile 不存在：${PROFILE_DIR}`)
say(`✅ profile: ${profile}  (${PROFILE_DIR})`)
say(`   插件将 link 到：${HERE}`)

if (dry) {
  say('')
  say('── --dry：只显示计划，不落盘 ──')
  say(`1. ${join(PROFILE_DIR, 'package.json')} 的 dependencies 里加 "${PKG_NAME}": "link:${HERE}"`)
  say(`2. 同文件的 dsh.profile.bundles 里加 "${PKG_NAME}"`)
  say(`3. 在 ${PROFILE_DIR} 跑：${dsh} plugin --profile ${profile} install`)
  say('4. 重启 DSH（这一步要人手动做，重启会中断当前会话）')
  process.exit(0)
}

// ── 改 package.json（先备份）─────────────────────────────────────────────
const pkgFile = join(PROFILE_DIR, 'package.json')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const bak = `${pkgFile}.bak-${stamp}`
copyFileSync(pkgFile, bak)
say(`✅ 已备份 package.json → ${bak.split(/[\\/]/).pop()}`)

try {
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  pkg.dependencies = pkg.dependencies || {}
  pkg.dependencies[PKG_NAME] = `link:${HERE}`
  pkg.dsh = pkg.dsh || {}
  pkg.dsh.profile = pkg.dsh.profile || {}
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
  if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) pkg.dsh.profile.bundles.push(PKG_NAME)
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
  say('   已写入 dependencies 与 dsh.profile.bundles')
} catch (e) {
  copyFileSync(bak, pkgFile)
  die(`改 package.json 失败（已还原）：${e.message}`)
}

// ── 确保 pnpm 可用 ───────────────────────────────────────────────────────
// DSH 的 plugin install 内部调用 pnpm。很多机器没单独装 pnpm，但有 corepack（Node 自带），
// 这时给一个临时 shim，装完就撤。Windows 要 .cmd，Linux/macOS 要可执行 shell 脚本。
let shimDir = ''
const cleanup = () => { if (shimDir) { try { rmSync(shimDir, { recursive: true, force: true }) } catch {} } }
process.on('exit', cleanup)

if (!which('pnpm')) {
  if (!which('corepack')) {
    copyFileSync(bak, pkgFile)
    die(`找不到 pnpm。请先装一个：
   npm i -g pnpm        （或）   corepack enable`)
  }
  shimDir = mkdtempSync(join(tmpdir(), 'dsh-pnpm-shim-'))
  if (WIN) {
    writeFileSync(join(shimDir, 'pnpm.cmd'), '@echo off\r\ncorepack pnpm %*\r\n')
  } else {
    const f = join(shimDir, 'pnpm')
    writeFileSync(f, '#!/bin/sh\nexec corepack pnpm "$@"\n')
    chmodSync(f, 0o755)
  }
  process.env.PATH = shimDir + (WIN ? ';' : ':') + process.env.PATH
  say('ℹ️  本机没有 pnpm，已用 corepack 临时顶替（装完自动撤掉）')
}

// ── 装依赖 ───────────────────────────────────────────────────────────────
say('')
say('▶ 正在安装依赖（可能会下载一些包，慢的话等一下）…')
const inst = spawnSync(dsh, ['plugin', '--profile', profile, 'install'], {
  cwd: PROFILE_DIR,
  stdio: 'inherit',
  shell: WIN,
})
if (inst.status !== 0) {
  copyFileSync(bak, pkgFile)
  die(`安装失败，已把 package.json 还原。
   排查：进 ${PROFILE_DIR} 手动跑一次 "${dsh} plugin --profile ${profile} install"，看完整报错。`)
}

// ── 验收：配置树里必须恰好出现 1 次 ──────────────────────────────────────
say('')
say('▶ 验收配置树…')
const dump = spawnSync(dsh, ['--profile', profile, '--dump-config'], { encoding: 'utf8', shell: WIN })
const out = `${dump.stdout || ''}${dump.stderr || ''}`
// ⚠️ 只数「条目头」`- id: <包名>`，不要数裸包名（注释 + id 行 + name 行会各出现一次，会误判重复注册）。
// ⚠️ id 有的带引号有的不带：`- id: '@local/xiaoyu-diary'` 与 `- id: dsh-memory-vault` 都要认。
const idRe = new RegExp(`^- id: ['"]?${PKG_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'm')
const cnt = (out.match(new RegExp(idRe.source, 'gm')) || []).length
const skip = out.split(/\r?\n/).filter((l) => l.includes('skipping profile bundle')).length
say(`   注册条目数：${cnt}  （应为 1，多于 1 说明被重复注册）`)
say(`   skipping 警告：${skip}  （应为 0）`)

if (cnt === 1 && skip === 0) {
  say('')
  say('🎉 装好了。还差最后一步：**重启 DSH**')
  say(`   重开 dsh ${profile}，或在服务里重启（systemd: systemctl restart <服务名>；Windows 计划任务/服务同理）`)
  say('')
  say('⚠️ 重启会让当前这个会话中断 —— 这是预期，不是装坏了。')
  say('   别让 agent 在同一轮里“重启 + 等结果”：等不到。让它先结束这一轮，下一轮再验证。')
  say('')
  say('装好后设置页会出现「小鱼日记」区块。第一次用先记一条：')
  say('   让 agent 调 xiaoyu_diary_write（来源 private），不传 date —— 目录会自动建，不用手工 mkdir。')
} else {
  say('')
  say('⚠️ 装上了但验收不通过。把上面两行数字贴给维护者。')
  say(`   回滚：cp "${bak}" "${pkgFile}" && cd "${PROFILE_DIR}" && "${dsh}" plugin --profile ${profile} install`)
  process.exit(1)
}
