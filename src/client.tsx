/**
 * 客户端半边（浏览器）。编译成 CommonJS 后由 `wrap-client.cjs` 包成
 * `window.__ModuleLoader__.load({ id, factory })`。
 *
 * **当前是最小闭环**：只验证「bundle 能被加载 + 插槽能注册」这条链路。
 * 表单模型在后续阶段补上。
 */
import type { Context } from '@deepseek-ai/cordis';
// 下面这些 type-only import 只为触发 `declare module` 增强，运行时**不产生 require**。
//
// 关键：增强都在各包的 **`/client` 子路径**下，不是包根。包根的 index.d.ts 是宿主半边
// （renderer 的根只导出一个空的 `apply(): void`），从包根导入拿不到任何增强。
//
//   renderer/client        → ctx.slots
//   settings/client        → ctx.configForms
//   plugin-manager/client  → plugins.* 插槽的 SlotMap 类型
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';

/** 设置命名空间 = 本插件在 `cordis.patch.yml` 里的 entry id（不是包名）。 */
export const NS = 'web-search-gongyy';

/** Cordis loader 诊断用的插件名。 */
export const name = NS;

/**
 * 刻意**不导出顶层 `inject`**。
 *
 * ## 为什么 —— 这是一次真实事故的修复
 *
 * 顶层 `inject` 里写的是 **cordis 服务名**，不是包名。我一开始写成了包名
 * `'@deepseek-ai/dsh-client-ui-plugin-manager'`，于是 cordis 永远在等一个不存在的服务，
 * entry 永久 pending，Web boot **致命失败**，整个界面起不来：
 *
 *     web boot: 1 entry did not activate
 *     dsh-web-search-gongyy: pending (waiting for service: @deepseek-ai/dsh-client-ui-plugin-manager)
 *
 * ## 现在的做法
 *
 * 改用 `ctx.inject([...], cb)` —— 它创建**子 fiber** 去等依赖，**父 entry 本体立即激活**。
 * 依赖缺失的后果因此从"整个 Web 起不来"降级为"我们的配置区不出现"。
 *
 * 对第三方插件这个取舍是明确的：**我们没有资格让宿主启动失败。**
 *
 * ## 两个 inject 别搞混
 *
 * | 位置 | 写什么 | 例子 |
 * | --- | --- | --- |
 * | `package.json` 的 `dsh.client.inject` | **包名**（模块工厂到达顺序 + 组合边） | `@deepseek-ai/dsh-client-ui-plugin-manager` |
 * | 本文件导出的 `inject` | **服务名** | `["slots", "locale", "remote", "configForms"]` |
 */
export function apply(ctx: Context): void {
  // 只依赖 slots（由 dsh-client-ui-renderer 挂到 Context 上）。
  ctx.inject(['slots'], (ctx) => {
    ctx.effect(() =>
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            // 按 npm 包名分发 —— 插件页用 entryKey: pkg.name 匹配。
            key: 'dsh-web-search-gongyy',
            // 暂不传 locale：它的类型是**受约束的字面量联合**，当前只接受插件页自己的
            // "pluginManager"。要用自己的词典，得先对 locale 命名空间做 declare-module
            // 增强（官方各插件就是这么做的）。留到表单阶段和 i18n 一起做。
          },
          () => <p>dsh-web-search-gongyy</p>,
        ),
      ),
    );
  });
}
