/**
 * 引擎适配器的内部契约。
 *
 * 引擎保持"笨"：输入 query / key / limit（或 url），输出归一化结果，失败抛普通 `Error`。
 * fallback 顺序、`WebError` 错误码、取消语义全部归 aggregate provider —— 这样每个引擎
 * 都能脱离 seam 单独单测。
 */

/** 一条可引用的结果来源，对应 seam 的 `WebSearchSource`。 */
export interface EngineSource {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly publishedAt?: string;
}

/** 一个引擎一次查询的结果。 */
export interface EngineResult {
  /** 引擎自己生成的直答/摘要文本，映射到 seam 的 `WebSearchResult.content`。 */
  readonly content?: string;
  readonly sources: readonly EngineSource[];
}

/** 一个引擎一次抓取的结果。 */
export interface EngineFetchResult {
  /**
   * 清洗后的正文（markdown 或纯文本）。
   *
   * **空或纯空白视为抓取失败** —— 聚合层会继续尝试下一个引擎，而不是把空正文交给模型。
   */
  readonly content: string;
  /** 该引擎自己是否截断了正文。 */
  readonly truncated: boolean;
  /** extract 报告的目标 URL；缺省时聚合层用请求 URL 兜底。 */
  readonly url?: string;
}

/**
 * 抓取失败的分类。
 *
 * 取值**只覆盖两个引擎真的能区分出来的情形**（依据 2026-10-09 的真机实测，
 * 见 tasks/10-09-fetch-typed-errors/research/upstream-error-codes.md）：
 * AnySearch 除"无信封的 403"之外一律回 `422 / code:-1` 通用消息，所以它区分不出
 * "被反爬"与"抽不出内容"—— 那就不要编。
 */
export type EngineFailureKind =
  /**
   * 上游**策略层面**拒绝了这个 URL（Tavily 的 `Validation Error: Invalid URL format`）。
   *
   * 注意名字不是 `url-invalid`：能走到引擎的 URL 一定已经通过本地语法校验
   * （`assertFetchableUrl` 拦掉了非 http/https 与解析失败），所以上游这句
   * "格式非法"在我们的管线里实际含义是**目标不被允许**（实测：非公网地址）
   * —— 对应 seam 的 `WEB_BLOCKED_URL`，与官方 `http` provider 的报法一致。
   * 与引擎无关，因此**短路**。
   */
  | 'url-rejected'
  /** 引擎自己抓取失败（`Failed to fetch url`、HTTP 5xx、网络异常）。可能是瞬时的。 */
  | 'engine-failed';

/**
 * 抓取失败的结构化载体。
 *
 * 引擎层仍然**不** import `WebError`（分层铁律）：这里只描述「上游说了什么」，
 * 错误码由聚合层决定。`reason` 一律是**上游原话**，不改写 —— 它是排查的唯一线索。
 */
export class EngineFetchError extends Error {
  readonly kind: EngineFailureKind;
  /** 上游 HTTP 状态；网络异常时为 `undefined`。 */
  readonly upstreamStatus?: number;
  /** 上游业务码（AnySearch 信封的 `code`；Tavily 没有）。 */
  readonly upstreamCode?: string | number;
  /** 上游给的原因文本。 */
  readonly reason?: string;

  constructor(
    message: string,
    fields: {
      kind: EngineFailureKind;
      upstreamStatus?: number;
      upstreamCode?: string | number;
      reason?: string;
      cause?: unknown;
    },
  ) {
    super(message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.name = 'EngineFetchError';
    this.kind = fields.kind;
    if (fields.upstreamStatus !== undefined) this.upstreamStatus = fields.upstreamStatus;
    if (fields.upstreamCode !== undefined) this.upstreamCode = fields.upstreamCode;
    if (fields.reason !== undefined) this.reason = fields.reason;
  }
}

/** 一个后端引擎。搜索是必备能力；抓取可选。 */
export interface Engine {
  /** 稳定 id，同时是 `providerOrder` 里使用的值。 */
  readonly id: string;

  /** 未配置字面 Key 时查询的环境变量名。 */
  readonly apiKeyEnv: string;
  /**
   * `true`  = 没有 Key 就不能调用（Tavily）。
   * `false` = 无 Key 也可调用，走服务端匿名额度（AnySearch）。
   */
  readonly requiresApiKey: boolean;
  /**
   * 执行一次查询。
   *
   * 实现约定：
   * - 必须把 `signal` 透传给 `fetch`；调用方取消时不要吞掉。
   * - 失败抛普通 `Error`，消息里带引擎名与可定位信息（HTTP 状态、服务端 message）。
   * - 缺失的可选字段不要用空字符串填充，用条件展开省略。
   */
  search(
    query: string,
    apiKey: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<EngineResult>;
  /**
   * **可选的**抓取能力：取回一个 URL 的清洗正文。
   *
   * **缺省表示该引擎没有 extract 端点**（纯 SERP 引擎），**不进抓取链**。
   *
   * 这里用「方法缺省」而不是「`supportsFetch` 布尔 + 必然存在的方法」，是为了让调用点
   * `if (engine.fetch === undefined) continue` 之后 TypeScript 能收窄 —— 不必再写一次断言。
   *
   * 实现约定与 `search` 相同：透传 `signal`、失败抛普通 `Error`、消息带引擎名与定位信息。
   */
  fetch?(url: string, apiKey: string, signal?: AbortSignal): Promise<EngineFetchResult>;
}
