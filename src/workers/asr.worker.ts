/**
 * Whisper 语音识别 Worker。
 *
 * 设计要点：
 *  1. 模型在**浏览器本地**运行（transformers.js + onnxruntime-web，WebGPU 优先，回退 WASM）。
 *  2. Whisper 的单次输入窗口是 30 秒，因此长视频必须切片。这里采用「带重叠的滑窗」：
 *     每片处理 chunkSeconds 秒，下一片从「本片最后一条字幕的结束时间」开始，
 *     既不会在切片边界丢词，也不会整段重复。
 *  3. 时间戳统一换算成「整段音频的绝对时间」，方便直接生成 SRT/VTT。
 */

import type { RawSegment, WorkerInMessage, WorkerOutMessage } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

const post = (msg: WorkerOutMessage) => (self as unknown as Worker).postMessage(msg);

let aborted = false;
/** 已加载模型缓存：key = `${model}|${device}|${dtype}` */
const pipelineCache = new Map<string, AnyFn>();

/** 依次尝试的 transformers.js 加载地址，第一个成功即用。 */
const TRANSFORMERS_SOURCES = [
  // 国内可直连的 npm CDN
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3',
  // 备用 CDN
  'https://esm.sh/@huggingface/transformers@3.3.3',
  'https://unpkg.com/@huggingface/transformers@3.3.3',
];

let transformersModule: any = null;

async function loadTransformers(): Promise<any> {
  if (transformersModule) return transformersModule;

  const errors: string[] = [];
  for (const url of TRANSFORMERS_SOURCES) {
    try {
      post({ type: 'status', message: `正在加载语音识别引擎…` });
      const mod = await import(/* @vite-ignore */ url);
      // 把 onnxruntime 的 wasm 文件也指向同一个 CDN，避免相对路径 404
      try {
        mod.env.backends.onnx.wasm.wasmPaths = url.replace(/\/@huggingface\/transformers@[\d.]+$/, '/onnxruntime-web@1.20.1/dist/');
      } catch {
        /* 忽略：不同版本字段可能不同 */
      }
      mod.env.allowLocalModels = false;
      transformersModule = mod;
      return mod;
    } catch (err) {
      errors.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `无法加载语音识别引擎（transformers.js）。请检查网络后刷新页面重试。\n尝试过的地址：\n  ${errors.join('\n  ')}`,
  );
}

async function getPipeline(
  model: string,
  device: string,
  dtype: string,
): Promise<AnyFn> {
  const key = `${model}|${device}|${dtype}`;
  const cached = pipelineCache.get(key);
  if (cached) {
    post({ type: 'status', message: '模型已就绪（本地缓存）' });
    return cached;
  }

  const mod = await loadTransformers();
  const { pipeline } = mod;

  const attempts: Array<{ device: string; dtype: string; label: string }> = [];
  if (device === 'webgpu') {
    attempts.push({ device: 'webgpu', dtype, label: `WebGPU(${dtype})` });
    attempts.push({ device: 'wasm', dtype: 'q8', label: 'WASM(q8)' });
  } else if (device === 'wasm') {
    attempts.push({ device: 'wasm', dtype, label: `WASM(${dtype})` });
  } else {
    // auto：有 WebGPU 就先试 WebGPU，失败回退 CPU
    const hasWebGPU = typeof (navigator as unknown as { gpu?: unknown }).gpu !== 'undefined';
    if (hasWebGPU) attempts.push({ device: 'webgpu', dtype, label: `WebGPU(${dtype})` });
    attempts.push({ device: 'wasm', dtype: 'q8', label: 'WASM(q8)' });
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      post({ type: 'status', message: `正在准备模型 ${model} · ${attempt.label}（首次使用需下载，请稍候）` });
      const pipe = await pipeline('automatic-speech-recognition', model, {
        device: attempt.device,
        dtype: attempt.dtype,
        progress_callback: (p: any) => {
          if (aborted) return;
          if (p && typeof p.progress === 'number') {
            const pct = Math.max(0, Math.min(1, p.progress / 100));
            post({
              type: 'progress',
              stage: 'load',
              value: pct,
              note: p.file ? `${p.status ?? ''} ${String(p.file).split('/').pop()}`.trim() : p.status,
            });
          }
        },
      });
      pipelineCache.set(key, pipe);
      return pipe;
    } catch (err) {
      errors.push(`${attempt.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `模型 ${model} 加载失败。\n${errors.join('\n')}\n` +
      `可能原因：网络无法访问 huggingface.co / CDN；或模型名拼写有误；或设备不支持所选后端（可在设置里切换为 WASM）。`,
  );
}

/** 提取文字：去掉 Whisper 的特殊标记与纯标点块 */
function cleanText(text: string): string {
  return (text || '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeaningful(text: string): boolean {
  if (!text) return false;
  // 去掉常见语气/标点后还有没有实际字符
  return /[\p{L}\p{N}]/u.test(text);
}

/** 归一化 pipeline 输出 */
function normalizeOutput(out: any): RawSegment[] {
  const list: any[] = Array.isArray(out) ? out : [out];
  const segments: RawSegment[] = [];
  for (const item of list) {
    if (!item) continue;
    if (Array.isArray(item.chunks) && item.chunks.length > 0) {
      for (const c of item.chunks) {
        segments.push({ text: cleanText(c.text), timestamp: c.timestamp ?? null });
      }
    } else {
      segments.push({ text: cleanText(item.text), timestamp: null });
    }
  }
  return segments;
}

/** 两段文字尾部/头部重叠去重（应对 stride 带来的边界重复） */
function overlapDedup(prev: string, next: string): string {
  const a = prev.split(' ');
  const b = next.split(' ');
  const max = Math.min(a.length, b.length, 12);
  for (let k = max; k >= 2; k--) {
    const tail = a.slice(a.length - k).join(' ').toLowerCase();
    const head = b.slice(0, k).join(' ').toLowerCase();
    if (tail === head && tail.length > 0) {
      return b.slice(k).join(' ');
    }
  }
  return next;
}

async function transcribe(msg: Extract<WorkerInMessage, { type: 'transcribe' }>) {
  const { audio, model, language, dtype, device, chunkSeconds, strideSeconds } = msg;
  const totalSeconds = audio.length / 16000;

  const pipe = await getPipeline(model, device, dtype);
  if (aborted) return;

  const callOptions: Record<string, unknown> = {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  };
  if (language && language !== 'auto') {
    callOptions.language = language;
    callOptions.task = 'transcribe';
  }

  const raw: RawSegment[] = [];
  let cursor = 0;
  let guard = 0;

  while (cursor < totalSeconds - 0.05 && !aborted) {
    guard++;
    if (guard > 2000) break; // 安全阀

    const end = Math.min(totalSeconds, cursor + chunkSeconds);
    const from = Math.max(0, Math.floor(cursor * 16000));
    const to = Math.min(audio.length, Math.ceil(end * 16000));
    const slice = audio.subarray(from, to);

    const out = await pipe(slice, callOptions);
    if (aborted) return;

    const segments = normalizeOutput(out);
    const usable = segments.filter((s) => isMeaningful(s.text));

    // 组装带上绝对时间戳的片段，并记录本片最后结束时间
    let lastEnd = end;
    let advanced = false;
    for (const s of usable) {
      const ts = s.timestamp;
      const absStart = ts && typeof ts[0] === 'number' ? ts[0] + cursor : null;
      const absEnd = ts && typeof ts[1] === 'number' ? ts[1] + cursor : null;
      if (absEnd !== null) {
        lastEnd = Math.max(lastEnd, absEnd);
        advanced = true;
      }
      const prev = raw[raw.length - 1];
      const text = prev ? overlapDedup(prev.text, s.text) : s.text;
      if (!isMeaningful(text)) continue;
      raw.push({
        text,
        timestamp: [absStart ?? cursor, absEnd],
      });
    }

    const progress = Math.min(1, end / totalSeconds);
    post({
      type: 'progress',
      stage: 'transcribe',
      value: progress,
      note: `${cursor.toFixed(0)}s / ${totalSeconds.toFixed(0)}s`,
    });

    if (advanced) {
      // 从最后一条字幕的结束时间继续，保证重叠、不丢词
      const next = Math.max(lastEnd - 0.2, cursor + strideSeconds);
      cursor = next;
    } else {
      // 本片没有可用时间戳：按固定步长推进
      cursor = end - strideSeconds;
      if (cursor <= 0) cursor = end;
    }
  }

  post({ type: 'result', segments: raw, language, duration: totalSeconds });
}

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  if (msg.type === 'abort') {
    aborted = true;
    return;
  }
  if (msg.type === 'transcribe') {
    aborted = false;
    try {
      post({ type: 'status', message: '开始语音识别…' });
      post({ type: 'progress', stage: 'transcribe', value: 0, note: '0%' });
      await transcribe(msg);
    } catch (err) {
      post({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
