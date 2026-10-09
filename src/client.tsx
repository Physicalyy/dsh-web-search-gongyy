/**
 * 客户端半边（浏览器）：在侧栏插件页的 bundle 详情里渲染配置表单。
 *
 * 编译成 CommonJS 后由 `wrap-client.cjs` 包成
 * `window.__ModuleLoader__.load({ id, factory })`。
 *
 * ## 两个 inject 别搞混（踩过一次，导致整个界面起不来）
 *
 * | 位置 | 写什么 | 例子 |
 * | --- | --- | --- |
 * | `package.json` 的 `dsh.client.inject` | **包名**（模块工厂到达顺序 + 组合边） | `@deepseek-ai/dsh-client-ui-plugin-manager` |
 * | 本文件可能导出的 `inject` | **服务名** | `["slots", "configForms", "locale"]` |
 *
 * 本项目**刻意不导出顶层 `inject`**，改用 `ctx.inject([...], cb)`：它建子 fiber 等依赖，
 * 父 entry 本体立即激活，于是依赖缺失的后果从"宿主起不来"降级为"配置区不显示"。
 *
 * ## 客户端侧的 declare-module 增强都在各包的 `/client` 子路径下
 *
 * 从**包根**导入拿不到任何增强（包根的 index.d.ts 是宿主半边）。
 */
import type { Context } from '@deepseek-ai/cordis';

// 只为触发 declare-module 增强，运行时**不产生 require**：
//   locale/client          → ctx.locale
//   renderer/client        → ctx.slots（注意：不是 slots 包！）
//   settings/client        → ctx.configForms
//   plugin-manager/client  → plugins.* 插槽的 SlotMap 类型
//   api-remotes/client     → ctx.remote 与它的 credentials 命名空间（写凭据域）
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-api-remotes/client';

// 这些是**静态平台模块**（由壳的 PLATFORM_MODULES 提供），直接 require 即可，不用声明。
import {
  SettingsForm,
  SettingsFormModel,
  SettingsSecretField,
  SettingsValueField,
  settingsNumberField,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  SettingsFieldSpec,
  SettingsFieldState,
  SettingsFormShell,
  SettingsSecretSpec,
} from '@deepseek-ai/dsh-client-ui-primitives';

/** 设置命名空间 = 本插件在 `cordis.patch.yml` 里的 entry id（不是包名）。 */
export const NS = 'web-search-gongyy';

/** Cordis loader 诊断用的插件名。 */
export const name = NS;

/** 本插件的词典。类型化注册强制双语平衡：两边 key 必须一一对应。 */
const zh = {
  description: '引擎调用顺序、结果数与 API Key。',
  orderLabel: '引擎调用顺序',
  orderHint: '逗号分隔，靠前的先调用。可选 anysearch、tavily。',
  orderInvalid: '只允许 anysearch / tavily，逗号分隔，且不能为空或重复',
  maxResultsLabel: '每次搜索的结果数上限',
  maxResultsHint: '正整数。调用方未指定条数时使用。',
  maxResultsInvalid: '必须是正整数',
  anysearchKeyLabel: 'AnySearch API Key',
  anysearchKeyHint: '直接粘贴 Key，保存时写进凭据域（不会落到配置文件）。AnySearch 支持匿名，留空即可。',
  tavilyKeyLabel: 'Tavily API Key',
  tavilyKeyHint: '直接粘贴 Key，保存时写进凭据域（不会落到配置文件）。',
  keySet: '已设置',
  keyUnset: '未设置',
  overridden: '已覆盖',
  reset: '恢复默认',
  unavailable: '配置暂不可用。',
  readOnly: '当前配置为只读。',
  saveFailed: '保存未生效，草稿已保留。',
  save: '保存',
  saving: '保存中…',
} as const;

/** 词典 key 的联合 —— 同时是插槽 locale 命名空间的 key 域。 */
type DictKey = keyof typeof zh;

const en: Record<DictKey, string> = {
  description: 'Engine order, result count, and API keys.',
  orderLabel: 'Engine order',
  orderHint: 'Comma-separated; earlier engines are tried first. Allowed: anysearch, tavily.',
  orderInvalid: 'Only anysearch / tavily, comma-separated, no blanks or duplicates',
  maxResultsLabel: 'Max results per engine',
  maxResultsHint: 'A positive integer. Used when the caller does not specify a count.',
  maxResultsInvalid: 'Must be a positive integer',
  anysearchKeyLabel: 'AnySearch API key',
  anysearchKeyHint: 'Paste the key; saving writes it to the credential store (never to the config file). AnySearch works anonymously — leave blank.',
  tavilyKeyLabel: 'Tavily API key',
  tavilyKeyHint: 'Paste the key; saving writes it to the credential store (never to the config file).',
  keySet: 'Configured',
  keyUnset: 'Not configured',
  overridden: 'Overridden',
  reset: 'Reset to default',
  unavailable: 'Configuration is unavailable.',
  readOnly: 'Configuration is read-only.',
  saveFailed: 'Save did not take effect; drafts kept.',
  save: 'Save',
  saving: 'Saving…',
};

// 把本插件的命名空间并入插槽的词典表 —— 这样 `locale: NS` 才合法，
// 而且 register 的 key 域会在编译期被强制与 zh 对齐。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'web-search-gongyy': DictKey;
  }
}

/** 已实现的引擎 id，与宿主半边的 `src/engines/index.ts` 保持一致。 */
const KNOWN_ENGINES = ['anysearch', 'tavily'];

/** 两种凭据：卡片各给它们一个 Key 控件。 */
type CredentialKind = 'anysearch' | 'tavily';

const KINDS: readonly CredentialKind[] = ['anysearch', 'tavily'];

/**
 * 表单里 Key 控件的字段名。
 *
 * **刻意不叫 `anysearchApiKey`** —— 那个名字已经被**宿主配置里的字面量字段**占用
 * （`Config` 的 `z.string().role('secret')`），而两者存储位置完全不同：字面量落配置文件，
 * 本控件写凭据域。同名会让后来人把两者搞混，甚至互相覆盖。
 */
const KEY_FIELD: Record<CredentialKind, string> = {
  anysearch: 'anysearchApiKeyCredential',
  tavily: 'tavilyApiKeyCredential',
};

/** 每个凭据对应哪个"引用名"配置字段，以及缺省引用名（与宿主 Config 的 default 一致）。 */
const ENV_FIELD: Record<CredentialKind, string> = {
  anysearch: 'anysearchApiKeyEnv',
  tavily: 'tavilyApiKeyEnv',
};

const DEFAULT_REF: Record<CredentialKind, string> = {
  anysearch: 'ANYSEARCH_API_KEY',
  tavily: 'TAVILY_API_KEY',
};

/** 凭据域只知道"有没有配"，值本身不会回传（见 primitives 对 SettingsSecretSpec 的说明）。 */
interface CredentialState {
  readonly ref: string;
  readonly configured: boolean;
  readonly writable: boolean;
}

/**
 * `providerOrder` 的字段规格。
 *
 * 表单模型只吃**文本草稿**（`format`/`parse` 负责转换），没有数组字段的原生支持，
 * 所以这里序列化成逗号分隔的 id 列表。序列非法时 `parse` 返回 undefined，
 * 框架会把该字段标成 invalid 并**阻止保存**（而不是丢掉这次编辑）。
 */
const providerOrderSpec: SettingsFieldSpec = {
  field: 'providerOrder',
  format: (value) => (Array.isArray(value) ? value.join(', ') : ''),
  parse: (text) => {
    const ids = text
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (ids.length === 0) return undefined;
    if (new Set(ids).size !== ids.length) return undefined;
    if (ids.some((id) => !KNOWN_ENGINES.includes(id))) return undefined;

    return { kind: 'set', value: ids };
  },
};

/**
 * 卡片上的配置字段：顺序与结果数。
 *
 * 凭据走 `SettingsSecretSpec`（见第 12.6 节）。原先还有两个"凭据引用名"字段，
 * 用户反馈界面上不需要（默认值 `ANYSEARCH_API_KEY` / `TAVILY_API_KEY` 就够），已撤掉 ——
 * 那两个仍是宿主 `Config` 的字段，手改 `cordis.patch.yml` 依然生效，而且 `refNameOf()`
 * 就是读它们来决定 Key 存到哪个引用名下。
 */
const SPECS: SettingsFieldSpec[] = [
  providerOrderSpec,
  settingsNumberField('maxResultsPerEngine'),
];

/** 卡片状态：框架态 + 每个控件的草稿态 + 两个凭据的"有没有配"。 */
interface CardState {
  readonly shell: SettingsFormShell;
  readonly order: SettingsFieldState;
  readonly maxResults: SettingsFieldState;
  readonly anysearchKey: SettingsFieldState;
  readonly tavilyKey: SettingsFieldState;
  readonly anysearchConfigured: boolean;
  readonly tavilyConfigured: boolean;
  readonly keysWritable: boolean;
}

/**
 * 插槽注入进组件的 props。
 *
 * `hooks: { webSearchConfig: store }` → 组件拿到 `props.useWebSearchConfig`；
 * `...model.actions()` → `props.edit / resetField / save / discard`。
 */
interface CardProps {
  readonly t: (key: DictKey) => string;
  readonly view?: 'summary' | 'page';
  readonly useWebSearchConfig: <S>(selector: (snapshot: CardState) => S) => S;
  readonly edit: (field: string, text: string) => void;
  readonly resetField: (field: string) => void;
  readonly save: () => void;
  readonly discard: () => void;
}

/** 一个受控字段。抽出来只为少写几遍同样的 props。 */
function valueField(args: {
  t: CardProps['t'];
  id: string;
  label: string;
  hint: string;
  invalidLabel: string;
  state: SettingsFieldState;
  disabled: boolean;
  onEdit: (text: string) => void;
  onReset: () => void;
}) {
  return (
    <SettingsValueField
      id={args.id}
      label={args.label}
      hint={args.hint}
      text={args.state.text}
      overridden={args.state.overridden}
      invalid={args.state.invalid}
      overriddenLabel={args.t('overridden')}
      resetLabel={args.t('reset')}
      invalidLabel={args.invalidLabel}
      disabled={args.disabled}
      onEdit={args.onEdit}
      onReset={args.onReset}
    />
  );
}

/**
 * 一个凭据控件：**只写不读**。
 *
 * 值不会随响应回流，所以草稿一开始是空的、界面只显示"有没有配"；空草稿保存不会写任何东西
 * （因此不会把已存的 Key 清掉）。没有 reset —— "清除凭据"不是这里能表达的动作。
 */
function secretField(args: {
  t: CardProps['t'];
  id: string;
  label: string;
  hint: string;
  state: SettingsFieldState;
  configured: boolean;
  disabled: boolean;
  onEdit: (text: string) => void;
}) {
  return (
    <SettingsSecretField
      id={args.id}
      label={args.label}
      hint={args.hint}
      text={args.state.text}
      configured={args.configured}
      stateLabel={args.t(args.configured ? 'keySet' : 'keyUnset')}
      disabled={args.disabled}
      onEdit={args.onEdit}
    />
  );
}

/** 配置卡片：插槽渲染的组件。 */
function ConfigCard(props: CardProps) {
  const { t } = props;
  const state = props.useWebSearchConfig((snapshot) => snapshot);

  // 插件页在 summary 位只要一行描述。
  if (props.view === 'summary') return <>{t('description')}</>;

  // 命名空间没被服务时什么都不渲染 —— 与框架组件自己的约定一致。
  if (!state.shell.available) return null;

  const disabled = !state.shell.writable;

  return (
    <SettingsForm
      labels={{
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }}
      state={state.shell}
      onSave={props.save}
      onDiscard={props.discard}
    >
      {valueField({
        t,
        id: 'wsg-provider-order',
        label: t('orderLabel'),
        hint: t('orderHint'),
        invalidLabel: t('orderInvalid'),
        state: state.order,
        disabled,
        onEdit: (text) => props.edit('providerOrder', text),
        onReset: () => props.resetField('providerOrder'),
      })}
      {valueField({
        t,
        id: 'wsg-max-results',
        label: t('maxResultsLabel'),
        hint: t('maxResultsHint'),
        invalidLabel: t('maxResultsInvalid'),
        state: state.maxResults,
        disabled,
        onEdit: (text) => props.edit('maxResultsPerEngine', text),
        onReset: () => props.resetField('maxResultsPerEngine'),
      })}
      {secretField({
        t,
        id: 'wsg-anysearch-key',
        label: t('anysearchKeyLabel'),
        hint: t('anysearchKeyHint'),
        state: state.anysearchKey,
        configured: state.anysearchConfigured,
        disabled: disabled || !state.keysWritable,
        onEdit: (text) => props.edit(KEY_FIELD.anysearch, text),
      })}
      {secretField({
        t,
        id: 'wsg-tavily-key',
        label: t('tavilyKeyLabel'),
        hint: t('tavilyKeyHint'),
        state: state.tavilyKey,
        configured: state.tavilyConfigured,
        disabled: disabled || !state.keysWritable,
        onEdit: (text) => props.edit(KEY_FIELD.tavily, text),
      })}
    </SettingsForm>
  );
}

/**
 * 客户端插件体。
 *
 * 刻意**不导出顶层 `inject`** —— 见文件头注释。
 */
export function apply(ctx: Context): void {
  // **全部工作都放在 ctx.inject 回调里** —— 依赖没就绪就一行都不跑。
  //
  // ★ 这里踩过一次：词典注册原本写在 apply 顶层（回调之外），而 `locale` 没被声明进
  //   inject，于是 apply 一开头就抛错，整个客户端半边**静默失效** —— 占位文字消失、
  //   配置区不出现，而且因为不占用 boot 审计，连崩溃日志都没有。
  //
  //   规矩：**用到哪个服务就必须声明哪个**，而且所有服务访问都要在回调之内。
  //
  // `remote` / `remote.credentials` 是"直接填 Key"要用的：Key 不在 settings 里，
  // 而是写进凭据域（`ctx.remote.credentials.set/describe`）。
  ctx.inject(['slots', 'configForms', 'locale', 'remote', 'remote.credentials'], (ctx) => {
    // 词典：类型化注册会强制 zh / en 的 key 域完全一致。
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'web-search-gongyy: dictionaries');

    const t = ctx.locale.bind(NS);

    // 表单模型：scope 来自 configForms，按命名空间取。
    //
    // **泛型要显式写出来**：`get<T>()` 的 T 以前是靠传给构造函数的上下文推断的，
    // 一旦先存进局部变量，T 会退化成 `unknown`，于是 `snapshot.value?.[字段]` 直接报错。
    const scope = ctx.configForms.get<Record<string, unknown>>(NS);

    /** 凭据域只知道"有没有配"；值本身不会回传（见 primitives 的 SettingsSecretSpec 说明）。 */
    const credentials: Record<CredentialKind, CredentialState> = {
      anysearch: { ref: '', configured: false, writable: true },
      tavily: { ref: '', configured: false, writable: true },
    };

    /** Key 控件当前的草稿（由表单模型持有），投影时读它。 */
    const keys = new Map<CredentialKind, SettingsFieldState>();

    /** 当前 Key 存在哪个引用名下：看配置里 `*ApiKeyEnv`，没配就用默认。 */
    function refNameOf(kind: CredentialKind): string {
      const value = scope.getSnapshot().value?.[ENV_FIELD[kind]];
      return typeof value === 'string' && value.length > 0 ? value : DEFAULT_REF[kind];
    }

    /** 状态变更的发布口。在 store 建好之前是空操作（读取可能先于它完成）。 */
    let publish: () => void = () => {};

    function projection(): CardState {
      return {
        shell: model.shell(),
        order: model.field('providerOrder'),
        maxResults: model.field('maxResultsPerEngine'),
        anysearchKey: keys.get('anysearch') ?? model.field(KEY_FIELD.anysearch),
        tavilyKey: keys.get('tavily') ?? model.field(KEY_FIELD.tavily),
        anysearchConfigured: credentials.anysearch.configured,
        tavilyConfigured: credentials.tavily.configured,
        keysWritable: credentials.anysearch.writable && credentials.tavily.writable,
      };
    }

    /**
     * 问凭据域：当前引用名下有没有 Key。
     *
     * **有个竞态要处理**：引用名可能在"发请求"与"收响应"之间被改。所以响应只在其 `ref`
     * 仍等于当前引用名时才采用（官方实现里也点了这一条）。
     */
    async function readCredential(kind: CredentialKind): Promise<void> {
      const ref = refNameOf(kind);
      if (ref !== credentials[kind].ref) {
        credentials[kind] = { ref, configured: false, writable: true };
        publish();
      }

      const response = await ctx.remote.credentials.describe([ref]);
      if (!response.ok) return;
      if (ref !== refNameOf(kind)) return;

      const view = response.value[ref];
      const next: CredentialState = {
        ref,
        configured: view?.configured ?? false,
        writable: view?.writable ?? true,
      };
      if (
        next.configured === credentials[kind].configured &&
        next.writable === credentials[kind].writable
      ) {
        return;
      }

      credentials[kind] = next;
      publish();
    }

    /** 保存时把草稿写进凭据域。框架保证空草稿不会调到这里。 */
    async function writeKey(kind: CredentialKind, text: string): Promise<boolean> {
      await ctx.remote.credentials.set(refNameOf(kind), text);
      await readCredential(kind);
      return credentials[kind].configured;
    }

    /** 值写到 settings 之外的控件 —— 这是"直接填 Key"的机制。 */
    const secretSpecs: SettingsSecretSpec[] = [
      { field: KEY_FIELD.anysearch, write: (text) => writeKey('anysearch', text) },
      { field: KEY_FIELD.tavily, write: (text) => writeKey('tavily', text) },
    ];

    const model = new SettingsFormModel<Record<string, unknown>>(scope, SPECS, secretSpecs);
    ctx.effect(() => () => model.dispose(), 'web-search-gongyy: form subscription');

    for (const kind of KINDS) keys.set(kind, model.field(KEY_FIELD[kind]));

    const store = model.bind(() => projection());
    publish = () => store.set(projection());

    // 引用名（或其它配置）变了 → Key 控件指向的引用名可能也变了，重读一次。
    ctx.effect(
      () =>
        scope.subscribe(() => {
          for (const kind of KINDS) void readCredential(kind);
        }),
      'web-search-gongyy: credential refresh on config change',
    );

    // 别处（例如 Models 页）改了同一个引用，徽标要跟着变。
    ctx.effect(
      () =>
        ctx.remote.$on('credentials/reference-updated', (ref: string) => {
          for (const kind of KINDS) {
            if (ref === refNameOf(kind)) void readCredential(kind);
          }
        }),
      'web-search-gongyy: credential refresh on host event',
    );

    for (const kind of KINDS) void readCredential(kind);

    ctx.effect(
      () =>
        ctx.configForms.whileServed([NS], () =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                // 按 npm 包名分发 —— 插件页用 entryKey: pkg.name 匹配。
                key: 'dsh-web-search-gongyy',
                locale: NS,
                inject: () => ({ hooks: { webSearchConfig: store }, ...model.actions() }),
              },
              ConfigCard as never,
            ),
          ),
        ),
      'web-search-gongyy: config card',
    );
  });
}
