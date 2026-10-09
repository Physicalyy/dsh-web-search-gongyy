/**
 * FallbackFetchProvider 的行为测试。
 *
 * 跑的是 `dist/` 的构建产物，网络用替换 `globalThis.fetch` 的桩 —— 与
 * `provider.test.mjs`（搜索端）同构：**差异只有成功判据（非空正文）与结果结构**。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { FallbackFetchProvider, PROVIDER_ID } from '../dist/index.js';

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  globalThis.fetch = realFetch;
});

/** 装一个按 URL 分派的 fetch 桩，返回被调用记录。 */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    calls.push({ url: href, init });
    return handler(href, init);
  };
  return calls;
}

/** 构造一个 JSON Response。 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 收集 warn 输出。 */
function collector() {
  const messages = [];
  return { messages, warn: (message) => messages.push(message) };
}

/** 构造一次操作的配置快照。 */
function snapshot(overrides = {}) {
  const log = overrides.log ?? collector();
  return {
    provider: new FallbackFetchProvider(() => ({
      order: ['anysearch', 'tavily'],
      maxResultsPerEngine: 8,
      literalApiKey: () => undefined,
      resolveApiKey: async () => 'test-key',
      warn: log.warn,
      ...overrides.options,
    })),
    log,
  };
}

/** AnySearch extract 的成功信封。 */
const anysearchOk = (content, extra = {}) =>
  json({ code: 0, message: 'ok', data: { content, ...extra } });

/** Tavily extract 的成功响应。 */
const tavilyOk = (rawContent) => json({ results: [{ raw_content: rawContent }] });

const TARGET = 'https://example.com/article';

describe('FallbackFetchProvider', () => {
  it('available() 与搜索 provider 同一语义', () => {
    assert.equal(snapshot().provider.available(), true);
    assert.equal(snapshot({ options: { order: [] } }).provider.available(), false);
  });

  it('id 与搜索 provider 相同（两个独立注册表，一个 id 服务两种能力）', () => {
    assert.equal(snapshot().provider.id, PROVIDER_ID);
  });

  it('首个引擎成功即返回，完全不调用第二个引擎', async () => {
    let tavilyCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) return anysearchOk('# 正文');
      tavilyCalls += 1;
      return tavilyOk('别的正文');
    });

    const result = await snapshot().provider.fetch({ url: TARGET });

    assert.equal(result.body.content, '# 正文');
    assert.equal(tavilyCalls, 0, '第一个引擎成功后不得再调用第二个');
  });

  it('结果结构：url / statusCode 200 / body.kind text / truncated', async () => {
    stubFetch(() => anysearchOk('# 正文'));
    const result = await snapshot().provider.fetch({ url: TARGET });

    assert.equal(result.url, TARGET, '引擎没报 URL 时用请求 URL 兜底');
    assert.equal(result.statusCode, 200, 'extract 成功投影不含源站状态，固定 200');
    assert.deepEqual(result.body, { kind: 'text', content: '# 正文' });
    assert.equal(result.truncated, false);
  });

  it('引擎报告了目标 URL 时用它（重定向后的地址）', async () => {
    stubFetch(() => anysearchOk('# 正文', { url: 'https://example.com/final' }));
    const result = await snapshot().provider.fetch({ url: TARGET });
    assert.equal(result.url, 'https://example.com/final');
  });

  it('首个引擎 HTTP 失败时 fallback 到第二个引擎', async () => {
    stubFetch((url) => {
      if (url.includes('anysearch.com')) return json({ error: 'boom' }, 500);
      return tavilyOk('Tavily 的正文');
    });

    const { provider, log } = snapshot();
    const result = await provider.fetch({ url: TARGET });

    assert.equal(result.body.content, 'Tavily 的正文');
    assert.ok(
      log.messages.some((m) => m.includes('anysearch') && m.includes('failed')),
      `应记录 anysearch 失败，实际：${JSON.stringify(log.messages)}`,
    );
    assert.ok(log.messages.some((m) => m.includes('fell back to engine "tavily" for fetch')));
  });

  // ── 与搜索端同一个关键回归点 ────────────────────────────────────────────
  it('AnySearch 返回 HTTP 200 但信封 code !== 0 时判定失败并 fallback', async () => {
    let anysearchCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) {
        anysearchCalls += 1;
        return json({ code: 50001, message: 'quota exhausted', data: null });
      }
      return tavilyOk('Tavily 的正文');
    });

    const { provider, log } = snapshot();
    const result = await provider.fetch({ url: TARGET });

    assert.equal(anysearchCalls, 1);
    assert.equal(result.body.content, 'Tavily 的正文', '必须落到第二个引擎，而不是返回空正文');

    const joined = log.messages.join('\n');
    assert.ok(joined.includes('50001'), `错误信息应带上信封 code，实际：${joined}`);
    assert.ok(joined.includes('quota exhausted'), `错误信息应带上信封 message，实际：${joined}`);
  });

  it('空正文不算成功，继续尝试下一个引擎', async () => {
    let tavilyCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) return anysearchOk('   \n  ');
      tavilyCalls += 1;
      return tavilyOk('Tavily 的正文');
    });

    const { provider } = snapshot();
    const result = await provider.fetch({ url: TARGET });

    assert.equal(tavilyCalls, 1, '纯空白正文应被视为失败');
    assert.equal(result.body.content, 'Tavily 的正文');
  });

  it('Tavily 取不到 raw_content 时也按空正文处理', async () => {
    stubFetch(() => json({ results: [{}] }));

    const { provider } = snapshot({ options: { order: ['tavily'] } });

    await assert.rejects(
      () => provider.fetch({ url: TARGET }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_ERROR');
        assert.ok(error.message.includes('empty content'), error.message);
        return true;
      },
    );
  });

  it('全部失败时抛 WEB_PROVIDER_ERROR，消息含每个引擎的失败原因', async () => {
    stubFetch(() => json({ error: 'down' }, 503));

    await assert.rejects(
      () => snapshot().provider.fetch({ url: TARGET }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_ERROR');
        assert.ok(error.message.includes('anysearch'));
        assert.ok(error.message.includes('tavily'));
        // 两者共用错误聚合函数，抓取失败时必须说 fetch 而不是 search（实测踩到过）。
        assert.ok(error.message.includes('web fetch'), `文案应指明是抓取失败：${error.message}`);
        return true;
      },
    );
  });

  it('只配了需要 Key 的引擎且无 Key 时抛 WEB_PROVIDER_CREDENTIAL_MISSING，且不发请求', async () => {
    let fetchCalls = 0;
    stubFetch(() => {
      fetchCalls += 1;
      return tavilyOk('不该被调用');
    });

    const { provider } = snapshot({
      options: {
        order: ['tavily'],
        literalApiKey: () => undefined,
        resolveApiKey: async () => undefined,
      },
    });

    await assert.rejects(
      () => provider.fetch({ url: TARGET }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING');
        assert.ok(error.message.includes('TAVILY_API_KEY'));
        assert.ok(error.message.includes('web fetch'), `文案应指明是抓取失败：${error.message}`);
        return true;
      },
    );

    assert.equal(fetchCalls, 0);
  });

  it('URL 非 http/https 时抛 WEB_INVALID_URL，且不发任何请求', async () => {
    let fetchCalls = 0;
    stubFetch(() => {
      fetchCalls += 1;
      return anysearchOk('不该被调用');
    });

    const { provider } = snapshot();

    for (const bad of ['ftp://example.com/x', 'file:///etc/hosts', 'data:text/plain,hi', 'not-a-url']) {
      await assert.rejects(
        () => provider.fetch({ url: bad }),
        (error) => {
          assert.equal(error.code, 'WEB_INVALID_URL', `"${bad}" 应当被判非法`);
          return true;
        },
      );
    }

    assert.equal(fetchCalls, 0, '协议校验必须在最前面，省掉一整轮引擎调用');
  });

  it('signal 已 abort 时抛 WEB_ABORTED，且不发请求', async () => {
    let fetchCalls = 0;
    stubFetch(() => {
      fetchCalls += 1;
      return anysearchOk('不该被调用');
    });

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => snapshot().provider.fetch({ url: TARGET }, controller.signal),
      (error) => {
        assert.equal(error.code, 'WEB_ABORTED');
        return true;
      },
    );

    assert.equal(fetchCalls, 0);
  });

  it('providerOrder 为空时抛 WEB_PROVIDER_ERROR', async () => {
    await assert.rejects(
      () => snapshot({ options: { order: [] } }).provider.fetch({ url: TARGET }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_ERROR');
        assert.ok(error.message.includes('providerOrder'));
        return true;
      },
    );
  });

  // ── 截断启发式 ──────────────────────────────────────────────────────────
  it('AnySearch 50000 字符上限：恰好达到即视为已截断', async () => {
    const atCap = 'x'.repeat(50_000);
    stubFetch(() => anysearchOk(atCap));
    const truncated = await snapshot().provider.fetch({ url: TARGET });
    assert.equal(truncated.truncated, true, 'API 不报截断标志，用「恰好达到上限」作启发式');
    assert.equal(truncated.body.content.length, 50_000);

    const belowCap = 'x'.repeat(49_999);
    stubFetch(() => anysearchOk(belowCap));
    const notTruncated = await snapshot().provider.fetch({ url: TARGET });
    assert.equal(notTruncated.truncated, false);
  });

  it('Tavily 恒报 truncated: false（该引擎不报截断，不能凭空声称）', async () => {
    stubFetch(() => tavilyOk('x'.repeat(60_000)));
    const result = await snapshot({ options: { order: ['tavily'] } }).provider.fetch({ url: TARGET });
    assert.equal(result.truncated, false, '截图上限由 seam 自己按输出上限处理');
  });

  // ── 一个无法测的分支（如实标注，不假装覆盖了）──────────────────────────
  // 「跳过没有 extract 端点的引擎」这条分支在当前引擎集下**不可达** —— AnySearch 与
  // Tavily 都实现了 fetch。它是为纯 SERP 引擎（如 Brave）预留的，而引擎列表
  // （src/engines/index.ts 的 ENGINES）是静态的、没有注入点，所以无法构造用例。
  // 想要覆盖它，得先把引擎表做成可注入的 —— 那属于为测试而改设计，暂不做。
});
