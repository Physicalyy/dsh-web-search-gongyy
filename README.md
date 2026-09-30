# dsh-web-search-gongyy

面向 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 Web 搜索插件，内部聚合 **AnySearch** 与 **Tavily**，按可配置顺序自动 fallback。

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

## 安装

前置条件：dsh ≥ `0.2.0-rc.2`，且 profile 的依赖管理用 pnpm。

### 方式一：界面安装（推荐）

侧栏 **插件** → **Add plugin** → 填入本仓库的**绝对路径**（或发布后的包名）→ 安装。

### 方式二：命令行

```sh
npx -y @deepseek-ai/dsh plugin --profile desktop add <本仓库绝对路径>
```

本机 profile 是 `desktop`（`~/.dsh/profiles/desktop`）。装完需要重启 dsh。

> **从本地源码安装前必须先构建。** `dist/` 被 gitignore，而包的 `main` 指向 `dist/index.js`：
>
> ```sh
> pnpm install && pnpm build
> ```
>
> 发布到 npm 的包里带 `dist/`，用包名安装时不需要这一步。

## 配置

### 凭据

推荐用 dsh 的托管凭据。编辑 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）：

```yaml
TAVILY_API_KEY: "tvly-xxxxxxxx"
```

AnySearch 只有在匿名额度不够时才需要：

```yaml
ANYSEARCH_API_KEY: "as_sk_xxxxxxxx"
```

也可以用启动环境变量（优先级低于托管凭据）：启动 dsh 前 `export TAVILY_API_KEY=...`。

> 换 Key 不需要重启 —— 每次搜索都会重新解析凭据。

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
| `anysearchApiKeyEnv` / `tavilyApiKeyEnv` | `ANYSEARCH_API_KEY` / `TAVILY_API_KEY` | 凭据引用名 |
| `anysearchApiKey` / `tavilyApiKey` | 空 | 字面 Key，优先级高于凭据引用 |

`providerOrder` 里写错 id 不会让插件失效 —— 该 id 会被跳过并记进日志与错误信息。

### 不泄露凭据地检查组合结果

```sh
npx -y @deepseek-ai/dsh --profile desktop --dump-config
```

输出里只应看到凭据引用的**名字**，不应出现 Key 的字面值。

## 验证

重启 dsh 后，在对话里让它搜索（"搜一下今天的新闻"）。应当返回带 URL 的 sources。

引擎发生 fallback 时会在 dsh 日志里留痕：

```
web-search-gongyy: engine "anysearch" failed: ...; trying next
web-search-gongyy: fell back to engine "tavily" after 1 failure(s): ...
```

**这条日志很重要**：没有它，首选引擎悄悄坏掉（额度用尽、接口变更）时你完全不会察觉，只会一直烧后面引擎的额度。

## 卸载

```sh
npx -y @deepseek-ai/dsh plugin --profile desktop remove dsh-web-search-gongyy
```

卸载后 web 搜索**自动回落到** dsh-base 的 `deepseek-official`，无需手改 profile。

用户层的配置（`cordis.patch.yml` 里的 `web-search-gongyy` entry）不会自动清除，需要手工删掉；凭据文件里的 Key 也需要自己清理。

## 已知限制

- **只有搜索，没有抓取。** 本版本不注册 fetch provider，也不改 `fetchProvider`，所以 `web_fetch` 保持原样由组合层提供。
- **没有配置界面。** 配置走 `cordis.patch.yml`，凭据走凭据文件或环境变量。客户端配置卡片是后续工作。
- **单引擎单 Key。** 同一引擎不支持多 Key 轮换。
- **搜索参数只有 query 和 maxResults。** 这是 seam 的限制（时效性、域名过滤、地区等 provider 中立参数上游尚未定义），不是本插件偷懒。
- **超时由工具层负责。** `dsh-tool-web` 的 `searchTimeoutMs`（默认 30s）会通过 `signal` 取消本次搜索，插件不自带超时。

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
5. `cordis.patch.yml` 动了 `fetchProvider`，而本插件没注册 fetch provider。

### 依赖布局用 hoisted

`pnpm-workspace.yaml` 里设了 `nodeLinker: hoisted`，**不是可选项**。pnpm 默认的 isolated linker 会把依赖装成指向 `Global\D:\...` 的 junction，Node 的 realpath 处理不了这种目标，解析传递依赖时会退回到链接路径查找，于是 `cordis` / `schemastery` 的依赖全部 `ERR_MODULE_NOT_FOUND`。hoisted 同时与 dsh profile 的布局一致。

### 架构

```
cordis.patch.yml      insert 本插件 + 把 web.searchProvider 重指过来
src/index.ts          插件入口：Config schema、凭据解析、注册 provider
src/provider.ts       FallbackSearchProvider —— 唯一注册到 ctx.web 的 provider
src/engines/*.ts      anysearch / tavily 适配器（只做「查询 → 归一化 sources」）
```

**只注册一个 provider 是硬约束。** seam 在没配 `searchProvider` 且存在多个可用 provider 时抛 `WEB_PROVIDER_AMBIGUOUS`，所以多引擎 fallback 必须做在 provider 内部。

开发时请先读本仓库的 `.trellis/spec/plugin/`，那里记录了目标运行时的真实接口契约与排查过程。

## 致谢

实现参考了两个 MIT 项目：

- [dsh-web-search-free](https://github.com/MochiNek0/dsh-web-search-free) —— 多引擎 + fallback 的 bundle 插件架构
- [anysearch-dsh](https://github.com/anysearch-team/anysearch-dsh) —— AnySearch 官方实现，含匿名访问与信封校验的处理方式

## 许可证

MIT，见 [LICENSE](./LICENSE)。
