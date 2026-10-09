/**
 * 客户端 bundle 的**离线**验证 —— 不碰用户的 dsh 环境。
 *
 * 用 mock 的 `window.__ModuleLoader__` 加载真实构建产物，逐条验证注册链路。
 *
 * 这是那次事故的回归测试：**`inject` 写成包名导致 Web boot 致命失败**，整个界面起不来。
 * 当时如果先跑这个文件，就不会烧到用户的 profile。教训是：改动客户端半边之前，
 * 先在这里把链路验完，再让用户重启（其实连重启都不用 —— 插件热加载就生效了）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'client.js');
const PACKAGE_NAME = 'dsh-web-search-gongyy';
const NS = 'web-search-gongyy';

/**
 * 加载 bundle，取回它向模块表注册的那一条。
 *
 * 用**间接 eval**（`(0, eval)`）而不是 `node:vm`：bundle 是 classic script，只需要
 * `window` 在全局。走 vm 会创建新 realm，那边数组的 `Array.prototype` 与宿主不同，
 * `deepStrictEqual` 会把两个看起来一样的数组判为不等 —— 白踩一次。
 */
function loadBundle() {
  const registrations = [];
  const previous = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
  try {
    (0, eval)(readFileSync(BUNDLE, 'utf8'));
  } finally {
    globalThis.window = previous;
  }

  assert.equal(registrations.length, 1, 'bundle 应当只注册一次');
  return registrations[0];
}

/** `ui-primitives` 的桩：记录表单模型的构造与绑定，供断言检查字段接线。 */
function stubPrimitives() {
  const calls = { constructed: [], bound: 0, disposed: 0, published: [] };

  class SettingsFormModel {
    constructor(scope, specs, secrets) {
      calls.constructed.push({ scope, specs, secrets });
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false };
    }
    field() {
      return { text: '', overridden: false, invalid: false };
    }
    bind(project) {
      calls.bound += 1;
      // 真实的 SnapshotStore 有 set（官方实现就靠它推送新状态）；桩必须照着实契约写，
      // 否则插件里 `store.set(...)` 这类调用会在测试里静默变成 unhandled rejection。
      return {
        getSnapshot: project,
        subscribe: () => () => {},
        set: (state) => calls.published.push(state),
      };
    }
    actions() {
      return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} };
    }
    dispose() {
      calls.disposed += 1;
    }
  }

  const field = (name) => ({ field: name, format: () => '', parse: () => undefined });

  return {
    calls,
    module: {
      SettingsForm: () => null,
      SettingsValueField: () => null,
      SettingsSecretField: () => null,
      SettingsFormModel,
      settingsNumberField: field,
      settingsTextField: field,
    },
  };
}

/**
 * 只供应**静态平台模块**的 require 桩。
 *
 * 这里出现的每个 specifier 都必须是壳的种子表成员：官方 plugin-manager 也是直接
 * require `react` / `react-dom` / `ui-primitives` / `ui-slots` / `client-store` 而
 * **不做任何声明**，所以我们的产物也只允许要这几个。
 */
function platformRequire(specifier, primitivesStub) {
  if (specifier === 'react/jsx-runtime') {
    return {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
      Fragment: Symbol('Fragment'),
    };
  }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub.module;
  throw new Error(`bundle 请求了非平台模块："${specifier}" —— 它应当由壳提供，不该被打包`);
}

/**
 * 假 cordis context。
 *
 * **关键：它只暴露已声明的服务** —— 访问一个没写进 `inject` 的服务会抛错，与真实 cordis
 * 的注入语义一致。这样"用到了却没声明"这类 bug 在测试里就会红，而不是静默地让用户
 * 在界面上看到"配置区不见了"（**真踩过一次**：`ctx.locale` 用了但没 inject，
 * apply 一开头就抛，客户端半边整个静默失效）。
 */
function fakeContext() {
  const calls = [];
  let declared = [];

  /** 凭据域的调用记录与"Host 说配没配"的可控状态。 */
  const credentials = { describe: [], set: [], views: {} };
  /** `remote.$on` 注册的监听，按事件名存下来供测试触发。 */
  const listeners = new Map();
  /** 配置命名空间的当前快照，可由测试改写（模拟用户改了引用名）。 */
  let snapshot = { value: undefined, writable: true, revision: 1 };
  let scopeListener = () => {};

  const credentialsImpl = {
    describe: async (refs) => {
      credentials.describe.push(refs);
      return {
        ok: true,
        value: Object.fromEntries(
          refs.map((ref) => [ref, credentials.views[ref] ?? { configured: false, writable: true }]),
        ),
      };
    },
    set: async (ref, value) => {
      credentials.set.push({ ref, value });
      credentials.views[ref] = { configured: true, writable: true };
      return { ok: true };
    },
  };

  const remoteImpl = { $on: (event, listener) => {
    calls.push({ kind: 'remote.$on', event });
    listeners.set(event, listener);
    return () => {};
  } };

  // `remote.credentials` 是**嵌套服务**：它也要按"声明了才能访问"的规矩来。
  Object.defineProperty(remoteImpl, 'credentials', {
    get() {
      if (!declared.includes('remote.credentials')) {
        throw new Error('服务 "remote.credentials" 没写进 inject 就被访问了 —— 真实 cordis 会拒绝');
      }
      return credentialsImpl;
    },
  });

  const implementations = {
    locale: {
      register: (ns, dicts) => {
        calls.push({ kind: 'locale.register', ns, dicts });
        return () => {};
      },
      bind: (ns) => {
        calls.push({ kind: 'locale.bind', ns });
        return (key) => `«${key}»`;
      },
    },
    configForms: {
      get: (ns) => {
        calls.push({ kind: 'configForms.get', ns });
        return {
          getSnapshot: () => snapshot,
          subscribe: (listener) => {
            calls.push({ kind: 'configForms.subscribe' });
            scopeListener = listener;
            return () => {};
          },
          mutate: async () => true,
        };
      },
      whileServed: (namespaces, callback) => {
        calls.push({ kind: 'configForms.whileServed', namespaces });
        callback();
        return () => {};
      },
    },
    slots: {
      inject: (name, callback) => {
        calls.push({ kind: 'slots.inject', name });
        callback();
        return {};
      },
      register: (options, component) => {
        calls.push({ kind: 'slots.register', options, component });
        return () => {};
      },
    },
    remote: remoteImpl,
  };

  const ctx = {
    inject: (deps, callback) => {
      declared = deps;
      calls.push({ kind: 'inject', deps });
      callback(ctx); // 真实实现是依赖就绪后回调；这里模拟立刻就绪
      return {};
    },
    effect: (callback) => {
      calls.push({ kind: 'effect' });
      callback();
      return () => {};
    },
    get: (name) => implementations[name],
  };

  for (const [name, implementation] of Object.entries(implementations)) {
    Object.defineProperty(ctx, name, {
      get() {
        if (!declared.includes(name)) {
          throw new Error(`服务 "${name}" 没写进 inject 就被访问了 —— 真实 cordis 会拒绝`);
        }
        return implementation;
      },
    });
  }

  return {
    ctx,
    calls,
    credentials,
    listeners,
    /** 改配置快照并触发订阅 —— 模拟"用户把引用名改了"。 */
    setConfigValue(value) {
      snapshot = { ...snapshot, value };
      scopeListener();
    },
  };
}

describe('客户端 bundle', () => {
  it('构建产物已被 wrap 成模块加载器能消费的形式', () => {
    const source = readFileSync(BUNDLE, 'utf8');
    assert.ok(source.includes('__ModuleLoader__.load'), 'dist/client.js 应当被 wrap-client.cjs 包装过');
  });

  it('注册 id 是 npm 包名（必须与 boot graph 的 row 一致）', () => {
    assert.equal(loadBundle().id, PACKAGE_NAME);
  });

  // ── 事故回归点 ──────────────────────────────────────────────────────────
  it('顶层 inject 必须是空的 —— 它写的是 cordis 服务名，不是包名', () => {
    const exports = loadBundle().factory((spec) => platformRequire(spec, stubPrimitives()));

    // 关键：本项目刻意完全不用顶层 inject（改用 ctx.inject 降级失败模式）。
    assert.equal(
      exports.inject,
      undefined,
      '顶层 inject 已移除是刻意的；若要用，里面只能放服务名（slots/locale/…），绝不能是包名',
    );
  });

  it('factory 只向平台表要模块，不请求任何非平台包', () => {
    const stub = stubPrimitives();
    assert.doesNotThrow(() => loadBundle().factory((spec) => platformRequire(spec, stub)));
  });

  it('导出 name 与 NS，且 apply 是函数', () => {
    const exports = loadBundle().factory((spec) => platformRequire(spec, stubPrimitives()));
    assert.equal(exports.name, NS);
    assert.equal(exports.NS, NS);
    assert.equal(typeof exports.apply, 'function');
  });

  it('apply() 注册双语词典，且 key 域两边一致', () => {
    const exports = loadBundle().factory((spec) => platformRequire(spec, stubPrimitives()));
    const { ctx, calls } = fakeContext();
    exports.apply(ctx);

    const registered = calls.find((call) => call.kind === 'locale.register');
    assert.equal(registered?.ns, NS, '词典命名空间就是 entry id');
    assert.deepEqual(Object.keys(registered.dicts).sort(), ['en', 'zh'], '中英双语');

    const zhKeys = Object.keys(registered.dicts.zh).sort();
    const enKeys = Object.keys(registered.dicts.en).sort();
    assert.deepEqual(enKeys, zhKeys, '两个词典的 key 必须一一对应（类型化注册也会强制）');
  });

  it('apply() 等服务就绪后再注册插槽（含写凭据域要用的 remote）', () => {
    const exports = loadBundle().factory((spec) => platformRequire(spec, stubPrimitives()));
    const { ctx, calls } = fakeContext();

    // 假 ctx 只暴露已声明的服务：这里一旦抛错，就说明"用了却没 inject"。
    assert.doesNotThrow(() => exports.apply(ctx), '访问未声明的服务会抛错');

    assert.deepEqual(
      calls.find((call) => call.kind === 'inject')?.deps,
      ['slots', 'configForms', 'locale', 'remote', 'remote.credentials'],
      '用到的服务都必须声明（locale 漏过一次导致客户端半边静默失效；remote.credentials 是写 Key 用的）',
    );
    assert.deepEqual(
      calls.find((call) => call.kind === 'configForms.whileServed')?.namespaces,
      [NS],
      '只在 Host 服务本命名空间时才挂载',
    );
    assert.equal(calls.find((call) => call.kind === 'slots.inject')?.name, 'plugins.bundle.config');

    const registration = calls.find((call) => call.kind === 'slots.register')?.options;
    assert.equal(registration?.name, 'plugins.bundle.config');
    assert.equal(registration?.key, PACKAGE_NAME, '插槽按 npm 包名分发（插件页用 entryKey: pkg.name 匹配）');
    assert.equal(registration?.locale, NS, '插槽文案走本插件自己的词典命名空间');
  });

  it('表单模型接了**两个配置字段** + 两个凭据控件（凭据控件不在 specs 里）', () => {
    const stub = stubPrimitives();
    const exports = loadBundle().factory((spec) => platformRequire(spec, stub));
    const { ctx, calls } = fakeContext();
    exports.apply(ctx);

    // 配置字段接线：卡片只留"顺序 + 结果数"，引用名两个字段已按用户要求从界面撤掉
    const specs = stub.calls.constructed[0]?.specs;
    assert.deepEqual(
      specs?.map((spec) => spec.field),
      ['providerOrder', 'maxResultsPerEngine'],
      '卡片上的配置字段只剩两个（引用名不再显示）',
    );

    // **凭据控件走第三个参数**：值写到 settings 之外（凭据域），所以不该出现在 specs 里。
    const secrets = stub.calls.constructed[0]?.secrets;
    assert.deepEqual(
      secrets?.map((secret) => secret.field),
      ['anysearchApiKeyCredential', 'tavilyApiKeyCredential'],
      'Key 控件是 SettingsSecretSpec：写凭据域，不写配置',
    );
    assert.ok(
      specs?.every((spec) => !secrets.some((secret) => secret.field === spec.field)),
      'Key 控件的字段名不能和配置字段重名',
    );
    assert.equal(stub.calls.bound, 1, '投影应当恰好 bind 一次');

    // 插槽注入：hooks 给组件 store，其余是 actions
    const injected = calls.find((call) => call.kind === 'slots.register')?.options?.inject?.();
    assert.ok(injected?.hooks?.webSearchConfig, '组件通过 hooks.webSearchConfig 拿到 store');
    for (const action of ['edit', 'resetField', 'save', 'discard']) {
      assert.equal(typeof injected[action], 'function', `注入块应当带 ${action}`);
    }
  });

  // ── 直接填 Key（写凭据域，不写配置）─────────────────────────────────────

  it('注册时按**默认引用名**问凭据域有没有配', async () => {
    const stub = stubPrimitives();
    const exports = loadBundle().factory((spec) => platformRequire(spec, stub));
    const { ctx, credentials } = fakeContext();
    exports.apply(ctx);
    await Promise.resolve(); // 读取是异步的：让它跑完再断言

    assert.deepEqual(credentials.describe, [['ANYSEARCH_API_KEY'], ['TAVILY_API_KEY']]);
  });

  it('在 Key 控件输入并保存 → 写的是**凭据域**，地址是配置里的引用名', async () => {
    const stub = stubPrimitives();
    const exports = loadBundle().factory((spec) => platformRequire(spec, stub));
    const { ctx, credentials } = fakeContext();
    exports.apply(ctx);

    const secrets = stub.calls.constructed[0].secrets;
    const tavily = secrets.find((secret) => secret.field === 'tavilyApiKeyCredential');

    assert.equal(await tavily.write('tvly-secret-value'), true, 'Host 接受后应当返回 true');
    assert.deepEqual(credentials.set, [{ ref: 'TAVILY_API_KEY', value: 'tvly-secret-value' }]);
  });

  it('引用名被别处改了（例如手改 patch）之后，Key 控件的写入地址跟着改', async () => {
    const stub = stubPrimitives();
    const exports = loadBundle().factory((spec) => platformRequire(spec, stub));
    const { ctx, credentials, setConfigValue } = fakeContext();
    exports.apply(ctx);

    setConfigValue({ tavilyApiKeyEnv: 'MY_OWN_TAVILY_KEY' });
    await Promise.resolve(); // 重读是异步的
    assert.deepEqual(credentials.describe.at(-1), ['MY_OWN_TAVILY_KEY'], '重读要用新的引用名');

    const tavily = stub.calls.constructed[0].secrets.find((s) => s.field === 'tavilyApiKeyCredential');
    await tavily.write('tvly-x');
    assert.equal(credentials.set.at(-1).ref, 'MY_OWN_TAVILY_KEY');
  });

  it('Host 报"已配置"时，投影里的徽标状态跟着变；reference-updated 会触发重读', async () => {
    const stub = stubPrimitives();
    const exports = loadBundle().factory((spec) => platformRequire(spec, stub));
    const { ctx, calls, credentials, listeners } = fakeContext();

    // 让 Host 说 Tavily 已经配好了（在 apply 之前的读取就会拿到它）
    credentials.views.TAVILY_API_KEY = { configured: true, writable: true };
    exports.apply(ctx);
    await Promise.resolve(); // 读取是异步的
    await Promise.resolve(); // describe 之后再投影一次

    const injected = calls.find((call) => call.kind === 'slots.register')?.options?.inject?.();
    const state = injected.hooks.webSearchConfig.getSnapshot();
    assert.equal(state.tavilyConfigured, true, 'describe 说配了就应显示已设置');
    assert.equal(state.anysearchConfigured, false);

    // 别处写了同一个引用 → Host 发事件 → 重读
    const before = credentials.describe.length;
    listeners.get('credentials/reference-updated')('TAVILY_API_KEY');
    await Promise.resolve();
    assert.equal(credentials.describe.length, before + 1, '命中自己引用的更新应当重读');
    listeners.get('credentials/reference-updated')('SOME_OTHER_KEY');
    await Promise.resolve();
    assert.equal(credentials.describe.length, before + 1, '别人的引用不该触发重读');
  });

  it('字段规格的解析规则：非法草稿必须被拒（parse 返回 undefined 才会阻止保存）', () => {
    const stub = stubPrimitives();
    const exports = loadBundle().factory((spec) => platformRequire(spec, stub));
    const { ctx } = fakeContext();
    exports.apply(ctx);

    const specs = Object.fromEntries(stub.calls.constructed[0].specs.map((spec) => [spec.field, spec]));

    // providerOrder
    assert.deepEqual(specs.providerOrder.parse('anysearch, tavily'), { kind: 'set', value: ['anysearch', 'tavily'] });
    assert.equal(specs.providerOrder.parse(''), undefined, '空顺序非法');
    assert.equal(specs.providerOrder.parse('anysearch, anysearch'), undefined, '重复非法');
    assert.equal(specs.providerOrder.parse('anysearch, google'), undefined, '未知引擎非法');
    assert.equal(specs.providerOrder.format(['tavily', 'anysearch']), 'tavily, anysearch');

    // 凭据引用名不再是卡片字段（撤掉了）—— 断言它**没有**被挂上来，防止将来误加回来
    assert.equal(specs.anysearchApiKeyEnv, undefined);
    assert.equal(specs.tavilyApiKeyEnv, undefined);
  });

  it('apply() 在没有这些服务时不该抛错（失败模式必须是降级而非崩溃）', () => {
    const exports = loadBundle().factory((spec) => platformRequire(spec, stubPrimitives()));
    const ctx = {
      inject: () => ({}), // 依赖永不就绪：真实实现下回调不会被调用
      effect: () => () => {},
      get: () => undefined,
    };
    assert.doesNotThrow(() => exports.apply(ctx));
  });
});
