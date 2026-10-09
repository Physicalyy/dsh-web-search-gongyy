import type { Engine, EngineFailureKind, EngineFetchResult, EngineResult, EngineSource } from '../types.js';
import { EngineFetchError } from '../types.js';
import { asArray, asRecord, optionalIsoDate, optionalString } from './fields.js';

/** Tavily 公开 API 基地址。 */
const BASE_URL = 'https://api.tavily.com';

interface TavilySearchResponse {
  readonly answer?: unknown;
  readonly results?: unknown;
}

/** extract 的响应形状：失败被包在 200 里，走 `failed_results`。 */
interface TavilyExtractResponse {
  readonly results?: unknown;
  readonly failed_results?: unknown;
  readonly detail?: unknown;
}

/**
 * 取上游给的原因文本。
 *
 * **两个位置都要看**（实测）：HTTP 200 的失败放在顶层 `failed_results[]`，
 * 而 HTTP 400 的失败把它**嵌在 `detail` 里面** —— 只看顶层会拿到 `detail.error`
 * 那句泛化文案（`All URLs failed validation.`），从而丢掉具体的
 * `Validation Error: Invalid URL format`，短路判断也就失效了。
 * 优先级：具体的 `failed_results[].error` > 泛化的 `detail.error`。
 */
function reasonOf(payload: TavilyExtractResponse | undefined): string | undefined {
  const detail = asRecord(payload?.detail);

  for (const list of [payload?.failed_results, detail?.['failed_results']]) {
    const failed = asArray(list)
      .map((entry) => asRecord(entry))
      .find((record) => record !== undefined);
    const fromFailed = optionalString(failed?.['error']);
    if (fromFailed !== undefined) return fromFailed;
  }

  return optionalString(detail?.['error']);
}

/**
 * 按上游原因文本分类。
 *
 * **这是一处脆弱匹配**（上游改文案就失效），所以匹配不上时的默认值是保守的
 * `engine-failed` —— 宁可少一次短路，也不要把"可能换引擎就能抓到"的情形判死。
 * 依据：2026-10-09 实测（见任务的 research/upstream-error-codes.md）。
 */
function classify(reason: string | undefined): EngineFailureKind {
  if (reason === undefined) return 'engine-failed';
  if (/invalid url format/i.test(reason)) return 'url-rejected';
  return 'engine-failed';
}

/** 组装带原因的结构化失败。 */
function extractFailure(status: number, statusText: string, reason: string | undefined): EngineFetchError {
  const suffix = reason === undefined ? '' : ` (upstream: ${reason})`;
  return new EngineFetchError(`Tavily extract failed: HTTP ${status} ${statusText}${suffix}`, {
    kind: classify(reason),
    upstreamStatus: status,
    ...(reason === undefined ? {} : { reason }),
  });
}

/**
 * Tavily 引擎。
 *
 * - **需要 Key**（`requiresApiKey: true`）。
 * - Tavily 是少数会返回 `answer`（直答摘要）的引擎，映射到 seam 的 `content`。
 * - `published_date` **仅在 `topic: 'news'` 下返回**；我们走通用搜索，所以预期为空。
 *   仍然照常读取 —— 代价为零，将来若改成 news 会自动生效。
 * - **extract 走 `/extract`**，取 `results[0].raw_content`。
 */
export const tavilyEngine: Engine = {
  id: 'tavily',
  apiKeyEnv: 'TAVILY_API_KEY',
  requiresApiKey: true,

  async search(query, apiKey, limit, signal): Promise<EngineResult> {
    const response = await fetch(`${BASE_URL}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: limit,
        search_depth: 'basic',
        include_answer: true,
      }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw new Error(`Tavily search failed: HTTP ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as TavilySearchResponse;
    const sources: EngineSource[] = [];

    for (const entry of asArray(payload.results)) {
      const record = asRecord(entry);
      if (record === undefined) continue;

      const url = optionalString(record['url']);
      if (url === undefined) continue;

      const title = optionalString(record['title']);
      const snippet = optionalString(record['content']);
      const publishedAt = optionalIsoDate(record['published_date']);

      sources.push({
        url,
        ...(title === undefined ? {} : { title }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
      });
    }

    const answer = optionalString(payload.answer);
    return {
      ...(answer === undefined ? {} : { content: answer }),
      sources,
    };
  },

  /**
   * 抓取一个 URL 的清洗正文：`POST /extract`，取 `results[0].raw_content`。
   *
   * Tavily **没有文档化的正文上限**，所以 `truncated` 恒为 `false` —— 该引擎不报截断，
   * 我们不能凭空声称它截断了（seam 自己还会按输出上限再截一次）。
   *
   * **它的失败形状很特别**：HTTP 200 + `results: []` + `failed_results: [{url, error}]`
   * （实测：`Failed to fetch url` / `404 page not found` / 400 时的
   * `Validation Error: Invalid URL format`）。原先把整段 `failed_results` 丢掉了，
   * 用户只看到一句 `returned empty content` —— 现在把原因带出去，并按原因分类。
   */
  async fetch(url, apiKey, signal): Promise<EngineFetchResult> {
    const response = await fetch(`${BASE_URL}/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, urls: [url] }),
      ...(signal === undefined ? {} : { signal }),
    });

    const payload = (await response.json().catch(() => undefined)) as TavilyExtractResponse | undefined;

    if (!response.ok) {
      throw extractFailure(response.status, response.statusText, reasonOf(payload));
    }

    const first = asArray(payload?.results)
      .map((entry) => asRecord(entry))
      .find((record) => record !== undefined);

    const content = optionalString(first?.['raw_content']) ?? '';

    // 取不到正文但有上游原因 → 抛出带原因的结构化失败。
    // 既没有正文、也没有原因（例如 `results: [{}]`）时**保持原行为**：返回空串，
    // 由聚合层按"空正文"处理 —— 那里的话术是既有的，不在这里改。
    if (content.length === 0) {
      const reason = reasonOf(payload);
      if (reason !== undefined) throw extractFailure(response.status, response.statusText, reason);
    }

    return { content, truncated: false };
  },
};
