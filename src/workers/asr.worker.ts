/**
 * Whisper 语音识别 Worker。
 *
 * 设计要点：
 *  1. 模型在**浏览器本地**运行（transformers.js + onnxruntime-web，WebGPU 优先，回退 WASM）。
 *  2. Whisper 的单次输入窗口是 30 秒，因此长视频必须切片。这里采用「带重叠的滑窗」：
 *     每片处理 chunkSeconds 秒，下一片从「本片最后一条字幕的结束时间」开始，
 *     既不会在切片边界丢词，也不会整段重复。
 *  3. 时间戳统一换算成「整段音频的绝对时间」，方便直接生成 SRT/VTT。
 *
 * ★ 模型下载为什么必须"探测 + 超时 + 换源"（本项目踩过的坑）：
 *   - huggingface.co 在国内会被彻底阻断：TCP 连不上，浏览器连第一个字节都收不到。
 *     而 transformers.js 内部用的是原生 fetch，**没有任何超时**，
 *     于是 progress_callback 一次都不会触发 → 界面永远停在「0%」，
 *     用户看到的就是"一直卡在模型准备 / 语音识别，没有任何进度"。
 *   - hf-mirror.net / aifasthub.com 这类镜像虽然能连，但它们返回的响应头是
 *     `Access-Control-Allow-Origin: https://huggingface.co`，
 *     第三方站点在浏览器里跨域 fetch 会被 CORS 直接拦截，同样拿不到模型。
 *   - 所以这里的做法是：
 *       ① 先「探测」候选来源（只取 config.json 与目标精度的 onnx 头部几个字节），
 *          并行探测、按优先级取第一个可用的，并记录该来源实际提供哪些精度；
 *       ② 所有模型请求都挂在自带的 AbortController 上，配有
 *          「首字节超时 / 下载停滞超时 / 编译超时」，任何阶段没动静就立刻中止并换源换精度，
 *          绝不无限等待；
 *       ③ 每秒推送一次心跳进度（含已用时长、当前文件、已下载字节），进度条始终在动；
 *       ④ 首选来源是「本站同源」（模型与站点一起部署，无 CORS、不被墙、可离线）。
 *
 * ★ 语言为什么必须"自己检测"（本项目踩过的第二个坑）：
 *   transformers.js 3.x 的 ASR pipeline **没有实现语言自动检测**，
 *   源码里就是 `// TODO: Implement language detection` + `language = 'en'`。
 *   也就是说：只要不显式传 language，**所有音频都会被当成英语解码**。
 *   中文/日文/韩文音频被按英语解码时，Whisper 不会报错，而是开始"编造"——
 *   输出 `[Spanish]`、`(Speaking in Japanese)`，或者一小段外文短语无限重复。
 *   用户看到的就是"明明是中文视频，却识别出一堆看不懂的重复文本"。
 *
 *   这里的做法：
 *       ① 用户显式选了语言 → 直接用（并校验该模型是否支持该语言）；
 *       ② 选「自动检测」→ 自己实现检测：取音频里最"响"的 30 秒，
 *          跑一次编码器 + 解码器首步，看语言 token 的概率分布（约 1 秒）；
 *       ③ 检测失败 → 按浏览器语言兜底（而不是默认英语）；
 *       ④ 识别结果再做一遍幻觉过滤（标记型 / 循环型 / 相邻重复 / 全片重复），
 *          静音分片直接跳过，避免在没人说话的地方产出垃圾字幕。
 */

import type { LanguageSource, RawSegment, WorkerInMessage, WorkerOutMessage } from '../types';
import {
  buildDeviceChain,
  buildDtypeChain,
  buildSourceChain,
  modelFileUrl,
  pathTemplateFor,
  type ModelSourceSpec,
} from '../lib/modelSources';
import { analyzeLevel, isQuietChunk } from '../lib/audio';
import { filterChunkSegments, findGloballyRepeating } from '../lib/hallucination';
import { detectLanguage } from '../lib/langDetect';
import {
  UI_LANGUAGE,
  guessLanguageFromNavigator,
  isSupportedByModel,
  languageLabel,
  whisperCodeOf,
} from '../lib/whisperLang';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

const post = (msg: WorkerOutMessage) => (self as unknown as Worker).postMessage(msg);

let aborted = false;
/** 已加载模型缓存：key = `${model}|${device}|${dtype}|${sourceBase}` */
const pipelineCache = new Map<string, AnyFn>();

/* =========================================================================
 * 一、超时与看门狗：这是"永不卡死"的核心
 * ========================================================================= */

/** 探测单个来源是否可用（小文件 / 只取头部字节） */
const PROBE_TIMEOUT = 8_000;
/** 请求发出后多久收不到任何进度事件 → 判定不可达，换源 */
const FIRST_BYTE_TIMEOUT = 20_000;
/** 下载途中多久没有新数据 → 判定停滞，换源 */
const STALL_TIMEOUT = 45_000;
/** 文件下载完之后的「编译 / 初始化推理引擎」阶段允许更长的静默 */
const COMPILE_TIMEOUT = 180_000;
/** 静默超过这个时间就主动向用户解释"可能正在做什么" */
const IDLE_HINT = 15_000;
/** 引擎脚本自身的加载超时（CDN 也可能被墙） */
const ENGINE_LOAD_TIMEOUT = 25_000;
/**
 * 来源探测的总预算。
 * 为什么需要它：如果首选来源（例如被墙的 huggingface.co）要等到自己的超时才失败，
 * 启动就会被拖慢几十秒。这里给"等首选"设一个上限，超了就先拿已知可用的来源开工。
 */
const PROBE_BUDGET = 20_000;

/** 定时 resolve 的辅助函数，用于给 Promise.race 加"预算上限" */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * WebGPU 是否真的能用。
 *
 * 只看 `'gpu' in navigator` 是不够的：很多环境（无头浏览器、禁用 GPU 的浏览器、
 * 老显卡、远程桌面）里 navigator.gpu 存在但 requestAdapter() 返回 null。
 * 这时如果还先试 WebGPU，就会白白下载一遍模型再报 "Failed to get GPU adapter"，
 * 用户看到的就是"又卡又失败"。所以这里真去请求一次适配器，拿不到就直接走 CPU。
 */
async function hasUsableWebGpu(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
  try {
    const adapter = await Promise.race([gpu.requestAdapter(), delay(3_000).then(() => undefined)]);
    return Boolean(adapter);
  } catch {
    return false;
  }
}

let guardController: AbortController | null = null;
let guardPrefixes: string[] = [];
let fetchPatched = false;

/**
 * 给「模型文件的请求」装上刹车。
 *
 * transformers.js 内部直接调用全局 fetch，不暴露取消/超时的入口，
 * 所以我们替换 worker 作用域内的 fetch：只给模型来源地址的请求注入 signal，
 * 其余请求原样放行。
 */
function ensureFetchGuard(): void {
  if (fetchPatched) return;
  fetchPatched = true;

  const original = self.fetch.bind(self) as typeof fetch;

  const patched: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = guardController;
    if (!controller || controller.signal.aborted) return original(input, init);

    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : ((input as Request)?.url ?? '');
    if (!url || !guardPrefixes.some((prefix) => url.startsWith(prefix))) return original(input, init);

    if (typeof input === 'string' || input instanceof URL) {
      const next: RequestInit = { ...(init ?? {}) };
      next.signal = mergeSignals(next.signal, controller.signal);
      return original(input, next);
    }
    // Request 对象：必须重建才能带上 signal
    return original(
      new Request(input as Request, { signal: mergeSignals((input as Request).signal, controller.signal) }),
      init,
    );
  };

  (self as unknown as { fetch: typeof fetch }).fetch = patched;
}

function mergeSignals(a: AbortSignal | null | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return typeof anyFn === 'function' ? anyFn([a, b]) : b;
}

function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort(new DOMException('timeout', 'TimeoutError'));
    } catch {
      controller.abort();
    }
  }, ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

/** 把各种报错翻译成用户能看懂的短句 */
function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/Failed to fetch|NetworkError|Load failed|network error/i.test(raw)) return '网络不可达，或被浏览器 CORS 策略拦截';
  if (/timeout|timed out|TimeoutError/i.test(raw)) return '连接超时';
  if (/abort/i.test(raw)) return '等待超时（已自动中止）';
  if (/404/.test(raw)) return '该模型/精度不存在（404）';
  if (/401|403/.test(raw)) return '没有访问权限（401/403）';
  return raw.slice(0, 200) || '未知错误';
}

/* =========================================================================
 * 二、来源探测（含精度探测）与引擎加载
 * ========================================================================= */

/** dtype → onnx 文件名后缀（与 transformers.js 的约定一致） */
const DTYPE_SUFFIX: Record<string, string> = {
  fp32: '',
  fp16: '_fp16',
  q8: '_quantized',
  int8: '_int8',
  uint8: '_uint8',
  q4: '_q4',
  bnb4: '_bnb4',
};

function onnxFileFor(dtype: string): string {
  const suffix = DTYPE_SUFFIX[dtype] ?? DTYPE_SUFFIX.q8;
  return `onnx/encoder_model${suffix}.onnx`;
}

interface ProbeResult {
  source: ModelSourceSpec;
  ok: boolean;
  reason: string;
  /** 实际存在的精度集合（只探测了我们关心的那几个） */
  available: Set<string>;
  ms: number;
}

/** 只读第一个字节，用来判断"这个精度的权重文件是否存在"，不会把整包拉下来 */
async function probeOnnx(url: string): Promise<string> {
  const { signal, cancel } = timeoutSignal(PROBE_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal,
      cache: 'no-store',
      credentials: 'omit',
      headers: { Range: 'bytes=0-0' },
    });
    // 不管成功与否，立刻掐掉响应体，避免服务器忽略 Range 时白下几十 MB
    try {
      await res.body?.cancel();
    } catch {
      /* 忽略 */
    }
    return res.ok ? 'ok' : `HTTP ${res.status}`;
  } catch (err) {
    return describeError(err);
  } finally {
    cancel();
  }
}

async function probeSource(source: ModelSourceSpec, model: string, dtypes: string[]): Promise<ProbeResult> {
  const started = Date.now();
  const cfg = modelFileUrl(source, model, 'config.json');
  const { signal, cancel } = timeoutSignal(PROBE_TIMEOUT);
  try {
    const res = await fetch(cfg, { signal, cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return { source, ok: false, reason: `HTTP ${res.status}`, available: new Set(), ms: Date.now() - started };
    const text = await res.text();
    if (!text.trimStart().startsWith('{')) {
      return {
        source,
        ok: false,
        reason: '返回的不是模型配置（可能被网关或登录页拦截）',
        available: new Set(),
        ms: Date.now() - started,
      };
    }
  } catch (err) {
    return { source, ok: false, reason: describeError(err), available: new Set(), ms: Date.now() - started };
  } finally {
    cancel();
  }

  const available = new Set<string>();
  /**
   * 精度探测的取巧之处：**主精度可用就立刻返回，其余精度继续在后台探**。
   *
   * 如果这里 await 所有精度（q8 + fp32），一旦某个精度在该来源上不存在
   * （例如 ModelScope 上没有 fp32 权重），就要白等到 PROBE_TIMEOUT 才继续 ——
   * 实测每次启动多花 8 秒。`available` 是同一个 Set 引用，后台探完会自行补进去。
   */
  const pending = dtypes.map(async (dt) => {
    const result = await probeOnnx(modelFileUrl(source, model, onnxFileFor(dt)));
    if (result === 'ok') available.add(dt);
    return result === 'ok';
  });

  const primaryOk = await pending[0];
  if (!primaryOk) await Promise.all(pending); // 主精度不行，才需要等其他精度

  if (available.size === 0) {
    return { source, ok: false, reason: '缺少可用的 onnx 权重文件（该模型/精度没有上传）', available, ms: Date.now() - started };
  }
  return { source, ok: true, reason: '可用', available, ms: Date.now() - started };
}

/** 可选的 transformers.js 加载源（第一个成功的即用） */
interface EngineSource {
  url: string;
  label: string;
}

/**
 * 注意：**不要覆盖** env.backends.onnx.wasm.wasmPaths！
 * transformers.js 的 dist 目录里自带 onnxruntime 的 wasm，
 * 默认指向 https://cdn.jsdelivr.net/npm/@huggingface/transformers@<version>/dist/，
 * 一旦手动指到别的 onnxruntime 版本，就会因版本/文件名不匹配而 404。
 * （本项目曾错指向 onnxruntime-web@1.20.1，该版本没有 .jsep.wasm，同样表现为"卡在 0%"）
 */
const ENGINE_SOURCES: Record<string, EngineSource> = {
  auto: { url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3', label: 'jsDelivr' },
  jsdelivr: { url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3', label: 'jsDelivr' },
  unpkg: { url: 'https://unpkg.com/@huggingface/transformers@3.3.3', label: 'unpkg' },
  esmsh: { url: 'https://esm.sh/@huggingface/transformers@3.3.3', label: 'esm.sh' },
};

let transformersModule: any = null;

function applyEnv(mod: any, source: ModelSourceSpec): void {
  try {
    mod.env.allowRemoteModels = true;
    mod.env.allowLocalModels = false;
    mod.env.useBrowserCache = true;
    // remoteHost 必须以 / 结尾；配合下面的模板拼出完整地址
    mod.env.remoteHost = source.base;
    mod.env.remotePathTemplate = pathTemplateFor(source);
  } catch {
    /* 忽略：不同版本的字段可能不同 */
  }
  try {
    // 静态站点无法设置 COOP/COEP 响应头，多线程 WASM 会失败；固定单线程最稳
    mod.env.backends.onnx.wasm.numThreads = 1;
    mod.env.backends.onnx.wasm.proxy = false;
  } catch {
    /* 忽略 */
  }
}

async function loadTransformers(source: EngineSource, modelSource: ModelSourceSpec): Promise<any> {
  if (transformersModule) return transformersModule;

  post({ type: 'status', message: `正在加载语音识别引擎（${source.label}）…` });
  const mod = await Promise.race([
    import(/* @vite-ignore */ source.url),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${source.label} 加载超时`)), ENGINE_LOAD_TIMEOUT),
    ),
  ]);

  applyEnv(mod, modelSource);
  transformersModule = mod as any;
  return transformersModule;
}

/* =========================================================================
 * 三、单次加载尝试：看门狗 + 心跳进度
 * ========================================================================= */

function fmtMB(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0MB';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** 速率显示要保留一位小数，"3.8MB/s" 才有意义 */
function fmtRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  const mb = bytesPerSecond / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)}MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))}KB/s`;
}

function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `剩余约 ${Math.round(seconds)} 秒`;
  return `剩余约 ${Math.ceil(seconds / 60)} 分钟`;
}

/** 把技术文件名换成用户看得懂的说法 */
function prettyFile(name: string): string {
  if (/^encoder.*\.onnx$/i.test(name)) return '编码器';
  if (/^decoder.*\.onnx$/i.test(name)) return '解码器';
  if (/^tokenizer.*|^vocab\.json$|^merges\.txt$|^added_tokens\.json$/i.test(name)) return '分词器';
  if (/config\.json$/i.test(name)) return '模型配置';
  return name;
}

/** 加载一次模型。任何阶段"没动静"都会主动中止并抛出可读的错误，由上层决定换源还是换精度。 */
async function attemptPipeline(model: string, source: ModelSourceSpec, device: string, dtype: string): Promise<AnyFn> {
  ensureFetchGuard();

  const controller = new AbortController();
  guardController = controller;
  guardPrefixes = [source.base];

  const label = `${device === 'wasm' ? 'CPU' : 'WebGPU'}·${dtype}`;
  const files = new Map<string, { loaded: number; total: number; pct: number }>();
  let phase: 'first' | 'download' | 'compile' = 'first';
  let idleLimit = FIRST_BYTE_TIMEOUT;
  let lastEvent = Date.now();
  let stalled: string | null = null;
  let hintPosted = false;
  let maxOverall = 0;
  const startedAt = Date.now();

  const totals = (): { loaded: number; total: number } => {
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    return { loaded, total };
  };

  const overall = (): number => {
    const { loaded, total } = totals();
    const raw =
      total > 0
        ? Math.max(0, Math.min(0.99, loaded / total))
        : files.size > 0
          ? Math.max(0, Math.min(0.99, [...files.values()].reduce((s, f) => s + f.pct, 0) / files.size))
          : 0;
    // 只增不减：模型是按文件顺序下载的，分母会随着新文件出现而变大，
    // 直接按比例算会让进度条"倒退"，看起来像出错。这里取历史最大值。
    if (raw > maxOverall) maxOverall = raw;
    return maxOverall;
  };

  /**
   * 实时下载速率（滑动窗口 8 秒）。
   * 为什么要做：用户看到"7% 一动不动"就会以为卡死，
   * 但实际上可能只是慢；把"3.8MB/s · 剩余 12 秒"直接摆出来，才能自己判断。
   */
  const samples: Array<{ t: number; loaded: number }> = [];
  const rate = (): number => {
    const now = Date.now();
    samples.push({ t: now, loaded: totals().loaded });
    while (samples.length > 2 && now - samples[0].t > 8_000) samples.shift();
    if (samples.length < 2) return 0;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    return dt >= 0.5 ? (last.loaded - first.loaded) / dt : 0;
  };

  /** 进度后缀：已下/总量 · 速度 · 剩余时间 */
  const rateSuffix = (): string => {
    const { loaded, total } = totals();
    if (total <= 0) return '';
    const speed = rate();
    const eta = speed > 0 && total > loaded ? (total - loaded) / speed : 0;
    return ` · ${fmtMB(loaded)}/${fmtMB(total)}${speed > 0 ? ` · ${fmtRate(speed)}` : ''}${eta > 0 ? ` · ${fmtEta(eta)}` : ''}`;
  };

  const heartbeat = (): string => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const suffix = rateSuffix();
    if (phase === 'compile') return `正在编译 / 初始化推理引擎… 已用 ${elapsed}s`;
    if (phase === 'first') return `正在连接 ${source.label}… 已用 ${elapsed}s`;
    return `正在下载模型… 已用 ${elapsed}s${suffix}`;
  };

  const onProgress = (p: any) => {
    if (aborted) return;
    lastEvent = Date.now();
    hintPosted = false;

    const rawName = p?.file ? String(p.file) : '';
    const name = rawName ? rawName.split('/').pop() || rawName : '';
    const loaded = Number(p?.loaded) || 0;
    const total = Number(p?.total) || 0;
    const reported = typeof p?.progress === 'number' ? p.progress / 100 : total > 0 ? loaded / total : 0;
    const pct = Math.max(0, Math.min(1, reported));
    const sizeText = rateSuffix();

    if (name) {
      const prev = files.get(name);
      files.set(name, { loaded, total, pct: Math.max(prev?.pct ?? 0, pct) });
    }

    if (phase === 'first') {
      phase = 'download';
      idleLimit = STALL_TIMEOUT;
    }
    // 所有已见到的文件都下载完了 → 进入"编译 / 初始化推理引擎"阶段
    if (files.size > 0 && [...files.values()].every((f) => f.pct >= 1)) {
      if (phase !== 'compile') {
        phase = 'compile';
        idleLimit = COMPILE_TIMEOUT;
        post({ type: 'status', message: '模型文件已下载完成，正在编译 / 初始化推理引擎（首次较慢，请稍候）…' });
      }
    }

    post({
      type: 'progress',
      stage: 'load',
      value: overall(),
      phase,
      note: name ? `${prettyFile(name)} ${Math.round(pct * 100)}%${sizeText}` : String(p?.status ?? '下载中'),
    });
  };

  const watchdog = setInterval(() => {
    if (aborted) return;
    const idle = Date.now() - lastEvent;
    if (idle > idleLimit) {
      stalled =
        phase === 'first'
          ? `发出请求后 ${Math.round(idle / 1000)} 秒没有收到任何数据`
          : phase === 'compile'
            ? `初始化阶段 ${Math.round(idle / 1000)} 秒没有响应`
            : `下载停滞 ${Math.round(idle / 1000)} 秒`;
      try {
        controller.abort(new DOMException('stalled', 'TimeoutError'));
      } catch {
        controller.abort();
      }
      return;
    }
    // 心跳：让界面每秒都在动，永远不会出现"看起来死掉了"的进度条
    post({
      type: 'progress',
      stage: 'load',
      value: overall(),
      phase: phase === 'first' ? 'probe' : phase,
      note: `${heartbeat()}`,
    });
    if (!hintPosted && idle > IDLE_HINT) {
      hintPosted = true;
      post({
        type: 'status',
        message:
          phase === 'compile'
            ? '模型已下载，正在编译推理引擎（首次使用较慢，请勿关闭页面）…'
            : `已经 ${Math.round(idle / 1000)} 秒没有新数据，若继续无响应会自动切换到下一个来源…`,
      });
    }
  }, 1000);

  try {
    post({
      type: 'status',
      message: `正在准备模型 ${model} · ${label} · ${source.label}（首次使用需下载并缓存，请稍候）`,
    });
    return await transformersModule.pipeline('automatic-speech-recognition', model, {
      device,
      dtype,
      progress_callback: onProgress,
    });
  } catch (err) {
    throw new Error(stalled ?? describeError(err));
  } finally {
    clearInterval(watchdog);
    guardController = null;
    guardPrefixes = [];
  }
}

/* =========================================================================
 * 四、总入口：探测 → 按优先级尝试 → 给出可读的错误
 * ========================================================================= */

async function getPipeline(
  model: string,
  device: string,
  dtype: string,
  engineSource: string,
  modelSource: string,
  customModelHost: string,
  siteBase: string,
): Promise<AnyFn> {
  // 必须在 import transformers.js **之前**装好，避免它内部缓存了原始 fetch 引用
  ensureFetchGuard();

  const cacheKey = `${model}|${device}|${dtype}|${modelSource}|${customModelHost}|${siteBase}`;
  const cached = pipelineCache.get(cacheKey);
  if (cached) {
    post({ type: 'status', message: '模型已就绪（本次会话已加载过）' });
    return cached;
  }

  const sources = buildSourceChain(modelSource, customModelHost, siteBase);
  if (sources.length === 0) throw new Error('没有可用的模型来源，请检查「识别设置 → 模型来源」。');

  const dtypes = buildDtypeChain(dtype);
  const devices = buildDeviceChain(device, await hasUsableWebGpu());

  if (device === 'auto' && devices[0] === 'wasm' && typeof (navigator as unknown as { gpu?: unknown }).gpu !== 'undefined') {
    post({ type: 'status', message: '当前浏览器拿不到 WebGPU 适配器，已自动改用 CPU 推理（较慢但兼容性最好）' });
  }

  // 按优先级探测：优先等待排在前面的来源，一旦可用就开始加载；
  // 但整体等待有预算上限，避免"首选被墙 + 必须等它超时"拖慢启动。
  post({ type: 'status', message: '正在探测可用的模型来源…' });
  const probing = sources.map((source) => probeSource(source, model, dtypes));

  const ordered: ProbeResult[] = [];
  const failures = new Map<string, string>();
  const probeStarted = Date.now();
  for (let i = 0; i < probing.length; i++) {
    const remaining = PROBE_BUDGET - (Date.now() - probeStarted);
    if (remaining <= 0) break;
    const result = await Promise.race([probing[i], delay(remaining)]);
    if (result?.ok) {
      ordered.push(result);
      break; // 找到可用来源就立刻开工
    }
    if (result && !result.ok) failures.set(result.source.id, result.reason);
  }

  if (ordered.length === 0) {
    // 一个来源都没探到 → 必须收齐所有失败原因，才能给出可读的错误信息
    const settled = await Promise.all(probing);
    for (const result of settled) {
      if (result.ok) ordered.push(result);
      else failures.set(result.source.id, result.reason);
    }
  } else {
    // 已经能开工了：其余来源只用来决定"兜底顺序"，让它们自己在后台收尾，**绝不 await**。
    // 之前这里 await 了它们，结果每次启动都被连不通的 huggingface.co 拖到超时才继续，
    // 白白多等 8 秒（正好是 PROBE_TIMEOUT）。
    for (const probe of probing) {
      probe
        .then((result) => {
          if (result.ok) {
            if (!ordered.some((r) => r.source.id === result.source.id)) ordered.push(result);
          } else {
            failures.set(result.source.id, result.reason);
          }
        })
        .catch(() => undefined);
    }
  }

  if (aborted) throw new Error('已取消');
  if (ordered.length === 0) {
    const detail = sources
      .map((s) => `  · ${s.label}（${s.base}）：${failures.get(s.id) ?? '不可用'}`)
      .join('\n');
    throw new Error(
      `没有找到可用的模型来源，已逐个探测：\n${detail}\n\n` +
        `可能的原因与解决办法：\n` +
        `  1. 站点未内置该模型（本站同源缺少文件）：请改用已内置的 Tiny / Base 模型；\n` +
        `  2. huggingface.co 被墙：请开启代理后重试，或保持使用「本站同源」；\n` +
        `  3. 镜像站被浏览器 CORS 拦截：这是对方响应头的限制，不是你的网络问题，改用本站同源即可；\n` +
        `  4. 自建镜像：在「识别设置 → 模型来源」里选择「自定义地址」并填写地址。`,
    );
  }

  post({
    type: 'status',
    message: `模型来源：${ordered[0].source.label}（${ordered[0].ms} ms 内响应）`,
  });

  // 引擎源：用户指定的排第一，其余兜底（某个 CDN 被墙时自动换）
  const preferredEngine = ENGINE_SOURCES[engineSource] ?? ENGINE_SOURCES.auto;
  const engineOrder = [preferredEngine, ...Object.values(ENGINE_SOURCES).filter((e) => e.label !== preferredEngine.label)];

  const errors: string[] = [];
  for (const probe of ordered) {
    const source = probe.source;
    for (const engine of engineOrder) {
      try {
        await loadTransformers(engine, source);
      } catch (err) {
        errors.push(`引擎 ${engine.label}：${describeError(err)}`);
        continue;
      }

      for (const dev of devices) {
        for (const dt of dtypes) {
          if (aborted) throw new Error('已取消');
          if (!probe.available.has(dt)) {
            errors.push(`${source.label} / ${dt}：该来源没有 ${dt} 精度的权重`);
            continue;
          }
          if (dt !== dtype) {
            post({
              type: 'status',
              message: `「${source.label}」没有 ${dtype} 精度，自动改用 ${dt} 精度…`,
            });
          }
          try {
            const pipe = await attemptPipeline(model, source, dev, dt);
            pipelineCache.set(cacheKey, pipe);
            post({
              type: 'status',
              message: `模型已就绪（${source.label} · ${dev === 'wasm' ? 'CPU' : 'WebGPU'} · ${dt}）`,
            });
            return pipe;
          } catch (err) {
            errors.push(`${source.label} / ${dev === 'wasm' ? 'CPU' : 'WebGPU'}·${dt}：${describeError(err)}`);
            if (aborted) throw new Error('已取消');
          }
        }
      }

      // 引擎模块已经加载成功 → 换另一个 CDN 只会把同样的「设备×精度」重跑一遍
      // （报错信息完全一样，还会重复下载模型）。所以这里直接跳出，换下一个来源兜底。
      break;
    }
  }

  // 同一类错误只保留一条，避免把用户淹没在重复信息里
  const seen = new Set<string>();
  const unique = errors.filter((e) => (seen.has(e) ? false : (seen.add(e), true)));
  const gpuHint = unique.some((e) => /webgpu|GPU adapter/i.test(e))
    ? `\n  4. 浏览器拿不到 WebGPU 适配器时，可在「识别设置 → 推理设备」里手动选「CPU（WASM）」。`
    : '';

  throw new Error(
    `模型 ${model} 加载失败，已尝试以下途径：\n${unique.map((e) => `  · ${e}`).join('\n')}\n\n` +
      `建议：\n` +
      `  1. 换用体积更小的模型（Tiny）或换精度（q8）；\n` +
      `  2. 确认「模型来源」为「自动」或「本站同源」；\n` +
      `  3. 若正在使用代理，请确认代理对浏览器生效（而不是只对命令行生效）。${gpuHint}`,
  );
}

/* =========================================================================
 * 五、语音识别主体
 * ========================================================================= */

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

/* ── 实时进度：速度 / 预计剩余时间 ─────────────────────────────
 * 长视频里"卡在某个百分比"多半只是慢，不是死了。
 * 这里以固定节奏上报已处理音频时长、实时倍速与预计剩余时间，
 * 让界面能明确区分"在慢慢跑"和"真的卡住"。
 */
const PROGRESS_INTERVAL_MS = 400;
let progressStartedAt = 0;
let progressLastEmit = 0;
let completedAudioSeconds = 0;
let progressTotalSeconds = 0;
let progressNoteSuffix = '';
let resumeBaseSeconds = 0;

function startProgressClock(totalSeconds: number, resumeFrom = 0) {
  progressStartedAt = Date.now();
  progressLastEmit = 0;
  completedAudioSeconds = 0;
  progressTotalSeconds = totalSeconds;
  progressNoteSuffix = '';
  resumeBaseSeconds = resumeFrom;
}

/** 本段任务相对续跑起点已推进的音频秒数（用于算速度） */
function audioSpanSinceStart(cursor: number) {
  return Math.max(0, cursor - resumeBaseSeconds);
}

/**
 * 上报进度。force=true 时忽略节流（用于分片刚结束这种关键节点）。
 */
function emitTranscribeProgress(cursor: number, force = false) {
  const now = Date.now();
  if (!force && now - progressLastEmit < PROGRESS_INTERVAL_MS) return;
  progressLastEmit = now;

  const elapsedMs = Math.max(1, now - progressStartedAt);
  const span = audioSpanSinceStart(cursor);
  // speed：处理 1 秒音频需要多少秒（<1 表示比实时快）
  const speed = span > 0.5 ? elapsedMs / 1000 / span : undefined;
  const remaining = Math.max(0, progressTotalSeconds - cursor);
  const etaMs = speed !== undefined && remaining > 0 ? Math.round(speed * remaining * 1000) : undefined;

  const done = Math.max(completedAudioSeconds, cursor);
  post({
    type: 'progress',
    stage: 'transcribe',
    value: progressTotalSeconds > 0 ? Math.min(1, done / progressTotalSeconds) : 0,
    note: `${done.toFixed(0)}s / ${progressTotalSeconds.toFixed(0)}s${progressNoteSuffix}`,
    speed,
    etaMs,
    processedSeconds: done,
    totalSeconds: progressTotalSeconds,
  });
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
  const {
    audio,
    model,
    language,
    dtype,
    device,
    chunkSeconds,
    strideSeconds,
    engineSource,
    modelSource,
    customModelHost,
    siteBase,
    resumeFrom,
  } = msg;
  const totalSeconds = audio.length / 16000;

  // 预热（客户端用极短静音触发）：只要把模型加载好，不做任何识别
  if (totalSeconds < 1) {
    await getPipeline(model, device, dtype, engineSource, modelSource, customModelHost, siteBase);
    post({ type: 'result', segments: [], language, duration: totalSeconds });
    return;
  }

  /* ── 音轨体检 ─────────────────────────────────────────────
   * 音轨是纯静音时（视频没声音 / 解码失败），Whisper 会"自信地"编出一堆固定套路
   * 的幻觉文本（`[BLANK_AUDIO]`、某句话无限循环……）。与其让用户看到垃圾字幕，
   * 不如直接说清楚问题出在音轨上。
   */
  const level = analyzeLevel(audio);
  if (level.peak < 1e-4) {
    throw new Error(
      `提取到的音轨几乎是静音（峰值 ${level.peak.toExponential(1)}），没有可识别的声音。\n` +
        `常见原因：\n` +
        `  1. 该视频本身没有音轨，或音轨是纯静音；\n` +
        `  2. 浏览器没能解码出声音（编码不被支持）。\n` +
        `建议：用播放器确认视频确实有声音，或先把音轨导出为 WAV / MP3 再试。`,
    );
  }

  const pipe = await getPipeline(model, device, dtype, engineSource, modelSource, customModelHost, siteBase);
  if (aborted) return;

  /* ── 语言解析（本文件最关键的一步）─────────────────────────
   * transformers.js 不传 language 时**一律按英语解码**（源码里就是
   * `// TODO: Implement language detection` + 默认 'en'）。
   * 中文音频被当成英语解码时，Whisper 会开始"编造"外文句子或无限重复同一段文本，
   * 于是中文视频识别出来全是看不懂的乱码。
   *
   * 所以「自动检测」必须自己实现：用编码器 + 解码器首步取语言 token 分布（约 1 秒）。
   * 检测不出来时也绝不默认英语，而是按浏览器语言兜底。
   */
  const pipeAny = pipe as any; // getPipeline 返回的是可调用对象，内部结构按库的约定取用
  const langToId = (pipeAny?.model?.generation_config?.lang_to_id ?? {}) as Record<string, number>;
  let resolved: {
    code: string;
    label: string;
    source: LanguageSource;
    confidence?: number;
    alternates: string[];
  } | null = null;

  if (language && language !== 'auto') {
    const code = whisperCodeOf(language);
    if (code && isSupportedByModel(code, langToId)) {
      resolved = { code, label: languageLabel(code), source: 'manual', alternates: [] };
    } else {
      // 例如 whisper-tiny/base 并没有粤语（yue）—— 硬传会让模型拿到 undefined token 进而胡言乱语
      post({ type: 'status', message: `当前模型不支持「${language}」，改为自动检测语种…` });
    }
  }

  if (!resolved) {
    post({ type: 'status', message: '正在自动检测语种（前 / 中 / 后分段采样）…' });
    const detected = await detectLanguage(pipeAny, audio, transformersModule ?? {}, { isAborted: () => aborted });
    if (aborted) return;

    if (detected) {
      resolved = {
        code: detected.code,
        label: detected.label,
        source: 'auto',
        confidence: detected.confidence,
        alternates: detected.ranked
          .slice(1)
          .map((item) => item.code)
          .filter((code) => isSupportedByModel(code, langToId)),
      };
      // 多段采样有分歧时置信度天然偏低，报百分比反而让人误以为"不可靠"
      const detail =
        detected.confidence >= 0.7 ? ` · 置信度 ${Math.round(detected.confidence * 100)}%` : ' · 已综合多段采样';
      post({
        type: 'status',
        message: `自动检测语种：${detected.label}（${detected.code}）${detail}`,
      });
    } else {
      let code = guessLanguageFromNavigator();
      if (!isSupportedByModel(code, langToId)) code = 'en';
      resolved = { code, label: languageLabel(code), source: 'fallback', alternates: [] };
      post({
        type: 'status',
        message: `未能自动检测语种，暂按「${resolved.label}」识别；如不正确请在「识别设置」里手动指定`,
      });
    }
  }

  /* ── 预期语言：过滤判据的基准 ──────────────────────────────
   * 必须与「正在尝试解码的语言」分开，否则会形成自证循环：
   * 用德语解码出的德语幻觉，拿德语当判据去检验，当然条条"合法"，
   * 于是第一片就锁定德语，整片再也轮不到中文 —— 这正是"中文视频识别出
   * 满屏德语/英语乱码"的根因。
   *
   * 这里以「用户意图」为准，优先级：
   *   手动选择 > 高置信度的自动检测 > 浏览器/界面语言 > 检测结果
   * 「自信地给出错误答案」在音乐干扰下很常见，所以只有检测置信度足够高
   * 才采信它；否则退回浏览器语言（中文用户即中文）——这是唯一独立于
   * 「检测」这条链路的信息源。
   */
  const fallbackLang = (() => {
    // 界面语言（本站为中文）优先级高于浏览器语言：装英文系统看中文视频的人不少，
    // 而"在用中文界面"这个事实本身就是很强的信号。
    if (isSupportedByModel(UI_LANGUAGE, langToId)) return UI_LANGUAGE;
    const nav = guessLanguageFromNavigator();
    return isSupportedByModel(nav, langToId) ? nav : resolved.code;
  })();
  const detectedTrustworthy = resolved.source === 'auto' && (resolved.confidence ?? 0) >= 0.85;
  const expectLang =
    resolved.source === 'manual' ? resolved.code : detectedTrustworthy ? resolved.code : fallbackLang;

  if (resolved.source === 'auto' && expectLang !== resolved.code) {
    post({
      type: 'status',
      message: `检测到「${resolved.label}」，但将优先按「${languageLabel(expectLang)}」尝试（可在「识别设置」里手动指定语言）`,
    });
  }

  const buildOptions = (lang: string) => ({
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    // 显式指定语言，绝不让库退回英语默认值
    language: lang,
    task: 'transcribe',
    // transformers.js 默认不做 n-gram 重复惩罚（默认 0），这里显式打开，
    // 直接压制"同一句话无限循环"这一最常见的幻觉形态
    no_repeat_ngram_size: 3,
  });

  const raw: RawSegment[] = [];
  // 续跑：从上次中断的时间点开始，但进度条仍按"整段视频"显示
  const startAt = Math.max(0, Math.min(resumeFrom ?? 0, Math.max(0, totalSeconds - 0.1)));
  let cursor = startAt;
  let guard = 0;
  let filteredCount = 0;
  let skippedSilentChunks = 0;
  /** 一旦某个语言真正产出了内容，后续分片就沿用它，避免在错误候选上反复浪费 */
  let lockedLang: string | null = null;
  /** 中转存档：每处理若干分片上报一次，主线程落盘，中断后可续跑 */
  let chunksSinceCheckpoint = 0;
  const CHECKPOINT_EVERY_CHUNKS = 6;

  startProgressClock(totalSeconds, startAt);
  emitTranscribeProgress(cursor, true);

  while (cursor < totalSeconds - 0.05 && !aborted) {
    guard++;
    if (guard > 2000) break; // 安全阀

    const end = Math.min(totalSeconds, cursor + chunkSeconds);
    const from = Math.max(0, Math.floor(cursor * 16000));
    const to = Math.min(audio.length, Math.ceil(end * 16000));
    const slice = audio.subarray(from, to);

    // 本片开始就报一次：长视频里"分片之间"是唯一能让界面动起来的时机
    emitTranscribeProgress(cursor, true);

    // 严格前进，避免死循环
    const minStep = Math.max(0.5, Math.min(strideSeconds, chunkSeconds * 0.9));

    // 整片静音：跳过。静音是幻觉的头号诱因，识别它既费时又只会产出垃圾
    if (isQuietChunk(slice, level.rms)) {
      skippedSilentChunks++;
      let next = end - strideSeconds;
      if (!(next > cursor)) next = cursor + minStep;
      if (totalSeconds - next < Math.min(minStep, 1)) break;
      cursor = next;
      completedAudioSeconds = Math.max(completedAudioSeconds, end);
      progressNoteSuffix = ' · 静音段已跳过';
      emitTranscribeProgress(cursor, true);
      continue;
    }

    /*
     * 候选语言池。
     *
     * 为什么要多候选：背景音乐会"自信地"给出完全错误的语言检测结果。
     *
     * 但**必须控制代价**：每多试一个候选，就是把同一段音频完整重新推理一遍，
     * 长视频下这是数倍的耗时。所以这里的策略是：
     *   1. 用户手动指定了语言 → 只跑这一个。用户已经拍板，反复试探纯属浪费
     *      （而且手动指定时 expectLang === resolved.code，不会触发幻觉循环，
     *       不需要"换个语言捞出内容"那套兜底）；
     *   2. 一旦某个语言产出过内容（lockedLang）→ 后续只用它。
     *      它已经证明能解码这段音频，再试别的只会白烧时间；
     *   3. 只有在"语言尚未确定"时，才依次尝试 主选 → 备选。
     */
    const manualLanguage = resolved.source === 'manual';
    let tryOrder: string[];
    if (manualLanguage) {
      tryOrder = [resolved.code];
    } else if (lockedLang) {
      tryOrder = [lockedLang];
    } else {
      tryOrder = [resolved.code, ...resolved.alternates.slice(0, 2)].filter(
        (code, index, arr) => arr.indexOf(code) === index,
      );
    }

    let usable: RawSegment[] = [];
    let droppedHere = 0;
    for (const lang of tryOrder) {
      const out = await pipe(slice, buildOptions(lang));
      if (aborted) return;
      const outcome = filterChunkSegments(
        normalizeOutput(out).filter((item) => isMeaningful(item.text)),
        raw[raw.length - 1]?.text,
        // ⚠ 判据固定用 expectLang，绝不能传 lang！
        // 传 lang 会让"用某语言解出的该语言幻觉"自我证明为合法内容，
        // 从而在第一片就锁定错误语言，中文再也没有机会被尝试。
        { language: expectLang },
      );
      usable = outcome.kept;
      droppedHere = outcome.dropped.length;
      if (usable.length > 0) {
        lockedLang = lang; // 认准这个语言，后面不再试别的
        break;
      }
    }

    // 兜底：所有候选都被「预期语言一致性」拦空，说明预期语言本身可能不对
    // （典型的：中文界面下用户在识别英文视频）。仅在整片第一片这么做——
    // 放弃语言判据，只拦跨语系乱码与循环重复，避免一次错误的语言判断
    // 让用户拿到一个彻头彻尾的空结果。
    // 手动指定语言时**不做**这层兜底：用户已经明确选定了语言，
    // 就不该背着他把整片换成别的语言重跑（长视频下这一下就是成倍耗时）。
    if (usable.length === 0 && droppedHere > 0 && cursor === 0 && !manualLanguage) {
      for (const lang of tryOrder) {
        const out = await pipe(slice, buildOptions(lang));
        if (aborted) return;
        const outcome = filterChunkSegments(
          normalizeOutput(out).filter((item) => isMeaningful(item.text)),
          undefined,
          // 不传 language：只启用于语言无关的判据
        );
        usable = outcome.kept;
        droppedHere += outcome.dropped.length;
        if (usable.length > 0) {
          lockedLang = lang;
          break;
        }
      }
    }
    filteredCount += droppedHere;

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

    completedAudioSeconds = Math.max(completedAudioSeconds, end);
    progressNoteSuffix = '';
    emitTranscribeProgress(cursor, true);

    // 计算下一个切片起点。无论走哪条分支，都必须严格前进，否则会死循环。
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
    if (totalSeconds - next < Math.min(minStep, 1)) {
      cursor = totalSeconds; // 视为跑完，进度条要走到 100%
      break;
    }
    cursor = next;

    // 定期存档：中断/刷新后可以从中断处续跑，长视频不必从零重来
    chunksSinceCheckpoint++;
    if (chunksSinceCheckpoint >= CHECKPOINT_EVERY_CHUNKS) {
      chunksSinceCheckpoint = 0;
      post({
        type: 'checkpoint',
        segments: raw,
        cursor,
        duration: totalSeconds,
        language: lockedLang ?? undefined,
      });
    }
  }

  // 全片兜底：同一句话一字不差出现 4 次以上，基本只可能是幻觉循环（真实语音不会这样）
  const repeats = findGloballyRepeating(raw);
  const segments = repeats.size > 0 ? raw.filter((_, index) => !repeats.has(index)) : raw;
  if (repeats.size > 0) filteredCount += repeats.size;

  // 最终语言以"真正产出字幕的那个"为准：
  // 若检测被背景音乐带偏、而实际是用备选语言救回来的，就得如实报告，
  // 否则界面会显示"波兰语"却输出中文字幕，用户只会更困惑。
  const finalCode = lockedLang ?? resolved.code;
  const switched = lockedLang !== null && lockedLang !== resolved.code;

  post({
    type: 'result',
    segments,
    language: finalCode,
    languageLabel: languageLabel(finalCode),
    languageSource: switched ? 'auto' : resolved.source,
    languageConfidence: switched ? undefined : resolved.confidence,
    filtered: filteredCount,
    skippedSilentChunks,
    duration: totalSeconds,
  });
}

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  if (msg.type === 'abort') {
    aborted = true;
    guardController?.abort();
    guardController = null;
    return;
  }
  if (msg.type === 'transcribe') {
    aborted = false;
    try {
      post({ type: 'status', message: '开始语音识别…' });
      if (msg.resumeFrom && msg.resumeFrom > 0) {
        post({
          type: 'status',
          message: `从中断处继续：已跳过前 ${Math.round(msg.resumeFrom)} 秒，不需要重新识别`,
        });
      }
      post({ type: 'progress', stage: 'transcribe', value: 0, note: '0%' });
      await transcribe(msg);
    } catch (err) {
      post({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      guardController = null;
      guardPrefixes = [];
    }
  }
};
