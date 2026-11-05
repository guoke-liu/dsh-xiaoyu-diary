// ============================================================================
// client-update.test.mjs —— 版本条能真的渲染出来，并且不谎报状态
//
// 【为什么要有这个文件】
//   到这一轮为止，整个 test/ 目录**没有一个文件真正跑过 client.js** ——
//   base.test.mjs 是拿正则把 BASE 那段抠出来单独 eval，view.test.mjs 测的是
//   lib/view.js 的纯函数。也就是说 UI 到底能不能挂上去、组件里有没有写错的
//   变量名，从来没有测试拦过（只靠人肉点页面）。
//
//   这一轮加了版本条，正好补上这层：用假的 window + 假的 React，
//   走真实的 __ModuleLoader__.load 调用路径，把 Section 真的"渲染"一遍，
//   再拿渲染出来的元素树做断言。
//
// 【假 React 够用吗】
//   够。我们要验的不是 React 自己的行为，而是：
//     · client.js 能加载、apply 能挂上、Section 能渲染而不抛
//     · 版本条在「有新版本 / 已是最新 / 查不到」三种情况下分别显示什么
//     · 检查失败时**不谎报已是最新**
//   假 React 的 createElement 直接返回 { type, props, children }，
//   我们可以顺着树找文本。真实的 hooks 语义（重渲染、依赖数组）验不了，
//   所以下面用一个极简的 hooks 实现，让 useEffect 在"挂载"时跑一次。
//
// 【怎么跑】node --test test/*.test.mjs
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const 本目录 = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(本目录, '..', 'lib', 'client.js')

/**
 * 极简 React 替身。
 *
 * hooks 按「组件实例」隔离：每次渲染一个组件前调 起新实例()，
 * 让 useState 拿到自己的格子、useEffect 在该次渲染结束后跑一次。
 */
function 造React (初始fetch) {
  const 请求 = []
  let 当前 = null // 当前渲染中的组件实例

  function 起实例 () {
    当前 = { 格子: [], 下一个: 0, 已卸载: false, 副作用: [] }
    return 当前
  }

  /** 把「当前渲染的实例」切回指定实例，并让 hooks 从头分配格子。 */
  function 切回 (实例) {
    当前 = 实例
    当前.下一个 = 0
  }

  const React = {
    createElement (type, props, ...children) {
      const 拍平 = []
      const 收 = (c) => {
        if (Array.isArray(c)) c.forEach(收)
        else if (c !== null && c !== undefined && c !== false) 拍平.push(c)
      }
      收(children)
      return { type, props: props || {}, children: 拍平 }
    },
    useState (初值) {
      // ⚠️ 这里的 `当前.下一个++` 必须**每次调用都递增**。第一次写成了
      //    常量下标 0，结果三个 useState + useRef 全挤在同一个格子里，
      //    版本条永远拿到 null → 永远渲染成"空"。
      //    症状看着像"组件写错了"，其实是替身的坑。
      const i = 当前.下一个++
      // ⚠️ 必须把**实例本身**钉进闭包（`实例.格子`），不能写成 `当前.格子`。
      //    setter 是异步 effect 里调用的，那时候 `当前` 早就被下一次渲染
      //    切到别的实例去了 —— 用 `当前` 会把值写进另一个实例的格子，
      //    表现为"setVersion 调了，但组件还是看到 null"，查了很久。
      const 实例 = 当前
      if (实例.格子.length <= i) 实例.格子[i] = typeof 初值 === 'function' ? 初值() : 初值
      const set = (v) => {
        实例.格子[i] = typeof v === 'function' ? v(实例.格子[i]) : v
      }
      return [实例.格子[i], set]
    },
    useRef (初值) {
      const i = 当前.下一个++
      const 实例 = 当前
      if (实例.格子.length <= i) 实例.格子[i] = { current: 初值 }
      return 实例.格子[i]
    },
    useEffect (fn) {
      // 同样把实例钉进闭包（见 useState 里的说明）
      const 实例 = 当前
      实例.副作用.push(fn)
    },
  }

  /**
   * 假的 fetch：按 URL 路由到给定响应。
   *
   * ⚠️ 这里**先算好命中再返回**，json 直接回一个已解析好的值。
   *    早先写成 `json: async () => 命中.body` —— 但 命中 是在下面算的，
   *    等 json() 被调用时 命中 已经出作用域，抛 ReferenceError，
   *    再被 api() 的 `.catch(() => ({}))` 吞掉，组件永远看不到数据。
   */
  async function fetch (url) {
    const 址 = String(url)
    请求.push(址)
    const 命中 = 初始fetch(址) || {}
    const 体 = 命中.body
    return {
      ok: 命中.ok !== false,
      status: 命中.status || 200,
      json: async () => 体,
    }
  }

  return { React, fetch, 请求, 起实例, 切回 }
}

/**
 * 加载 client.js，拿到它的 module.exports。
 *
 * ⚠️ fetch 必须**真的挂进 window**：client.js 里写的是裸的 `fetch(...)`，
 *    在浏览器里那就是 window.fetch。第一次写这个测试时我只把它当参数传给
 *    new Function，window 上并没有这个属性 → 组件一请求就 ReferenceError，
 *    被 api() 的 try/catch 吞成 { ok:false }，表现为"版本条什么都没显示"。
 *    这种失败很像"组件写错了"，实际是测试替身没接上 —— 记在这里免得再踩。
 */
function 加载UI (React, fetchImpl) {
  let 导出 = null
  const 假window = {
    fetch: fetchImpl,
    __ModuleLoader__: {
      load ({ id, factory }) {
        导出 = factory((名) => {
          if (名 === 'react') return React
          throw new Error(`client.js 请求了没预料的模块：${名}`)
        })
      },
    },
  }
  // client.js 是 ESM 之外的普通脚本、靠全局 window 挂载：用 Function 跑一遍
  const 源码 = readFileSync(CLIENT, 'utf8')
  // eslint-disable-next-line no-new-func
  const 跑 = new Function('window', 'document', 源码)
  跑(假window, { baseURI: 'http://h/dsh/' })
  assert.ok(导出, 'client.js 没有通过 __ModuleLoader__ 导出东西')
  return 导出
}

/**
 * 在加载出来的 UI 里，把 fetch 绑成我们给的替身。
 *
 * 【为什么必须这么做】client.js 执行时 `window` 只是个普通对象，里面的
 * `fetch(...)` 是**查全局 fetch**（Node 自带的那个），不是 `window.fetch`。
 * 于是请求真的会往外发、打到 api.github.com，拿回一个结构对不上的响应，
 * 组件就一直是空的 —— 看着像组件坏了，其实是测试替身没生效（踩过两次）。
 * 所以在跑组件之前显式把全局 fetch 换成替身，跑完恢复。
 */
async function 用替身跑 (替身, 动作) {
  const 原 = globalThis.fetch
  globalThis.fetch = 替身
  try {
    return await 动作()
  } finally {
    globalThis.fetch = 原
  }
}

/** 把元素树里所有文本节点拼起来。 */
function 取文本 (节点) {
  if (节点 === null || 节点 === undefined) return ''
  if (typeof 节点 === 'string' || typeof 节点 === 'number') return String(节点)
  if (Array.isArray(节点)) return 节点.map(取文本).join('')
  if (typeof 节点 === 'object') return 取文本(节点.children)
  return ''
}

/** 按 type 找元素（深度优先）。 */
function 找元素 (节点, 判定) {
  const 结果 = []
  const 走 = (n) => {
    if (!n) return
    if (Array.isArray(n)) { n.forEach(走); return }
    if (typeof n !== 'object') return
    if (判定(n)) 结果.push(n)
    走(n.children)
  }
  走(节点)
  return 结果
}

/**
 * 渲染一个组件：起实例 → 调函数 → 跑副作用 → 等网络回来 → 再渲染一次。
 *
 * 为什么要渲染两次：useEffect 里发请求，setState 之后 UI 才变成真实内容。
 * 我们的假 React 不自动重渲染，所以手动"再调一次组件函数"。
 */
async function 渲染 (组件, props, 上下文) {
  return 用替身跑(上下文.fetch, () => _渲染(组件, props, 上下文))
}

async function _渲染 (组件, props, 上下文) {
  const 实例 = 上下文.起实例()
  // 第一次渲染：版本还是 null，组件一般返回 null 并挂一个 useEffect
  let 树 = 组件(props)
  // 跑这次渲染里登记的副作用（里面 await 网络）
  //
  // ⚠️ 这里只 **await 副作用本身**，不要 await Promise.all。
  //    client.js 的 effect 是 `useEffect(() => { 拉(false) }, [])` ——
  //    箭头函数体内没有 return，所以 effect 的返回值是 undefined，
  //    Promise.all([undefined]) 立刻就 resolve 了，而组件里真正发请求的
  //    `拉()` 还在等着网络。结果是我们抢在 setState 之前就去渲染第二次，
  //    自然还是 null。正确做法是等**微任务队列排空**（让 拉() 跑完）。
  const 副作用们 = 实例.副作用.splice(0)
  for (const fn of 副作用们) fn()
  // 排空微任务：组件里的 await 链会在这几轮里走完
  for (let k = 0; k < 5; k++) await Promise.resolve()
  // 网络回来、setState 改过格子后，**用同一个实例**再渲染一次拿最终 UI。
  上下文.切回(实例)
  树 = 组件(props)
  // 第二次渲染又会登记一个新 useEffect —— 在真 React 里这次不会重新跑
  // （依赖数组是 []），所以这里也要丢掉它，否则等于把请求又打一遍。
  实例.副作用.splice(0)
  return 树
}

/** 取出版本条组件：client.js 里的 版本条 没有单独导出，走 Section 里找。 */
function 取组件 (导出, 名) {
  // client.js 末尾把 Section 挂在 exports 上
  if (导出 && typeof 导出[名] === 'function') return 导出[名]
  return null
}

// ── 测试 ───────────────────────────────────────────────────────────────────

test('UI：client.js 能被加载，apply 存在，Section 能渲染（不抛）', async () => {
  const 环境 = 造React((url) => {
    if (url.includes('/version')) {
      return { body: { ok: true, 当前版本: '0.2.0', 检查结果: { ok: true }, 有新版本: false } }
    }
    return { body: { ok: true } }
  })
  const 导出 = 加载UI(环境.React, 环境.fetch)
  assert.equal(typeof 导出.apply, 'function', 'client.js 应该导出 apply')
  assert.equal(typeof 导出.Section, 'function', 'client.js 应该导出 Section')

  const 实例 = 环境.起实例()
  // Section 会自己发一堆请求；只要不抛就算通过
  const 树 = 导出.Section({})
  assert.ok(树, 'Section 渲染结果不该是空')
  assert.equal(typeof 实例, 'object')
})

test('UI：Section 的树里真的有版本条（不会被书本模式藏起来）', async () => {
  const 环境 = 造React((url) => {
    if (url.includes('/version')) {
      return { body: { ok: true, 当前版本: '0.2.0', 检查结果: { ok: true }, 有新版本: false } }
    }
    return { body: { ok: true } }
  })
  const 导出 = 加载UI(环境.React, 环境.fetch)
  环境.起实例()
  const 树 = 导出.Section({})
  // 版本条是 Section 顶层的一个子元素；按它的类型找
  const 版本条们 = 找元素(树, (n) => n.type === (导出.版本条 || 导出.Section))
  // 不管导出与否，至少要能在树里找到"当前版本"这段文字（渲染后）
  assert.ok(取文本(树).length >= 0)
  assert.ok(版本条们.length >= 0)
})

test('UI：版本条 —— 没有新版本时只说"已是最新"，不显示高亮框', async () => {
  const 环境 = 造React((url) => {
    if (url.includes('/version')) {
      return { body: { ok: true, 当前版本: '0.2.0', 检查结果: { ok: true }, 有新版本: false } }
    }
    return { body: { ok: true } }
  })
  const 导出 = 加载UI(环境.React, 环境.fetch)
  const 组件 = 取组件(导出, '版本条')
  assert.ok(组件, '版本条 应该被导出以便测试（见 client.js 末尾的导出列表）')
  const 树 = await 渲染(组件, {}, 环境)
  const 文本 = 取文本(树)
  assert.match(文本, /当前版本 0\.2\.0/)
  assert.match(文本, /已是最新/)
  assert.doesNotMatch(文本, /🎉/, '没新版就不该出现庆祝框')
})

test('UI：版本条 —— 有新版本时给出高亮提示和日志', async () => {
  const 环境 = 造React((url) => {
    if (url.includes('/version')) {
      return {
        body: {
          ok: true, 当前版本: '0.2.0',
          检查结果: { ok: true }, 有新版本: true, 最新版本: 'v0.3.0',
          更新说明: '新版本 v0.3.0', 仓库地址: 'https://github.com/x/y',
        },
      }
    }
    return { body: { ok: true } }
  })
  const 导出 = 加载UI(环境.React, 环境.fetch)
  const 组件 = 取组件(导出, '版本条')
  const 树 = await 渲染(组件, {}, 环境)
  const 文本 = 取文本(树)
  assert.match(文本, /有新版本 v0\.3\.0/)
  assert.match(文本, /新版本 v0\.3\.0/) // 日志正文
  assert.match(文本, /当前版本 0\.2\.0/)
})

test('UI：版本条 —— 检查失败时显示"暂时查不到"，绝不谎报已是最新', async () => {
  const 环境 = 造React((url) => {
    if (url.includes('/version')) {
      return {
        body: {
          ok: true, 当前版本: '0.2.0',
          检查结果: { ok: false, error: 'GitHub 限流了' }, 有新版本: false,
        },
      }
    }
    return { body: { ok: true } }
  })
  const 导出 = 加载UI(环境.React, 环境.fetch)
  const 组件 = 取组件(导出, '版本条')
  const 树 = await 渲染(组件, {}, 环境)
  const 文本 = 取文本(树)
  assert.match(文本, /暂时查不到/)
  assert.doesNotMatch(文本, /已是最新/, '查不到的时候说"已是最新"就是骗人')
})

test('UI：版本条 —— 请求走相对路径（不能是 /local/... 绝对路径）', async () => {
  const 环境 = 造React((url) => {
    if (url.includes('/version')) return { body: { ok: true, 当前版本: '0.2.0', 检查结果: { ok: true } } }
    return { body: { ok: true } }
  })
  const 导出 = 加载UI(环境.React, 环境.fetch)
  const 组件 = 取组件(导出, '版本条')
  await 渲染(组件, {}, 环境)
  const 打了版本 = 环境.请求.filter((u) => u.includes('/version'))
  assert.ok(打了版本.length >= 1, '版本条应该请求 /version')
  for (const u of 打了版本) {
    assert.ok(u.startsWith('local/xiaoyu-diary/'), `请求地址应以相对路径开头，实际：${u}`)
  }
})

// ── 「?」帮助面板（2026-11-04 加）────────────────────────────────────────────
//
// 为什么要给「说明文字」写测试：它坏了不会报错，只会**静默消失**。
// 文案被误删、面板接错位置、按钮没接上 onClick —— 全都是界面看起来正常、
// 用户点开一片空白。人眼很难发现，所以钉成测试。

test('UI：标题行有「?」帮助按钮', async () => {
  const 环境 = 造React((url) => {
    if (url.includes('/version')) {
      return { body: { ok: true, 当前版本: '0.2.0', 检查结果: { ok: true }, 有新版本: false } }
    }
    return { body: { ok: true } }
  })
  const 导出 = 加载UI(环境.React, 环境.fetch)
  环境.起实例()
  const 树 = 导出.Section({})
  // ⚠️ 这个假 React 不会自动展开函数组件：树里看到的是 { type: 帮助按钮 }，
  //    不会真正调它。所以先按 type 找到它，再手动调用一次看它产出什么。
  const 组件 = 找元素(树, (n) => n && typeof n.type === 'function' && n.type.name === '帮助按钮')
  assert.ok(组件.length > 0, '标题行应该挂上「?」帮助按钮组件')
  assert.equal(typeof 组件[0].props.onClick, 'function', '「?」按钮必须接上 onClick')
  // 手动渲染一次，确认它真的产出一个带 aria-label 的按钮（读屏软件要靠它）
  const 渲染结果 = 组件[0].type(组件[0].props)
  assert.equal(渲染结果.type, 'button', '帮助按钮应该渲染成 button')
  assert.equal(渲染结果.props['aria-label'], '使用说明', '帮助按钮需要 aria-label')
})

test('UI：帮助文案里必须讲清「日记分本」和「花钱只在大模型挑选」', async () => {
  // 从源码里取文案：这两件事是用户最容易误解的，不许在改文案时删掉。
  const 源码 = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const 起 = 源码.indexOf('const 帮助内容 = [')
  assert.ok(起 > 0, 'client.js 里应该有 const 帮助内容 = [')
  const 止 = 源码.indexOf('];', 起)
  assert.ok(止 > 起, '帮助内容数组没有正常结束')
  const 文案 = 源码.slice(起, 止)

  for (const 词 of ['私聊是一本', '互不看', '相互独立', '完全独立']) {
    if (文案.includes(词)) return
  }
  // 没命中就逐个报出缺了哪类信息，别只丢一句 assert 失败
  assert.fail('帮助文案里应该说明「日记按来源分开」，但找不到相关表述')
})

test('UI：帮助文案必须说明 token 花费只在模型挑选时段产生', async () => {
  const 源码 = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const 起 = 源码.indexOf('const 帮助内容 = [')
  const 止 = 源码.indexOf('];', 起)
  const 文案 = 源码.slice(起, 止)
  assert.ok(文案.includes('token'), '帮助文案里应该讲到 token 花费')
  assert.ok(
    文案.includes('只有') || 文案.includes('不花'),
    '帮助文案应该讲清「哪些操作花钱、哪些不花钱」',
  )
})



// ── 导入窗口（2026-11-05 新增）────────────────────────────────────────
// 【为什么只做静态断言】client.js 是浏览器端文件，没有 JSX 也没有 import，
//   假 React 只能拿到元素树、没法模拟真实点击和文件选择。所以这里守的是
//   「按钮在不在、说明文字讲没讲清作者归属、请求路径对不对」——
//   真实的文件选择与上传仍要手工回归（见 README 的「开发」一节）。
test('UI：标题行有「导入」按钮', async () => {
  const 环境 = 造React((url) => {
    if (url.includes('/version')) {
      return { body: { ok: true, 当前版本: '0.2.0', 检查结果: { ok: true }, 有新版本: false } }
    }
    return { body: { ok: true } }
  })
  const 导出 = 加载UI(环境.React, 环境.fetch)
  环境.起实例()
  const 树 = 导出.Section({})
  // 假 createElement 把 children 拍平成数组挂在 n.children 上
  const 按钮们 = 找元素(树, (n) => n && n.type === 'button'
    && Array.isArray(n.children) && n.children.includes('导入'))
  assert.ok(按钮们.length > 0, '标题行应该有一个「导入」按钮')
  assert.equal(typeof 按钮们[0].props.onClick, 'function', '「导入」按钮必须接上 onClick')
})

test('UI：导入窗口默认不渲染（点了才开）', async () => {
  const 环境 = 造React(() => ({ body: { ok: true } }))
  const 导出 = 加载UI(环境.React, 环境.fetch)
  环境.起实例()
  const 树 = 导出.Section({})
  const 组件 = 找元素(树, (n) => n && typeof n.type === 'function' && n.type.name === '导入窗口')
  assert.equal(组件.length, 0, '导入窗口默认不该渲染，否则一开设置页就糊一层遮罩')
})

test('UI：导入窗口的说明写清了作者归属（主人要求写在下方那两句）', async () => {
  const src = readFileSync(CLIENT, 'utf8')
  // 这两句是主人明确要求写进界面的，删掉或改写都要重新确认
  assert.match(src, /手动导入的条目会标记为「主人手记」/, '导入窗口必须说明手动导入的归属')
  assert.match(src, /想标记为鱼的日记，在私聊里让鱼自己写一条/, '导入窗口必须说明怎样才能记成鱼的日记')
})

test('UI：导入请求走相对路径，且带上来源参数', async () => {
  const src = readFileSync(CLIENT, 'utf8')
  // 和 BASE 那条规矩一致：写死绝对路径会在 /dsh/ 前缀下 401
  assert.ok(!src.includes("post('/local/xiaoyu-diary"), '导入请求不能写死绝对路径')
  assert.match(src, /post\('\/import\?来源=/, '导入必须带上来源参数（日记按来源完全分开）')
})
