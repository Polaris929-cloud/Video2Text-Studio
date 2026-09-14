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
 */

import type { RawSegment, WorkerInMessage, WorkerOutMessage } from '../types';
import {
  buildDeviceChain,
  buildDtypeChain,
  buildSourceChain,
  modelFileUrl,
  pathTemplateFor,
  type ModelSourceSpec,
} from '../lib/modelSources';

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
  await Promise.all(
    dtypes.map(async (dt) => {
      const result = await probeOnnx(modelFileUrl(source, model, onnxFileFor(dt)));
      if (result === 'ok') available.add(dt);
    }),
  );

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
  const startedAt = Date.now();

  const overall = (): number => {
    let loaded = 0;
    let total = 0;
    let pctSum = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
      pctSum += f.pct;
    }
    const value = total > 0 ? loaded / total : files.size > 0 ? pctSum / files.size : 0;
    return Math.max(0, Math.min(0.99, value));
  };

  const heartbeat = (): string => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (phase === 'compile') return `正在编译 / 初始化推理引擎… 已用 ${elapsed}s`;
    if (phase === 'first') return `正在连接 ${source.label}… 已用 ${elapsed}s`;
    return `正在下载模型… 已用 ${elapsed}s`;
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
    const sizeText = total > 0 ? ` · ${fmtMB(loaded)}/${fmtMB(total)}` : '';

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
      note: name ? `${name} ${Math.round(pct * 100)}%${sizeText}` : String(p?.status ?? '下载中'),
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
    post({ type: 'progress', stage: 'load', value: overall(), note: `${heartbeat()}` });
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
    const result = remaining > 0 ? await Promise.race([probing[i], delay(remaining)]) : null;
    if (result?.ok) {
      ordered.push(result);
      break; // 找到可用来源就立刻开工，后面的探测结果只用于兜底
    }
    if (result && !result.ok) failures.set(result.source.id, result.reason);
    if (remaining <= 0) break;
  }
  // 其余探测继续在后台完成，作为兜底顺序
  for (const probe of probing) {
    const result = await probe;
    if (result.ok && !ordered.some((r) => r.source.id === result.source.id)) ordered.push(result);
    else if (!result.ok) failures.set(result.source.id, result.reason);
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
  } = msg;
  const totalSeconds = audio.length / 16000;

  const pipe = await getPipeline(model, device, dtype, engineSource, modelSource, customModelHost, siteBase);
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
    guardController?.abort();
    guardController = null;
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
      guardController = null;
      guardPrefixes = [];
    }
  }
};
