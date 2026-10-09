/**
 * FallbackFetchProvider 的行为测试。
 *
 * 跑的是 `dist/` 的构建产物，网络用替换 `globalThis.fetch` 的桩 —— 与
 * `provider.test.mjs`（搜索端）同构：**差异只有成功判据（非空正文）与结果结构**。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, beforeEach, describe, it } from 'node:test';

import { FallbackFetchProvider, PROVIDER_ID } from '../dist/index.js';

/**
 * 真实样本 fixture（由 `.tools/dsh-cli/make-quality-fixtures.mjs` 从真机 extract 结果截取）。
 * 用真样本而不是手写字符串，否则等于"用魔法数字测魔法数字"。
 */
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

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

  // ── 上游失败的分类与短路（2026-10-09 实测形状，见任务的 research/upstream-error-codes.md）──

  it('Tavily 的失败包在 HTTP 200 里：原因必须带进消息，而不是压成 empty content', async () => {
    stubFetch(() => json({ results: [], failed_results: [{ url: TARGET, error: 'Failed to fetch url' }] }));

    const { provider, log } = snapshot({ options: { order: ['tavily'] } });

    await assert.rejects(
      () => provider.fetch({ url: TARGET }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_ERROR');
        assert.ok(
          error.message.includes('Failed to fetch url'),
          `必须带出上游原话，实际：${error.message}`,
        );
        return true;
      },
    );
    assert.ok(log.messages.some((m) => m.includes('Failed to fetch url')));
  });

  it('Tavily 说 URL 被策略拒绝时抛 WEB_BLOCKED_URL，且不再尝试后面的引擎（短路）', async () => {
    let anysearchCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) {
        anysearchCalls += 1;
        return anysearchOk('不该被调用');
      }
      // 实测形状：非公网地址会换来 400 + failed_results 里的 Validation Error
      return json(
        {
          detail: { error: 'All URLs failed validation.' },
          failed_results: [{ url: TARGET, error: 'Validation Error: Invalid URL format' }],
        },
        400,
      );
    });

    const { provider } = snapshot({ options: { order: ['tavily', 'anysearch'] } });

    await assert.rejects(
      () => provider.fetch({ url: TARGET }),
      (error) => {
        // 能走到引擎的 URL 一定已过本地语法校验，所以上游这句"格式非法"在本管线里
        // 实际是**目标不被允许**（实测就是非公网地址），对应 WEB_BLOCKED_URL ——
        // 与官方 http provider 对同一地址的报法一致。
        assert.equal(error.code, 'WEB_BLOCKED_URL');
        assert.ok(error.message.includes('Invalid URL format'), error.message);
        assert.ok(error.message.includes('remaining engines were not tried'), '应说明短路原因');
        return true;
      },
    );

    assert.equal(anysearchCalls, 0, 'URL 级失败与引擎无关，不该再试下一个');
  });

  it('Tavily HTTP 400 把 failed_results 嵌在 detail 里时，仍取到**具体**原因并短路', async () => {
    let anysearchCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) {
        anysearchCalls += 1;
        return anysearchOk('不该被调用');
      }
      // 实测形状（真机抓到的原样结构）：failed_results 嵌在 detail 内，且 detail.error 是泛化文案
      return json(
        {
          detail: {
            error: 'All URLs failed validation.',
            failed_results: [{ url: TARGET, error: 'Validation Error: Invalid URL format' }],
          },
        },
        400,
      );
    });

    const { provider } = snapshot({ options: { order: ['tavily', 'anysearch'] } });

    await assert.rejects(
      () => provider.fetch({ url: TARGET }),
      (error) => {
        assert.equal(error.code, 'WEB_BLOCKED_URL');
        assert.ok(
          error.message.includes('Invalid URL format'),
          `必须取到具体原因而不是泛化的 detail.error，实际：${error.message}`,
        );
        return true;
      },
    );

    assert.equal(anysearchCalls, 0, '短路生效');
  });

  it('AnySearch 无信封的 403 归类为 URL 被拒，但**不短路**（403 也可能是配额/鉴权问题）', async () => {
    let tavilyCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) {
        return new Response('<!DOCTYPE HTML><html><title>ERROR: The requested URL could not be retrieved', {
          status: 403,
          statusText: 'Forbidden',
        });
      }
      tavilyCalls += 1;
      return tavilyOk('Tavily 救回来了');
    });

    const { provider } = snapshot();

    const result = await provider.fetch({ url: TARGET });

    assert.equal(tavilyCalls, 1, '403 不短路：仍要给别的引擎一次机会');
    assert.equal(result.body.content, 'Tavily 救回来了');
  });

  it('AnySearch 信封 code !== 0 时，消息里带出上游的 code 与 message', async () => {
    stubFetch((url) => {
      if (url.includes('anysearch.com')) {
        return json({ code: -1, message: 'Unable to extract content from the URL.', data: {} });
      }
      return json({ results: [], failed_results: [{ url: TARGET, error: 'Failed to fetch url' }] });
    });

    await assert.rejects(
      () => snapshot().provider.fetch({ url: TARGET }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_ERROR');
        assert.ok(error.message.includes('code=-1'), `应带出上游 code，实际：${error.message}`);
        assert.ok(error.message.includes('Unable to extract content'), '应带出上游 message');
        return true;
      },
    );
  });

  it('上游 5xx 不短路：仍会尝试下一个引擎', async () => {
    let tavilyCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) return json({ error: 'down' }, 503);
      tavilyCalls += 1;
      return tavilyOk('Tavily 的正文');
    });

    const result = await snapshot().provider.fetch({ url: TARGET });
    assert.equal(tavilyCalls, 1);
    assert.equal(result.body.content, 'Tavily 的正文');
  });

  // ── 超时与取消必须可区分 ──────────────────────────────────────────────────

  it('超时（AbortSignal.timeout）抛 WEB_FETCH_TIMEOUT，而不是 WEB_ABORTED', async () => {
    stubFetch(() => {
      throw new Error('不该被调用');
    });

    const signal = AbortSignal.timeout(5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(signal.aborted, true, '前置：超时信号必须已经 abort');

    await assert.rejects(
      () => snapshot().provider.fetch({ url: TARGET }, signal),
      (error) => {
        assert.equal(error.code, 'WEB_FETCH_TIMEOUT', `实际：${error.code} / ${error.message}`);
        return true;
      },
    );
  });

  it('调用方取消仍抛 WEB_ABORTED（与超时可区分）', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));

    await assert.rejects(
      () => snapshot().provider.fetch({ url: TARGET }, controller.signal),
      (error) => {
        assert.equal(error.code, 'WEB_ABORTED');
        return true;
      },
    );
  });

  // ── 网络错误要把 cause 带出来（否则只剩一句 fetch failed）──────────────

  it('网络错误要把 cause 链带进消息', async () => {
    stubFetch(() => {
      // undici 的真实形状：TypeError: fetch failed，原因在 cause 里
      const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
      throw new TypeError('fetch failed', { cause });
    });

    await assert.rejects(
      () => snapshot({ options: { order: ['tavily'] } }).provider.fetch({ url: TARGET }),
      (error) => {
        assert.ok(error.message.includes('fetch failed'), error.message);
        assert.ok(
          error.message.includes('ECONNREFUSED'),
          `cause 必须带出来，否则看不出断在哪一层：${error.message}`,
        );
        return true;
      },
    );
  });

  it('没有 message 但有 code 的错误，用 code 当标签', async () => {
    stubFetch(() => {
      throw Object.assign(new Error(''), { code: 'UND_ERR_SOCKET' });
    });

    await assert.rejects(
      () => snapshot({ options: { order: ['tavily'] } }).provider.fetch({ url: TARGET }),
      (error) => {
        assert.ok(error.message.includes('UND_ERR_SOCKET'), error.message);
        return true;
      },
    );
  });

  // ── 低质正文兜底（判据与阈值由真实样本标定，见任务 research/quality-calibration*.md）──

  it('CSS 正文（真实 baidu 样本）判为低质，继续 fallback 到下一个引擎', async () => {
    const css = fixture('baidu-anysearch-css.txt');
    let tavilyCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) return anysearchOk(css);
      tavilyCalls += 1;
      return tavilyOk('Tavily 的真页面 markdown');
    });

    const { provider, log } = snapshot();
    const result = await provider.fetch({ url: TARGET });

    assert.equal(tavilyCalls, 1, '低质不该终止链路');
    assert.equal(result.body.content, 'Tavily 的真页面 markdown');
    assert.ok(
      log.messages.some((m) => m.includes('non-prose') && m.includes('style/script tag')),
      `应留下低质原因：${JSON.stringify(log.messages)}`,
    );
  });

  it('去掉开头 <style> 标签的真实 CSS 靠**密度**判据命中（条件 B）', async () => {
    const css = fixture('css-without-leading-tag.txt');
    assert.ok(!/^\s*<(style|script)/i.test(css), '前置：该样本不以标记开头，只能靠密度命中');

    let tavilyCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) return anysearchOk(css);
      tavilyCalls += 1;
      return tavilyOk('第二个引擎的正文');
    });

    const result = await snapshot().provider.fetch({ url: TARGET });
    assert.equal(tavilyCalls, 1);
    assert.equal(result.body.content, '第二个引擎的正文');
  });

  it('JSON 响应（真实 GitHub API 样本）**不**判低质：引号密度把它摘出去', async () => {
    const json = fixture('github-api-json.json');
    let tavilyCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) return anysearchOk(json);
      tavilyCalls += 1;
      return tavilyOk('不该被调用');
    });

    const result = await snapshot().provider.fetch({ url: TARGET });

    assert.equal(tavilyCalls, 0, 'JSON 是合法内容，不该被当成垃圾');
    assert.equal(result.body.content, json);
  });

  it('极短合法页（真实 example.com 样本）不判低质', async () => {
    const short = fixture('example-com.txt');
    let tavilyCalls = 0;
    stubFetch((url) => {
      if (url.includes('anysearch.com')) return anysearchOk(short);
      tavilyCalls += 1;
      return tavilyOk('不该被调用');
    });

    const result = await snapshot().provider.fetch({ url: TARGET });
    assert.equal(tavilyCalls, 0);
    assert.equal(result.body.content, short);
  });

  it('两个引擎都只给非正文时，返回**第一份**并留痕（不抛错）', async () => {
    const first = fixture('baidu-anysearch-css.txt');
    const second = fixture('css-without-leading-tag.txt'); // 两份不同的非正文样本
    stubFetch((url) => (url.includes('anysearch.com') ? anysearchOk(first) : tavilyOk(second)));

    const { provider, log } = snapshot();
    const result = await provider.fetch({ url: TARGET });

    assert.equal(result.body.content, first, '要退回首份结果，而不是最后一份、也不是抛错');
    assert.equal(result.statusCode, 200);
    assert.ok(
      log.messages.some((m) => m.includes('every engine returned non-prose content')),
      `应有明确的 warn：${JSON.stringify(log.messages)}`,
    );
  });

  it('低质 + 后续引擎报错时：返回第一份低质结果，且两类原因都留在日志里', async () => {
    const css = fixture('baidu-anysearch-css.txt');
    stubFetch((url) => {
      if (url.includes('anysearch.com')) return anysearchOk(css);
      return json({ error: 'down' }, 503);
    });

    const { provider, log } = snapshot();
    const result = await provider.fetch({ url: TARGET });

    // Q2 的取舍：手上有内容就返回内容 —— 抛错会让用户彻底拿不到东西。
    assert.equal(result.body.content, css, '不该因为第二个引擎报错就把第一份内容丢掉');

    const joined = log.messages.join('\n');
    assert.ok(joined.includes('non-prose'), `低质原因要在日志里：${joined}`);
    assert.ok(joined.includes('503'), `后续引擎的报错原因也要在日志里：${joined}`);
  });

  // ── 一个无法测的分支（如实标注，不假装覆盖了）──────────────────────────
  // 「跳过没有 extract 端点的引擎」这条分支在当前引擎集下**不可达** —— AnySearch 与
  // Tavily 都实现了 fetch。它是为纯 SERP 引擎（如 Brave）预留的，而引擎列表
  // （src/engines/index.ts 的 ENGINES）是静态的、没有注入点，所以无法构造用例。
  // 想要覆盖它，得先把引擎表做成可注入的 —— 那属于为测试而改设计，暂不做。
});
