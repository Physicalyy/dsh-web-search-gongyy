# dsh-web-search-gongyy

面向 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 Web **搜索与抓取**插件，内部聚合 **AnySearch** 与 **Tavily**，按可配置顺序自动 fallback。

## 为什么需要它

dsh 默认的 `deepseek-official` 通道**不是一个专用检索端点**：每次搜索都会发起一次**完整的模型调用**（带原生 `web_search` 服务端工具），由 DeepSeek 在服务端执行搜索。于是每次搜索烧两份 token —— 辅助搜索请求本身，以及回灌进对话上下文、会一直重发到压缩为止的 sources。

本插件直接调用检索引擎的专用检索端点，**全程不经过任何 LLM**：

| | `deepseek-official` | 本插件 |
| --- | --- | --- |
| 检索方式 | 完整模型调用 + 服务端搜索工具 | 直接调引擎检索端点 |
| 模型 token | 每次搜索都烧 | **0** |
| 计费来源 | DeepSeek API 余额 | 各引擎自己的额度 |
| 凭据要求 | **必须** `DEEPSEEK_API_KEY` | 无（AnySearch 支持匿名） |

## 支持的引擎

| 引擎 | 需要 Key | 免费额度 | 申请地址 |
| --- | :---: | --- | --- |
| **AnySearch** | 否（支持匿名） | 1,000 次/天，每天重置 | <https://anysearch.com/pricing> |
| **Tavily** | 是 | 1,000 credits/月，每月重置 | <https://app.tavily.com/> |

默认顺序 `[anysearch, tavily]`：首引擎额度是次引擎的约 30 倍，放前面更省。

**装上即可用** —— AnySearch 支持匿名访问，不配任何 Key 就能搜索。Tavily 需要 Key，但只在 AnySearch 失败时才会用到。

## 抓取（`web_fetch`）

除了搜索，插件也接管 **`web_fetch`**：抓取改为走两个引擎的 extract 端点（AnySearch `/v1/extract`、
Tavily `/extract`），模型拿到的是**清洗后的正文**，而不是"抓到什么算什么"的裸 HTML 转换结果。

- fallback 逻辑与搜索完全一致，同样受 `providerOrder` 控制
- **大页面明显更全**：官方 `http` provider 会把 HTML 先截到 10 万字符再转 markdown，所以重页面丢内容 ——
  实测 Wikipedia 官方 30494 字符 vs 本插件 144694 字符；GitHub 仓库页 3690 vs 15691
- **门户页从"空"变成"有"**：baidu 首页在官方路径下 turndown 之后是 **0 字符**（HTTP 200 但正文全空），
  本插件能拿到真页面 markdown
- **非正文会被跳过**：某些站点上引擎会吐出"不是正文的东西"（实测 AnySearch 抓 baidu 首页给 5 万字符
  `<style>` CSS），这类结果**判为低质并继续 fallback**，不会塞给模型；只有所有引擎都给不出正文时才
  退回首份并留日志。判据与阈值来自 11 个真实页面的标定，JSON/源码/纯文本/极短页都不会被误伤
- 默认顺序是"**额度优先**"：AnySearch 1000 次/天免费（可匿名），Tavily 1000 credits/月。
  想质量优先就改 `providerOrder`，代价是烧 Tavily 的月额度
- 本机/内网地址**两边都抓不到**（官方 provider 也拒绝非公网地址），且本插件会**立刻**报
  `WEB_BLOCKED_URL` —— 这类失败与"谁去抓"无关，不会白跑后面的引擎
- 想**只退抓取、不退搜索**：删掉 `cordis.patch.yml` 里 `fetchProvider` 那一行，`web_fetch` 就回到
  dsh-base 的 `http` provider，方便直接 A/B 对比（对照数据见 `.trellis/tasks/` 里的 ab-report）

抓取失败时给的是**可路由的错误码 + 上游原话**，例：

```
WEB_BLOCKED_URL  Web fetch was blocked for this URL — tavily: … (upstream: Validation Error: Invalid URL format). …
WEB_FETCH_TIMEOUT / WEB_ABORTED / WEB_INVALID_URL / WEB_PROVIDER_ERROR
```

> 两个引擎的上游错误词汇比想象中少：AnySearch 对"主机不存在 / PDF / 404 / 反爬"回的是**同一句**
> `422 · error_code=extract_failed`，所以我们**不编造**它给不出的码（如"内容过大""类型不支持"）。

## 安装

前置条件：dsh ≥ `0.2.0-rc.2`，且 profile 的依赖管理用 pnpm。

### 从 GitHub 取源码

```sh
git clone git@github.com:Physicalyy/dsh-web-search-gongyy.git   # 或 https://github.com/Physicalyy/dsh-web-search-gongyy.git
cd dsh-web-search-gongyy
pnpm install && pnpm build     # dist/ 不入库，必须先构建（见下方说明）
```

然后用下面的界面方式安装，路径填这个仓库的**绝对路径**。

> 目前**没有发布到 npm** —— 只能从源码路径安装。`package.json` 里的 `version` 是 `0.0.1`，
> 首次对外发布时要一起确定（打 tag 与 npm 版本号）。

### 只有界面一条路（`desktop` profile）

侧栏 **插件** → **Add plugin** → 填入本仓库的**绝对路径**（或发布后的包名）→ 安装 → **重启 dsh**。

> **`desktop` profile 不能用命令行装。** 它由 Electron 应用独占管理，CLI 会直接拒绝：
>
> ```
> error: profile "desktop" is managed exclusively by the Electron application
> ```
>
> `npx -y @deepseek-ai/dsh plugin --profile <name> add ...` 只适用于非 desktop 的 profile（例如 `web`）。
>
> 重启是必须的：bundle 的组合层在**启动时**算出来。凭据则不需要重启（每次搜索都重新解析）。

> **从本地源码安装前必须先构建。** `dist/` 被 gitignore，而包的 `main` 指向 `dist/index.js`：
>
> ```sh
> pnpm install && pnpm build
> ```
>
> 发布到 npm 的包里带 `dist/`，用包名安装时不需要这一步。

## 配置

### 凭据

**最省事的办法是在插件页里直接填**：侧栏 **插件** → `dsh-web-search-gongyy` 的详情页有两个 Key 输入框，
粘贴后点保存即可 —— Key 会写进 dsh 的**托管凭据域**（`$DSH_HOME/.credentials.yaml`），
**不会**落到 `cordis.patch.yml`。

- 框里那排 **圆点**只表示"已经配了 Key"，它**不会被保存**（在圆点后面接着打字也不会污染保存值）
- 留空保存**不会**清掉已存的 Key（那是无操作）
- 界面**不会回显**真实 Key —— 右上角徽标显示"已设置 / 未设置"

也可以手编凭据文件（`$DSH_HOME/.credentials.yaml`，默认 `~/.dsh/.credentials.yaml`）：

```yaml
TAVILY_API_KEY: "tvly-xxxxxxxx"
```

AnySearch 只有在匿名额度不够时才需要：

```yaml
ANYSEARCH_API_KEY: "as_sk_xxxxxxxx"
```

也可以用启动环境变量：启动 dsh 前 `export TAVILY_API_KEY=...`。
**注意它是最高优先级（只读压过凭据文件）** —— 它的存在会让卡片上那个 Key 框变成只读，
因为在这里写会被环境变量遮蔽，宿主会直接拒绝。

> 换 Key 不需要重启 —— 每次搜索都会重新解析凭据。
> 卡片的 Key 输入框是**只写不读**的：它永远不会显示已存的 Key，这也是"空着保存不会清掉 Key"的原因。

### 插件配置

覆盖 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/desktop/cordis.patch.yml`）。bundle 层已经插入了本插件的 entry，所以这里只写**同 id 的 config 覆盖**，不要再写 `insert`：

```yaml
- id: web-search-gongyy
  config:
    providerOrder: [anysearch, tavily]
    maxResultsPerEngine: 8
    # 可选：改凭据引用的名字
    # tavilyApiKeyEnv: TAVILY_API_KEY
    # 可选：字面 Key，仅本地调试用（优先级最高）
    # tavilyApiKey: tvly-xxxx
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `providerOrder` | `[anysearch, tavily]` | 引擎调用顺序；靠前的先调，失败自动落到下一个 |
| `maxResultsPerEngine` | `8` | 调用方没给 `maxResults` 时，每个引擎默认请求多少条 |
| `anysearchApiKeyEnv` / `tavilyApiKeyEnv` | `ANYSEARCH_API_KEY` / `TAVILY_API_KEY` | 凭据引用名 —— **卡片上不显示**（默认值够用）；它决定卡片里那个 Key 存到哪个名字下，要改名就手改这里 |
| `anysearchApiKey` / `tavilyApiKey` | 空 | 字面 Key，优先级高于凭据引用。**卡片刻意不暴露它**（会落进配置文件），只留作本地调试 |

卡片上能改的是：引擎顺序、结果数上限，以及**两个 API Key**（Key 直接粘，写进凭据域）。

`providerOrder` 里写错 id 不会让插件失效 —— 该 id 会被跳过并记进日志与错误信息。

### 不泄露凭据地检查组合结果

`desktop` profile 不能用 CLI 检查（与安装同理，会被独占限制拒绝）。改看侧栏 **插件** 页：本插件的卡片与各行的状态都在那里；**Settings → Built-in plugins** 是只读清单。

凭据文件 `~/.dsh/.credentials.yaml` 里是**明文** Key，查看时注意不要外传。

## 验证

重启 dsh 后，在对话里让它搜索（"搜一下今天的新闻"）。应当返回带 URL 的 sources。

再让它抓一个具体 URL（或直接把链接丢给它）。返回的应当是**清洗后的正文**；想确认这次抓取真的走了本插件，
最可靠的是抓一个**非法协议**地址（如 `ftp://example.com/probe`）——报错文案 `unsupported URL scheme "ftp:"`
是本插件的本地校验原文（0ms 就拒，不联网）。

用内网地址（`http://127.0.0.1:...`）也能探，但要**看消息而不是看错误码**：现在两边都报 `WEB_BLOCKED_URL`
（本插件刻意与官方对齐）。区别在文案 —— 本插件会点名 `anysearch` / `tavily`、带出上游原话，
并说明 "remaining engines were not tried"；官方那条只有一句地址被拒。

引擎发生 fallback（含"判为低质"）时会在 dsh 日志里留痕：

```
web-search-gongyy: engine "anysearch" failed: ...; trying next
web-search-gongyy: engine "anysearch" returned non-prose content (starts with a style/script tag; braces+semicolons 47.1/1k, quotes 0.4/1k); trying next
web-search-gongyy: fell back to engine "tavily" after 1 failure(s): ...
```

**这条日志很重要**：没有它，首选引擎悄悄坏掉（额度用尽、接口变更、开始返垃圾）时你完全不会察觉，
只会一直烧后面引擎的额度。

## 卸载

在侧栏 **插件** → **Installed** 里找到 `dsh-web-search-gongyy` 并卸载（也可以先关掉它那一行的开关做临时停用），然后**重启 dsh**。

卸载后 web 搜索**自动回落到** dsh-base 的 `deepseek-official`、抓取回落到 `http`，无需手改 profile。

用户层的配置（`cordis.patch.yml` 里的 `web-search-gongyy` entry）不会自动清除，需要手工删掉；凭据文件里的 Key 也需要自己清理。

## 已知限制

- **抓取走 extract 服务，不是裸 HTTP。** 好处是大页面/门户页的正文明显更全（实测 Wikipedia 4.7×、
  GitHub 4.3×，baidu 从"空正文"变成有内容）；代价是**抽取质量随站点与引擎而异** ——
  我们只能靠"判为非正文就继续 fallback"来兜（会多跑一个引擎、多烧一次额度），
  且同样**抓不到非公网地址**（这一点官方 `http` provider 也一样）。
  见上文「抓取」一节与 `.trellis/spec/plugin/architecture.md`。
- **抓取没有单独开关。** `fetchProvider` 被 patch 钉死，把 `available()` 变假的后果是**报错**而不是让位；
  "只退抓取"的正确做法是删掉 patch 里 `fetchProvider` 那一行。
- **配置界面在插件页。** 侧栏 **插件** → `dsh-web-search-gongyy` 的详情页可以改**引擎顺序、结果数上限，
  以及直接粘两个 API Key**（Key 写进凭据域，不落配置文件；界面只显示"已设置/未设置"）。
  凭据引用名与配置的字面 Key 走手编 `cordis.patch.yml` 的方式。
- **由启动环境变量提供的 Key 在卡片上是只读的。** 那条环境变量的优先级压过凭据文件，
  写入会被遮蔽，所以宿主拒绝编辑、卡片把输入框禁用并说明原因。想让卡片能改，
  就先在启动 dsh 的环境里去掉那个变量。**可写性是逐字段判断的**：一个只读不会连带另一个。
- **单引擎单 Key。** 同一引擎不支持多 Key 轮换。
- **搜索参数只有 query 和 maxResults。** 这是 seam 的限制（时效性、域名过滤、地区等 provider 中立参数上游尚未定义），不是本插件偷懒。
- **超时由工具层负责。** `dsh-tool-web` 的 `searchTimeoutMs`（默认 30s）会通过 `signal` 取消本次搜索，插件不自带超时。
  抓取侧会把**超时与取消分开报**：`AbortSignal.timeout()` 到点 → `WEB_FETCH_TIMEOUT`，调用方主动取消 → `WEB_ABORTED`。

## 开发

```sh
pnpm install
pnpm typecheck     # 零 TS 错误
pnpm test          # 构建后跑单元测试
pnpm run check     # 发布前门禁
```

`pnpm run check` 拦的是**只在别人机器上复现**的问题，本地测试发现不了：

1. `@deepseek-ai/*` 进了 `dependencies` 或非 optional 的 `peerDependencies`
   —— 会让 profile 里多出一份私有副本、遮蔽宿主那份，Cordis Service 身份不再相等，注入静默失效；
2. `files` 白名单缺文件；
3. `dsh.bundle.patch` 指向的文件不存在；
4. `cordis.patch.yml` 的 entry id 与源码注册的 provider id 不一致
   —— 表现为插件装上了、界面没报错，但搜索根本没走本插件；
5. `cordis.patch.yml` 动了 `fetchProvider`，但 `src/index.ts` 里没有 `registerFetchProvider`
   —— 接管了却没有能力，`web_fetch` 会报 `WEB_PROVIDER_CONFIGURED_MISSING`；
6. 客户端半边声明不全，或顶层 `inject` 里写了包名（写错的后果是整个 Web 界面起不来）。

### 依赖布局用 hoisted

`pnpm-workspace.yaml` 里设了 `nodeLinker: hoisted`，**不是可选项**。pnpm 默认的 isolated linker 会把依赖装成指向 `Global\D:\...` 的 junction，Node 的 realpath 处理不了这种目标，解析传递依赖时会退回到链接路径查找，于是 `cordis` / `schemastery` 的依赖全部 `ERR_MODULE_NOT_FOUND`。hoisted 同时与 dsh profile 的布局一致。

### 架构

```
cordis.patch.yml      insert 本插件 + 把 web.searchProvider 与 web.fetchProvider 都重指过来
src/index.ts          插件入口：Config schema、凭据解析、注册两个 provider
src/provider.ts       FallbackSearchProvider + FallbackFetchProvider —— 注册到 ctx.web 的两个 provider
src/engines/*.ts      anysearch / tavily 适配器（搜索必备，extract 用可选的 fetch() 表达）
src/client.tsx        客户端半边：插件页里的配置卡片
```

**搜索与抓取各只注册一个 provider，且共用同一个 id。** seam 在没配 `searchProvider` 且存在多个可用
provider 时抛 `WEB_PROVIDER_AMBIGUOUS`，所以多引擎 fallback 必须做在 provider 内部；而 search / fetch
是两个独立注册表，同一个 id 两边都能注册。

开发时请先读本仓库的 `.trellis/spec/plugin/`，那里记录了目标运行时的真实接口契约与排查过程。

## 致谢

实现参考了两个 MIT 项目：

- [dsh-web-search-free](https://github.com/MochiNek0/dsh-web-search-free) —— 多引擎 + fallback 的 bundle 插件架构
- [anysearch-dsh](https://github.com/anysearch-team/anysearch-dsh) —— AnySearch 官方实现，含匿名访问与信封校验的处理方式

## 许可证

MIT，见 [LICENSE](./LICENSE)。
