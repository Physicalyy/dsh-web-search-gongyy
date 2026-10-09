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
import { EngineFetchError } from './types.js';
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

/**
 * 已取消就抛 seam 的稳定取消错误，保留调用方给的原因。
 *
 * **超时与取消要分开**：`AbortSignal.timeout()` 到点时 `signal.aborted === true`，
 * 但 `reason` 是 `TimeoutError` —— 那是超时（`WEB_FETCH_TIMEOUT`），不是调用方取消。
 * 只有抓取侧做这个区分：搜索侧的既有行为（一律 `WEB_ABORTED`）不在本任务范围内改动。
 */
function throwIfAborted(signal: AbortSignal | undefined, capability: Capability = 'search'): void {
  if (signal?.aborted !== true) return;

  const timedOut =
    capability === 'fetch' &&
    signal.reason instanceof Error &&
    signal.reason.name === 'TimeoutError';

  throw new WebError(
    timedOut ? 'Web fetch timed out' : `Web ${capability} aborted`,
    timedOut ? 'WEB_FETCH_TIMEOUT' : 'WEB_ABORTED',
    { cause: signal.reason },
  );
}

/** 无消息时的标签：Node 的网络错误靠 `code` 区分，优先用它。 */
function labelOf(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : error.name;
}

/**
 * 把任意抛出物压成一行可读文本，**带上 cause 链**。
 *
 * undici 的网络失败原因在 `error.cause` 里（`ECONNRESET` / `UND_ERR_*` / 证书问题…），
 * 只取 `message` 会退化成一句 `fetch failed` —— 实测在 dsh 宿主进程里就是这样，
 * 完全看不出断在哪一层（同一个地址在独立夹具里回的是 403，说明上游边缘行为不稳定）。
 *
 * 最多往下走 3 层并去重（Node 常见 `TypeError: fetch failed` → `Error: connect ECONNREFUSED …`）。
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const chain: string[] = [error.message.length === 0 ? labelOf(error) : error.message];
  let cause: unknown = (error as { cause?: unknown }).cause;

  for (let depth = 0; depth < 3 && cause !== undefined && cause !== null; depth += 1) {
    if (cause instanceof Error) {
      const entry = cause.message.length === 0 ? labelOf(cause) : `${labelOf(cause)}: ${cause.message}`;
      if (!chain.includes(entry)) chain.push(entry);
      cause = (cause as { cause?: unknown }).cause;
    } else {
      const entry = String(cause);
      if (!chain.includes(entry)) chain.push(entry);
      break;
    }
  }

  const head = chain[0] ?? String(error);
  return chain.length === 1 ? head : `${head} (cause: ${chain.slice(1).join(' → ')})`;
}

/**
 * 抓取链上"这个失败与谁去抓无关"的判断依据。
 *
 * 依据 2026-10-09 的上游实测（`tasks/10-09-fetch-typed-errors/research/upstream-error-codes.md`）——
 * **只映射我们真的观测得到的信号**：编出来的码比没有更糟，因为它会误导排查。
 *
 * | `EngineFetchError.kind` | seam 码 | 是否短路 |
 * | --- | --- | --- |
 * | `url-rejected` | `WEB_BLOCKED_URL` | ✅ 上游策略拒绝该目标，换引擎也一样 |
 * | `engine-failed` | `WEB_PROVIDER_ERROR` | ❌ 可能是瞬时的，换引擎有意义 |
 *
 * 本地语法校验拦下的非法 URL 仍然是 `WEB_INVALID_URL`（`assertFetchableUrl`，不发任何请求）。
 */
function isTerminalFetchFailure(error: unknown): boolean {
  return error instanceof EngineFetchError && error.kind === 'url-rejected';
}

/** 这次操作是搜索还是抓取 —— 只影响错误文案，不影响判定逻辑。 */
type Capability = 'search' | 'fetch';

/**
 * 把「所有引擎都没成功」拼成携带可操作指引的 `WebError`。
 *
 * 错误码的依据是 **是否真的发出过请求**，而不是「有没有 Key」：AnySearch 可以无 Key
 * 调用（匿名额度），所以只要发出去过，全失败就是 provider 层面的错误；一次都没发出去
 * （全被缺 Key 拦下）才是凭据问题。
 *
 * `capability` 是**实测补上的**：两个 provider 共用本函数，抓取失败时原文案说的是
 * "web search engine"，用户看到的是一句与刚才那次抓取无关的话。
 */
function buildAllEnginesFailed(
  failures: readonly string[],
  attempted: boolean,
  capability: Capability,
): WebError {
  const detail = failures.join('; ');
  if (attempted) {
    return new WebError(
      `Every engine that could be called for this web ${capability} failed — ${detail}. ` +
        'Check each engine\'s availability and remaining quota, or reorder "providerOrder" ' +
        'in the web-search-gongyy configuration.',
      'WEB_PROVIDER_ERROR',
    );
  }
  return new WebError(
    `No engine could be called for this web ${capability} — ${detail}. ` +
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

    throw buildAllEnginesFailed(failures, attempted, 'search');
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
 * 内容质量判据的阈值 —— **集中一处**，标定过程见
 * `tasks/archive/2026-10/10-09-fetch-quality-fallback/research/quality-calibration.md`
 *（后续扩样见 `tasks/10-09-fetch-polish/research/quality-calibration-2.md`）。
 *
 * 标定样本（真实页面 × 2 引擎）：
 * - 垃圾样本（baidu 首页的 AnySearch 输出）：花括号+分号 **47.1/千字**、引号 **0/千字**、链接 **0**
 * - 合法样本群的 cssScore 上限：**12.7/千字**（nodejs.org 的 Tavily 输出）
 * - 唯一"cssScore 高但合法"的样本是 JSON：它的**引号密度是 69–72/千字** —— 用引号把它摘出去
 *
 * 阈值取在 12.7 与 47.1 之间（留 1.5× 余量）。三个子条件必须**同时**成立才判低质：
 * 宁可漏判（多交给模型一份噪声），不要误伤（把 JSON/源码判成垃圾）。
 *
 * 导出是为了让**标定脚本与测试用同一份实现** —— 抄一份阈值过去一定会漂移。
 */
export const QUALITY = {
  /** 花括号+分号密度阈值（每千字符）。 */
  cssDensityPer1k: 20,
  /** 引号密度上限（每千字符）—— 高于它说明更像 JSON，不是 CSS。 */
  quoteDensityPer1k: 10,
} as const;

/**
 * 这份正文像不像"给模型看的正文"。
 *
 * 判据（两者任一命中即算非正文）：
 * 1. 正文开头就是 `<style` / `<script`（标记残留）
 * 2. 花括号+分号密度 ≥ 20/千字 **且** 引号密度 < 10/千字 **且** 链接数为 0（CSS 的形状）
 *
 * 纯本地、同步、无依赖。**不改** `truncated`，也不新增字段（seam 的 `WebFetchResult` 没有质量位）。
 */
export function looksLikeNonProse(text: string): boolean {
  if (/^\s*<(style|script)\b/i.test(text.slice(0, 200))) return true;

  const length = Math.max(text.length, 1);
  const per1k = (pattern: RegExp): number => ((text.match(pattern) ?? []).length / length) * 1000;

  return (
    per1k(/[{};]/g) >= QUALITY.cssDensityPer1k &&
    per1k(/["']/g) < QUALITY.quoteDensityPer1k &&
    (text.match(/\]\(/g) ?? []).length === 0
  );
}

/** 低质原因的可读描述（写进 failures 与日志，便于将来按实际情况调阈值）。 */
function describeNonProse(text: string): string {
  const length = Math.max(text.length, 1);
  const per1k = (pattern: RegExp): string =>
    (((text.match(pattern) ?? []).length / length) * 1000).toFixed(1);
  const head = /^\s*<(style|script)\b/i.test(text.slice(0, 200)) ? 'starts with a style/script tag' : 'css-like';
  return `non-prose content (${head}; braces+semicolons ${per1k(/[{};]/g)}/1k, quotes ${per1k(/["']/g)}/1k)`;
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
    /** 第一份"非正文"结果：所有引擎都给不出正文时退回它，而不是抛错。 */
    let firstNonProse: WebFetchResult | undefined;

    for (const id of options.order) {
      throwIfAborted(signal, 'fetch');

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
        throwIfAborted(signal, 'fetch');
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

        const asResult: WebFetchResult = {
          url: result.url ?? request.url,
          statusCode: 200,
          body: { kind: 'text', content: result.content },
          truncated: result.truncated,
        };

        // 不是正文（实测：AnySearch 抓 baidu 首页给 5 万字符 <style> CSS）→ 当失败处理，
        // 让下一个引擎有机会给真正文。**记住第一份**：万一所有引擎都只给出噪声，
        // 返回它总好过抛错（详见 design.md 的 Q2）。
        if (looksLikeNonProse(result.content)) {
          const reason = describeNonProse(result.content);
          failures.push(`${id}: ${reason}`);
          options.warn(`web-search-gongyy: engine "${id}" returned ${reason}; trying next`);
          firstNonProse ??= asResult;
          continue;
        }

        if (failures.length > 0) {
          options.warn(
            `web-search-gongyy: fell back to engine "${id}" for fetch after ${failures.length} failure(s): ${failures.join('; ')}`,
          );
        }

        return asResult;
      } catch (error) {
        // 顺序不变：先把取消/超时转成 seam 错误抛出去，再决定要不要记进 failures。
        throwIfAborted(signal, 'fetch');
        const reason = describe(error);
        failures.push(`${id}: ${reason}`);
        options.warn(`web-search-gongyy: engine "${id}" fetch failed: ${reason}; trying next`);

        // 与引擎无关的失败：继续试下一个只会再失败一次（实测内网地址白跑 427–818ms）。
        if (isTerminalFetchFailure(error)) {
          throw new WebError(
            `Web fetch was blocked for this URL — ${failures.join('; ')}. ` +
              'This failure is about the URL itself, so the remaining engines were not tried. ' +
              'Check the URL, or reorder "providerOrder" in the web-search-gongyy configuration.',
            'WEB_BLOCKED_URL',
          );
        }
      }
    }

    // 所有引擎都没给出正文，但只要有一份"非正文"内容，就返回它而不是抛错：
    // 抛错会让用户彻底拿不到东西，而噪声至少可能含有信息（design.md 的 Q2）。
    if (firstNonProse !== undefined) {
      options.warn(
        'web-search-gongyy: every engine returned non-prose content; returning the first one anyway',
      );
      return firstNonProse;
    }

    throw buildAllEnginesFailed(failures, attempted, 'fetch');
  }
}
