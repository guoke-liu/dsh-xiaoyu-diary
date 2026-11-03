// ============================================================================
// llm.js —— 大模型挑选通道（手动）：把一整天聊天交给模型挑「值得记的事」
//
// 【这个模块负责什么】
//   用户在 UI 上点一下「交给大模型挑」，本模块把当天**全部**聊天交给一个
//   OpenAI 兼容接口，由模型判断哪些事真正值得写进日记。与 extract.js 的
//   规则初筛互补：规则便宜但只认词面，模型贵但懂语义 —— 手动通道追求质量，
//   所以整天的原始记录都给模型看，不做规则预筛。
//
// 【为什么这样设计】
//   1. 不绑死任何一家服务。这是要开源的插件，用户可能接智谱、DeepSeek、
//      OpenAI 或自建网关，所以 baseURL / apiKey / model 全部由调用方传入，
//      本文件里不出现任何写死的 API 地址、模型名，也不内置任何密钥。
//      调用格式是事实标准：POST {baseURL}/chat/completions，
//      Authorization: Bearer {apiKey}，body {model, messages, temperature, max_tokens}。
//
//   2. 必须分批。实测某一天有 2363 行聊天、约 6.5 万 token，超过很多模型的
//      上下文窗口；就算塞得进去，一次超长请求也容易超时或被截断。
//      所以按行数切片（默认每批 400 行），每批单独请求，最后合并去重。
//      副产品：单批失败只损失那 400 行，而不是整天白跑 —— 这也是
//      「某批失败不中断、继续跑下一批」的原因。
//
//   3. 密钥零泄漏。任何日志、错误信息、返回值里都不得出现 apiKey 原文。
//      本模块不写任何日志；唯一要防的意外是服务端在错误响应里"回显"了我们
//      发出去的 key（罕见但不是不可能），所以凡是要把响应内容拼进错误信息的
//      地方，都先过一遍 脱敏() 再说。
//
// 【对外导出】
//   · 渲染批次(行们) —— 把一批聊天行渲染成给模型看的文本
//   · 挑一批(配置, 行们, 选项) —— 调一次模型挑一批（不抛异常，失败折算成 ok:false）
//   · 挑选一天(配置, 行们, 选项) —— 自动分批 + 串行请求 + 合并去重
//
// 【环境】Node ≥ 20，ESM，零第三方依赖（只用全局 fetch / AbortController）。
// 【许可】MIT，见根目录 LICENSE。
// ============================================================================

/** 聊天行。字段与记忆仓库 chatlog 的格式一致（见 extract.js 的 解析聊天）。 */
/**
 * @typedef {object} 聊天行
 * @property {string} 时间 如 '09:00:00'
 * @property {string} 昵称
 * @property {string} 内容
 */

/** 一件值得记的事（模型输出的最小单元）。 */
/**
 * @typedef {object} 事项
 * @property {string} 内容 一句话概括，能脱离上下文看懂（写清是谁、什么事）
 * @property {string} 理由 为什么值得记（模型没给就补空串）
 * @property {string} 来源 原文里的 [时间] 昵称，如 '09:00:00 某人'
 */

/**
 * 默认每批行数。
 *
 * 为什么是 400：实测最重的一天 2363 行 ≈ 6.5 万 token，按 400 行切，
 * 单批大约 1 万 token 出头，落在一大批便宜模型的上下文安全区内；
 * 再小则请求数翻倍、整天耗时变长，再大则回到"塞不下"的老问题。
 */
const 默认每批行数 = 400

/**
 * 单批请求超时默认值（毫秒）。
 * 60 秒的考量：小参数模型生成 2000 token 通常十几秒，60 秒已含裕量；
 * 上一批不返回，下一批就得干等（串行），所以宁可超时报错也别无限挂起。
 */
const 默认超时毫秒 = 60000

/**
 * 单批失败后的重试次数，默认 2（即最多请求 3 次）。
 *
 * 为什么需要：实测免费通道下同一天 4 批全部 429 —— 串行并不能避免限流。
 * 为什么不设更多：免费额度本来就很紧，退避到第 3 次还不行，说明这一轮
 * 的配额确实用完了，再等下去只是让用户干等（一天 6 批 × 更多重试 = 几分钟）。
 */
const 重试次数 = 2

/** 退避的基础等待（毫秒）。第 N 次重试等 基础 × 2^(N-1)：2s、4s… */
const 基础退避毫秒 = 2000

/**
 * 判断一条失败是否值得重试。
 *
 * 只认「等一会儿可能就好了」的情形：限流（429）、超时、服务端 5xx。
 * 其它情况（配置错、模型返回非 JSON、鉴权失败）重试多少次都一样，
 * 白白让用户多等几轮。
 *
 * @param {string} 错误 挑一批 返回的错误文本
 * @returns {boolean}
 */
function 可重试 (错误) {
  const t = String(错误 || '')
  return t.includes('429') ||
    t.includes('限流') ||
    t.includes('速率限制') ||
    t.includes('超时') ||
    t.includes('timeout') ||
    /\b5\d\d\b/.test(t)
}

/** 温度压到 0.3：这是信息抽取不是创作，输出越稳定、越贴合原文越好。 */
const 采样温度 = 0.3

/**
 * 单批最大输出 token，默认 4000。
 *
 * 为什么不是 2000：普通模型挑一批只需几百 token，2000 绰绰有余；
 * 但**思考模型**（如智谱 glm-5.3-flash）会把思考过程也算进 max_tokens ——
 * 实测 3000 时思考就吃光了全部预算，正文为空；调到 6000 才稳定出结果
 * （那次输出 5375，其中正文只有几百）。
 *
 * 所以默认给 4000 保底，用思考模型的用户在「额外参数」里写
 * `{"max_tokens": 6000}` 覆盖即可（额外参数会覆盖这个默认值）。
 */
const 单批最大输出 = 4000

/**
 * 发给模型的 system 提示词。
 *
 * ⚠️ 这段文字是筛选质量的命根子。没有特殊理由不要改动；
 *    改了请用真实一整天的聊天数据对比前后效果再合入。
 *
 * 【一次实测翻车，改提示词前必读】
 * 早先为了压掉「今天很开心」这类废话，这段提示词越写越长（1131 字），
 * 塞满了反例、正例对比、自检口令，还写了一句
 * 「如果当天确实没有具体的事，返回空数组 —— 空数组是正常且合格的结果」。
 *
 * 用免费的小模型（Agnes 3.0 flash）实测 100 行真实聊天：
 *   完整提示词 → 只输出 6 个 token，内容 {"事项":[]}     ← 直接放弃
 *   精简提示词 → 输出 181 个 token，正常挑出内容
 *
 * 根因不是"小模型能力差"，是**那句退出口**：模型宁可返回空数组（永远不会错），
 * 也不愿承担"挑错"的风险。约束写得越密、越像是陷阱，它越倾向交白卷。
 *
 * 所以现在这版的原则：
 *   · 去掉「返回空数组是合格的」这类退出口
 *   · 少用「绝对禁止/必须/✗✗✗」，改成正面描述"什么值得记"
 *   · 长度控制在 500 字上下，够用就行，不堆例子
 * 当前 491 字，同一天 387 行实测 4 批全部成功、挑出真实事项。
 */
const SYSTEM_PROMPT = `你是日记助手。从下面的聊天记录里，找出真正值得记进日记的事。

什么叫值得记：
- 有具体内容的约定、承诺、计划（谁、什么时候、做什么）
- 做出了决定
- 重要信息：地址、电话、金额、截止时间
- 某件真实发生的事，以及它带来的结果
- 一个人对自己的真实认识、心里话

什么叫不值得记：
- 寒暄、附和、"哈哈哈"、"好的"、"嗯"
- 单纯的心情词（开心、高兴）
- 一起玩了什么、聊到过什么话题
- 笼统概括（"聊了很久""讨论了很多"）

怎么判断：把这条放进日记，一年后翻出来还有意义吗？有就记，没有就不记。
同一件事的几句对话合并成一条，写清楚发生了什么，不要写成"某人提到了X"。

输出要求：
- 只输出 JSON，不要解释、不要 markdown 代码块。
- 格式：{"事项":[{"内容":"...","理由":"...","来源":"..."}]}
- 内容：一句话说清谁、什么事、结果
- 理由：为什么值得记
- 来源：原文里的时间和昵称，如 "09:00:00 张三"
- 一天通常有 0-3 条。认真逐条看完整段聊天，多数日子至少有一两件事值得留下。`

/**
 * 把文本里可能混入的 apiKey 原文替换成 [已隐藏]。
 *
 * 用 split/join 而不是 replace + 正则：apiKey 里可能含正则特殊字符，
 * 逐字面量替换最稳。本文件所有错误出口都必须经过它 —— 万一服务端在
 * 错误响应里回显了我们发出的 key，这是最后一道闸。
 *
 * @param {unknown} 文本 待脱敏文本
 * @param {string} apiKey 调用方密钥（仅用于匹配替换，绝不参与请求）
 * @returns {string} 脱敏后的文本
 */
function 脱敏 (文本, apiKey) {
  const 字符串 = String(文本 ?? '')
  if (typeof apiKey !== 'string' || apiKey === '') return 字符串
  return 字符串.split(apiKey).join('[已隐藏]')
}

/**
 * 取正数，非法/非正时回默认值。
 * @param {unknown} 值
 * @param {number} 默认值
 * @returns {number}
 */
function 取正数 (值, 默认值) {
  const 数字 = Number(值)
  return Number.isFinite(数字) && 数字 > 0 ? 数字 : 默认值
}

/**
 * 取非负整数，非法/非正时回 0（用于 usage 统计，缺了就填 0）。
 * @param {unknown} 值
 * @returns {number}
 */
function 取计数 (值) {
  const 数字 = Number(值)
  return Number.isFinite(数字) && 数字 > 0 ? Math.floor(数字) : 0
}

/**
 * 校验三项必填配置，返回缺失的字段名数组。
 *
 * 提前挡下来而不是让 fetch 去炸：没有 baseURL/model 时报的是难懂的底层
 * 错误，没有 apiKey 时必然 401；在这里拦住，错误信息一眼能懂，
 * 也省一次注定失败的网络往返。缺 apiKey 时只说「缺少 apiKey」，
 * 绝不带任何原文。
 *
 * @param {object} [配置]
 * @returns {string[]} 缺失字段名，如 ['baseURL', 'apiKey']
 */
function 缺失配置 (配置) {
  const 检查项 = [
    ['baseURL', 配置 && 配置.baseURL],
    ['apiKey', 配置 && 配置.apiKey],
    ['model', 配置 && 配置.model],
  ]
  return 检查项
    .filter(([, 值]) => 值 == null || String(值).trim() === '')
    .map(([名]) => 名)
}

/**
 * 由 baseURL 拼出完整接口地址。
 * 先去掉末尾斜杠再拼路径：用户填 '.../v4' 和 '.../v4/' 都该能用，
 * 而直接拼接会把后者变成 '.../v4//chat/completions'，有的网关会 404。
 *
 * @param {unknown} baseURL
 * @returns {string}
 */
function 接口地址 (baseURL) {
  return `${String(baseURL).replace(/\/+$/, '')}/chat/completions`
}

/**
 * 把一批聊天行渲染成给模型看的文本。
 *
 * 格式：一行一条 `[时间] 昵称: 内容`。内容为空的行直接跳过 —— 空行发出去
 * 只是浪费 token，还会教模型"记录里可以有空条目"。行内自带的换行会被压成
 * 空格：模型要靠「一行 = 一条记录」的结构来写「来源」字段，结构一散，
 * 来源就对不上原文了。
 *
 * @param {Array<聊天行>} 行们
 * @returns {string} 渲染后的多行文本；输入不合法或全为空时返回 ''
 */
export function 渲染批次 (行们) {
  if (!Array.isArray(行们)) return ''
  const 行文本们 = []
  for (const 行 of 行们) {
    if (!行 || typeof 行 !== 'object') continue
    const 内容 = 行.内容 == null ? '' : String(行.内容)
    if (内容.trim() === '') continue
    const 单行内容 = 内容.replace(/\s*\r?\n\s*/g, ' ').trim()
    const 时间 = 行.时间 == null ? '' : String(行.时间)
    const 昵称 = 行.昵称 == null ? '' : String(行.昵称)
    行文本们.push(`[${时间}] ${昵称}: ${单行内容}`)
  }
  return 行文本们.join('\n')
}

/**
 * 从模型回复里容错地抠出事项数组。
 *
 * 【为什么要写得这么宽容】
 * system 提示词里明明要求「只输出 JSON，不要 markdown 代码块」，但实测模型
 * （尤其小参数档）仍然经常：包一层 ```json … ```、前面先客套一句
 * 「好的，以下是结果：」、结尾再补一句解释。严格 JSON.parse 在真实数据上
 * 会大面积失败，而一次解析失败 = 这一批 token 白烧。所以按三步兜底：
 *   ① 剥掉 markdown 代码围栏（```json / ```JSON / 裸 ```）；
 *   ② 截第一个 { 到最后一个 } 之间的部分，把围栏外的客套话整段丢掉；
 *   ③ JSON.parse，取 .事项（必须是数组）。
 * 三步走完还不行才认输，并把原文前 200 字带回给调用方排障。
 *
 * @param {string} 原始回复 模型返回的 message.content
 * @param {string} apiKey 仅用于把错误文本里的密钥脱敏
 * @returns {{事项: Array<事项>, 错误: string}} 错误为 '' 表示解析成功
 */
function 解析事项 (原始回复, apiKey) {
  const 原文 = String(原始回复 ?? '')

  // ① 剥围栏。[a-zA-Z]* 是为了连 ```json5、```JSON 一起剥掉；
  //    就算 ``` 出现在 JSON 字符串内部（极端情况），剥掉也只影响字符串内容，
  //    不会破坏 JSON 结构本身。
  const 剥壳 = 原文.replace(/```[a-zA-Z]*/g, '')

  // ② 截取 JSON 对象主体
  const 开始 = 剥壳.indexOf('{')
  const 结束 = 剥壳.lastIndexOf('}')
  if (开始 === -1 || 结束 <= 开始) {
    return {
      事项: [],
      错误: `模型返回的不是合法 JSON（没找到 JSON 对象），原文前 200 字：${脱敏(原文, apiKey).slice(0, 200)}`,
    }
  }

  // ③ 解析
  let 数据 = null
  try {
    数据 = JSON.parse(剥壳.slice(开始, 结束 + 1))
  } catch (错误对象) {
    const 原因 = (错误对象 && 错误对象.message) || '解析失败'
    return {
      事项: [],
      错误: `模型返回的不是合法 JSON（${原因}），原文前 200 字：${脱敏(原文, apiKey).slice(0, 200)}`,
    }
  }

  if (!数据 || typeof 数据 !== 'object' || !Array.isArray(数据.事项)) {
    return {
      事项: [],
      错误: `模型返回的不是合法 JSON（"事项"不是数组），原文前 200 字：${脱敏(原文, apiKey).slice(0, 200)}`,
    }
  }

  // 逐条清洗：「内容」是唯一硬性字段（空壳条目直接丢，别把空气写进日记）；
  // 理由/来源缺失补空串 —— 上游展示时有它没它都能活，不值得为它报错。
  const 事项 = []
  for (const 项 of 数据.事项) {
    if (!项 || typeof 项 !== 'object' || Array.isArray(项)) continue
    const 内容 = 项.内容 == null ? '' : String(项.内容).trim()
    if (内容 === '') continue
    事项.push({
      内容,
      理由: 项.理由 == null ? '' : String(项.理由).trim(),
      来源: 项.来源 == null ? '' : String(项.来源).trim(),
    })
  }
  return { 事项, 错误: '' }
}

/**
 * 调一次大模型，让它从一批聊天里挑出值得记的事。
 *
 * 本函数**不抛异常**：所有失败（配置缺失/网络错误/超时/非 2xx/解析失败）
 * 都折算成 ok:false + 错误，调用方不需要包 try/catch。
 * —— 为什么不抛：上层「挑选一天」要实现"某批失败继续跑下一批"，
 * 每批都接异常的代码既啰嗦又容易漏接。
 *
 * @param {object} 配置
 * @param {string} 配置.baseURL OpenAI 兼容服务的根地址（末尾带不带 / 都行）
 * @param {string} 配置.apiKey
 * @param {string} 配置.model
 * @param {number} [配置.timeoutMs=60000] 单次请求超时（毫秒）
 * @param {Array<聊天行>} 行们 本批聊天行
 * @param {object} [选项]
 * @param {string} [选项.date] 聊天所属日期（YYYY-MM-DD），拼进 user 消息帮模型定位时间
 * @returns {Promise<{ok: boolean, 事项: Array<事项>, 错误: string, usage: {输入: number, 输出: number}}>}
 *   ok=true 时 错误 为 ''；usage 缺失时各项为 0。
 */
export async function 挑一批 (配置, 行们, 选项 = {}) {
  const apiKey = 配置 && typeof 配置.apiKey === 'string' ? 配置.apiKey : ''

  // 统一的失败出口：所有错误文本都从这里走，保证必过一遍脱敏。
  const 失败 = (错误文本, usage) => ({
    ok: false,
    事项: [],
    错误: 脱敏(错误文本, apiKey),
    usage: usage || { 输入: 0, 输出: 0 },
  })

  const 缺 = 缺失配置(配置)
  if (缺.length > 0) return 失败(`配置不完整：缺少 ${缺.join('、')}`)

  const 渲染 = 渲染批次(行们)
  // 整批渲染出来是空的（比如这批全是空消息）：发请求纯属浪费，直接按
  // 「本批无事可记」成功返回
  if (渲染 === '') return { ok: true, 事项: [], 错误: '', usage: { 输入: 0, 输出: 0 } }

  // 把「当天日记里已经记过的事」一起告诉模型，让它自己避开。
  //
  // 为什么不靠事后做文本去重：模型每次措辞都不同，实测两句话的 2-gram
  // Jaccard 相似度只有 0.22（「过客决定重做日记插件」vs「过客在给小鱼儿做新的
  // 日记插件」），任何字符串相似度阈值都会漏判或误杀。让模型看着已有清单挑，
  // 才是这条链路上唯一可靠的做法。
  const 已记清单 = Array.isArray(选项 && 选项.已记) ? 选项.已记.filter(Boolean) : []
  const 已记段 = 已记清单.length > 0
    ? `\n\n【当天已经记进日记的内容，不要重复挑这些】\n${已记清单.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
    : ''

  // 告诉模型「这段聊天是谁和谁的」。
  // 为什么要说：私聊和群聊的重要标准不同 —— 私聊里的约定要记，
  // 群里的斗嘴不必记。不标注通道，模型会把群友闲聊也当成你的约定挑出来
  // （实测：不标来源时，群聊行混进私聊候选里，模型分不清说话的人是不是你）。
  const 来源段 = (选项 && 选项.来源标签) ? `\n通道：${选项.来源标签}（只看这个通道的聊天）` : ''

  const 用户消息 = `日期：${(选项 && 选项.date) || '未提供'}${来源段}${已记段}\n聊天记录：\n${渲染}`

  const 超时毫秒 = 取正数(配置.timeoutMs, 默认超时毫秒)
  const 控制器 = new AbortController()
  // 到点就 abort：挂在无响应的网关上干等比失败更伤（上层是串行的，一批挂着整天停摆）
  const 计时器 = setTimeout(() => 控制器.abort(), 超时毫秒)

  try {
    const 响应 = await fetch(接口地址(配置.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 密钥只允许出现在这里：请求头不会进任何日志、错误信息或返回值
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 配置.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: 用户消息 },
        ],
        temperature: 采样温度,
        max_tokens: 单批最大输出,
        // 额外参数透传：不同厂商的「思考模型」开关各不相同，没法在代码里逐个适配
        //（智谱 glm-5.3-flash 要 thinking:{type:'enabled'}，别家可能是别的字段名）。
        // 所以留这个口子，由调用方从配置里给，本模块原样合并进请求体。
        // 合并顺序放最后：允许它覆盖上面的默认值（比如某个模型必须调大 max_tokens）。
        ...(配置.额外参数 && typeof 配置.额外参数 === 'object' ? 配置.额外参数 : {}),
      }),
      signal: 控制器.signal,
    })

    const 状态 = 响应.status
    // 先整读成文本再解析：非 2xx 时要从里面截错误详情，读文本对大小不敏感
    const 正文 = await 响应.text()

    if (!(状态 >= 200 && 状态 < 300)) {
      // 注意顺序：先脱敏、再截 200 字。反过来截的话，密钥正好跨在截断点
      // 会被留下半截 —— 先整段替换就绝无可能。
      return 失败(`请求失败：HTTP ${状态}，响应体前 200 字：${脱敏(正文, apiKey).slice(0, 200)}`)
    }

    let 数据 = null
    try {
      数据 = JSON.parse(正文)
    } catch {
      数据 = null
    }
    if (!数据 || typeof 数据 !== 'object') {
      return 失败(`服务端返回的不是合法 JSON，响应体前 200 字：${脱敏(正文, apiKey).slice(0, 200)}`)
    }

    const usage = {
      输入: 取计数(数据.usage && 数据.usage.prompt_tokens),
      输出: 取计数(数据.usage && 数据.usage.completion_tokens),
    }

    const 回复 = 数据.choices && 数据.choices[0] && 数据.choices[0].message && 数据.choices[0].message.content
    if (typeof 回复 !== 'string' || 回复.trim() === '') {
      // 空 content 最常见的两个原因，必须写进错误里，否则用户完全无从下手：
      //   1. 用了「思考模型」（reasoning model）：思考过程吃光了 max_tokens，
      //      正文一个字都没剩。智谱 glm-5.3-flash 就是这种 —— 实测 3000 token
      //      全被 reasoning_content 用掉。解法是把 max_tokens 调到 6000 以上，
      //      并透传厂商的思考开关（如 {"thinking":{"type":"enabled"}}）。
      //   2. 模型只回了思考没有正文。
      // 判据：返回体里若存在 reasoning_content，就是第 1 种。
      const 有思考 = !!(数据.choices && 数据.choices[0] && 数据.choices[0].message &&
        数据.choices[0].message.reasoning_content)
      const 提示 = 有思考
        ? '这个模型是「思考模型」，思考过程把 max_tokens 用光了、正文没剩。' +
          '请在「额外参数」里把 max_tokens 调大（建议 6000 以上），必要时同时透传厂商的思考开关。'
        : '模型没有返回内容。可尝试调大「额外参数」里的 max_tokens，或换一个模型。'
      return 失败(`模型返回内容为空。${提示}`, usage)
    }

    const { 事项, 错误 } = 解析事项(回复, apiKey)
    if (错误 !== '') return 失败(错误, usage)
    return { ok: true, 事项, 错误: '', usage }
  } catch (错误对象) {
    // 能到这里的基本是网络层：DNS/连接失败、超时 abort 等。
    // 超时单独翻译成人话，其余带上原始 message 方便排障；
    // message 也过脱敏兜一手 —— 报错文本里理论上有可能带 URL。
    if (错误对象 && 错误对象.name === 'AbortError') {
      return 失败(`请求超时（${超时毫秒} 毫秒）`)
    }
    return 失败(`请求失败：${(错误对象 && 错误对象.message) || String(错误对象)}`)
  } finally {
    clearTimeout(计时器)
  }
}

/**
 * 「内容」的规范化比较键：去掉所有空白和标点（含全角/半角、常见符号），
 * 再统一小写。
 *
 * 【为什么去得这么狠】相邻两批各自概括同一件事时，一个带句号一个不带、
 * 一个全角逗号一个半角逗号是常态，只按原文全等比较几乎去不了重；
 * 大小写差异同理（英文内容）。规范化只用于比较键，保留下来的是
 * 先出现的那条原文，内容不受影响。
 *
 * @param {unknown} 文本
 * @returns {string}
 */
function 规范化键 (文本) {
  return String(文本 ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 按「内容」规范化后去重，保留先出现的（前面的批次时间上更早，顺序因此稳定）。
 * @param {Array<事项>} 事项们
 * @returns {Array<事项>}
 */
function 去重 (事项们) {
  const 见过的键 = new Set()
  const 结果 = []
  for (const 项 of 事项们) {
    const 键 = 规范化键(项 && 项.内容)
    if (键 === '') continue // 理论上到不了这里（解析时已滤过空内容），防一手
    if (见过的键.has(键)) continue
    见过的键.add(键)
    结果.push(项)
  }
  return 结果
}

/**
 * 把一整天的聊天交给模型挑（自动分批 + 合并去重）。
 *
 * 流程：校验配置 → 按行数切片 → 逐批**串行**请求 → 失败不中断 → 合并去重。
 *
 * 【为什么不并发】一天切成五六批时并发请求很容易撞上游的 RPM 限流（429），
 * 省下的那几秒不值得换来限流重试/退避的复杂度；分批的目的本来就是稳。
 *
 * 【ok 的语义】ok = 每一批都成功。部分失败时 ok:false，但「事项」里仍有
 * 成功批次的结果 —— 用不用由调用方自行决定。
 *
 * @param {object} 配置 同 挑一批：{baseURL, apiKey, model, timeoutMs?}
 * @param {Array<聊天行>} 行们 当天全部聊天行
 * @param {object} [选项]
 * @param {string} [选项.date] 当天日期（YYYY-MM-DD）
 * @param {number} [选项.每批行数=400] 切批大小（非法值回退默认）
 * @param {(进度: {已完成: number, 总批数: number, 本批事项数: number}) => void} [选项.进度回调]
 *   每批做完调一次；回调抛异常会被吞掉 —— 它只服务于 UI 进度条，
 *   不该有权力打断整个挑选流程
 * @returns {Promise<{ok: boolean, 事项: Array<事项>, 批数: number, 失败批数: number,
 *   usage: {输入: number, 输出: number}, 错误: string}>}
 *   错误 = 各失败批次的摘要（第 N 批失败：…，用；连接）；全部成功时为 ''
 *
 * @example
 * const 结果 = await 挑选一天(
 *   { baseURL: 'https://example.com/api/v4', apiKey: '***', model: 'glm-4-flash' },
 *   当天全部行,
 *   { date: '2026-11-03', 进度回调: (p) => console.log(`${p.已完成}/${p.总批数}`) },
 * )
 * if (!结果.ok) console.warn(结果.错误) // 部分批次失败，但仍可用 结果.事项
 */
export async function 挑选一天 (配置, 行们, 选项 = {}) {
  const apiKey = 配置 && typeof 配置.apiKey === 'string' ? 配置.apiKey : ''

  // —— 配置校验：缺了直接返回，绝不发请求 ——
  // 为什么这么严：没有 baseURL/model 时 fetch 会报难懂的底层错误，
  // 没有 apiKey 时请求必然 401；提前挡下来省一次注定失败的网络往返，
  // 错误信息也一眼能懂（且绝不携带密钥原文）。
  const 缺 = 缺失配置(配置)
  if (缺.length > 0) {
    return {
      ok: false,
      事项: [],
      错误: `配置不完整：缺少 ${缺.join('、')}`,
      批数: 0,
      失败批数: 0,
      usage: { 输入: 0, 输出: 0 },
    }
  }

  const 列表 = Array.isArray(行们) ? 行们 : []
  const 每批 = 取正数(选项 && 选项.每批行数, 默认每批行数)
  const 批次们 = []
  for (let 起 = 0; 起 < 列表.length; 起 += 每批) {
    批次们.push(列表.slice(起, 起 + 每批))
  }
  const 总批数 = 批次们.length

  const 合并事项 = []
  const 失败摘要 = []
  let 失败批数 = 0
  const usage = { 输入: 0, 输出: 0 }

  for (let 序号 = 0; 序号 < 总批数; 序号++) {
    // 撞限流/临时故障时退避重试。
    //
    // ⚠️ 这段是实测加上的：原先的设计写着「串行就够了，不值得引入退避复杂度」，
    //    但用免费的 Agnes 通道实测同一天 4 批，**4 批全部 429**——
    //    串行并不能避免限流，免费额度的 RPM 就是这么低。没有退避时，
    //    一整天全废、用户只看到一串「第 N 批失败」。
    //
    // 只重试「可重试」的失败：429 限流、超时、5xx。参数错误之类重试也没用，
    // 直接放过，免得白等。
    let 结果 = await 挑一批(配置, 批次们[序号], 选项)
    for (let 次 = 1; 次 <= 重试次数 && !结果.ok; 次++) {
      if (!可重试(结果.错误)) break
      // 指数退避：2s、4s、8s…给上游喘息窗口。
      // 等待期间也检查一次进度回调，让 UI 不至于看起来卡死。
      const 等 = 基础退避毫秒 * Math.pow(2, 次 - 1)
      await new Promise((r) => setTimeout(r, 等))
      结果 = await 挑一批(配置, 批次们[序号], 选项)
    }

    usage.输入 += (结果.usage && 结果.usage.输入) || 0
    usage.输出 += (结果.usage && 结果.usage.输出) || 0

    if (结果.ok) {
      合并事项.push(...结果.事项)
    } else {
      // 记下哪一批、为什么失败，但**不中断**：
      // 一批失败只该损失这一批（比如恰好网络抖动），把整天全放弃太亏。
      失败批数 += 1
      失败摘要.push(`第 ${序号 + 1} 批失败：${结果.错误}`)
    }

    if (typeof (选项 && 选项.进度回调) === 'function') {
      try {
        选项.进度回调({ 已完成: 序号 + 1, 总批数, 本批事项数: 结果.事项.length })
      } catch {
        // 进度回调坏了不该连累主流程（它只是给 UI 刷进度用的），吞掉异常
      }
    }
  }

  return {
    ok: 失败批数 === 0,
    事项: 去重(合并事项),
    批数: 总批数,
    失败批数,
    usage,
    // 挑一批返回的错误已各自脱敏过，这里再过一遍只是多上一道保险
    错误: 失败摘要.length > 0 ? 脱敏(失败摘要.join('；'), apiKey) : '',
  }
}
