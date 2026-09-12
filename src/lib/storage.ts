/**
 * localStorage 持久化：设置项与「上次识别结果」。
 * 全部数据只存在用户自己的浏览器里。
 */

import { DEFAULT_ASR, DEFAULT_LLM, STORAGE_KEYS } from './constants';
import type { AsrSettings, LlmSettings, Segment, SummaryResult } from '../types';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return { ...fallback, ...parsed } as T;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式或配额满：忽略 */
  }
}

export const loadAsrSettings = (): AsrSettings => readJson(STORAGE_KEYS.asr, DEFAULT_ASR);
export const saveAsrSettings = (s: AsrSettings) => writeJson(STORAGE_KEYS.asr, s);

export const loadLlmSettings = (): LlmSettings => readJson(STORAGE_KEYS.llm, DEFAULT_LLM);
export const saveLlmSettings = (s: LlmSettings) => writeJson(STORAGE_KEYS.llm, s);

export interface PersistedResult {
  fileName: string;
  duration: number;
  model: string;
  language?: string;
  segments: Segment[];
  summary: SummaryResult | null;
  savedAt: number;
}

export function loadLastResult(): PersistedResult | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.lastResult);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedResult;
    if (!parsed || !Array.isArray(parsed.segments)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveLastResult(result: PersistedResult | null): void {
  try {
    if (!result) {
      localStorage.removeItem(STORAGE_KEYS.lastResult);
      return;
    }
    localStorage.setItem(STORAGE_KEYS.lastResult, JSON.stringify(result));
  } catch {
    // 结果太大时可能超配额：静默降级，不影响主流程
  }
}
