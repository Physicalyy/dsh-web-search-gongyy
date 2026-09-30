import type { Engine } from '../types.js';
import { anysearchEngine } from './anysearch.js';
import { tavilyEngine } from './tavily.js';

/**
 * 所有已实现的引擎。
 *
 * 数组顺序**不代表**调用顺序 —— 调用顺序完全由配置的 `providerOrder` 决定。
 * 这里只提供 id 到实现的查找表。
 */
export const ENGINES: readonly Engine[] = [anysearchEngine, tavilyEngine];

const BY_ID = new Map<string, Engine>(ENGINES.map((engine) => [engine.id, engine]));

/**
 * 按 id 查找引擎。
 *
 * 未知 id 返回 `undefined` 而不是抛错：`providerOrder` 里写错一个 id 不应该让整个
 * provider 失效，调用方会把它记进失败列表并跳过。
 */
export function engineById(id: string): Engine | undefined {
  return BY_ID.get(id);
}

/** 所有已知引擎 id，用于错误信息与自检。 */
export function knownEngineIds(): readonly string[] {
  return ENGINES.map((engine) => engine.id);
}
