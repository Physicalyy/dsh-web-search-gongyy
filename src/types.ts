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
