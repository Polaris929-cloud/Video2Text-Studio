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

export const loadAsrSettings = (): AsrSettings => {
  const raw = readJson<AsrSettings & { modelHost?: string; localModel?: boolean }>(STORAGE_KEYS.asr, DEFAULT_ASR);
  // 旧版本（v1.0）用的是「模型下载源」下拉 + 「本地模型目录」开关：
  //   - modelHost 有值 → 迁移成自定义地址，继续当兜底源使用；
  //   - 丢掉已经废弃的 localModel 字段。
  const legacyHost = typeof raw.modelHost === 'string' ? raw.modelHost.trim() : '';
  const { modelHost: _dropHost, localModel: _dropLocal, ...rest } = raw;
  return {
    ...DEFAULT_ASR,
    ...rest,
    customModelHost: rest.customModelHost || legacyHost,
  };
};
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

/* ── 长视频的中转存档 ────────────────────────────────────────────
 * 37 分钟的视频在 CPU 上要跑几十分钟，中途刷新/关页面/崩溃的概率不低。
 * 识别过程中每处理若干分片就落一次盘，让用户能从中断处接着跑，
 * 而不是从头再来一遍（那基本等于放弃）。
 */
export interface Checkpoint {
  fileName: string;
  /** 已处理到的音频时间点（秒），续跑从这里开始 */
  cursor: number;
  /** 音频总时长 */
  duration: number;
  segments: Segment[];
  savedAt: number;
}

export function loadCheckpoint(): Checkpoint | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.checkpoint);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Checkpoint;
    if (!parsed || !Array.isArray(parsed.segments) || typeof parsed.cursor !== 'number') return null;
    // 已经跑完的存档没有续跑价值
    if (parsed.cursor >= parsed.duration - 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCheckpoint(
  meta: { cursor: number; duration: number; fileName: string },
  segments: Segment[],
): void {
  try {
    const payload: Checkpoint = { ...meta, segments, savedAt: Date.now() };
    localStorage.setItem(STORAGE_KEYS.checkpoint, JSON.stringify(payload));
  } catch {
    // 超配额（长视频字幕可能很大）：放弃本次落盘，不影响识别本身
  }
}

export function clearCheckpoint(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.checkpoint);
  } catch {
    /* ignore */
  }
}
