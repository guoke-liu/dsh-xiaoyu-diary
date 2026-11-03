#!/usr/bin/env node
// ============================================================================
// tools/归属群聊.mjs —— 命令行：把「群聊」老日记归到指定的群
//
// 【为什么要有这个脚本】
//   老日记条目只有 `群聊` 标签、**没记是哪个群**（2026-11-03 实测 34 条全部如此）。
//   程序无法可靠推断（靠成员昵称只能判对 1/34，因为很多人早退群改名了），
//   所以这一步**必须由人指定**。这个脚本就是把「人指定」这件事做成一条命令。
//
// 【用法】
//   node tools/归属群聊.mjs list                      # 先看有哪些条目在等归属
//   node tools/归属群聊.mjs assign group:730783833     # 全部归到这个群
//   node tools/归属群聊.mjs assign group:730783833 --dry  # 只看会动什么，不落盘
//
//   默认日记库是 ~/.dsh/xiaoyu-diary，可用 --root=/path 改。
//
// 【安全约定】
//   · 先打备份目录，再动手；
//   · --dry 只报告不写盘；
//   · 幂等：同一条不会加两次；
//   · 只动 `群聊` 标签的条目，私聊的一条都不碰。
// ============================================================================

import path from 'node:path'
import os from 'node:os'
import { cp, readdir, readFile } from 'node:fs/promises'
import {
  列出待归属老条目, 修复误迁的群聊, 迁移老数据, 按昵称猜归属, 归到指定群,
} from '../lib/store.js'
import { 校验来源, 来源标签, 私聊 } from '../lib/source.js'
import { 列出来源, 探测仓库 } from '../lib/vault.js'
import path2 from 'node:path'

/** 从 argv 里取 --root=/path。 */
function 取根 () {
  const a = process.argv.find((x) => x.startsWith('--root='))
  if (a) return a.slice('--root='.length)
  return process.env.DIARY_HOME || path.join(os.homedir(), '.dsh', 'xiaoyu-diary')
}

/** 解析 argv 里的位置参数（跳过 -- 开头的开关）。 */
function 取参数 () {
  return process.argv.slice(2).filter((x) => !x.startsWith('--'))
}

function 有开关 (名) {
  return process.argv.includes(名)
}

/**
 * 扫每个群的成员昵称（从记忆仓库群聊记录的行里解析）。
 *
 * 为什么要扫全部记录而不是只看最新一天：来群里说过话、但最近没说话的人都算成员，
 * 只看一天会漏掉一大批老成员。老日记里的人恰恰多是"以前来说过话"的。
 *
 * @returns {Promise<Object<string, string[]>>} 来源 key → 成员昵称数组
 */
async function 取群成员 (vaultDir) {
  const 行格式 = /^\[(\d{2}):(\d{2}):(\d{2})\]\s*([^(]*)\(([^)]+)\):\s*(.*)$/
  const 出 = {}
  let 来源们 = []
  try {
    来源们 = await 列出来源(vaultDir, await 探测仓库(() => {}))
  } catch { return 出 }
  for (const s of 来源们) {
    if (!s.群号) continue
    const 目录 = path2.join(vaultDir, 'chat', 'group', s.群号)
    let 文件们 = []
    try { 文件们 = await readdir(目录) } catch { continue }
    const 集 = new Set()
    for (const f of 文件们.filter((x) => x.endsWith('.txt'))) {
      let raw = ''
      try { raw = await readFile(path2.join(目录, f), 'utf8') } catch { continue }
      for (const line of raw.split(/\r?\n/)) {
        const m = 行格式.exec(line)
        if (m && m[4].trim()) 集.add(m[4].trim())
      }
    }
    出[s.来源] = [...集]
  }
  return 出
}

async function 主 () {
  const root = 取根()
  const [命令, 目标] = 取参数()

  if (命令 === 'list' || 命令 === undefined) {
    const r = await 列出待归属老条目(root)
    console.log(`日记库：${root}`)
    console.log(`待归属的群聊老日记：${r.总数} 条，涉及 ${r.天数} 天\n`)
    if (r.总数 === 0) {
      console.log('✅ 没有待归属的条目。')
      return
    }
    // 按日期分组打印，方便一眼看出是哪几天的
    const 按天 = new Map()
    for (const x of r.待归属) {
      if (!按天.has(x.日期)) 按天.set(x.日期, [])
      按天.get(x.日期).push(x)
    }
    for (const [date, 们] of [...按天.entries()].sort()) {
      console.log(`【${date}】${们.length} 条（在 ${们[0].来源文件}）`)
      for (const x of 们) {
        console.log(`  ${x.id || '?'}  ${x.text.slice(0, 50)}`)
      }
    }
    console.log('\n挑一个群，然后：node tools/归属群聊.mjs assign group:<群号>')
    return
  }

  if (命令 === 'bynick') {
    // 按群昵称检索来分：先查每个群的成员名单，再看老条目的 tag 命中哪个群
    const vault = (process.argv.find((x) => x.startsWith('--vault=')) || '').slice('--vault='.length)
      || process.env.VAULT_HOME || path.join(os.homedir(), '.dsh', 'memory-vault')
    const 待 = await 列出待归属老条目(root)
    if (待.总数 === 0) { console.log('✅ 没有待归属的条目。'); return }
    const 群成员 = await 取群成员(vault)
    const 群们 = Object.keys(群成员)
    if (群们.length === 0) {
      console.error(`❌ 在 ${vault} 里没扫到任何群的成员名单，无法按昵称分。`)
      process.exitCode = 1
      return
    }
    const 结果 = 按昵称猜归属(待.待归属, 群成员)
    const 能定 = 结果.filter((x) => x.判定 === '能定')
    const 判不了 = 结果.filter((x) => x.判定 === '判不了')
    const 无依据 = 结果.filter((x) => x.判定 === '无依据')
    console.log(`共 ${结果.length} 条待归属。群成员名单：${群们.map((k) => `${来源标签(k)}(${群成员[k].length} 人)`).join('、')}`)
    console.log(`\n【能定】${能定.length} 条`)
    for (const x of 能定) console.log(`  ${x.日期} ${x.id}  → ${来源标签(x.归属)}  （${x.依据}）`)
    console.log(`\n【判不了】${判不了.length} 条（多个群都命中）`)
    for (const x of 判不了) console.log(`  ${x.日期} ${x.id}  ${x.依据}`)
    console.log(`\n【无依据】${无依据.length} 条（人名都查不到，多半是已退群改名的）`)

    if (能定.length === 0) {
      console.log('\n没有任何一条能可靠判定归属。按昵称分这条路走不通，需要人工指定。')
      return
    }
    const dry = 有开关('--dry')
    console.log(`\n${dry ? '预览' : '执行'}：把【能定】的 ${能定.length} 条写进各自该去的群`)
    if (dry) return

    // 按来源分组写盘
    const 分好 = new Map()
    for (const x of 能定) {
      if (!分好.has(x.归属)) 分好.set(x.归属, [])
      分好.get(x.归属).push(x)
    }
    for (const [key, 们] of 分好) {
      const r = await 归到指定群(root, key, 们.map((x) => ({ 日期: x.日期, id: x.id })))
      console.log(`  ${来源标签(key)}：归入 ${r.归入} 条`)
    }
    const 剩 = await 列出待归属老条目(root)
    console.log(`\n完成。剩余待归属 ${剩.总数} 条（判不了的仍然留给你定）。`)
    return
  }

  if (命令 === 'assign') {
    const key = 校验来源(目标)
    if (!key || key === 私聊) {
      console.error(`❌ 目标必须是 group:<群号>，收到：${目标 || '(空)'}`)
      process.exitCode = 1
      return
    }
    const dry = 有开关('--dry')

    const 待 = await 列出待归属老条目(root)
    if (待.总数 === 0) {
      console.log('✅ 没有待归属的条目，什么都不用做。')
      return
    }
    console.log(`准备把 ${待.总数} 条群聊老日记（${待.天数} 天）归到 ${来源标签(key)}（${key}）`)
    if (dry) {
      console.log('\n--dry 模式，只预览不写盘。将要处理的条目：')
      for (const x of 待.待归属.slice(0, 10)) console.log(`  ${x.日期} ${x.id}  ${x.text.slice(0, 40)}`)
      if (待.总数 > 10) console.log(`  …还有 ${待.总数 - 10} 条`)
      return
    }

    // 动手前先整份备份日记库（真的复制，不是打印一句就算）
    const 时间戳 = new Date().toISOString().replace(/[:.]/g, '-')
    const 备份 = `${root}.bak-${时间戳}`
    await cp(root, 备份, { recursive: true })
    console.log(`\n已整份备份到 ${备份}`)

    // 1) 老文件里的（迁移还没动过的）→ 跑迁移，指定群来源
    const 迁移 = await 迁移老数据(root, { 群来源: key })
    if (迁移.搬了 > 0) {
      console.log(`  老文件迁移：私聊 ${迁移.私聊条} 条、群聊 ${迁移.群聊条} 条`)
      console.log(`  原文备份：${迁移.备份目录}`)
    }
    // 2) 误迁进私聊的 → 挑回去
    const 修 = await 修复误迁的群聊(root, { 群来源: key })
    if (修.挪了 > 0) {
      console.log(`  从私聊挑回群：${修.挪了} 条（${修.日期.length} 天）`)
    }

    // 3) 复验
    const 之后 = await 列出待归属老条目(root)
    console.log(`\n完成。剩余待归属：${之后.总数} 条`)
    if (之后.总数 === 0) console.log('✅ 全部归位。')
    else console.log('⚠️ 还有条目没归位，可能目标来源已有同一天数据被跳过（不会覆盖）。')
    return
  }

  console.error(`未知命令：${命令}\n可用：list / assign group:<群号> [--dry]`)
  process.exitCode = 1
}

主().catch((e) => {
  console.error('出错了：', (e && e.message) || e)
  process.exitCode = 1
})
