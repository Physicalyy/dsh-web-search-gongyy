/**
 * FallbackSearchProvider 的行为测试。
 *
 * 跑的是 `dist/` 的构建产物（`pretest` 会先 build），网络用替换 `globalThis.fetch`
 * 的桩。不引入测试框架 —— `node:test` + `node:assert` 够用。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { FallbackSearchProvider } from '../dist/index.js';

const realFetch = globalThis.fetch;

after(() => {
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

/** 收集 warn 输出，顺便当断言素材。 */
function collector() {
  const messages = [];
  return { messages, warn: (message) => messages.push(message) };
}

/** 构造一次操作的配置快照。 */
function snapshot(overrides = {}) {
  const log = overrides.log ?? collector();
  return {
    provider: new FallbackSearchProvider(() => ({
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

/** AnySearch 的成功信封。 */
const anysearchOk = (results) => json({ code: 0, message: 'ok', data: { results } });

/** Tavily 的成功响应。 */
const tavilyOk = (results) => json({ answer: '', results });

beforeEach(() => {
  globalThis.fetch = realFetch;
});

describe('FallbackSearchProvider', () => {
  it('available() 在 providerOrder 非空时为 true，为空时为 false', () => {
    assert.equal(snapshot().provider.available(), true);
    assert.equal(snapshot({ options: { order: [] } }).provider.available(), false);

    // 缺 Key 也不影响 available()：它必须同步且不发网络请求，
    // 凭据问题留到搜索时以错误码暴露。
    const { provider } = snapshot({ options: { resolveApiKey: async () => undefined } });
    assert.equal(provider.available(), true);
  });

  it('首个引擎成功即返回，完全不调用第二个引擎', async () => {
    let tavilyCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) {
        return anysearchOk([{ url: 'https://a.example/1', title: 'A1' }]);
      }
      tavilyCalls += 1;
      return tavilyOk([{ url: 'https://b.example/1', title: 'B1' }]);
    });

    const { provider } = snapshot();
    const result = await provider.search({ query: 'q' });

    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].url, 'https://a.example/1');
    assert.equal(result.truncated, false, 'truncated 由 seam 置位，provider 不应谎报');
    assert.equal(tavilyCalls, 0, '第一个引擎成功后不得再调用第二个');
  });

  it('首个引擎 HTTP 失败时 fallback 到第二个引擎', async () => {
    stubFetch((url) => {
      if (url.includes('anysearch.com')) return json({ error: 'boom' }, 500);
      return tavilyOk([{ url: 'https://b.example/1', title: 'B1' }]);
    });

    const { provider, log } = snapshot();
    const result = await provider.search({ query: 'q' });

    assert.equal(result.sources[0].url, 'https://b.example/1');
    assert.ok(
      log.messages.some((m) => m.includes('anysearch') && m.includes('failed')),
      `应记录 anysearch 失败，实际：${JSON.stringify(log.messages)}`,
    );
    assert.ok(
      log.messages.some((m) => m.includes('fell back to engine "tavily"')),
      `应记录 fallback 结果，实际：${JSON.stringify(log.messages)}`,
    );
  });

  // ── 关键回归点 ──────────────────────────────────────────────────────────
  // AnySearch 用 { code, message, data } 信封包装，HTTP 200 也可能是业务失败。
  // 只判 res.ok 会把服务端错误当成功、返回空结果、直接中断整条 fallback 链。
  it('AnySearch 返回 HTTP 200 但信封 code !== 0 时判定失败并 fallback', async () => {
    let anysearchCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) {
        anysearchCalls += 1;
        return json({ code: 50001, message: 'quota exhausted', data: null });
      }
      return tavilyOk([{ url: 'https://b.example/1', title: 'B1' }]);
    });

    const { provider, log } = snapshot();
    const result = await provider.search({ query: 'q' });

    assert.equal(anysearchCalls, 1);
    assert.equal(result.sources[0].url, 'https://b.example/1', '必须落到第二个引擎，而不是返回空结果');

    const joined = log.messages.join('\n');
    assert.ok(joined.includes('50001'), `错误信息应带上信封 code，实际：${joined}`);
    assert.ok(joined.includes('quota exhausted'), `错误信息应带上信封 message，实际：${joined}`);
  });

  it('engine 返回空结果时继续尝试下一个引擎', async () => {
    let tavilyCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) return anysearchOk([]);
      tavilyCalls += 1;
      return tavilyOk([{ url: 'https://b.example/1', title: 'B1' }]);
    });

    const { provider } = snapshot();
    const result = await provider.search({ query: 'q' });

    assert.equal(tavilyCalls, 1, '空结果不应终止整条链');
    assert.equal(result.sources[0].url, 'https://b.example/1');
  });

  it('所有引擎都失败时抛 WEB_PROVIDER_ERROR，消息含每个引擎的失败原因', async () => {
    stubFetch(() => json({ error: 'down' }, 503));

    const { provider } = snapshot();

    await assert.rejects(
      () => provider.search({ query: 'q' }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_ERROR');
        assert.ok(error.message.includes('anysearch'), '消息应点名 anysearch');
        assert.ok(error.message.includes('tavily'), '消息应点名 tavily');
        return true;
      },
    );
  });

  it('只配了需要 Key 的引擎且无 Key 时抛 WEB_PROVIDER_CREDENTIAL_MISSING，且不发任何请求', async () => {
    const log = collector();
    let fetchCalls = 0;
    stubFetch(() => {
      fetchCalls += 1;
      return tavilyOk([]);
    });

    const { provider } = snapshot({
      options: {
        order: ['tavily'],
        literalApiKey: () => undefined,
        resolveApiKey: async () => undefined,
        warn: log.warn,
      },
    });

    await assert.rejects(
      () => provider.search({ query: 'q' }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING');
        assert.ok(error.message.includes('TAVILY_API_KEY'), '消息应指出该配哪个环境变量');
        return true;
      },
    );

    assert.equal(fetchCalls, 0, '没有任何可用引擎时不应发出请求');
  });

  it('AnySearch 可匿名调用：无 Key 时仍发请求且不带 Authorization 头', async () => {
    const seen = [];
    stubFetch((url, init) => {
      seen.push(init);
      return anysearchOk([{ url: 'https://a.example/1', title: 'A1' }]);
    });

    const { provider } = snapshot({
      options: {
        order: ['anysearch'],
        literalApiKey: () => undefined,
        resolveApiKey: async () => undefined,
      },
    });

    const result = await provider.search({ query: 'q' });

    assert.equal(result.sources.length, 1);
    assert.equal(seen.length, 1, '匿名额度下仍应发出请求');
    assert.equal(
      Object.keys(seen[0].headers).some((h) => h.toLowerCase() === 'authorization'),
      false,
      '无 Key 时不应携带 Authorization 头',
    );
  });

  it('无 Key 的 AnySearch 被真的调用过时，全失败算 WEB_PROVIDER_ERROR 而不是凭据缺失', async () => {
    stubFetch(() => json({ code: 50002, message: 'anonymous quota exceeded' }, 200));

    const { provider } = snapshot({
      options: {
        order: ['anysearch'],
        literalApiKey: () => undefined,
        resolveApiKey: async () => undefined,
      },
    });

    await assert.rejects(
      () => provider.search({ query: 'q' }),
      (error) => {
        // 依据是"是否真的发出过请求"，不是"有没有 Key" —— AnySearch 支持匿名。
        assert.equal(error.code, 'WEB_PROVIDER_ERROR');
        assert.ok(error.message.includes('anonymous quota exceeded'));
        return true;
      },
    );
  });

  it('signal 已 abort 时抛 WEB_ABORTED，且不发请求', async () => {
    let fetchCalls = 0;
    stubFetch(() => {
      fetchCalls += 1;
      return anysearchOk([]);
    });

    const controller = new AbortController();
    controller.abort();

    const { provider } = snapshot();

    await assert.rejects(
      () => provider.search({ query: 'q' }, controller.signal),
      (error) => {
        assert.equal(error.code, 'WEB_ABORTED');
        return true;
      },
    );

    assert.equal(fetchCalls, 0);
  });

  it('providerOrder 里的未知 id 被跳过并留痕，不影响后续引擎', async () => {
    stubFetch(() => tavilyOk([{ url: 'https://b.example/1', title: 'B1' }]));

    const { provider, log } = snapshot({ options: { order: ['nope', 'tavily'] } });
    const result = await provider.search({ query: 'q' });

    assert.equal(result.sources[0].url, 'https://b.example/1');
    assert.ok(
      log.messages.some((m) => m.includes('unknown engine "nope"')),
      `应记录未知引擎，实际：${JSON.stringify(log.messages)}`,
    );
  });

  it('providerOrder 为空时抛 WEB_PROVIDER_ERROR', async () => {
    const { provider } = snapshot({ options: { order: [] } });

    await assert.rejects(
      () => provider.search({ query: 'q' }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_ERROR');
        assert.ok(error.message.includes('providerOrder'));
        return true;
      },
    );
  });

  it('请求大小：maxResults 优先于 maxResultsPerEngine', async () => {
    const bodies = [];
    stubFetch((url, init) => {
      bodies.push(JSON.parse(init.body));
      return anysearchOk([{ url: 'https://a.example/1' }]);
    });

    const { provider } = snapshot({ options: { maxResultsPerEngine: 3 } });
    await provider.search({ query: 'q', maxResults: 11 });

    assert.equal(bodies[0].max_results, 11);

    bodies.length = 0;
    await provider.search({ query: 'q' });
    assert.equal(bodies[0].max_results, 3, '调用方没给 maxResults 时用配置的默认值');
  });

  it('Tavily 的 answer 映射到 seam 的 content', async () => {
    stubFetch(() => json({ answer: '这是直答', results: [{ url: 'https://b.example/1' }] }));

    const { provider } = snapshot({ options: { order: ['tavily'] } });
    const result = await provider.search({ query: 'q' });

    assert.equal(result.content, '这是直答');
  });

  it('缺失的可选字段被省略，而不是填空字符串', async () => {
    stubFetch(() =>
      anysearchOk([{ url: 'https://a.example/1', title: '', snippet: 'x' }]),
    );

    const { provider } = snapshot({ options: { order: ['anysearch'] } });
    const result = await provider.search({ query: 'q' });

    const source = result.sources[0];
    assert.equal(source.url, 'https://a.example/1');
    assert.equal('title' in source, false, '空标题应省略字段，而不是填 ""');
    assert.equal(source.snippet, 'x');
  });
});
