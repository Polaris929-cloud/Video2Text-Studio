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
 * 可选的 transformers.js 加载源（第一个成功即用）。
 *
 * 重要：不要覆盖 env.backends.onnx.wasm.wasmPaths！
 * transformers.js 的 dist 目录里**自带** onnxruntime 的 wasm 文件，默认指向
 *   https://cdn.jsdelivr.net/npm/@huggingface/transformers@<version>/dist/
 * 一旦手动指到别的 onnxruntime 版本，就极容易因为版本号/文件名不匹配而 404，
 * 表现为"模型一直卡在 0%"（本项目就踩过：曾错指向 onnxruntime-web@1.20.1，该版本没有 .jsep.wasm）。
 */
interface EngineSource {
  url: string;
  label: string;
}

const ENGINE_SOURCES: Record<string, EngineSource> = {
  auto: { url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3', label: 'jsDelivr' },
  jsdelivr: { url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3', label: 'jsDelivr' },
  unpkg: { url: 'https://unpkg.com/@huggingface/transformers@3.3.3', label: 'unpkg' },
  esmsh: { url: 'https://esm.sh/@huggingface/transformers@3.3.3', label: 'esm.sh' },
};

let transformersModule: any = null;

/** 按引擎源设置 + 模型下载源（镜像）配置环境 */
function applyEnv(mod: any, modelHost: string) {
  try {
    mod.env.allowLocalModels = false;
    mod.env.useBrowserCache = true;
  } catch {
    /* 忽略 */
  }
  try {
    if (modelHost) {
      // 自定义镜像（例如国内常用的 https://hf-mirror.com/），必须以 / 结尾
      mod.env.remoteHost = modelHost.endsWith('/') ? modelHost : `${modelHost}/`;
    }
  } catch {
    /* 忽略 */
  }
  try {
    // 静态站点无法设置 COOP/COEP 响应头，多线程 WASM 会失败；固定单线程最稳
    mod.env.backends.onnx.wasm.numThreads = 1;
    mod.env.backends.onnx.wasm.proxy = false;
  } catch {
    /* 忽略：不同版本的字段可能不同 */
  }
  // 注意：这里刻意不设置 wasmPaths，使用 transformers.js 自带的默认值
}

/** 按指定源加载引擎（同一个源只加载一次，结果缓存复用）。 */
async function loadTransformers(source: EngineSource, modelHost: string): Promise<any> {
  if (transformersModule) return transformersModule;
  post({ type: 'status', message: `正在加载语音识别引擎（${source.label}）…` });
  const mod = await import(/* @vite-ignore */ source.url);
  applyEnv(mod, modelHost);
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

/** 字节数格式化，用于显示模型下载进度 */
function fmtMB(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** 下载停滞检测：超过 STALL_TIMEOUT 没有进度事件就报错，而不是无限等待 */
const STALL_TIMEOUT = 90_000;
let lastTick = Date.now();
let stallTimer: ReturnType<typeof setInterval> | null = null;

function tick() {
  lastTick = Date.now();
}

function withStallGuard(promise: Promise<any>, label: string): Promise<AnyFn> {
  tick();
  if (!stallTimer) {
    stallTimer = setInterval(() => {
      if (aborted) return;
      const idle = Date.now() - lastTick;
      if (idle > STALL_TIMEOUT) {
        post({
          type: 'status',
          message: `${label} 已停滞 ${Math.round(idle / 1000)} 秒没有下载进度，可能被网络拦截。若一直不动，请点「中止」并改用镜像源或更小的模型。`,
        });
      }
    }, 10_000);
  }
  return promise as Promise<AnyFn>;
}

async function getPipeline(
  model: string,
  device: string,
  dtype: string,
  engineSource: string,
  modelHost: string,
): Promise<AnyFn> {
  const key = `${model}|${device}|${dtype}`;
  const cached = pipelineCache.get(key);
  if (cached) {
    post({ type: 'status', message: '模型已就绪（本地缓存）' });
    return cached;
  }

  /*
   * 回退链：设备（WebGPU → CPU）× 精度。
   * 精度只回退一跳（所选精度 → fp32），不做全精度轮询——
   * 否则一个精度失败就会去下 1GB 的 fp32，用户会以为"卡死"。
   */
  const devices: string[] = [];
  if (device === 'webgpu') devices.push('webgpu', 'wasm');
  else if (device === 'wasm') devices.push('wasm');
  else devices.push(...(typeof (navigator as unknown as { gpu?: unknown }).gpu !== 'undefined' ? ['webgpu', 'wasm'] : ['wasm']));

  const attempts: Array<{ device: string; dtype: string; label: string }> = [];
  for (const dev of devices) {
    const order = dedupe([dtype, 'fp32']);
    for (const dt of order) {
      attempts.push({ device: dev, dtype: dt, label: `${dev === 'wasm' ? 'CPU' : 'WebGPU'}·${dt}` });
    }
  }

  const sources: EngineSource[] = [
    ENGINE_SOURCES[engineSource] ?? ENGINE_SOURCES.auto,
    ...Object.values(ENGINE_SOURCES).filter((s) => s.label !== (ENGINE_SOURCES[engineSource] ?? ENGINE_SOURCES.auto).label),
  ];

  const errors: string[] = [];
  // 外层遍历引擎源：某个 CDN 挂了/被墙时换下一个；内层遍历后端与精度
  for (const source of sources) {
    let mod: any;
    try {
      mod = await loadTransformers(source, modelHost);
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
        const pipe = await withStallGuard(
          mod.pipeline('automatic-speech-recognition', model, {
            device: attempt.device,
            dtype: attempt.dtype,
            progress_callback: (p: any) => {
              if (aborted) return;
              tick();
              if (p && typeof p.progress === 'number') {
                const pct = Math.max(0, Math.min(1, p.progress / 100));
                const loaded = typeof p.loaded === 'number' ? p.loaded : null;
                const total = typeof p.total === 'number' ? p.total : null;
                const sizeText = loaded && total ? ` ${fmtMB(loaded)}/${fmtMB(total)}` : '';
                post({
                  type: 'progress',
                  stage: 'load',
                  value: pct,
                  note: p.file ? `${String(p.file).split('/').pop()} ${Math.round(pct * 100)}%${sizeText}` : p.status,
                });
              }
            },
          }),
          `${attempt.label} · ${source.label}`,
        );
        pipelineCache.set(key, pipe);
        return pipe;
      } catch (err) {
        errors.push(`${source.label}/${attempt.label}: ${err instanceof Error ? err.message : String(err)}`);
        if (aborted) return Promise.reject(new Error('已取消'));
      }
    }
  }

  throw new Error(
    `模型 ${model} 加载失败。\n${errors.join('\n')}\n` +
      `可能原因：\n` +
      `  1. 网络访问不到模型源（默认 huggingface.co）—— 可在「识别设置」里把「模型下载源」改成镜像站，例如 https://hf-mirror.com/；\n` +
      `  2. 该模型仓库里没有所选精度（q8/fp16）的权重，请改用 fp32 或换一个小模型；\n` +
      `  3. 引擎 CDN 被拦截 —— 可在设置里切换引擎源。`,
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
  const { audio, model, language, dtype, device, chunkSeconds, strideSeconds, engineSource, modelHost } = msg;
  const totalSeconds = audio.length / 16000;

  const pipe = await getPipeline(model, device, dtype, engineSource, modelHost);
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
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
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
    } finally {
      if (stallTimer) {
        clearInterval(stallTimer);
        stallTimer = null;
      }
    }
  }
};
