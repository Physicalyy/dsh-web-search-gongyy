import type { Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import z from '@deepseek-ai/schemastery';
import { FallbackFetchProvider, FallbackSearchProvider, PROVIDER_ID } from './provider.js';
import type { ProviderOptions } from './provider.js';
import type { Engine } from './types.js';

export { FallbackFetchProvider, FallbackSearchProvider, PROVIDER_ID };
// 质量判据导出，好让标定脚本/测试用**同一份实现**，而不是各自抄一份阈值
export { QUALITY, looksLikeNonProse } from './provider.js';
export { ENGINES, engineById, knownEngineIds } from './engines/index.js';
export type { Engine, EngineFetchResult, EngineResult, EngineSource } from './types.js';
export type { EngineFailureKind } from './types.js';
export { EngineFetchError } from './types.js';

/** Cordis loader 诊断用的插件名；同时是 `cordis.patch.yml` 里引用的 entry id。 */
export const name = PROVIDER_ID;

/**
 * 只声明 `web`。
 *
 * 其余服务（`credentials` / `launchEnvironment`）一律用 `ctx.get()` 软取。把宿主可能
 * 没有的 service 放进顶层 `inject`，会让这个 entry 永远 pending，而 Web boot 把「有
 * entry 没激活」当成致命错误抛出 —— 整个界面会停在 "Failed to load plugins"。
 */
export const inject = ['web'];

/** 配置的**输入**形态（`cordis.patch.yml` 里写的字段）。 */
export interface Config {
  anysearchApiKey?: string;
  anysearchApiKeyEnv?: string;
  tavilyApiKey?: string;
  tavilyApiKeyEnv?: string;
  providerOrder?: string[];
  maxResultsPerEngine?: number;
}

/**
 * 配置 schema。
 *
 * **每个字段都标 `.volatile()`**：不标就不会进入设置表单的投影；而一个都不标时，这个
 * entry 根本不会出现在浏览器的 describe 镜像里，配置界面会永远显示"不可用"。
 */
export const Config = z.object({
  anysearchApiKey: z.string().role('secret').volatile(),
  anysearchApiKeyEnv: z.string().role('credential-ref').default('ANYSEARCH_API_KEY').volatile(),
  tavilyApiKey: z.string().role('secret').volatile(),
  tavilyApiKeyEnv: z.string().role('credential-ref').default('TAVILY_API_KEY').volatile(),
  providerOrder: z.array(z.string()).default(['anysearch', 'tavily']).volatile(),
  maxResultsPerEngine: z.number().step(1).min(1).default(8).volatile(),
});

/** `.volatile()` 字段在运行时是带 `.get()` 的引用，不是裸值。 */
export interface VolatileRef<T> {
  get(): T;
}

/**
 * loader 传给 `apply` 的、已解析的配置。
 *
 * 这是**手写**的契约：`schemastery` 把带 `.default()` 的 `.volatile()` 字段解析成
 * `Volatile<T>`、不带的解析成 `Volatile<T | undefined>`（见其 `SchemaOutput` 类型）。
 * 这里照此声明，读取一律走 `.get()`。
 */
export interface ResolvedConfig {
  readonly anysearchApiKey: VolatileRef<string | undefined>;
  readonly anysearchApiKeyEnv: VolatileRef<string>;
  readonly tavilyApiKey: VolatileRef<string | undefined>;
  readonly tavilyApiKeyEnv: VolatileRef<string>;
  readonly providerOrder: VolatileRef<readonly string[]>;
  readonly maxResultsPerEngine: VolatileRef<number>;
}

/** `ctx.get()` 的返回是 `any`；这里收敛成我们真正用到的形状。 */
interface CredentialsLike {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>;
}

/** 空串按缺失处理 —— seam 的凭据约定里，空值就等于没配置。 */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** 引擎 id → 配置字段的映射（配置字段名与引擎 id 不是机械对应，所以显式列表）。 */
interface EngineWiring {
  /** 配置里的字面 Key（仅本地调试用）。 */
  literalKey(config: ResolvedConfig): string | undefined;
  /** 配置里的凭据引用名；未配置时回落到引擎自带的默认环境变量名。 */
  apiKeyEnv(config: ResolvedConfig): string;
}

const WIRING: Readonly<Record<string, EngineWiring>> = {
  anysearch: {
    literalKey: (config) => nonEmpty(config.anysearchApiKey.get()),
    apiKeyEnv: (config) => nonEmpty(config.anysearchApiKeyEnv.get()) ?? 'ANYSEARCH_API_KEY',
  },
  tavily: {
    literalKey: (config) => nonEmpty(config.tavilyApiKey.get()),
    apiKeyEnv: (config) => nonEmpty(config.tavilyApiKeyEnv.get()) ?? 'TAVILY_API_KEY',
  },
};

/**
 * 把当前配置读成一次操作的不可变快照。
 *
 * 每次操作入口调用一次并冻结：配置可能在两次搜索之间被改，而重新注册 provider 会让
 * seam 的选择对用户可见地抖动。
 */
function snapshotOptions(ctx: Context, config: ResolvedConfig): ProviderOptions {
  const credentials = ctx.get('credentials') as CredentialsLike | undefined;
  const launchEnvironment = launchEnvironmentOf(ctx);
  const logger = ctx.logger(name);

  /** 按 id 取该引擎的配置接线；未知 id 没有接线。 */
  const wiringOf = (engine: Engine): EngineWiring | undefined => WIRING[engine.id];

  return {
    order: config.providerOrder.get(),
    maxResultsPerEngine: config.maxResultsPerEngine.get(),

    literalApiKey: (engine) => wiringOf(engine)?.literalKey(config),

    /**
     * 解析一个引擎的 Key。顺序：**字面值 → 托管凭据 → 启动环境变量**。
     *
     * 与官方 provider 一致：配置里写死的字面值是显式覆盖，优先级最高。
     * 每次操作重新解析、不缓存 —— 这正是"换 Key 不需要重启"的实现方式。
     */
    resolveApiKey: async (engine, signal) => {
      const wiring = wiringOf(engine);
      if (wiring === undefined) return undefined;

      const literal = nonEmpty(wiring.literalKey(config));
      if (literal !== undefined) return literal;

      const envName = wiring.apiKeyEnv(config);
      const ref = credentialRef(envName);

      if (credentials !== undefined) {
        const resolved = await credentials.resolve(ref);
        const value = nonEmpty(resolved?.value);
        if (value !== undefined) return value;
      }

      const ambient = launchEnvironment.get(envName);
      if (ambient !== undefined && ambient.value.length > 0) return ambient.value;

      if (signal?.aborted === true) return undefined;
      return undefined;
    },

    warn: (message) => logger.warn(message),
  };
}

/**
 * 注册聚合的搜索与抓取 provider。
 *
 * **两个 provider 用同一个 id** —— seam 的 search / fetch 是两个独立注册表，
 * 同一个 id 两边都能注册。这样 patch 里两行 `*Provider: web-search-gongyy` 就够。
 *
 * 两处都用 `() => snapshotOptions(...)` 这个 **thunk**：每次操作重新读配置，
 * 所以改配置不需要重新注册 provider（也就不会让 seam 的选择抖动）。
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  ctx.web.registerSearchProvider(new FallbackSearchProvider(() => snapshotOptions(ctx, config)));
  ctx.web.registerFetchProvider(new FallbackFetchProvider(() => snapshotOptions(ctx, config)));
}
