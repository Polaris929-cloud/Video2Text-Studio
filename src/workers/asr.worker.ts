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

/**
 * 依次尝试的 transformers.js 加载地址（第一个成功即用）。
 * wasmPaths 必须与各自的 CDN 目录结构匹配——不能用正则从 transformers 的地址推导，
 * 因为 esm.sh / unpkg 的路径规则与 jsDelivr 完全不同。
 */
interface EngineSource {
  url: string;
  wasmPaths: string;
  label: string;
}

const TRANSFORMERS_SOURCES: EngineSource[] = [
  {
    // 国内可直连、路径规则的 npm CDN
    url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3',
    wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/',
    label: 'jsDelivr',
  },
  {
    url: 'https://esm.sh/@huggingface/transformers@3.3.3',
    wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/',
    label: 'esm.sh',
  },
  {
    url: 'https://unpkg.com/@huggingface/transformers@3.3.3',
    wasmPaths: 'https://unpkg.com/onnxruntime-web@1.20.1/dist/',
    label: 'unpkg',
  },
];

let transformersModule: any = null;

function applyEnv(mod: any, source: EngineSource) {
  try {
    mod.env.allowLocalModels = false;
    mod.env.useBrowserCache = true;
    mod.env.backends.onnx.wasm.wasmPaths = source.wasmPaths;
    // 静态站点无法设置 COOP/COEP 响应头，多线程 WASM 会失败；固定单线程最稳
    mod.env.backends.onnx.wasm.numThreads = 1;
    mod.env.backends.onnx.wasm.proxy = false;
  } catch {
    /* 忽略：不同版本的字段可能不同 */
  }
}

/** 按指定源加载引擎（同一个源只加载一次，结果缓存复用）。 */
async function loadTransformers(source: EngineSource): Promise<any> {
  if (transformersModule) return transformersModule;
  post({ type: 'status', message: `正在加载语音识别引擎（${source.label}）…` });
  const mod = await import(/* @vite-ignore */ source.url);
  applyEnv(mod, source);
  transformersModule = mod;
  return mod;
}

/** 去重并保持顺序 */
function dedupe(list: string[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
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

  /*
   * 回退链：外层 CDN 源 × 内层（设备 + 精度）。
   * 精度回退很关键——某些模型的仓库里并没有 q8 量化权重，
   * 只有 fp16/fp32；写死一个精度会让用户直接卡在"加载失败"。
   */
  const devices: string[] = [];
  if (device === 'webgpu') devices.push('webgpu', 'wasm');
  else if (device === 'wasm') devices.push('wasm');
  else devices.push(...(typeof (navigator as unknown as { gpu?: unknown }).gpu !== 'undefined' ? ['webgpu', 'wasm'] : ['wasm']));

  const attempts: Array<{ device: string; dtype: string; label: string }> = [];
  const seen = new Set<string>();
  for (const dev of devices) {
    // 用户选的精度优先，其余按"体积从小到大"依次兜底
    const order = dedupe([dtype, ...(dev === 'wasm' ? ['q8', 'q4', 'fp32'] : ['q8', 'fp16', 'q4', 'fp32'])]);
    for (const dt of order) {
      const key = `${dev}|${dt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attempts.push({ device: dev, dtype: dt, label: `${dev === 'wasm' ? 'CPU' : 'WebGPU'}·${dt}` });
    }
  }

  const errors: string[] = [];
  // 外层遍历引擎源：某个 CDN 挂了/被墙时换下一个；内层遍历后端与精度
  for (const source of TRANSFORMERS_SOURCES) {
    let mod: any;
    try {
      mod = await loadTransformers(source);
    } catch (err) {
      errors.push(`引擎(${source.label}): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const attempt of attempts) {
      try {
        post({
          type: 'status',
          message: `正在准备模型 ${model} · ${attempt.label} · ${source.label}（首次使用需下载，请稍候）`,
        });
        const pipe = await mod.pipeline('automatic-speech-recognition', model, {
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
        errors.push(`${source.label}/${attempt.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
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
    // 显式指定语言可跳过模型的语言探测，更快也更准。
    // 'auto' 时这里什么都不传——transformers.js 会自动检测语言。
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

    // 计算下一个切片起点。无论走哪条分支，都必须严格前进，否则会死循环。
    const minStep = Math.max(0.5, Math.min(strideSeconds, chunkSeconds * 0.9));
    let next: number;
    if (advanced) {
      // 从最后一条字幕的结束时间继续：保留重叠、不丢词
      next = Math.max(lastEnd - 0.2, cursor + minStep);
    } else {
      // 本片没有可用时间戳：按固定步长推进
      next = end - strideSeconds;
    }
    if (!(next > cursor)) next = cursor + minStep;
    // 距离末尾不足一个最小步长时直接收尾，避免最后反复扫同一小段
    if (totalSeconds - next < Math.min(minStep, 1)) break;
    cursor = next;
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
