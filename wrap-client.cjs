#!/usr/bin/env node
/**
 * 把 tsc 产出的 CommonJS 客户端半边包装成 DSH 模块加载器能消费的形式。
 *
 * DSH 浏览器侧是 lazy-CJS 模块表：脚本执行时**只注册一个工厂**，模块体的副作用
 * （含 CSS 注入）要等到 materialize 才跑。注册接口是
 * `window.__ModuleLoader__.load({ id, factory })`，其中 `id` 必须是**包名**且与
 * boot graph 的 row 一致（见 @deepseek-ai/dsh-client-modules 的 manifest.ts）。
 *
 * **必须幂等**：`pnpm build` 可重复执行，第二次不能把已包装的文件再套一层 ——
 * 套两层会让工厂嵌套注册，页面直接崩。
 */

const fs = require('node:fs');
const path = require('node:path');

const packageName = require('./package.json').name;
const clientPath = path.join(__dirname, 'dist', 'client.js');
const MARKER = 'window.__ModuleLoader__.load(';

if (!fs.existsSync(clientPath)) {
  console.error(
    `wrap-client: 找不到 ${path.relative(__dirname, clientPath)}\n` +
      '  先跑 `tsc -p tsconfig.client.json`。',
  );
  process.exit(1);
}

const code = fs.readFileSync(clientPath, 'utf8');

if (code.includes(MARKER)) {
  console.log(`wrap-client: ${path.basename(clientPath)} 已包装过，跳过（幂等）`);
  process.exit(0);
}

const wrapped = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(packageName)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

${code}
		return module.exports;
	}
});
`;

fs.writeFileSync(clientPath, wrapped, 'utf8');
console.log(`wrap-client: 已包装 dist/client.js（id=${packageName}）`);
