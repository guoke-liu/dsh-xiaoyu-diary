// ============================================================================
// view.js —— 浏览器端 UI 的纯计算逻辑（脱离 React 可直接单测）
//
// 【这个模块负责什么】
//   把 lib/client.js 里散落在组件内部的「算数」集中到这里：
//   书本模式开书时翻到哪一页、当前在第几页、能不能上/下翻、
//   大模型通道的进度百分比与 20 格文本进度条、跳转日期的校验。
//   这些逻辑原来藏在 React 组件里，只能靠临时脚本验证；抽成纯函数后，
//   test/view.test.mjs 可以用 node --test 直接锁行为，不依赖浏览器。
//
// 【为什么这样设计】
//   · 全部是纯函数：不 import React、不碰 DOM、不发请求、没有副作用 ——
//     同样的输入永远同样的输出，测试不需要 mock 任何环境。
//   · 输入一律容错：pages 传 null/undefined 按空数组处理、当前日期传 null
//     按空串处理。后端字段缺失或接口刚失败时，UI 拿到的仍是可以直接渲染的
//     返回值，不会因为一次空值把整个面板炸掉。
//   · client.js 无法 import 本文件（宿主 __ModuleLoader__ 只注入 React，
//     不支持 ESM import），所以那边保留了一份逐字相同的副本；
//     改任意一边必须同步另一边（详见 client.js 内的 ⚠️ 注释）。
// ============================================================================

/**
 * 计算书本模式当前应该显示哪一页。
 * 规则：书签里的 lastDate 如果还在 pages 里，就翻到那页；否则落到最后一页。
 * @param {string[]} pages 所有有日记的日期（升序）
 * @param {string} lastDate 书签记录的日期（可能是空串，也可能已失效）
 * @returns {string} 起始日期；pages 为空时返回空串
 */
export function 选起始页 (pages, lastDate) {
  const 页 = pages || [];
  // 书签有效才翻回去：空串（从没存过书签）或已失效（那天的日记被清了）
  // 都落到最新一页 —— 「打开日记先看到最近写的」比「看到报错」合理
  if (lastDate && 页.includes(lastDate)) return lastDate;
  return 页[页.length - 1] || '';
}

/**
 * 计算书本模式的分页状态。
 * @param {string[]} pages 升序日期数组
 * @param {string} 当前 当前显示的日期
 * @returns {{页码:number, 总页数:number, 能上一页:boolean, 能下一页:boolean, 下标:number}}
 *   - 页码从 1 开始；当前日期不在 pages 里时 页码 为 0、下标 为 -1
 *   - 能上一页 = 下标 > 0
 *   - 能下一页 = 下标 >= 0 且 下标 < 总页数 - 1
 *   - 总页数 = pages.length
 */
export function 翻页状态 (pages, 当前) {
  const 页 = pages || [];
  const 总页数 = 页.length;
  const 现 = 当前 || '';
  // indexOf 找不到（书签悬空/日记刚被清）返回 -1：页码按 0 显示、两向都翻不了
  const 下标 = 页.indexOf(现);
  return {
    页码: 下标 >= 0 ? 下标 + 1 : 0,
    总页数,
    能上一页: 下标 > 0,
    能下一页: 下标 >= 0 && 下标 < 总页数 - 1,
    下标,
  };
}

/**
 * 计算进度条百分比。
 * @param {number} 已完成
 * @param {number} 总批数
 * @returns {number} 0-100 的整数；总批数 <= 0 时返回 0（不能除零）
 *   已完成 可能大于 总批数（后端预估偏差），要夹到 100
 */
export function 进度百分比 (已完成, 总批数) {
  const 总 = 总批数 || 0;
  // 任务刚开还没出分片：不能除零，界面显示「准备中…」
  if (总 <= 0) return 0;
  const 完 = 已完成 || 0;
  // 后端预估的批数可能偏小，已完成 > 总批数 时夹回 100，不出现「117%」
  return Math.max(0, Math.min(100, Math.round((完 / 总) * 100)));
}

/**
 * 把百分比渲染成 20 格文本进度条。
 * @param {number} 百分比 0-100
 * @returns {string} 例如 50 → '══════════──────────'（10 满格 + 10 空格）
 *   每格 5%，满格用 '═'，空格用 '─'；必须恰好 20 个字符
 */
export function 进度条文本 (百分比) {
  // 每格 5%；百分比理论上 0-100，防御性夹回 0..20 格，
  // 保证任何输入下长度都恰好 20（这是渲染对齐的硬前提）
  const 满格数 = Math.max(0, Math.min(20, Math.floor((百分比 || 0) / 5)));
  const 空格数 = Math.max(0, 20 - 满格数);
  return '═'.repeat(满格数) + '─'.repeat(空格数);
}

/**
 * 判断一个日期能不能跳过去（书本模式的跳转校验）。
 * @param {string[]} pages
 * @param {string} 目标日期
 * @returns {{可跳:boolean, 提示:string}}
 *   - 目标为空串 → {可跳:false, 提示:''}（用户没选，不报错）
 *   - 目标不在 pages 里 → {可跳:false, 提示:'那天没有日记'}
 *   - 在 pages 里 → {可跳:true, 提示:''}
 */
export function 校验跳转 (pages, 目标日期) {
  const 页 = pages || [];
  const 目标 = 目标日期 || '';
  // 空串 = 用户只是清空了日期框，不是操作失误：静默不动，不弹提示打扰
  if (!目标) return { 可跳: false, 提示: '' };
  // 那天没有日记：明确提示一句，让用户知道是「没数据」而不是「界面坏了」
  if (!页.includes(目标)) return { 可跳: false, 提示: '那天没有日记' };
  return { 可跳: true, 提示: '' };
}
