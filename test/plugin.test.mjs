/**
 * `apply()` 的接线测试。
 *
 * provider 的行为已在 provider.test.mjs 覆盖；这里测的是**插件入口到 provider 之间**
 * 那一段：注册了什么、凭据按什么顺序解析、配置快照怎么读。用假的 ctx 和假的 seam，
 * 不碰真实的 dsh profile。
 */

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { apply, name, PROVIDER_ID, inject } from '../dist/index.js';

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  globalThis.fetch = realFetch;
});

/** 记录被注册的 provider。 */
function fakeContext({ credentials, launchEnvironment } = {}) {
  const state = { registered: [], registeredFetch: [] };
  const ctx = {
    // 注意 `launchEnvironmentOf(ctx)` 内部走的是 `ctx.get("launchEnvironment")`，
    // 不是读 `ctx.launchEnvironment` —— 桩必须按前者来。
    get: (service) => {
      if (service === 'credentials') return credentials;
      if (service === 'launchEnvironment') return launchEnvironment;
      return undefined;
    },
    logger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    web: {
      // 两个注册表分开记录 —— seam 的 search / fetch 是两个独立注册表，
      // 同一个 id 两边都能注册（本项目正是这么用的）。
      registerSearchProvider: (provider) => {
        state.registered.push(provider);
        return () => {};
      },
      registerFetchProvider: (provider) => {
        state.registeredFetch.push(provider);
        return () => {};
      },
    },
  };
  return { ctx, state };
}

/** 构造 `.volatile()` 字段的假引用 —— 运行时它们就是带 get() 的对象。 */
function fakeConfig(overrides = {}) {
  const values = {
    anysearchApiKey: undefined,
    anysearchApiKeyEnv: 'ANYSEARCH_API_KEY',
    tavilyApiKey: undefined,
    tavilyApiKeyEnv: 'TAVILY_API_KEY',
    providerOrder: ['anysearch', 'tavily'],
    maxResultsPerEngine: 8,
    ...overrides,
  };
  const ref = (key) => ({ get: () => values[key] });
  return Object.fromEntries(Object.keys(values).map((key) => [key, ref(key)]));
}

/** 按名字应答的假凭据服务。 */
function fakeCredentials(entries) {
  const resolved = [];
  return {
    resolved,
    resolve: async (ref) => {
      const key = String(ref);
      resolved.push(key);
      const value = entries[key];
      return value === undefined ? undefined : { value, source: 'file' };
    },
  };
}

/** 假的启动环境快照。 */
function fakeLaunchEnvironment(entries) {
  return {
    get: (name) => (entries[name] === undefined ? undefined : { value: entries[name], source: 'process' }),
  };
}

describe('apply()', () => {
  it('插件身份：name 就是 provider id，且只 inject web', () => {
    assert.equal(name, PROVIDER_ID);
    assert.deepEqual(inject, ['web']);
  });

  it('注册恰好一个 search provider，且 available() 为 true', () => {
    const { ctx, state } = fakeContext();
    apply(ctx, fakeConfig());

    assert.equal(state.registered.length, 1, '必须只注册一个 search provider');
    assert.equal(state.registered[0].id, PROVIDER_ID);
    assert.equal(state.registered[0].available(), true);

    // 抓取是**另一个注册表**，且复用同一个 id —— seam 的 search / fetch 相互独立，
    // 所以一个 id 能服务两种能力（patch 里两行 `*Provider: web-search-gongyy` 就够）。
    assert.equal(state.registeredFetch.length, 1, '必须只注册一个 fetch provider');
    assert.equal(state.registeredFetch[0].id, PROVIDER_ID, '两种能力复用同一个 id');
    assert.equal(state.registeredFetch[0].available(), true);
    assert.equal(state.registered[0].available(), true);
  });

  it('Tavily 的 Key 从托管凭据解析，并作为 api_key 发出去', async () => {
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ answer: '', results: [{ url: 'https://b.example/1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const credentials = fakeCredentials({ TAVILY_API_KEY: 'tvly-from-credentials' });
    const { ctx, state } = fakeContext({ credentials });
    apply(ctx, fakeConfig({ providerOrder: ['tavily'] }));

    const result = await state.registered[0].search({ query: 'q' });

    assert.equal(result.sources[0].url, 'https://b.example/1');
    assert.equal(bodies[0].api_key, 'tvly-from-credentials');
    assert.deepEqual(credentials.resolved, ['TAVILY_API_KEY']);
  });

  it('优先级：字面值 > 托管凭据', async () => {
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ answer: '', results: [{ url: 'https://b.example/1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const credentials = fakeCredentials({ TAVILY_API_KEY: 'tvly-from-credentials' });
    const { ctx, state } = fakeContext({ credentials });
    apply(ctx, fakeConfig({ providerOrder: ['tavily'], tavilyApiKey: 'tvly-literal' }));

    await state.registered[0].search({ query: 'q' });

    assert.equal(bodies[0].api_key, 'tvly-literal', '配置里的字面值是显式覆盖，应压过托管凭据');
    assert.deepEqual(credentials.resolved, [], '字面值命中时不应再去解析凭据');
  });

  it('优先级：托管凭据 > 启动环境变量', async () => {
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ answer: '', results: [{ url: 'https://b.example/1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const credentials = fakeCredentials({ TAVILY_API_KEY: 'tvly-from-credentials' });
    const { ctx, state } = fakeContext({
      credentials,
      launchEnvironment: fakeLaunchEnvironment({ TAVILY_API_KEY: 'tvly-from-env' }),
    });
    apply(ctx, fakeConfig({ providerOrder: ['tavily'] }));

    await state.registered[0].search({ query: 'q' });

    assert.equal(bodies[0].api_key, 'tvly-from-credentials');
  });

  it('回落：托管凭据没有时用启动环境变量', async () => {
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ answer: '', results: [{ url: 'https://b.example/1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const credentials = fakeCredentials({});
    const { ctx, state } = fakeContext({
      credentials,
      launchEnvironment: fakeLaunchEnvironment({ TAVILY_API_KEY: 'tvly-from-env' }),
    });
    apply(ctx, fakeConfig({ providerOrder: ['tavily'] }));

    await state.registered[0].search({ query: 'q' });

    assert.equal(bodies[0].api_key, 'tvly-from-env');
  });

  it('Tavily 单引擎且哪里都没有 Key 时抛 WEB_PROVIDER_CREDENTIAL_MISSING', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    };

    const { ctx, state } = fakeContext({ credentials: fakeCredentials({}) });
    apply(ctx, fakeConfig({ providerOrder: ['tavily'] }));

    await assert.rejects(
      () => state.registered[0].search({ query: 'q' }),
      (error) => {
        assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING');
        assert.ok(error.message.includes('TAVILY_API_KEY'));
        return true;
      },
    );

    assert.equal(fetchCalls, 0);
  });

  it('AnySearch 无任何 Key 时走匿名，不发 Authorization 头', async () => {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push(init);
      return new Response(
        JSON.stringify({ code: 0, message: 'ok', data: { results: [{ url: 'https://a.example/1' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const { ctx, state } = fakeContext({ credentials: fakeCredentials({}) });
    apply(ctx, fakeConfig({ providerOrder: ['anysearch'] }));

    const result = await state.registered[0].search({ query: 'q' });

    assert.equal(result.sources.length, 1, '匿名额度下应当有结果');
    assert.equal(
      Object.keys(seen[0].headers).some((h) => h.toLowerCase() === 'authorization'),
      false,
    );
  });

  it('配置每次操作重新读取：改顺序后同一个 provider 立即生效，无需重新注册', async () => {
    const hit = [];
    globalThis.fetch = async (url) => {
      hit.push(String(url));
      return String(url).includes('anysearch.com')
        ? new Response(
            JSON.stringify({ code: 0, message: 'ok', data: { results: [{ url: 'https://a.example/1' }] } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : new Response(JSON.stringify({ answer: '', results: [{ url: 'https://b.example/1' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    };

    let order = ['anysearch'];
    const config = fakeConfig();
    config.providerOrder = { get: () => order };

    const { ctx, state } = fakeContext({ credentials: fakeCredentials({ TAVILY_API_KEY: 'k' }) });
    apply(ctx, config);

    await state.registered[0].search({ query: 'q' });
    assert.ok(hit.at(-1).includes('anysearch.com'));

    order = ['tavily']; // 只改配置，不重新 apply

    await state.registered[0].search({ query: 'q' });
    assert.ok(hit.at(-1).includes('tavily.com'), '同一个 provider 实例应读到新顺序');
    assert.equal(state.registered.length, 1, '不应发生重新注册');
  });
});
