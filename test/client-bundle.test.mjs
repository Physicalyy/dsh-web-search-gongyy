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
  const calls = { constructed: [], bound: 0, disposed: 0 };

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
      return { getSnapshot: project, subscribe: () => () => {} };
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

/** 假 cordis context：记录调用链，并让依赖"立即就绪"。 */
function fakeContext() {
  const calls = [];
  const ctx = {
    inject: (deps, callback) => {
      calls.push({ kind: 'inject', deps });
      callback(ctx); // 真实实现是依赖就绪后回调；这里模拟立刻就绪
      return {};
    },
    effect: (callback) => {
      calls.push({ kind: 'effect' });
      callback();
      return () => {};
    },
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
        return { getSnapshot: () => ({}), subscribe: () => () => {}, mutate: async () => true };
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
  };
  return { ctx, calls };
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

  it('apply() 等 slots 与 configForms 就绪后再注册插槽', () => {
    const exports = loadBundle().factory((spec) => platformRequire(spec, stubPrimitives()));
    const { ctx, calls } = fakeContext();

    assert.doesNotThrow(() => exports.apply(ctx));

    assert.deepEqual(
      calls.find((call) => call.kind === 'inject')?.deps,
      ['slots', 'configForms'],
      '应当用 ctx.inject 等待这两个服务',
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

  it('表单模型接了四个字段，且注入块同时给出 store 与 actions', () => {
    const stub = stubPrimitives();
    const exports = loadBundle().factory((spec) => platformRequire(spec, stub));
    const { ctx, calls } = fakeContext();
    exports.apply(ctx);

    // 字段接线
    const specs = stub.calls.constructed[0]?.specs;
    assert.deepEqual(
      specs?.map((spec) => spec.field),
      ['providerOrder', 'maxResultsPerEngine', 'anysearchApiKeyEnv', 'tavilyApiKeyEnv'],
      '四个字段都要挂上表单模型',
    );
    assert.equal(stub.calls.bound, 1, '投影应当恰好 bind 一次');

    // 插槽注入：hooks 给组件 store，其余是 actions
    const injected = calls.find((call) => call.kind === 'slots.register')?.options?.inject?.();
    assert.ok(injected?.hooks?.webSearchConfig, '组件通过 hooks.webSearchConfig 拿到 store');
    for (const action of ['edit', 'resetField', 'save', 'discard']) {
      assert.equal(typeof injected[action], 'function', `注入块应当带 ${action}`);
    }
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

    // 凭据引用名
    assert.deepEqual(specs.tavilyApiKeyEnv.parse('TAVILY_API_KEY'), { kind: 'set', value: 'TAVILY_API_KEY' });
    assert.deepEqual(specs.tavilyApiKeyEnv.parse('   '), { kind: 'clear' }, '空草稿 = 清除，回落到默认值');
    assert.equal(specs.tavilyApiKeyEnv.parse('tavily-key'), undefined, '不是环境变量名，非法');
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
