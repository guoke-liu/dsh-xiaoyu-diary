# AGENTS.md —— 给接手这个项目的 AI agent / 贡献者的速查

> DSH 会把 `$DSH_HOME/AGENTS.md` 和「项目根 → 会话目录」链路上的每个 AGENTS.md
> 一起注入上下文。这份文件放在插件根目录，所以只要在仓库里开工就会读到。

---

## 一、这个项目是什么

把记忆仓库的聊天记录，按「私聊 / 每个群」完全分开，每天提取出**值得记住的事**，
由人来挑选后写进日记，并且能检索回来。

**两条铁律，改代码前先看：**

1. **来源完全分开**：私聊一本、每个群各一本。存储、候选、LLM 通道、检索、UI、工具、路由
   **全部按来源隔离**。`test/isolation.test.mjs` 就是这条的护栏。
   ⚠️ 别为了省事把来源合并 —— 那正是这个插件存在的理由。
2. **回归测试必须能失败**：加测试时要先把 bug 重新种回去，确认它真的红。
   「写完就绿」的测试不能证明任何事。

---

## 二、跑测试

```bash
node --test test/*.test.mjs      # 必须带 glob，node --test test/ 会找不到模块
```

当前 142 个测试。任何一个红了都别提交。

---

## 三、踩过的坑（按惨烈程度排，都是有代价换来的）

### 1. 前端接口路径要**跟着页面挂载路径走**，不能写死 `/local/...`

DSH 可能挂在子路径下（例如 nginx 把 `/dsh/` 反代到 `127.0.0.1:6600/`）。
DSH 自己不感知这层前缀，但**浏览器是感知的**：页面在 `http://h/dsh/` 时，
任何以 `/` 开头的绝对路径都会被解析成 `http://h/local/...`，**跳出前缀**，
落到别的东西上（比如同域的反向代理站点），被拦成 401。
症状：首屏能开（服务端渲染），一翻页就「书签读不到」。

**正解**：`lib/client.js` 里 `BASE` 用**不带前导斜杠的相对路径**
`'local/xiaoyu-diary'`。浏览器按当前目录解析：

```
http://h/      + local/xiaoyu-diary  → http://h/local/...       ✅
http://h/dsh/  + local/xiaoyu-diary  → http://h/dsh/local/...   ✅
```

⚠️ 两种错误写法（`test/base.test.mjs` 会拦）：
- `'/local/xiaoyu-diary'` —— 绝对路径，丢前缀 → 401
- `'../local/xiaoyu-diary'` —— 逃出前缀，还是落到别处 → 401

### 2. DSH 的 token 栅栏**只管首页**，插件路由它不验

`dsh-host-frontend-static` 里只有 index 走 `authorizeIndex`。
插件注册的路由**完全不校验**！DSH 只听 `127.0.0.1` 时没事，
一旦经反向代理暴露出去，任何人都能裸调。

**所以插件自己在 `lib/routes.js` 的 `包()` 里加了闸门**，复用宿主的
`ctx.get('connection').browserAuth.isAuthenticated(req, secure)` ——
和首页同一套签名 cookie，不自己造一套。拿不到 connection 服务时降级放行
（本地开发/单测没有它），并打一条日志。
`test/auth.test.mjs` 逐条验这 15 条路由，漏一条就是后门。

⚠️ **不要**为了让某个部署能用，就在反代里把插件路径直通出去 ——
那等于绕过认证、把日记接口裸放公网。

### 3. 反代时 `Host` 头必须带端口

如果 DSH 用 `--trusted-host` 指定了带端口的地址（如 `1.2.3.4:80`），
nginx 的 `$host` 不带端口就对不上 → 一直 401。要用 `$http_host`。

### 4. `auth_basic` 会被父 block 继承

在父 `server` 块开了 Basic 认证时，反代 DSH 的那条 location 必须**显式**
写 `auth_basic off;`，否则整站都要密码。

### 5. 插件 `inject` 必须含 `webServer`

漏了就是 `cannot get property "webServer" without inject`，
而且 `--dump-config` 看不出来。

### 6. 工具 `output.render` 必须返回内容块数组

返回裸字符串 → 宿主 `content.some is not a function` → 整次工具调用判失败，
模型一个字都拿不到。`parameters` 也要写成属性映射，不是 JSON Schema 外壳。

### 7. 老日记的来源在 `tags[0]`

老版本数据每条都带 `tags[0]`（`私聊` / `群聊`）。迁移时按它分开，
不要假设「老数据没有来源，全归私聊」。

---

## 四、代码结构

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件入口；解析配置与 dsh-tools |
| `lib/source.js` | 来源 key（`private` / `group:<号>`）的定义与校验 |
| `lib/store.js` | 按来源分开的存储（entries / index / candidates / bookmark） |
| `lib/vault.js` | 记忆仓库适配器（三档降级：接口 → 路径 → 读文件） |
| `lib/extract.js` | 从聊天里提取候选 |
| `lib/llm.js` | 大模型挑选通道（分批、退避重试） |
| `lib/search.js` | 检索 |
| `lib/tools.js` | 6 个面向模型的工具 |
| `lib/routes.js` | 15 条 HTTP 路由 + **鉴权闸门** |
| `lib/client.js` | 浏览器端 UI（React，零依赖，无 JSX） |
| `lib/view.js` | 纯函数（分页/跳转），被 client.js 内联了一份副本 |

⚠️ `lib/view.js` 和 `lib/client.js` 里有 5 个同源纯函数（浏览器没法 import）。
改一边必须同步另一边，`test/view.test.mjs` 锁的是副本一致性。
