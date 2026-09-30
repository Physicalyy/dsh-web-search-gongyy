/**
 * 客户端 bundle 的**离线**验证 —— 不碰用户的 dsh 环境。
 *
 * 用 mock 的 `window.__ModuleLoader__` 加载真实构建产物，逐条验证注册链路。
 *
 * 这是那次事故的回归测试：**`inject` 写成包名导致 Web boot 致命失败**，整个界面起不来。
 * 当时如果先跑这个文件，就不会烧到用户的 profile。教训是：改动客户端半边之前，
 * 先在这里把链路验完，再让用户重启。
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
 * `window` 在全局。走 vm 会创建新 realm，那边 `['slots']` 的 `Array.prototype` 与宿主
 * 不同，`deepStrictEqual` 会把两个看起来一样的数组判为不等 —— 白踩一次。
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

/** 只供应静态平台模块的 require 桩。 */
function platformRequire(specifier) {
  if (specifier === 'react/jsx-runtime') {
    return {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
      Fragment: Symbol('Fragment'),
    };
  }
  throw new Error(`bundle 请求了非平台模块："${specifier}" —— 它应当由壳提供，不该被打包`);
}

/** 假的 cordis context：记录调用链，并让依赖"立即就绪"。 */
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
    const exports = loadBundle().factory(platformRequire);

    // 关键：本项目刻意完全不用顶层 inject（改用 ctx.inject 降级失败模式）。
    assert.equal(
      exports.inject,
      undefined,
      '顶层 inject 已移除是刻意的；若要用，里面只能放服务名（slots/locale/…），绝不能是包名',
    );
  });

  it('factory 只向平台表要模块，不请求任何非平台包', () => {
    assert.doesNotThrow(() => loadBundle().factory(platformRequire));
  });

  it('导出 name 与 NS，且 apply 是函数', () => {
    const exports = loadBundle().factory(platformRequire);
    assert.equal(exports.name, NS);
    assert.equal(exports.NS, NS);
    assert.equal(typeof exports.apply, 'function');
  });

  it('apply() 等 slots 就绪后再注册 plugins.bundle.config 插槽', () => {
    const exports = loadBundle().factory(platformRequire);
    const { ctx, calls } = fakeContext();

    assert.doesNotThrow(() => exports.apply(ctx));

    assert.deepEqual(
      calls.find((call) => call.kind === 'inject')?.deps,
      ['slots'],
      '应当用 ctx.inject 等待 slots 服务',
    );
    assert.equal(
      calls.find((call) => call.kind === 'slots.inject')?.name,
      'plugins.bundle.config',
      '注册前要先等父级声明插槽',
    );

    const registration = calls.find((call) => call.kind === 'slots.register')?.options;
    assert.equal(registration?.name, 'plugins.bundle.config');
    assert.equal(registration?.key, PACKAGE_NAME, '插槽按 npm 包名分发（插件页用 entryKey: pkg.name 匹配）');
  });

  it('apply() 在没有 slots 服务时不该抛错（失败模式必须是降级而非崩溃）', () => {
    const exports = loadBundle().factory(platformRequire);
    const ctx = {
      inject: () => ({}), // 依赖永不就绪：真实实现下回调不会被调用
      effect: () => () => {},
      get: () => undefined,
    };
    assert.doesNotThrow(() => exports.apply(ctx));
  });
});
