#!/usr/bin/env node
/**
 * 发布前门禁。
 *
 * 这里检查的都是「只在别人机器上复现」的问题，本地测试发现不了：
 * 装了插件之后 profile 才会崩，或者装上去了但根本没接管搜索。
 *
 * 故意不依赖 `dist/`，所以它可以在 build 之前跑。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function readJson(relative) {
  return JSON.parse(readFileSync(join(ROOT, relative), 'utf8'));
}

function readText(relative) {
  return readFileSync(join(ROOT, relative), 'utf8');
}

const pkg = readJson('package.json');

// ── 1. 运行时依赖铁律 ───────────────────────────────────────────────────────
// 插件装在 profile 旁边；@deepseek-ai/* 一旦进入 dependencies（或非 optional 的
// peerDependencies，pnpm 会自动装它），profile 里就会多出一份私有副本，Cordis
// Service 身份不再相等，注入静默失效。
const optionalPeers = new Set(
  Object.entries(pkg.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta?.optional === true)
    .map(([name]) => name),
);

const forbidden = [];

for (const name of Object.keys(pkg.dependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/')) forbidden.push(`dependencies.${name}`);
}

for (const name of Object.keys(pkg.peerDependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/') && !optionalPeers.has(name)) {
    forbidden.push(`peerDependencies.${name} (not marked optional)`);
  }
}

if (forbidden.length > 0) {
  fail(
    `禁止把 @deepseek-ai/* 放进运行时依赖，否则 profile 里会多一份私有副本并遮蔽宿主那份：\n` +
      forbidden.map((entry) => `    - ${entry}`).join('\n'),
  );
} else {
  notes.push('运行时依赖里没有 @deepseek-ai/*');
}

// ── 2. files 白名单 ─────────────────────────────────────────────────────────
const files = pkg.files ?? [];
for (const required of ['dist', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  if (!files.includes(required)) fail(`package.json 的 files 缺少 "${required}" —— 发布产物会缺文件`);
}

// ── 3. bundle patch 声明与文件存在 ──────────────────────────────────────────
const patchPath = pkg.dsh?.bundle?.patch;
if (typeof patchPath !== 'string' || patchPath.length === 0) {
  fail('package.json 缺少 dsh.bundle.patch —— 装上插件不会接管搜索');
} else {
  const absolute = resolve(ROOT, patchPath);
  if (!existsSync(absolute)) {
    fail(`dsh.bundle.patch 指向的 ${patchPath} 不存在`);
  } else {
    notes.push(`bundle patch: ${patchPath}`);

    // ── 4. entry id 与源码里注册的 provider id 必须一致 ──────────────────────
    // 不一致的表现是：插件装上了、界面没报错，但搜索根本没走本插件。
    const providerId = /export const PROVIDER_ID = '([^']+)'/.exec(readText('src/provider.ts'))?.[1];

    if (providerId === undefined) {
      fail('src/provider.ts 里找不到 PROVIDER_ID');
    } else {
      const patch = readText(patchPath);

      const insertId = /-\s*insert:\s*\n\s*-\s*id:\s*(\S+)/.exec(patch)?.[1];
      if (insertId === undefined) {
        fail(`${patchPath} 里找不到 insert 的 entry id`);
      } else if (insertId !== providerId) {
        fail(`entry id 不一致：patch 里是 "${insertId}"，源码里是 "${providerId}"`);
      }

      const pinned = /-\s*id:\s*web\s*\n\s*config:\s*\n\s*searchProvider:\s*(\S+)/.exec(patch)?.[1];
      if (pinned === undefined) {
        fail(`${patchPath} 没有把 web.searchProvider 重指到本插件`);
      } else if (pinned !== providerId) {
        fail(`web.searchProvider 指向 "${pinned}"，但源码注册的是 "${providerId}"`);
      }

      // fetchProvider 必须保持不动 —— 本插件不注册 fetch provider。
      if (/^\s*fetchProvider:/m.test(patch)) {
        fail(`${patchPath} 动了 fetchProvider，但本插件没有注册 fetch provider（会让 web_fetch 报 WEB_PROVIDER_CONFIGURED_MISSING）`);
      }
    }
  }
}

// ── 结果 ───────────────────────────────────────────────────────────────────
for (const note of notes) console.log(`  ok  ${note}`);

if (failures.length > 0) {
  console.error('\ncheck-package 失败：\n');
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('\ncheck-package 通过。');
