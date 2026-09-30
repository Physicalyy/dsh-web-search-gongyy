/**
 * 引擎适配器的内部契约。
 *
 * 引擎保持"笨"：输入 query / key / limit，输出归一化后的 sources，失败抛普通 `Error`。
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

/** 一个搜索后端。 */
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
}
