import type { Engine, EngineResult, EngineSource } from '../types.js';
import { asArray, asRecord, optionalString } from './fields.js';

/** AnySearch 公开 API 基地址。 */
const BASE_URL = 'https://api.anysearch.com';

/**
 * AnySearch 的响应信封。
 *
 * **关键**：AnySearch 一律用 `{ code, message, request_id, data }` 包装，而且
 * **HTTP 200 也可能是业务失败** —— 成功与否看 `code === 0`，不看状态码。
 */
interface Envelope {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly data?: unknown;
}

/** 把信封的失败信息拼成可定位的消息（带上 code 和 message）。 */
function envelopeFailure(operation: string, envelope: Envelope): Error {
  const code = envelope.code === undefined ? '(absent)' : String(envelope.code);
  const message = optionalString(envelope.message) ?? '(no message)';
  return new Error(`AnySearch ${operation} failed: code=${code}, message=${message}`);
}

/**
 * AnySearch 引擎。
 *
 * 三个实现要点：
 *
 * 1. **必须判信封的 `code === 0`。** 只判 `res.ok` 会把服务端错误（额度用尽、参数
 *    非法等）当成成功，返回空结果，从而**直接中断整条 fallback 链** —— 用户看到的是
 *    "搜不到东西"，而不是"引擎 A 挂了、已切到引擎 B"。
 * 2. **支持匿名。** `requiresApiKey: false`；Key 为空时不带 `Authorization` 头，
 *    走服务端匿名额度。官方实现对此的注释是 `Missing values use anonymous access.`
 * 3. **没有日期字段。** AnySearch 不返回 `publishedAt`，所以永远不设置它。
 */
export const anysearchEngine: Engine = {
  id: 'anysearch',
  apiKeyEnv: 'ANYSEARCH_API_KEY',
  requiresApiKey: false,

  async search(query, apiKey, limit, signal): Promise<EngineResult> {
    const response = await fetch(`${BASE_URL}/v1/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ query, max_results: limit }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      throw new Error(`AnySearch search failed: HTTP ${response.status} ${response.statusText}`);
    }

    const envelope = (await response.json()) as Envelope;
    if (envelope.code !== 0) throw envelopeFailure('search', envelope);

    const data = asRecord(envelope.data);
    const sources: EngineSource[] = [];

    for (const entry of asArray(data?.['results'])) {
      const record = asRecord(entry);
      if (record === undefined) continue;

      const url = optionalString(record['url']);
      if (url === undefined) continue;

      const title = optionalString(record['title']);
      // `content` 比 `snippet` 更丰富，优先取它（与官方 CLI 的 content || snippet 一致）。
      const snippet = optionalString(record['content']) ?? optionalString(record['snippet']);

      sources.push({
        url,
        ...(title === undefined ? {} : { title }),
        ...(snippet === undefined ? {} : { snippet }),
      });
    }

    return { sources };
  },
};
