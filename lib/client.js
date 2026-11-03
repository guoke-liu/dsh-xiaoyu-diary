// ============================================================================
// client.js —— 小鱼日记的浏览器端 UI（React，宿主注入，零第三方依赖）
//
// 【这个模块负责什么】
//   往宿主设置页挂一个「小鱼日记」区块，提供两种阅读模式：
//     · 挑选模式（默认）：按天列出候选，逐条「放进去 / 不放」，支持批量全放 / 全排除
//       —— 顶部还有一块「大模型通道」：填 LLM 配置 + 一键让模型挑 + 逐条「记进日记」
//     · 书本模式（点「📖 翻开日记」切换）：一天一页，可翻页 / 跳转，记住读到第几页
//   所有数据都来自后端 12 条 HTTP 路由（lib/routes.js），本文件不含业务逻辑。
//
// 【为什么这样设计】
//   · React 由宿主通过 factory(require) 注入，零第三方依赖：宿主转译 / 不转译
//     都能跑，不引任何 npm 包，不引入 TypeScript。
//   · 必须用 window.__ModuleLoader__.load({ id, factory }) 而不是 ESM export：
//     宿主只认这个包装壳，React 从 factory 的 require('react') 取；
//     写成 globalThis.React 或 ESM export 都会导致页面白屏（对照
//     dsh-structured、dsh-memory-vault 跑通的写法）。
//   · 用 React.createElement（别名 ce）而不是 JSX：宿主可能不转译 JSX，
//     createElement 是两种路径都安全的写法。
//   · 网络失败只降级显示（空态 + 重试按钮），绝不让页面白屏。
//   · LLM 通道默认收起，避免没配 key 的用户每次打开设置页都被输入框占屏。
//
// 【对外导出】
//   本文件不是模块（没有 import / export），而是直接挂到
//   window.__ModuleLoader__。宿主拿到 factory 返回的 module.exports：
//     · apply(ctx) —— 往 settings.section 挂「小鱼日记」区块
//     · inject —— 本组件需要宿主提供的服务清单（['slots']）
//     · Section —— 主面板组件（挑选模式 + 书本模式切换）
// ============================================================================
window.__ModuleLoader__.load({
  id: '@local/xiaoyu-diary',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const inject = ['slots'];

    // ── 接口前缀：要跟着 DSH 页面的部署路径走，不能写死 ────────────────────
    // 【症状】云端 DSH 挂在 nginx 的 /dsh/ 下（/dsh/ → 反代 127.0.0.1:6600/，
    //   DSH 自己不知道有这层前缀）。写死的 '/local/xiaoyu-diary' 是站点根绝对路径，
    //   浏览器会请求 http://<host>/local/... —— 那里是 noVNC 站点、要 Basic 密码 → 401。
    //   手机翻书报「书签读不到：HTTP 401」就是这个。
    // 【正解】请求必须带页面自己的前缀：http://<host>/dsh/local/xiaoyu-diary/...，
    //   这样才会经 nginx 的 /dsh/ 落到 DSH 上那些 /local/... 路由。
    //   浏览器把相对地址按「当前目录」解析，所以：
    //     http://h/      → 'local/xiaoyu-diary'      → http://h/local/...        ✅
    //     http://h/dsh/  → 'local/xiaoyu-diary'      → http://h/dsh/local/...    ✅
    //   即：**直接用不带斜杠的相对路径**，站点根和子路径两种部署都对。
    //   ⚠️ 千万别写成 '/local/...'（绝对路径，会丢掉 /dsh/ 前缀）或 './local/...'
    //   （在 /dsh/ 下也对，但会被当成"当前目录"，不如裸相对路径直观）。
    // 【兜底】没有 document（纯 node 单测）时退回绝对路径，行为与旧版一致。
    const BASE = (() => {
      try {
        return typeof document !== 'undefined' && document ? 'local/xiaoyu-diary' : '/local/xiaoyu-diary';
      } catch (e) {
        return '/local/xiaoyu-diary';
      }
    })();
    const ce = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;

    /** 三种取舍状态，与后端 store.js 的 候选状态 对齐。 */
    const S = { 待定: 'pending', 放进去: 'accepted', 不放: 'rejected' };

    /** 拉 JSON；任何失败都返回 { ok:false, error }，不抛。 */
    async function api(path, opts) {
      try {
        const r = await fetch(BASE + path, opts);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, error: (j && j.error) || `HTTP ${r.status}` };
        return j;
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    /** 提交 JSON。 */
    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    }

    // ⚠️ 这里的 5 个纯函数与 lib/view.js 是同一份逻辑的副本：
    //    · lib/view.js  —— 可被 node 单测直接 import
    //    · 这里            —— 浏览器端无法 import，只能内联
    // 改任意一边必须同步另一边，test/view.test.mjs 锁的是 view.js 那份。
    // （之所以不共享：宿主的 __ModuleLoader__ 只注入 React，不支持 ESM import。）

    /** 计算书本模式当前应该显示哪一页：书签有效翻书签，失效落最后一页。 */
    function 选起始页 (pages, lastDate) {
      const 页 = pages || [];
      if (lastDate && 页.includes(lastDate)) return lastDate;
      return 页[页.length - 1] || '';
    }

    /** 计算书本模式的分页状态：页码从 1 起；找不到当前日期时 页码 0、下标 -1。 */
    function 翻页状态 (pages, 当前) {
      const 页 = pages || [];
      const 总页数 = 页.length;
      const 现 = 当前 || '';
      const 下标 = 页.indexOf(现);
      return {
        页码: 下标 >= 0 ? 下标 + 1 : 0,
        总页数,
        能上一页: 下标 > 0,
        能下一页: 下标 >= 0 && 下标 < 总页数 - 1,
        下标,
      };
    }

    /** 计算进度条百分比：总批数 <= 0 返回 0（不能除零）；超过 100 夹到 100。 */
    function 进度百分比 (已完成, 总批数) {
      const 总 = 总批数 || 0;
      if (总 <= 0) return 0;
      const 完 = 已完成 || 0;
      return Math.max(0, Math.min(100, Math.round((完 / 总) * 100)));
    }

    /** 把百分比渲染成 20 格文本进度条：每格 5%，满格 '═'、空格 '─'，恰好 20 字符。 */
    function 进度条文本 (百分比) {
      const 满格数 = Math.max(0, Math.min(20, Math.floor((百分比 || 0) / 5)));
      const 空格数 = Math.max(0, 20 - 满格数);
      return '═'.repeat(满格数) + '─'.repeat(空格数);
    }

    /** 跳转校验：空串=用户没选（静默）；不在 pages 里提示「那天没有日记」。 */
    function 校验跳转 (pages, 目标日期) {
      const 页 = pages || [];
      const 目标 = 目标日期 || '';
      if (!目标) return { 可跳: false, 提示: '' };
      if (!页.includes(目标)) return { 可跳: false, 提示: '那天没有日记' };
      return { 可跳: true, 提示: '' };
    }

    // 样式全部内联，不依赖宿主的 CSS 变量，深色浅色都能看
    const st = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      hint: { opacity: 0.7, fontSize: 12 },
      btn: {
        padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)',
        background: 'transparent', cursor: 'pointer', fontSize: 12, color: 'inherit',
      },
      btnOn: {
        padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)',
        background: 'rgba(128,128,128,.18)', cursor: 'pointer', fontSize: 12,
        color: 'inherit', fontWeight: 600,
      },
      input: {
        padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)',
        background: 'transparent', color: 'inherit', fontSize: 12, minWidth: 200,
      },
      card: {
        border: '1px solid rgba(128,128,128,.28)', borderRadius: 8, padding: '8px 10px',
        display: 'flex', flexDirection: 'column', gap: 4,
      },
      meta: { fontSize: 11, opacity: 0.65, display: 'flex', gap: 8, flexWrap: 'wrap' },
      chip: {
        fontSize: 10, padding: '1px 6px', borderRadius: 999,
        border: '1px solid rgba(128,128,128,.4)', opacity: 0.85,
      },
      err: { color: '#d33', fontSize: 12 },
      ok: { color: '#2a8', fontSize: 12 },
      // 书本模式：做成「一本书」的样子 —— 边框 + 圆角 + 阴影 + 居中 + 宽度适中
      book: {
        maxWidth: 640, margin: '0 auto', padding: '14px 16px',
        border: '1px solid rgba(128,128,128,.45)', borderRadius: 10,
        boxShadow: '0 2px 8px rgba(0,0,0,.15)',
        background: 'rgba(128,128,128,.06)',
        display: 'flex', flexDirection: 'column', gap: 10,
      },
      bookPage: {
        minHeight: 160, display: 'flex', flexDirection: 'column', gap: 8,
        borderLeft: '1px solid rgba(128,128,128,.3)', paddingLeft: 12,
      },
      bookNav: { display: 'flex', justifyContent: 'space-between', gap: 8 },
      bookEntry: { lineHeight: 1.5, fontSize: 13 },
      // 大模型通道：配置折叠区 + 触发按钮 + 结果卡片 + 实时进度
      fold: {
        border: '1px solid rgba(128,128,128,.28)', borderRadius: 8,
        background: 'rgba(128,128,128,.05)',
      },
      foldHead: {
        padding: '6px 10px', cursor: 'pointer', userSelect: 'none',
        fontSize: 12, opacity: 0.85, display: 'flex', gap: 6, alignItems: 'center',
      },
      foldBody: { padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 },
      foldRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      lbl: { fontSize: 12, opacity: 0.7, minWidth: 70 },
      textarea: {
        padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)',
        background: 'transparent', color: 'inherit', fontSize: 12,
        minHeight: 56, width: '100%', boxSizing: 'border-box',
        fontFamily: 'monospace',
      },
      pickBtn: {
        padding: '8px 14px', borderRadius: 8, border: '1px solid rgba(128,128,128,.5)',
        background: 'rgba(128,128,128,.15)', cursor: 'pointer', fontSize: 13,
        fontWeight: 600, color: 'inherit', marginTop: 4,
      },
      item: {
        border: '1px solid rgba(128,128,128,.28)', borderRadius: 8, padding: '8px 10px',
        display: 'flex', flexDirection: 'column', gap: 4,
      },
      itemHead: { display: 'flex', gap: 8, alignItems: 'flex-start' },
      // 进度条：外层灰色底 + 内层按比例填充
      progressWrap: {
        display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 4,
      },
      progressOuter: {
        width: '100%', maxWidth: 280, height: 8, borderRadius: 4,
        background: 'rgba(128,128,128,.15)', overflow: 'hidden',
      },
      progressInner: {
        height: '100%', borderRadius: 4,
        background: 'rgba(42,136,136,.85)',
        transition: 'width .3s ease',
      },
      // 版本条：标题行底下的一行小字；有新版本时另起一条高亮框。
      // 用半透明灰/青而不是写死颜色，深浅主题下都看得见。
      verBar: { fontSize: 11, opacity: 0.7, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      verNew: {
        border: '1px solid rgba(42,136,136,.75)', borderRadius: 8,
        background: 'rgba(42,136,136,.10)', padding: '8px 10px',
        display: 'flex', flexDirection: 'column', gap: 6,
      },
      verHead: { fontSize: 12, fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      verLog: {
        fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', opacity: 0.85,
        fontFamily: 'inherit', margin: 0,
      },
    };

    /**
     * 版本条：显示当前版本，有新版本时给一条提示 + 更新日志。
     *
     * 【为什么做成独立组件】它有自己的网络请求（/version）、自己的加载态，
     *   跟候选/书本完全无关。挂在 Section 上会让 Section 再多三个 state，
     *   而 Section 已经有十几个了。
     *
     * 【为什么不自动弹窗】主人明确要的是「更新推送」，但日记插件的设置页
     *   不该像流氓软件一样弹提示。所以做成一行灰字 + 有新版本时高亮一条，
     *   用户自己决定要不要点开看。
     *
     * 【为什么默认不显示检查失败】检查更新依赖 GitHub，网络不通很正常。
     *   失败时只在**用户主动点「重新检查」之后**才显示原因；静默挂载时
     *   失败就当没有这回事（显示「暂时查不到」一行小字，不弹红字）。
     *   不然用户每次开设置页都看到一串红字，会以为插件坏了。
     *
     * 【只问一次】挂载时查一次就够。后台/服务器会缓存 30 分钟，
     *   所以即使反复开设置页也不会把 GitHub 的配额点光。
     */
    function 版本条() {
      const [版本, set版本] = useState(null); // /version 的返回
      const [载入中, set载入中] = useState(true);
      const [用户重查错, set用户重查错] = useState(''); // 只有用户主动点了才显示
      const 已卸载 = useRef(false);

      async function 拉(强制) {
        set载入中(true);
        const r = await api(`/version${强制 ? '?force=1' : ''}`);
        if (已卸载.current) return;
        set载入中(false);
        if (!r.ok) {
          // 后端路由本身挂了（不该发生）—— 当作用户重查错误显示，因为这次是用户视角
          if (强制) set用户重查错(r.error || '检查失败');
          return;
        }
        set版本(r);
        if (强制) set用户重查错('');
      }

      useEffect(() => {
        已卸载.current = false;
        拉(false);
        return () => { 已卸载.current = true; };
      }, []);

      // 连当前版本都还没拿到：什么都不显示，让别人家的界面先出来
      if (!版本) {
        return 用户重查错
          ? ce('div', { style: st.err }, `版本检查失败：${用户重查错}`)
          : null;
      }

      const 检查 = 版本.检查结果 || {};
      const 有新 = 版本.有新版本 === true;
      // 检查失败时**不谎报已是最新**，如实说「暂时查不到」
      const 查不到 = 检查.ok === false;
      const 仓库地址 = 版本.仓库地址 || '';

      return ce(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        // ── 一行小字：当前版本 + 重新检查 ──
        ce('div', { style: st.verBar },
          ce('span', null, `当前版本 ${版本.当前版本 || '未知'}`),
          有新
            ? ce('span', { style: { fontWeight: 600, color: '#2a8' } }, `→ 有新版 ${版本.最新版本}`)
            : 载入中
              ? ce('span', null, '正在检查更新…')
              : 查不到
                ? ce('span', null, '更新状态：暂时查不到')
                : ce('span', null, '已是最新'),
          ce('button', {
            style: st.btn,
            disabled: 载入中,
            onClick: () => 拉(true),
            title: '重新去 GitHub 问一次（会跳过 30 分钟缓存）',
          }, 载入中 ? '检查中…' : '重新检查'),
          仓库地址
            ? ce('a', {
                href: 仓库地址,
                target: '_blank',
                rel: 'noopener noreferrer',
                style: { color: 'inherit', fontSize: 11, opacity: 0.8 },
              }, '打开仓库 ↗')
            : null,
        ),

        // 用户主动重查才显示失败原因（静默失败时只说「暂时查不到」）
        用户重查错 ? ce('div', { style: st.err }, `检查失败：${用户重查错}`) : null,

        // ── 有新版本：高亮一条，带更新日志 ──
        有新
          ? ce('div', { style: st.verNew },
              ce('div', { style: st.verHead },
                ce('span', null, `🎉 有新版本 ${版本.最新版本}`),
                ce('span', { style: { fontSize: 11, opacity: 0.7 } },
                  `你装的是 ${版本.当前版本}`),
              ),
              ce('pre', { style: st.verLog }, 版本.更新说明 || '（仓库没给更新说明，点「打开仓库」看改动）'),
              ce('div', { style: { fontSize: 11, opacity: 0.7 } },
                '升级方式：到插件目录 git pull 后重启 dsh。这里只提示，不会替你改动已装的东西。'),
            )
          : null,
      );
    }

    /** 一条候选卡片：显示内容 + 为什么被挑中 + 三个取舍按钮。 */
    function 候选卡(props) {
      const it = props.it;
      const 已放 = it.状态 === S.放进去;
      const 不放 = it.状态 === S.不放;
      const 边 = 已放
        ? '1px solid rgba(42,136,136,.75)'
        : 不放
          ? '1px dashed rgba(128,128,128,.45)'
          : '1px solid rgba(128,128,128,.28)';
      const 样式 = Object.assign({}, st.card, { border: 边, opacity: 不放 ? 0.55 : 1 });
      return ce(
        'div',
        { style: 样式 },
        ce(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
          ce('div', { style: { flex: 1, lineHeight: 1.5, textDecoration: 不放 ? 'line-through' : 'none' } }, it.内容),
          ce('div', { style: { display: 'flex', gap: 4, flexShrink: 0 } },
            ce('button', {
              style: 已放 ? st.btnOn : st.btn,
              onClick: () => props.决定(it.cid, 已放 ? S.待定 : S.放进去),
              title: 已放 ? '点一下撤回（同时从日记里删掉）' : '放进日记',
            }, 已放 ? '✓ 已放入' : '放进去'),
            ce('button', {
              style: 不放 ? st.btnOn : st.btn,
              onClick: () => props.决定(it.cid, 不放 ? S.待定 : S.不放),
              title: 不放 ? '点一下恢复待定' : '这条不要',
            }, 不放 ? '✕ 已排除' : '不放'),
          ),
        ),
        ce('div', { style: st.meta },
          ce('span', null, `[${it.时间}] ${it.昵称}`),
          (it.命中 || []).map((h, i) => ce('span', { key: i, style: st.chip }, h)),
          it.条目id ? ce('span', { style: st.chip }, `日记 ${it.条目id}`) : null,
        ),
      );
    }

    /** 书页模式的一本书：一天一页，能翻页、能跳转、记住翻到第几页。
     *  为什么单独拆组件：翻页状态（页码/加载/提示）只在书本模式有意义，
     *  挂在 Section 里会污染默认界面；拆出来状态互不干扰。
     *  重新挂载（key 换掉）会重跑「开书」逻辑 —— Section 用 key 控制：
     *  每次点进书本模式都从书签/最后一页起步，符合「进入书本模式时」的规格。 */
    function 书(props) {
      // 来源：这本书是「哪个来源」的。每个来源是**独立的一本书**，
      // 各有自己的书签 —— 在私聊里读到第 3 页，切到群里不该跳到第 3 页。
      const 源 = (props && props.来源) || '';
      const 源标签 = (props && props.标签) || '';
      const [书, set书] = useState({ 载入中: true, 页: [], 当前: '', 载入失败: '' });
      const [当日, set当日] = useState(null); // GET /entries 的结果
      const [当日失败, set当日失败] = useState('');
      const [跳提示, set跳提示] = useState('');

      /** 拉书签：翻到 lastDate（若它在 pages 里），否则翻到最后一页。 */
      async function 开书() {
        set书({ 载入中: true, 页: [], 当前: '', 载入失败: '' });
        const b = await api(`/bookmark?来源=${encodeURIComponent(源)}`);
        if (!b.ok) {
          // 后端挂了不能白屏：没有页就显示「还没有任何日记」，让读者去「重新提取这天」
          set书({ 载入中: false, 页: [], 当前: '', 载入失败: b.error || '书签读取失败' });
          return;
        }
        const 页 = b.pages || [];
        // 优先翻回上次读到的位置；没有记录或记录已不在（日记被清）就落到最新一页
        // （选起始页 与 lib/view.js 同源：书签有效翻书签，失效/为空落最后一页）
        const 起点 = 选起始页(页, b.lastDate);
        set书({ 载入中: false, 页, 当前: 起点, 载入失败: '' });
        if (起点) 载当日(起点);
      }

      async function 载当日(d) {
        set当日(null); set当日失败('');
        const e = await api(`/entries?来源=${encodeURIComponent(源)}&date=${encodeURIComponent(d)}`);
        if (!e.ok) { set当日失败(e.error || '这一页读失败了'); return; }
        set当日(e);
      }

      /** 翻到指定日期（含上一页/下一页/跳转）：只改「当前」并写回书签。
       *  用函数式 set 读 prev，是因为翻页按钮的闭包里拿到的 书 可能是上一帧的旧值，
       *  函数式更新保证校验（那天有没有日记）始终基于最新状态。 */
      async function 翻到(d) {
        set跳提示('');
        let 合法 = false;
        set书((prev) => {
          const 页 = prev.页;
          if (页.length === 0 || !页.includes(d)) return prev; // 那天没有日记：不动
          合法 = true;
          return Object.assign({}, prev, { 当前: d });
        });
        if (!合法) return;
        await 载当日(d);
        // 每次翻页（含跳转）都把位置存回书签；失败静默忽略，不打断阅读
        post('/bookmark', { 来源: 源, lastDate: d }).catch(() => {});
      }

      // 「跳提示」的触发逻辑：select 直接 onChange 就翻；date 输入框要判断那天有没有日记
      function 选日期跳(e) { 翻到(e.target.value); }
      function 手动跳(e) {
        const d = e.target.value;
        // 校验收进纯函数（与 lib/view.js 同源）：
        //   空串 = 用户没选日期，静默不动（提示为空，不 set）
        //   那天没有日记 = 提示一句，不翻页
        const v = 校验跳转(书.页, d);
        if (!v.可跳) {
          if (v.提示) set跳提示(v.提示);
          return;
        }
        翻到(d);
      }

      useEffect(() => { 开书(); /* 只在挂载时开书一次，之后由翻到/跳转驱动 */ }, []);

      const 页 = 书.页;
      // 分页状态收进纯函数（与 lib/view.js 同源）：页码/总页数/能否上翻下翻。
      // 解构沿用原来的局部变量名，下面的渲染结构一行不改。
      const { 页码: N, 总页数: M, 能上一页: 能上, 能下一页: 能下, 下标 } = 翻页状态(页, 书.当前);
      const 条 = (当日 && 当日.entries) || [];

      // 载入失败时降级：给一句提示 + 重试，不白屏
      if (书.载入失败) {
        return ce('div', { style: st.book },
          ce('div', { style: st.err }, `书签读不到：${书.载入失败}`),
          ce('button', { style: st.btn, onClick: 开书 }, '再试一次'));
      }

      // 一页日记都没有（pages 为空数组）：不是错误，是正常空态
      if (M === 0) {
        return ce('div', { style: st.book },
          ce('div', { style: st.hint }, '还没有任何日记'),
          ce('div', { style: st.hint }, '回到挑选模式提取候选，放进去了就有第一页。'));
      }

      return ce(
        'div',
        { style: st.book },
        // 顶部：第 N 页 / 共 M 页 + 当前日期 + 跳转
        ce('div', { style: st.row },
          ce('span', { style: { fontWeight: 600 } },
            书.当前 ? `第 ${N} 页 / 共 ${M} 页　${书.当前}` : `共 ${M} 页`),
        ),
        ce('div', { style: st.row },
          ce('select', { style: st.input, value: 书.当前, onChange: 选日期跳 },
            页.map((d) => ce('option', { key: d, value: d }, d))),
          ce('input', {
            type: 'date', style: st.input, value: 书.当前,
            min: 页[0], max: 页[M - 1],
            onChange: 手动跳,
          }),
          跳提示 ? ce('span', { style: st.hint }, 跳提示) : null,
        ),
        // 中间：当天日记
        ce('div', { style: st.bookPage },
          当日失败
            ? ce('div', { style: st.err }, 当日失败)
            : 当日 === null
              ? ce('div', { style: st.hint }, 书.载入中 ? '翻开中…' : '翻到日子了…')
              : 条.length === 0
                ? ce('div', { style: st.hint }, '这一页是空的')
                : 条.map((e) => ce('div', { key: e.id, style: st.bookEntry },
                    ce('div', null, e.text),
                    (e.tags || []).length > 0
                      ? ce('div', { style: st.meta }, (e.tags || []).map((t, i) => ce('span', { key: i, style: st.chip }, t)))
                      : null,
                  )),
        ),
        // 左右翻页：第一页不能上，最后一页不能下
        ce('div', { style: st.bookNav },
          ce('button', {
            style: st.btn, disabled: !能上,
            onClick: () => { if (能上) 翻到(页[下标 - 1]); },
          }, '‹ 上一页'),
          ce('button', {
            style: st.btn, disabled: !能下,
            onClick: () => { if (能下) 翻到(页[下标 + 1]); },
          }, '下一页 ›'),
        ),
      );
    }

    /**
     * 大模型通道：LLM 配置（可折叠，默认收起）+ 一键触发（异步任务 + 实时进度）+ 结果列表。
     *
     * 为什么单独拆组件：
     *   · 配置输入、保存态、触发态、结果列表这一堆状态只服务 LLM 通道，
     *     挂在 Section 上会污染主界面（候选卡的 10 多个 state 已经够多了）。
     *   · 配置区默认收起：没配 key 的用户每次打开设置页都不该被输入框占屏；
     *     收起时本组件只渲染一个折叠头，对现有界面无影响。
     *   · 「记进日记」走 quick-write 路由（POST /local/xiaoyu-diary/quick-write），
     *     不走 candidates/decide —— 模型候选没有 cid，不经过候选暂存区，
     *     直接追加一条新日记（tags 打「大模型」方便检索过滤）。
     *   · 触发改为异步任务（llm-pick-async → llm-pick-progress 轮询）：
     *     思考模型一天可能跑 6 批、每批 40-60 秒，同步调用会让用户干等好几分钟
     *     且无法取消；异步后用户随时能看到「第 3 / 6 批」并中途取消。
     *
     * 失败降级：任何 fetch 失败都就地显示错误文案，绝不白屏；
     * 配置读取失败也不影响触发按钮（点了再报「配置不完整」）。
     */
    function 大模型通道 (props) {
      const 日期 = props.日期; // 当前选中的日期（来自 Section）
      // 来源：本组件只管「当前视角」这一个来源的挑选任务。
      // 私聊和群各是独立任务 —— 切换来源时 Section 用 key 重挂载本组件，
      // 正在跑的轮询会被卸载逻辑干净地停掉，不会串台到另一个来源。
      const 源 = props.来源 || '';
      const 源标签 = props.标签 || '';
      const [收起, set收起] = useState(true);
      const [配, set配] = useState({ baseURL: '', apiKey: '', model: '', 额外参数: '' });
      const [配错, set配错] = useState('');
      const [已存, set已存] = useState('');
      const [存忙, set存忙] = useState(false);
      const [挑中, set挑中] = useState(false); // 任务在跑（异步轮询期间）
      const [结果, set结果] = useState(null); // { ok, 日期, 行数, 事项, 已有条数, 错误, 已过滤, 结果? }
      const [写状态, set写状态] = useState({}); // key:idx -> 'ok' | 'busy' | 'err'
      const [进度, set进度] = useState(null); // 轮询拿到的 progress 对象，done/failed 后保留最终值
      const [取消忙, set取消忙] = useState(false);

      // 轮询句柄：
      //   定时句柄 —— setTimeout 的 id；null 表示当前没有排定的下一次轮询。
      //   已卸载 —— 组件卸载标记：定时器回调里先检查它，避免卸载后再 set 状态
      //   job 守卫 —— 当前轮询的 jobId；取消/卸载时把守卫改成无效值，
      //     让在途的那次请求回来后静默丢弃（不 set 状态），防止"僵尸轮询"继续跑。
      // 为什么用 ref 而不是 state：轮询回调里要读"最新值"决定继续还是停，
      // state 的闭包值会过期，ref.current 永远是最新的。
      const 定时句柄 = useRef(null); // 注意：useRef 在宿主注入的 React 里可用
      const 轮询job = useRef(null); // 当前正在轮询的 jobId；停止后置 null
      const 已卸载 = useRef(false);

      /** 拉一次脱敏配置填进输入框；失败只记一句提示，不白屏。 */
      async function 拉配置() {
        const r = await api('/llm-config');
        if (r.ok) {
          const c = r.配置 || {};
          set配({
            baseURL: c.baseURL || '',
            apiKey: c.apiKey || '', // 脱敏值：*** 或 ''
            model: c.model || '',
            额外参数: c.额外参数 && Object.keys(c.额外参数).length
              ? JSON.stringify(c.额外参数, null, 2)
              : '',
          });
        } else {
          set配错(`配置读取失败：${r.error || '未知'}`);
        }
      }
      // 只在展开时拉一次（收起 → 展开的瞬间填值；重复展开不重拉，避免覆盖未保存的编辑）
      useEffect(() => {
        if (!收起) 拉配置();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [收起]);

      /** 保存：额外参数 JSON 不合法时提示但**允许保存**（spec 要求），
       *  把原字符串透传，后端 写配置 会因类型检查跳过非对象值。 */
      async function 保存() {
        set存忙(true); set已存(''); set配错('');
        let 额外 = {};
        if (配.额外参数.trim() !== '') {
          try {
            const p = JSON.parse(配.额外参数);
            if (p && typeof p === 'object' && !Array.isArray(p)) 额外 = p;
            else set配错('额外参数不是 JSON 对象，本次未保存该字段');
          } catch {
            set配错('额外参数不是合法 JSON，本次未保存该字段（其余字段照常保存）');
          }
        }
        // apiKey 是 *** 说明没改：直接透传给后端，后端会保留磁盘上的真值
        const r = await post('/llm-config', {
          baseURL: 配.baseURL,
          apiKey: 配.apiKey,
          model: 配.model,
          额外参数: 额外,
        });
        set存忙(false);
        if (!r.ok) { set配错(`保存失败：${r.error || '未知'}`); return; }
        if (r.缺 && r.缺.length) set已存(`已保存，但还缺：${r.缺.join('、')}`);
        else set已存('已保存');
      }

      /**
       * 轮询进度：拉一次 llm-pick-progress，running 则再排下一次，done/failed 就停。
       *
       * 为什么用 setTimeout 递归而不用 setInterval：
       *   思考模型每批 40-60 秒，单次 GET 在慢网络/负载高峰下也可能几百毫秒。
       *   setInterval 是"固定节拍"，上一发还没回来就排下一发，请求会堆积排队，
       *   越堆越慢；而"请求回来后才排下一次"的 setTimeout 递归保证同一时刻
       *   永远只有一个在途请求，2 秒是两次请求完成之间的最小间隔，不会漏也不会叠。
       *
       * 怎么保证停掉（三条路）：
       *   1. 任务完成/失败：状态不再是 running，直接不排下一次；
       *   2. 用户点取消：取消成功后把 轮询job 守卫置 null，
       *      在途回调回来一看守卫不匹配就静默丢弃；
       *   3. 组件卸载：useEffect 清理里把 已卸载 置 true 并 clearTimeout，
       *      同时清掉守卫。卸载后即使有在途请求回来，回调顶部一检查已卸载就 return。
       */
      function 轮询(jobId) {
        // 已卸载：组件不在了，任何在途回调直接丢弃，不碰 setState
        if (已卸载.current) return;
        // 守卫：当前轮询的 job 必须匹配，否则是旧任务的僵尸回调，丢弃
        if (轮询job.current !== jobId) return;
        (async () => {
          const p = await api(`/llm-pick-progress?jobId=${encodeURIComponent(jobId)}`);
          // 请求回来后再检查一次：等待期间可能已卸载或已切任务
          if (已卸载.current || 轮询job.current !== jobId) return;
          if (p.ok && p.状态) {
            set进度(p);
            if (p.状态 === 'running') {
              // 还在跑：排下一次。
              // 句柄存进 ref，取消/卸载时能 clearTimeout 掐掉尚未触发的这一次
              定时句柄.current = setTimeout(() => 轮询(jobId), 2000);
            } else {
              // done / failed：停止轮询（不排下一次），清掉句柄引用
              定时句柄.current = null;
              轮询job.current = null;
              set挑中(false);
              // 把最终结果灌进 结果 供下方渲染（复用现有的 事项 列表逻辑）
              if (p.状态 === 'done') {
                set结果(Object.assign({}, p.结果 || {}, {
                  ok: true,
                  事项: p.事项 || [],
                  已过滤: p.已过滤 || 0,
                  日期: p.日期 || 日期,
                  行数: p.行数,
                }));
              } else {
                set结果({
                  ok: false,
                  事项: [],
                  错误: p.错误 || '任务失败',
                  日期: p.日期 || 日期,
                });
              }
            }
          } else if (p.ok) {
            // 后端 ok 但没给 状态（不该发生）：别停，继续轮询
            定时句柄.current = setTimeout(() => 轮询(jobId), 2000);
          } else {
            // 拉进度本身失败（网络断了/后端 500）：降级显示，停止轮询，
            // 任务在后端可能还在跑，但 UI 侧不再等它 —— 恢复可点，用户可重试
            定时句柄.current = null;
            轮询job.current = null;
            set挑中(false);
            set结果({ ok: false, 事项: [], 错误: `进度查询失败：${p.error || '未知'}`, 日期 });
          }
        })();
      }

      /** 触发：开一个异步挑选任务，然后进入轮询。 */
      async function 挑() {
        set挑中(true); set结果(null); set写状态({}); set进度(null);
        const r = await post('/llm-pick-async', { date: 日期, 来源: 源 });
        if (!r.ok || !r.jobId) {
          // 没开出任务（配置不完整/没聊天记录）：不轮询，直接降级显示
          set挑中(false);
          set结果({ ok: false, 日期: r.日期 || 日期, 事项: [], 已有条数: 0, 错误: r.错误 || r.error || '无法开任务' });
          return;
        }
        // 拿到 jobId：从这一刻起 轮询job 守卫生效，先停掉上一个可能还在的定时（幂等）
        if (定时句柄.current) clearTimeout(定时句柄.current);
        轮询job.current = r.jobId;
        轮询(r.jobId);
      }

      /** 取消：调 llm-pick-cancel。成功后守卫置 null，在途的进度回调回来会自动丢弃。 */
      async function 取消() {
        const jobId = 轮询job.current;
        if (!jobId) return;
        set取消忙(true);
        await post('/llm-pick-cancel', { jobId });
        set取消忙(false);
        // 无论取消成功与否都停止 UI 侧轮询：任务已经被取消了（或后端会自行处理）
        if (定时句柄.current) clearTimeout(定时句柄.current);
        定时句柄.current = null;
        轮询job.current = null; // 守卫失效：在途回调回来会静默丢弃
        set挑中(false);
        set进度(null);
      }

      /**
       * 组件卸载清理：这是"三种停止情形"里最关键的一条 ——
       * 用户在任务跑完前切走设置页/换了区块，定时器必须被掐掉，
       * 否则组件卸载后回调里还调 setState 会报警告甚至泄漏（严格模式下还会双跑）。
       * 同时把 轮询job 守卫也清掉，让还在途的请求回来时静默丢弃。
       */
      useEffect(() => {
        已卸载.current = false;
        return () => {
          已卸载.current = true;
          if (定时句柄.current) clearTimeout(定时句柄.current);
          定时句柄.current = null;
          轮询job.current = null;
        };
      }, []);

      /** 把某条候选写进当天日记。成功后该条变「✓ 已记入」并禁用。 */
      async function 记入(idx) {
        const m = 结果 && 结果.事项 && 结果.事项[idx];
        if (!m || 写状态[idx]) return;
        set写状态((s) => Object.assign({}, s, { [idx]: 'busy' }));
        // 注意两个不同的「来源」：
        //   来源 —— 这个来源是哪段聊天（哪个视角），写到哪本日记里
        //   出处 —— 这条内容在聊天里的出处（模型给的「谁在什么时候说的」），存进条目备注
        // 早先两者同名，加视角之后必须分开，否则写进日记的出处会被误当视角。
        const r = await post('/quick-write', { date: 日期, 来源: 源, text: m.内容, 出处: m.来源 || '' });
        if (!r.ok) {
          set写状态((s) => { const n = Object.assign({}, s); n[idx] = 'err'; return n; });
          return;
        }
        set写状态((s) => { const n = Object.assign({}, s); n[idx] = 'ok'; return n; });
        // 写进日记了，主界面的「当天日记」区也该刷新（由 Section 负责）
        if (typeof props.已写 === 'function') props.已写(日期);
      }

      const 事项们 = (结果 && 结果.事项) || [];
      // 进度计算收进纯函数（与 lib/view.js 同源）：
      //   进度百分比 —— 总批数为 0（任务刚开还没出分片）不能除零，显示「准备中…」；
      //                 已完成可能大于总批数（后端预估偏差），夹到 100
      //   进度条文本 —— 20 格、5% 一格；用字符串拼接而不嵌在模板字面量里，
      //                 避免嵌套模板字面量的转义陷阱
      const 完成 = (进度 && 进度.已完成) || 0;
      const 总批数 = (进度 && 进度.总批数) || 0;
      const 百分比 = 进度百分比(完成, 总批数);
      const 条文本 = 进度条文本(百分比);
      // done 之后才有的统计信息（usage / 批数 / 失败批数）
      const 统计 = 结果 && 结果.结果 && 结果.结果.usage
        ? 结果.结果
        : (进度 && 进度.结果) || null;

      return ce('div', { style: st.fold },
        // 折叠头：点开/收起
        ce('div', {
          style: st.foldHead,
          onClick: () => set收起((v) => !v),
          role: 'button',
        },
          ce('span', null, 收起 ? '▸' : '▾'),
          ce('span', { style: { fontWeight: 600 } }, '🤖 大模型通道'),
          已存 ? ce('span', { style: Object.assign({}, st.hint, { color: '#2a8' }) }, 已存) : null,
        ),
        收起 ? null : ce('div', { style: st.foldBody },
          ce('div', { style: st.foldRow },
            ce('span', { style: st.lbl }, 'baseURL'),
            ce('input', {
              style: st.input,
              placeholder: 'https://your-openai-compatible/api/v4',
              value: 配.baseURL,
              onChange: (e) => set配((p) => Object.assign({}, p, { baseURL: e.target.value })),
            }),
          ),
          ce('div', { style: st.foldRow },
            ce('span', { style: st.lbl }, 'apiKey'),
            ce('input', {
              style: st.input,
              type: 'password',
              placeholder: '留空 = 不改动已保存的 key',
              value: 配.apiKey,
              onChange: (e) => set配((p) => Object.assign({}, p, { apiKey: e.target.value })),
            }),
          ),
          ce('div', { style: st.foldRow },
            ce('span', { style: st.lbl }, 'model'),
            ce('input', {
              style: st.input,
              placeholder: 'glm-4-flash / deepseek-chat / gpt-4o-mini …',
              value: 配.model,
              onChange: (e) => set配((p) => Object.assign({}, p, { model: e.target.value })),
            }),
          ),
          ce('div', { style: st.foldRow, flexDirection: 'column', alignItems: 'stretch' },
            ce('div', { style: st.row },
              ce('span', { style: st.lbl }, '额外参数'),
              ce('span', { style: st.hint }, 'JSON，透传给厂商（如 智谱思考模型 {"thinking":{"type":"enabled"}}）'),
            ),
            ce('textarea', {
              style: st.textarea,
              placeholder: '{} 或 {"thinking":{"type":"enabled"},"max_tokens":3000}',
              value: 配.额外参数,
              onChange: (e) => set配((p) => Object.assign({}, p, { 额外参数: e.target.value })),
            }),
          ),
          配错 ? ce('div', { style: st.err }, 配错) : null,
          ce('div', { style: st.foldRow },
            ce('button', { style: st.btn, onClick: 保存, disabled: 存忙 },
              存忙 ? '保存中…' : '保存配置'),
          ),
        ),
        // 触发按钮：配置区下方，始终可见（配置没保存也能点，后端会拦）
        ce('div', { style: { marginTop: 6 } },
          ce('button', {
            style: Object.assign({}, st.pickBtn, { opacity: 挑中 ? 0.6 : 1 }),
            disabled: 挑中,
            onClick: 挑,
          },
            挑中 ? '正在挑…（可能要几分钟）' : '🤖 让大模型挑这一天'),
        ),
        // 进度区：任务在跑时显示「第 N / M 批 + 进度条 + 取消按钮」
        挑中 ? ce('div', { style: st.progressWrap },
          ce('span', null,
            总批数 > 0
              ? `正在挑… 第 ${完成} / ${总批数} 批　[${条文本}] ${百分比}%`
              : '正在挑… 准备中…'),
          ce('div', { style: st.progressOuter },
            ce('div', {
              style: Object.assign({}, st.progressInner, { width: 总批数 > 0 ? `${百分比}%` : '0%' }),
            }),
          ),
          ce('button', {
            style: st.btn,
            disabled: 取消忙,
            onClick: 取消,
            title: '取消这个挑选任务',
          }, 取消忙 ? '取消中…' : '取消'),
        ) : null,
        // 结果区
        结果 === null ? null : 结果.ok === false
          ? ce('div', { style: st.err }, `挑选没成功：${结果.错误 || '未知原因'}`)
          : 事项们.length === 0
            ? ce('div', { style: st.hint },
                ce('div', null,
                  结果.已有条数
                    ? '模型认为没有新的事值得记（当天日记里已有相关内容已过滤）。'
                    : '模型认为这天没有值得记的事。'),
                // done 时的统计小字：N 批 / 消耗 token / 已过滤
                统计
                  ? ce('div', { style: st.meta },
                      ce('span', null,
                        `共 ${统计.批数 || 总批数 || '?'} 批，消耗 token：输入 ${统计.usage ? 统计.usage.输入 || 0 : 0} / 输出 ${统计.usage ? 统计.usage.输出 || 0 : 0}`),
                      结果.已过滤
                        ? ce('span', null, `已自动跳过 ${结果.已过滤} 条当天已记过的`)
                        : null)
                  : (结果.已过滤
                      ? ce('div', { style: st.meta },
                          ce('span', null, `已自动跳过 ${结果.已过滤} 条当天已记过的`))
                      : null),
              )
            : ce('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 } },
                // 统计小字（done 时）
                统计 ? ce('div', { style: st.meta },
                    ce('span', null,
                      `共 ${统计.批数 || '?'} 批，消耗 token：输入 ${统计.usage ? 统计.usage.输入 || 0 : 0} / 输出 ${统计.usage ? 统计.usage.输出 || 0 : 0}`),
                    结果.已过滤
                      ? ce('span', null, `已自动跳过 ${结果.已过滤} 条当天已记过的`)
                      : null,
                  ) : (结果.已过滤
                      ? ce('div', { style: st.meta },
                          ce('span', null, `已自动跳过 ${结果.已过滤} 条当天已记过的`))
                      : null),
                事项们.map((m, i) => {
                  const ws = 写状态[i];
                  return ce('div', { key: i, style: st.item },
                    ce('div', { style: st.itemHead },
                      ce('div', { style: { flex: 1, lineHeight: 1.5 } },
                        ce('div', null, m.内容),
                        m.理由 ? ce('div', { style: st.meta }, `理由：${m.理由}`) : null,
                        m.来源 ? ce('div', { style: st.meta }, `来源：${m.来源}`) : null,
                      ),
                      ce('button', {
                        style: ws === 'ok' ? st.btnOn : st.btn,
                        disabled: ws === 'ok' || ws === 'busy' || ws === 'err',
                        onClick: () => 记入(i),
                        title: '写进当天日记（tags 带「大模型」）',
                      },
                        ws === 'ok' ? '✓ 已记入' : ws === 'busy' ? '记入中…' : ws === 'err' ? '写失败了' : '记进日记'),
                    ),
                  );
                }),
              ),
        );
    }

    /** 主面板。 */
    function Section() {
      const [书本模式, set书本模式] = useState(false);
      // 来源：日记按来源完全分开（私聊一份、每个群各一份），
      // 下面的日期/候选/日记/检索全都只作用于「当前来源」。
      const [来源们, set来源们] = useState([]);
      const [来源, set来源] = useState('');
      const [日期, set日期] = useState('');
      const [候选, set候选] = useState(null);
      const [概览, set概览] = useState(null);
      const [日记, set日记] = useState(null);
      const [搜索词, set搜索词] = useState('');
      const [搜索结果, set搜索结果] = useState(null);
      const [提示, set提示] = useState('');
      const [错误, set错误] = useState('');
      const [忙, set忙] = useState(false);

      /** 当前来源的人读名字，用来在界面上一直亮着「你正在看哪一本」。 */
      function 源标签(k) {
        const it = (来源们 || []).find((x) => x.来源 === (k || 来源));
        return (it && it.标签) || k || 来源 || '';
      }

      /** 拉来源列表。私聊永远排第一（后端已排好序）。 */
      async function 载来源() {
        const r = await api('/sources');
        if (!r.ok) { set错误(r.error || '来源读取失败'); return ''; }
        const 们 = r.来源们 || [];
        set来源们(们);
        if (们.length === 0) return '';
        // 保持当前选择；没有就默认私聊（列表第一项），私聊不存在才拿第一个
        const 保住 = 们.some((x) => x.来源 === 来源) ? 来源 : '';
        const 首选 = 保住 || (们.find((x) => x.来源 === 'private') || 们[0]).来源;
        set来源(首选);
        return 首选;
      }

      /** 拉概览；没指定日期时默认最新一个有待定候选的日子，否则今天。 */
      async function 载概览(哪个来源) {
        const k = 哪个来源 || 来源;
        if (!k) return null;
        const o = await api(`/overview?来源=${encodeURIComponent(k)}`);
        if (!o.ok) { set错误(o.error || '概览读取失败'); return null; }
        set概览(o);
        // 换来源后原来的日期可能不属于新来源，重新挑一个默认日期。
        // 用一个「本次请求对应的来源」判断而不是闭包里的 来源，
        // 因为 set来源 之后这个闭包里的 来源 还是旧值。
        const 待定天 = (o.候选列表 || []).filter((x) => x.待定 > 0);
        const 默认 = 待定天.length ? 待定天[待定天.length - 1].date : (o.今天 || '');
        set日期(默认);
        return 默认;
      }

      /** 拉某来源某天的候选 + 日记。 */
      async function 载当天(d, 哪个来源) {
        if (!d) return;
        const k = 哪个来源 || 来源;
        if (!k) return;
        const [c, e] = await Promise.all([
          api(`/candidates?来源=${encodeURIComponent(k)}&date=${encodeURIComponent(d)}`),
          api(`/entries?来源=${encodeURIComponent(k)}&date=${encodeURIComponent(d)}`),
        ]);
        if (!c.ok) { set错误(c.error || '候选读取失败'); return; }
        set候选(c);
        set日记(e.ok ? e : null);
      }

      useEffect(() => {
        (async () => {
          const k = await 载来源();
          if (!k) return;
          const d = await 载概览(k);
          if (d) await 载当天(d, k);
        })();
        // 只在首次挂载跑一次：日期/来源变化由下面的显式调用驱动，避免重复请求
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      /** 切来源：候选、日记、检索结果全部清空重拉，避免上一个来源的残留串台。 */
      async function 选来源(k) {
        set来源(k);
        set提示('');
        set错误('');
        set候选(null);
        set日记(null);
        set搜索结果(null);
        set搜索词('');
        set日期('');
        const d = await 载概览(k);
        if (d) await 载当天(d, k);
      }

      /** 切日期。 */
      async function 选日期(d) {
        set日期(d);
        set提示('');
        set错误('');
        await 载当天(d, 来源);
      }

      /** 重新提取。 */
      async function 刷新() {
        if (!日期) return;
        set忙(true); set错误(''); set提示('');
        const r = await post('/candidates/refresh', { 来源, date: 日期 });
        set忙(false);
        if (!r.ok) { set错误(r.error || '提取失败'); return; }
        if (r.note) set提示(r.note);
        else set提示(`重新提取完成：${r.行数} 行聊天，产出 ${r.items ? r.items.length : 0} 条候选（保留已决定 ${r.保留} 条）`);
        await 载当天(日期, 来源);
        await 载概览(来源);
      }

      /** 对某条候选做取舍。 */
      async function 决定(cid, 状态) {
        set错误('');
        const r = await post('/candidates/decide', { 来源, date: 日期, cid, 状态 });
        if (!r.ok) { set错误(r.error || '操作失败'); return; }
        // 本地先更新，立刻有反馈；随后以后端为准重拉
        set候选((prev) => {
          if (!prev) return prev;
          return Object.assign({}, prev, {
            items: prev.items.map((x) => x.cid === cid ? Object.assign({}, x, { 状态: r.状态, 条目id: r.条目id }) : x),
          });
        });
        const e = await api(`/entries?来源=${encodeURIComponent(来源)}&date=${encodeURIComponent(日期)}`);
        if (e.ok) set日记(e);
        await 载概览(来源);
      }

      /** 批量：把所有待定的放进 / 全排除。 */
      async function 批量(目标) {
        if (!候选) return;
        const 待处理 = 候选.items.filter((x) => x.状态 === S.待定);
        if (待处理.length === 0) { set提示('没有待定的候选'); return; }
        set忙(true); set错误('');
        for (const it of 待处理) {
          await post('/candidates/decide', { 来源, date: 日期, cid: it.cid, 状态: 目标 });
        }
        set忙(false);
        set提示(`已把 ${待处理.length} 条待定候选${目标 === S.放进去 ? '全部放入' : '全部排除'}`);
        await 载当天(日期, 来源);
        await 载概览(来源);
      }

      /** 检索。 */
      async function 搜() {
        const q = 搜索词.trim();
        if (!q) { set搜索结果(null); return; }
        const r = await api(`/search?来源=${encodeURIComponent(来源)}&q=${encodeURIComponent(q)}`);
        set搜索结果(r.ok ? r : { ok: false, error: r.error });
      }

      /** 大模型写进日记后刷新当天日记与概览。 */
      async function 已写(d) {
        await 载当天(d, 来源);
        await 载概览(来源);
      }

      const 列表 = (概览 && 概览.候选列表) || [];
      const 当日日记 = (日记 && 日记.entries) || [];
      const items = (候选 && 候选.items) || [];
      const 待定数 = items.filter((x) => x.状态 === S.待定).length;
      const 已放数 = items.filter((x) => x.状态 === S.放进去).length;
      const 已排数 = items.filter((x) => x.状态 === S.不放).length;

      return ce(
        'div',
        { style: st.wrap },
        // ── 顶部：标题 + 书本开关 ──
        // 开关放标题行里，两个模式都可见：书本模式下点「回到挑选」就能退回
        ce('div', { style: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' } },
          ce('div', { style: { fontSize: 15, fontWeight: 600 } }, '小鱼日记'),
          ce('button', {
            style: st.btn,
            onClick: () => set书本模式((v) => !v),
            title: 书本模式 ? '回到候选挑选' : '翻开日记',
          }, 书本模式 ? '✏️ 回到挑选' : '📖 翻开日记'),
        ),

        // ── 版本条：当前版本 / 有新版本时一条提示 + 更新日志 ──
        // 放在标题下面、两种模式之外：书本模式下也看得见，不会被「整页替换」藏起来。
        // 有新版本时它会自己长成一块高亮框，没新版本就只是一行灰字。
        ce(版本条),

        // 书本模式整页替换掉候选界面：key 让 书 每次进入都重挂载，
        // 重新按「书签/最后一页」规则起步（规格：进入书本模式时调 GET /bookmark）
        // key 里带来源：切换来源 = 换一本书（各自的书签、各自的页数）
        书本模式
          ? ce(书, { key: 'book-' + 来源, 来源, 标签: 源标签(来源) })
          : ce('div', { style: st.wrap },
        // ── 来源切换：日记按来源完全分开，先选看哪一本 ──
        ce('div', { style: st.row },
          ce('span', { style: { fontSize: 12, opacity: 0.8 } }, '看哪本'),
          ce('select', {
            style: st.input,
            value: 来源,
            onChange: (e) => 选来源(e.target.value),
            title: '私聊和每个群各有独立的日记、候选和阅读进度',
          },
            来源们.length === 0
              ? ce('option', { value: '' }, '（没有可用的来源）')
              : 来源们.map((x) => ce('option', { key: x.来源, value: x.来源 }, x.标签)),
          ),
          ce('span', { style: st.hint }, 源标签(来源) ? `当前：${源标签(来源)}` : ''),
        ),

        // 模式提示（只在默认模式显示）
        ce('div', { style: st.hint },
          '私聊和每个群各有独立的日记。每天从所选来源当天的聊天里提取候选，你来挑哪些放进日记、哪些不要。'),

        // ── 大模型通道（配置折叠 + 触发 + 逐条记入）──────────────────────
        // 放日期选择行下方：候选的「来源日期」就是 日期，触发时用它。
        // key 带来源：切来源就重挂载，正在跑的轮询会被干净停掉，不会串台
        ce(大模型通道, { key: 'llm-' + 来源, 日期, 来源, 标签: 源标签(来源), 已写 }),

        ce('div', { style: st.row },
          ce('span', { style: { fontSize: 12, opacity: 0.8 } }, '日期'),
          ce('select', {
            style: st.input,
            value: 日期,
            onChange: (e) => 选日期(e.target.value),
          },
            列表.length === 0
              ? ce('option', { value: 日期 || '' }, 日期 || '（还没有候选）')
              : 列表.map((x) => ce('option', { key: x.date, value: x.date },
                `${x.date}　待定 ${x.待定} · 放入 ${x.放进去} · 排除 ${x.不放}`)),
          ),
          ce('button', { style: st.btn, onClick: 刷新, disabled: 忙 },
            忙 ? '处理中…' : '重新提取这天'),
        ),

        ce('div', { style: st.row },
          ce('span', { style: st.hint }, `候选 ${items.length} 条：待定 ${待定数} · 已放 ${已放数} · 已排 ${已排数}`),
          ce('button', { style: st.btn, onClick: () => 批量(S.放进去), disabled: 忙 || 待定数 === 0 }, '待定全放入'),
          ce('button', { style: st.btn, onClick: () => 批量(S.不放), disabled: 忙 || 待定数 === 0 }, '待定全排除'),
        ),

        错误 ? ce('div', { style: st.err }, 错误) : null,
        提示 ? ce('div', { style: st.ok }, 提示) : null,

        // ── 候选列表 ──
        候选 === null
          ? ce('div', { style: st.hint }, '载入中…')
          : items.length === 0
            ? ce('div', { style: st.hint },
              '这天还没有候选。点「重新提取这天」从记忆仓库当天的聊天里筛。')
            : ce('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              items.map((it) => ce(候选卡, { key: it.cid, it, 决定 }))),

        // ── 当天日记 ──
        ce('div', { style: { marginTop: 8, fontSize: 13, fontWeight: 600 } },
          `当天日记（${当日日记.length} 条）`),
        当日日记.length === 0
          ? ce('div', { style: st.hint }, '这天日记还是空的。')
          : ce('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            当日日记.map((e) => ce('div', { key: e.id, style: st.card },
               ce('div', null, e.text),
               ce('div', { style: st.meta },
                 ce('span', null, e.id),
                 (e.tags || []).map((t, i) => ce('span', { key: i, style: st.chip }, t)),
                 e.来源 ? ce('span', null, e.来源) : null,
               ),
             ))),

        // ── 检索 ──
        ce('div', { style: { marginTop: 8, fontSize: 13, fontWeight: 600 } }, '翻旧账'),
        ce('div', { style: st.row },
          ce('input', {
            style: st.input,
            placeholder: '搜关键词，比如「爬山」「服务器」',
            value: 搜索词,
            onChange: (e) => set搜索词(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') 搜(); },
          }),
          ce('button', { style: st.btn, onClick: 搜 }, '搜索'),
        ),
        搜索结果
          ? 搜索结果.ok === false
            ? ce('div', { style: st.err }, 搜索结果.error || '搜索失败')
            : (搜索结果.结果 || []).length === 0
              ? ce('div', { style: st.hint }, '没搜到。')
              : ce('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                搜索结果.结果.map((r) => ce('div', { key: r.id, style: st.card },
                  ce('div', null, r.内容),
                  ce('div', { style: st.meta },
                    ce('span', null, r.日期),
                    r.标题 ? ce('span', null, r.标题) : null,
                    (r.标签 || []).map((t, i) => ce('span', { key: i, style: st.chip }, t)),
                    ce('span', null, `相关度 ${r.相关度}`),
                  ),
                )))
          : null,
        ),
      );
    }

    /** 宿主入口：往 settings.section 挂本插件的设置区。 */
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'xiaoyu-diary-settings',
            order: 55,
            label: () => '小鱼日记',
          },
          Section,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.Section = Section;
    // 版本条 单独导出，只为让 test/client-update.test.mjs 能把它当普通组件渲染、
    // 逐条验「有新版本 / 已是最新 / 查不到」三种显示。宿主不会用到这个导出。
    exports.版本条 = 版本条;
    return module.exports;
  },
});
