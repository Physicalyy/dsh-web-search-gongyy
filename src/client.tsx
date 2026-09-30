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
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';

// 这些是**静态平台模块**（由壳的 PLATFORM_MODULES 提供），直接 require 即可，不用声明。
import {
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  settingsNumberField,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  SettingsFieldSpec,
  SettingsFieldState,
  SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives';

/** 设置命名空间 = 本插件在 `cordis.patch.yml` 里的 entry id（不是包名）。 */
export const NS = 'web-search-gongyy';

/** Cordis loader 诊断用的插件名。 */
export const name = NS;

/** 本插件的词典。类型化注册强制双语平衡：两边 key 必须一一对应。 */
const zh = {
  description: '引擎调用顺序、结果数与凭据引用名。',
  orderLabel: '引擎调用顺序',
  orderHint: '逗号分隔，靠前的先调用。可选 anysearch、tavily。',
  orderInvalid: '只允许 anysearch / tavily，逗号分隔，且不能为空或重复',
  maxResultsLabel: '每次搜索的结果数上限',
  maxResultsHint: '正整数。调用方未指定条数时使用。',
  maxResultsInvalid: '必须是正整数',
  anysearchEnvLabel: 'AnySearch 凭据引用名',
  anysearchEnvHint: '环境变量名。AnySearch 支持匿名，留空即可。',
  tavilyEnvLabel: 'Tavily 凭据引用名',
  tavilyEnvHint: '环境变量名，例如 TAVILY_API_KEY。',
  envInvalid: '必须是形如 ANYSEARCH_API_KEY 的环境变量名',
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
  description: 'Engine order, result count, and credential reference names.',
  orderLabel: 'Engine order',
  orderHint: 'Comma-separated; earlier engines are tried first. Allowed: anysearch, tavily.',
  orderInvalid: 'Only anysearch / tavily, comma-separated, no blanks or duplicates',
  maxResultsLabel: 'Max results per engine',
  maxResultsHint: 'A positive integer. Used when the caller does not specify a count.',
  maxResultsInvalid: 'Must be a positive integer',
  anysearchEnvLabel: 'AnySearch credential reference',
  anysearchEnvHint: 'An environment variable name. AnySearch works anonymously — leave blank.',
  tavilyEnvLabel: 'Tavily credential reference',
  tavilyEnvHint: 'An environment variable name, e.g. TAVILY_API_KEY.',
  envInvalid: 'Must be an environment variable name such as ANYSEARCH_API_KEY',
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
 * 凭据引用名字段：必须是 POSIX 环境变量名。
 *
 * 空草稿 = 清除（回落到默认值），与 `settingsTextField` 的语义一致。
 */
function credentialRefSpec(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      const name = text.trim();
      if (name.length === 0) return { kind: 'clear' };
      return /^[A-Z][A-Z0-9_]*$/.test(name) ? { kind: 'set', value: name } : undefined;
    },
  };
}

const SPECS: SettingsFieldSpec[] = [
  providerOrderSpec,
  settingsNumberField('maxResultsPerEngine'),
  credentialRefSpec('anysearchApiKeyEnv'),
  credentialRefSpec('tavilyApiKeyEnv'),
];

/** 卡片状态：框架态 + 每个控件的草稿态。 */
interface CardState {
  readonly shell: SettingsFormShell;
  readonly order: SettingsFieldState;
  readonly maxResults: SettingsFieldState;
  readonly anysearchEnv: SettingsFieldState;
  readonly tavilyEnv: SettingsFieldState;
}

/** 从表单模型投影出卡片状态（scope 或草稿每次变化都会重建）。 */
function projection(model: SettingsFormModel<Record<string, unknown>>): CardState {
  return {
    shell: model.shell(),
    order: model.field('providerOrder'),
    maxResults: model.field('maxResultsPerEngine'),
    anysearchEnv: model.field('anysearchApiKeyEnv'),
    tavilyEnv: model.field('tavilyApiKeyEnv'),
  };
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

/** 一个受控字段。抽出来只为少写四遍同样的 props。 */
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
      {valueField({
        t,
        id: 'wsg-anysearch-env',
        label: t('anysearchEnvLabel'),
        hint: t('anysearchEnvHint'),
        invalidLabel: t('envInvalid'),
        state: state.anysearchEnv,
        disabled,
        onEdit: (text) => props.edit('anysearchApiKeyEnv', text),
        onReset: () => props.resetField('anysearchApiKeyEnv'),
      })}
      {valueField({
        t,
        id: 'wsg-tavily-env',
        label: t('tavilyEnvLabel'),
        hint: t('tavilyEnvHint'),
        invalidLabel: t('envInvalid'),
        state: state.tavilyEnv,
        disabled,
        onEdit: (text) => props.edit('tavilyApiKeyEnv', text),
        onReset: () => props.resetField('tavilyApiKeyEnv'),
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
  ctx.inject(['slots', 'configForms', 'locale'], (ctx) => {
    // 词典：类型化注册会强制 zh / en 的 key 域完全一致。
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'web-search-gongyy: dictionaries');

    const t = ctx.locale.bind(NS);

    // 表单模型：scope 来自 configForms，按命名空间取。
    const model = new SettingsFormModel<Record<string, unknown>>(ctx.configForms.get(NS), SPECS);
    ctx.effect(() => () => model.dispose(), 'web-search-gongyy: form subscription');

    const store = model.bind(() => projection(model));

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
