import type { Engine, EngineFetchResult, EngineResult, EngineSource } from '../types.js';
import { asArray, asRecord, optionalIsoDate, optionalString } from './fields.js';

/** Tavily 公开 API 基地址。 */
const BASE_URL = 'https://api.tavily.com';

interface TavilySearchResponse {
  readonly answer?: unknown;
  readonly results?: unknown;
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
   */
  async fetch(url, apiKey, signal): Promise<EngineFetchResult> {
    const response = await fetch(`${BASE_URL}/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, urls: [url] }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw new Error(`Tavily extract failed: HTTP ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as { readonly results?: unknown };
    const first = asArray(payload.results)
      .map((entry) => asRecord(entry))
      .find((record) => record !== undefined);

    // 取不到正文时返回空串 —— 聚合层把空正文当失败，会继续尝试下一个引擎。
    const content = optionalString(first?.['raw_content']) ?? '';

    return { content, truncated: false };
  },
};
