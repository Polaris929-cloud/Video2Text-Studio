/**
 * 语音识别客户端：主线程侧对 Worker 的封装。
 */

import type { AsrSettings, Segment, WorkerInMessage, WorkerOutMessage } from '../types';
import { TARGET_SAMPLE_RATE } from './audio';
import { resolveSiteBase } from './modelSources';

export interface TranscribeCallbacks {
  onStatus?: (message: string) => void;
  onProgress?: (info: {
    stage: 'load' | 'transcribe';
    value: number;
    note?: string;
    /** 加载阶段细分，界面据此区分「下载中」与「编译初始化中」 */
    phase?: 'probe' | 'download' | 'compile';
  }) => void;
}

export interface TranscribeResult {
  segments: Segment[];
  language?: string;
  duration: number;
}

/** 把 Worker 返回的原始片段整理成有序、不重叠的 Segment 列表 */
export function normalizeSegments(raw: Array<{ text: string; timestamp: [number, number | null] | null }>): Segment[] {
  const segments: Segment[] = [];
  let lastEnd = 0;

  for (const item of raw) {
    const text = item.text.trim();
    if (!text) continue;

    let start = item.timestamp?.[0];
    let end = item.timestamp?.[1];

    if (typeof start !== 'number' || !Number.isFinite(start)) start = lastEnd;
    if (typeof end !== 'number' || !Number.isFinite(end) || end <= start) {
      // 没有结束时间：按语速估算（中文约 5 字/秒，英文约 2.5 词/秒）
      const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
      const words = (text.match(/[A-Za-z']+/g) ?? []).length;
      const estimate = Math.max(0.8, Math.min(15, cjk / 5 + words / 2.5));
      end = start + estimate;
    }

    // 避免与上一条重叠
    if (start < lastEnd) start = lastEnd;
    if (end <= start) end = start + 0.6;
    lastEnd = end;

    segments.push({ index: segments.length, start, end, text });
  }

  return segments;
}

export class WhisperClient {
  private worker: Worker | null = null;

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/asr.worker.ts', import.meta.url), { type: 'module' });
    }
    return this.worker;
  }

  /** 预热：提前开始下载模型，用户点「开始识别」时就不用等太久 */
  async preload(settings: AsrSettings, callbacks: TranscribeCallbacks = {}): Promise<void> {
    // 用一个极短的静音片段触发模型加载，加载完成后 Worker 内部会缓存 pipeline
    const silence = new Float32Array(TARGET_SAMPLE_RATE / 2);
    await this.transcribe(silence, settings, callbacks, { preloadOnly: true });
  }

  transcribe(
    audio: Float32Array,
    settings: AsrSettings,
    callbacks: TranscribeCallbacks = {},
    options: { preloadOnly?: boolean } = {},
  ): Promise<TranscribeResult> {
    const worker = this.ensureWorker();

    return new Promise<TranscribeResult>((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };

      const onMessage = (event: MessageEvent<WorkerOutMessage>) => {
        const msg = event.data;
        switch (msg.type) {
          case 'status':
            callbacks.onStatus?.(msg.message);
            break;
          case 'progress':
            callbacks.onProgress?.({ stage: msg.stage, value: msg.value, note: msg.note, phase: msg.phase });
            break;
          case 'result': {
            cleanup();
            if (options.preloadOnly) {
              resolve({ segments: [], language: msg.language, duration: msg.duration });
              return;
            }
            resolve({
              segments: normalizeSegments(msg.segments),
              language: msg.language,
              duration: msg.duration,
            });
            break;
          }
          case 'error':
            cleanup();
            reject(new Error(msg.message));
            break;
          default:
            break;
        }
      };

      const onError = (event: ErrorEvent) => {
        cleanup();
        reject(new Error(event.message || '语音识别 Worker 发生未知错误。'));
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);

      const payload: WorkerInMessage = {
        type: 'transcribe',
        audio,
        model: settings.model,
        language: settings.language,
        dtype: settings.dtype,
        device: settings.device,
        chunkSeconds: settings.chunkSeconds,
        strideSeconds: settings.strideSeconds,
        engineSource: settings.engineSource,
        modelSource: settings.modelSource,
        customModelHost: settings.customModelHost,
        siteBase: resolveSiteBase(document.baseURI),
      };
      // 用 transferable 传大数组，避免拷贝
      worker.postMessage(payload, [audio.buffer]);
    });
  }

  abort(): void {
    if (this.worker) {
      const msg: WorkerInMessage = { type: 'abort' };
      this.worker.postMessage(msg);
      // Worker 被 abort 后内部状态可能不干净，直接销毁，下次重建
      this.worker.terminate();
      this.worker = null;
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
