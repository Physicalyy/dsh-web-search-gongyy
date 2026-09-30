import { WebError } from '@deepseek-ai/dsh-web';
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from '@deepseek-ai/dsh-web';
import { engineById, knownEngineIds } from './engines/index.js';
import type { Engine } from './types.js';

/** 注册到 `ctx.web` 的稳定 provider id。 */
export const PROVIDER_ID = 'web-search-gongyy';

/**
 * 一次操作使用的配置快照。
 *
 * 由 `apply()` 传进来的 thunk 在每次操作入口构造一次并冻结 —— 配置可能在两次搜索
 * 之间被改，而重新注册 provider 会让 seam 的选择对用户可见地抖动。
 */
export interface ProviderOptions {
  /** 引擎调用顺序。 */
  readonly order: readonly string[];
  /** 调用方没给 `maxResults` 时，每个引擎默认请求多少条。 */
  readonly maxResultsPerEngine: number;
  /** 取某引擎配置的字面 Key（仅本地调试用）。 */
  literalApiKey(engine: Engine): string | undefined;
  /** 解析某引擎的 Key；未配置返回 `undefined`。每次操作重新解析，不缓存。 */
  resolveApiKey(engine: Engine, signal?: AbortSignal): Promise<string | undefined>;
  /** 诊断输出。fallback 发生的实时机在这里留痕。 */
  warn(message: string): void;
}

/** 已取消就抛 seam 的稳定取消错误，保留调用方给的原因。 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new WebError('Web search aborted', 'WEB_ABORTED', { cause: signal.reason });
  }
}

/** 把任意抛出物压成一行可读文本。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把「所有引擎都没成功」拼成携带可操作指引的 `WebError`。
 *
 * 错误码的依据是 **是否真的发出过请求**，而不是「有没有 Key」：AnySearch 可以无 Key
 * 调用（匿名额度），所以只要发出去过，全失败就是 provider 层面的错误；一次都没发出去
 * （全被缺 Key 拦下）才是凭据问题。
 */
function buildAllEnginesFailed(failures: readonly string[], attempted: boolean): WebError {
  const detail = failures.join('; ');
  if (attempted) {
    return new WebError(
      `Every web search engine that could be called failed — ${detail}. ` +
        'Check each engine\'s availability and remaining quota, or reorder "providerOrder" ' +
        'in the web-search-gongyy configuration.',
      'WEB_PROVIDER_ERROR',
    );
  }
  return new WebError(
    `No web search engine could be called — ${detail}. ` +
      'AnySearch works without a key (anonymous quota); Tavily needs TAVILY_API_KEY. ' +
      'Store a key in $DSH_HOME/.credentials.yaml, or export it before launching DSH.',
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  );
}

/**
 * 把多个检索引擎聚合成**一个** seam provider。
 *
 * 为什么不是「每个引擎注册一个 provider」：seam 在没配 `searchProvider` 且存在多个可用
 * provider 时抛 `WEB_PROVIDER_AMBIGUOUS`。把 fallback 收进一个 provider 内部，既满足
 * seam 的选择规则，也让 `searchProvider` 这个配置项有确定含义。
 *
 * 可重入：`web_search` 会并发调用本 provider（每次查询一个），所以这里不持有任何跨调用
 * 的可变状态 —— 每个 `search()` 只读自己那份配置快照。
 */
export class FallbackSearchProvider implements WebSearchProvider {
  readonly id = PROVIDER_ID;

  private readonly snapshot: () => ProviderOptions;

  constructor(snapshot: () => ProviderOptions) {
    this.snapshot = snapshot;
  }

  /**
   * 廉价、同步、**不发网络请求**的可用性判断 —— seam 每次执行都会问它。
   *
   * 语义是「这个 provider 有意愿工作」：凭据解析是异步的，而这里必须同步，所以
   * 缺 Key 留到搜索时以错误码暴露（与官方 provider 一致）。AnySearch 的匿名能力
   * 让「零配置可用」成为默认路径。
   */
  available(): boolean {
    return this.snapshot().order.length > 0;
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.snapshot();

    if (options.order.length === 0) {
      throw new WebError(
        'Web search is not configured: "providerOrder" is empty. ' +
          'Set it to at least one engine, for example [anysearch, tavily].',
        'WEB_PROVIDER_ERROR',
      );
    }

    const limit = request.maxResults ?? options.maxResultsPerEngine;
    const failures: string[] = [];
    let attempted = false;

    for (const id of options.order) {
      throwIfAborted(signal);

      const engine = engineById(id);
      if (engine === undefined) {
        failures.push(`${id}: unknown engine (known engines: ${knownEngineIds().join(', ')})`);
        options.warn(`web-search-gongyy: skipping unknown engine "${id}"`);
        continue;
      }

      let apiKey: string | undefined;
      try {
        apiKey = options.literalApiKey(engine) ?? (await options.resolveApiKey(engine, signal));
      } catch (error) {
        throwIfAborted(signal);
        const reason = describe(error);
        failures.push(`${id}: credential resolution failed (${reason})`);
        options.warn(`web-search-gongyy: engine "${id}" credential resolution failed: ${reason}`);
        continue;
      }

      if (engine.requiresApiKey && (apiKey === undefined || apiKey.length === 0)) {
        failures.push(`${id}: no API key (set ${engine.apiKeyEnv}, or use an engine that supports anonymous access)`);
        options.warn(`web-search-gongyy: engine "${id}" needs ${engine.apiKeyEnv}; skipped`);
        continue;
      }

      attempted = true;

      try {
        const result = await engine.search(request.query, apiKey ?? '', limit, signal);

        if (result.sources.length === 0) {
          failures.push(`${id}: returned no results`);
          options.warn(`web-search-gongyy: engine "${id}" returned no results; trying next`);
          continue;
        }

        // 之前有引擎失败过 —— 这次成功就是一次 fallback，必须留痕，否则
        // 引擎故障会完全隐形，用户只会一直烧后面引擎的额度。
        if (failures.length > 0) {
          options.warn(
            `web-search-gongyy: fell back to engine "${id}" after ${failures.length} failure(s): ${failures.join('; ')}`,
          );
        }

        return {
          ...(result.content === undefined || result.content.length === 0
            ? {}
            : { content: result.content }),
          sources: result.sources,
          // seam 在按 maxResults 截断时自己置位；provider 不应谎报。
          truncated: false,
        };
      } catch (error) {
        throwIfAborted(signal);
        const reason = describe(error);
        failures.push(`${id}: ${reason}`);
        options.warn(`web-search-gongyy: engine "${id}" failed: ${reason}; trying next`);
      }
    }

    throw buildAllEnginesFailed(failures, attempted);
  }
}

/** 只有 http / https 能抓 —— 其它协议（file:、ftp:、data: 等）直接判非法，不发请求。 */
function assertFetchableUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new WebError(`invalid URL: ${raw}`, 'WEB_INVALID_URL', { cause: error });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebError(
      `unsupported URL scheme "${parsed.protocol}" (only http and https are allowed)`,
      'WEB_INVALID_URL',
    );
  }
}

/**
 * 把多个抓取引擎聚合成**一个** seam fetch provider。
 *
 * 与 {@link FallbackSearchProvider} 同构 —— 复用同一份配置快照、同一套取消纪律、
 * 同一个错误聚合。**差异只有一处**：成功判据是**非空正文**，不是非空 sources。
 *
 * id 与搜索 provider **相同**：seam 的 search / fetch 是两个独立注册表，同一个 id
 * 两边都能注册（官方实现同样是 `ANYSEARCH_FETCH_PROVIDER_ID === ANYSEARCH_PROVIDER_ID`）。
 *
 * 结果结构上的两个取舍（照参考实现）：
 * - `statusCode` 固定 `200` —— extract 接口的成功投影**不含源站状态**，我们不能谎报一个
 *   没拿到的状态码。这是"这次抓取成功了"的约定写法，不是对目标页面的断言。
 * - `body.kind` 是 `'text'` —— extract 返回的是清洗后的 markdown，不是 HTML。
 */
export class FallbackFetchProvider implements WebFetchProvider {
  readonly id = PROVIDER_ID;

  private readonly snapshot: () => ProviderOptions;

  constructor(snapshot: () => ProviderOptions) {
    this.snapshot = snapshot;
  }

  /** 与搜索 provider 同一语义：表达"有意愿工作"，缺 Key 留到操作时以错误码暴露。 */
  available(): boolean {
    return this.snapshot().order.length > 0;
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    // 协议校验放最前面：非法 URL 省掉一整轮引擎调用。
    assertFetchableUrl(request.url);

    const options = this.snapshot();

    if (options.order.length === 0) {
      throw new WebError(
        'Web fetch is not configured: "providerOrder" is empty. ' +
          'Set it to at least one engine that supports fetching, for example [anysearch, tavily].',
        'WEB_PROVIDER_ERROR',
      );
    }

    const failures: string[] = [];
    let attempted = false;

    for (const id of options.order) {
      throwIfAborted(signal);

      const engine = engineById(id);
      if (engine === undefined) {
        failures.push(`${id}: unknown engine (known engines: ${knownEngineIds().join(', ')})`);
        options.warn(`web-search-gongyy: skipping unknown engine "${id}"`);
        continue;
      }

      // 没有 extract 端点的引擎（纯 SERP）不进抓取链 —— 可选方法让这里直接收窄。
      if (engine.fetch === undefined) {
        failures.push(`${id}: does not support fetching`);
        options.warn(`web-search-gongyy: engine "${id}" has no extract endpoint; skipped for fetch`);
        continue;
      }
      const fetchFromEngine = engine.fetch.bind(engine);

      let apiKey: string | undefined;
      try {
        apiKey = options.literalApiKey(engine) ?? (await options.resolveApiKey(engine, signal));
      } catch (error) {
        throwIfAborted(signal);
        const reason = describe(error);
        failures.push(`${id}: credential resolution failed (${reason})`);
        options.warn(`web-search-gongyy: engine "${id}" credential resolution failed: ${reason}`);
        continue;
      }

      if (engine.requiresApiKey && (apiKey === undefined || apiKey.length === 0)) {
        failures.push(
          `${id}: no API key (set ${engine.apiKeyEnv}, or use an engine that supports anonymous access)`,
        );
        options.warn(`web-search-gongyy: engine "${id}" needs ${engine.apiKeyEnv}; skipped`);
        continue;
      }

      attempted = true;

      try {
        const result = await fetchFromEngine(request.url, apiKey ?? '', signal);

        // 空/纯空白正文不算成功 —— 否则模型会收到一个空的"抓取结果"。
        if (result.content.trim().length === 0) {
          failures.push(`${id}: returned empty content`);
          options.warn(`web-search-gongyy: engine "${id}" returned empty content; trying next`);
          continue;
        }

        if (failures.length > 0) {
          options.warn(
            `web-search-gongyy: fell back to engine "${id}" for fetch after ${failures.length} failure(s): ${failures.join('; ')}`,
          );
        }

        return {
          url: result.url ?? request.url,
          statusCode: 200,
          body: { kind: 'text', content: result.content },
          truncated: result.truncated,
        };
      } catch (error) {
        throwIfAborted(signal);
        const reason = describe(error);
        failures.push(`${id}: ${reason}`);
        options.warn(`web-search-gongyy: engine "${id}" fetch failed: ${reason}; trying next`);
      }
    }

    throw buildAllEnginesFailed(failures, attempted);
  }
}
