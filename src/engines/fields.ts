/**
 * 各引擎共用的字段收敛工具。
 *
 * 各家 API 的返回结构差异很大，但 seam 的 `WebSearchSource` 只认四个字段，且
 * `title` / `snippet` / `publishedAt` 都是可选的。这里的函数把"上游给的东西"收敛成
 * "非空字符串或 undefined"，**绝不**用空字符串冒充缺失值 —— 让 seam 拿到真实的缺失。
 */

/** 非空字符串原样返回；空串、非字符串一律按缺失处理。 */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 收敛成 ISO-8601 字符串（seam 对 `publishedAt` 的要求）。
 *
 * 无法被 `Date` 解析的值一律返回 undefined —— 宁可省略，也不要给模型一个它无法
 * 判断时效性的垃圾日期。
 */
export function optionalIsoDate(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** 上游返回的数组，非数组一律当空数组。 */
export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 上游返回的对象，非对象一律按 undefined。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
