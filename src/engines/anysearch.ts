import type { Engine, EngineFetchResult, EngineResult, EngineSource } from '../types.js';
import { EngineFetchError } from '../types.js';
import { asArray, asRecord, optionalString } from './fields.js';

/** AnySearch 公开 API 基地址。 */
const BASE_URL = 'https://api.anysearch.com';

/**
 * AnySearch extract 的正文上限（字符）。
 *
 * 取自参考实现的实测值。**API 自己不报截断标志**，所以只能用「正文长度恰好达到上限」
 * 作为启发式 —— 这是有损的判断，但比永远报 `truncated: false` 诚实。
 */
const EXTRACT_MAX_CHARACTERS = 50_000;

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

/** 带鉴权头（无 Key 时不带，走匿名额度）。 */
function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

/**
 * 把 extract 的非 2xx 分类。
 *
 * 实测（2026-10-09，含**完整信封**）：
 * - `http://127.0.0.1:19387/` 这类非公网目标 → **403 + 一整页 HTML 错误页**（不是信封）
 * - 其余失败 → **422 + 信封**，但信封里 `code=-1`、`error_code="extract_failed"`、
 *   `message="Unable to extract content from the URL."` ——
 *   "主机不存在 / PDF / 404 路径 / 反爬站点"**四种情形完全相同**，
 *   所以**没有** `extract_target_blocked` / `extract_unsupported_content` 之类的可区分码
 *   （参考实现里那张表在本版本的公开 API 上不存在）
 *
 * 结论：只区分"非信封的 403"（`engine-failed` + 记下状态码）与其它（同样 `engine-failed`），
 * 但**把信封字段原样带进消息** —— 那是排查的唯一线索。
 *
 * 注意：403 虽然看起来像"目标被拒"，但 403 也可能来自配额/鉴权层面，所以聚合层
 * **不为它短路**（见 `provider.ts` 的 `isTerminalFetchFailure`）：宁可多跑一次 fallback，
 * 也不要因为一次边缘拒绝就放弃其它引擎。
 */
function extractFailureFromHttp(status: number, statusText: string, body: string): EngineFetchError {
  const compact = body.replace(/\s+/g, ' ').trim();
  const envelope = asRecord(safeJson(compact));

  if (envelope !== undefined && (envelope['code'] !== undefined || envelope['message'] !== undefined)) {
    const parts = [
      envelope['code'] === undefined ? undefined : `code=${String(envelope['code'])}`,
      optionalString(envelope['error_code']) === undefined
        ? undefined
        : `error_code=${optionalString(envelope['error_code']) as string}`,
      optionalString(envelope['message']) === undefined
        ? undefined
        : `message=${optionalString(envelope['message']) as string}`,
    ].filter((part): part is string => part !== undefined);

    const reason = parts.join(', ');
    return new EngineFetchError(`AnySearch extract failed: HTTP ${status} ${statusText} (${reason})`, {
      kind: 'engine-failed',
      upstreamStatus: status,
      ...(envelope['code'] === undefined ? {} : { upstreamCode: String(envelope['code']) }),
      reason,
    });
  }

  const reason = compact.length === 0 ? undefined : compact.slice(0, 200);
  return new EngineFetchError(
    `AnySearch extract failed: HTTP ${status} ${statusText}${reason === undefined ? '' : ` (body: ${reason})`}`,
    {
      kind: 'engine-failed',
      upstreamStatus: status,
      ...(reason === undefined ? {} : { reason }),
    },
  );
}

/** 解析 JSON，失败返回 `undefined`（上游的 403 是一整页 HTML，不能假定是 JSON）。 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * AnySearch 引擎。
 *
 * 四个实现要点：
 *
 * 1. **必须判信封的 `code === 0`。** 只判 `res.ok` 会把服务端错误（额度用尽、参数
 *    非法等）当成成功，返回空结果，从而**直接中断整条 fallback 链** —— 用户看到的是
 *    "搜不到东西"，而不是"引擎 A 挂了、已切到引擎 B"。搜索与抓取两端同样适用。
 * 2. **支持匿名。** `requiresApiKey: false`；Key 为空时不带 `Authorization` 头，
 *    走服务端匿名额度。官方实现对此的注释是 `Missing values use anonymous access.`
 * 3. **没有日期字段。** AnySearch 不返回 `publishedAt`，所以永远不设置它。
 * 4. **extract 返回的是清洗后的 markdown**，不是 HTML。
 */
export const anysearchEngine: Engine = {
  id: 'anysearch',
  apiKeyEnv: 'ANYSEARCH_API_KEY',
  requiresApiKey: false,

  async search(query, apiKey, limit, signal): Promise<EngineResult> {
    const response = await fetch(`${BASE_URL}/v1/search`, {
      method: 'POST',
      headers: jsonHeaders(apiKey),
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

  /**
   * 抓取一个 URL 的清洗正文：`POST /v1/extract`，取 `data.content`。
   *
   * 与搜索同样要判信封 —— extract 的 HTTP 200 也可能是业务失败。
   *
   * **错误的分类只做两档**（实测依据见 tasks/10-09-fetch-typed-errors/research/upstream-error-codes.md）：
   * - 非 2xx **且响应体不是信封**（实测是一整页 HTML）→ `url-blocked`：这是 AnySearch 的边缘策略
   *   在拒绝这个目标，与"哪个引擎来抓"无关
   * - 其余一切（信封 `code !== 0`、5xx）→ `engine-failed`：AnySearch 把它们全压成
   *   `422 / code:-1 / "Unable to extract content from the URL."`，**区分不了**
   *   "被反爬"与"抽不出正文"，所以不编造更细的码
   */
  async fetch(url, apiKey, signal): Promise<EngineFetchResult> {
    const response = await fetch(`${BASE_URL}/v1/extract`, {
      method: 'POST',
      headers: jsonHeaders(apiKey),
      body: JSON.stringify({ url }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw extractFailureFromHttp(response.status, response.statusText, body);
    }

    const envelope = (await response.json()) as Envelope;
    if (envelope.code !== 0) {
      const code = envelope.code === undefined ? '(absent)' : String(envelope.code);
      const reason = optionalString(envelope.message) ?? '(no message)';
      throw new EngineFetchError(`AnySearch extract failed: code=${code}, message=${reason}`, {
        kind: 'engine-failed',
        upstreamStatus: response.status,
        upstreamCode: envelope.code === undefined ? '(absent)' : String(envelope.code),
        reason,
      });
    }

    const data = asRecord(envelope.data);
    const content = optionalString(data?.['content']) ?? '';
    // extract 可能报告目标 URL（重定向后的）；缺省时让聚合层用请求 URL 兜底。
    const reported = optionalString(data?.['url']);

    return {
      content,
      truncated: content.length >= EXTRACT_MAX_CHARACTERS,
      ...(reported === undefined ? {} : { url: reported }),
    };
  },
};
