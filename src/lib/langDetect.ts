/**
 * Whisper 语种自动检测（自己实现，因为 transformers.js 没做）。
 *
 * 原理与官方 Python 版 `WhisperForConditionalGeneration.detect_language` 一致：
 *   1. 取 30 秒音频 → 特征 → 编码器；
 *   2. 只用 `<|startoftranscript|>` 作为解码器首步输入跑一次，
 *      取最后一位 logits 在「语言 token」上的分布；
 *   3. 概率最高的语言即为检测结果。
 *
 * 代价很小：以 whisper-tiny 为例，编码器约 1.1 秒 + 解码器 0.1 秒（CPU）。
 * 换来的是「中文视频不会再被当成英语解码」——这是幻觉文本的根因。
 *
 * 实现细节依赖 transformers.js 的内部结构（`model.sessions` / `addPastKeyValues`），
 * 全部包了 try/catch：拿不到就返回 null，由调用方回退，绝不让识别流程挂掉。
 */

import { analyzeLevel, pickDetectionWindows, TARGET_SAMPLE_RATE } from './audio';
import { languageLabel, type LangPrediction } from './whisperLang';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyPipe = any;
type TensorCtor = new (type: string, data: any, dims: number[]) => any;

export interface DetectOptions {
  /** 窗口里至少要有这么多秒的有效声音才值得检测（默认 0.8 秒） */
  minVoicedSeconds?: number;
  /** 用户点了「中止」时提前退出 */
  isAborted?: () => boolean;
  /**
   * 取样窗口数（把音频按前/中/后分段，各取一个窗口），默认 3。
   * 窗口越多越能抵抗"背景音乐比人声更响"的干扰，代价是多跑几次编码器。
   */
  windowCount?: number;
}

/** 库的 Tensor 与 onnxruntime 原生 tensor 都能直接喂给 session.run，这里统一一下 */
function toOrt(value: any): any {
  return value?.ort_tensor ?? value;
}

/**
 * 对单个 30 秒窗口做一次检测（编码器一次前向 + 解码器首步）。
 * 失败（不支持的环境 / 模型结构变化）返回 null。
 */
async function detectOnce(
  pipe: AnyPipe,
  window: Float32Array,
  mod: { Tensor?: TensorCtor },
  options: DetectOptions = {},
): Promise<LangPrediction | null> {
  try {
    const model = pipe?.model;
    const sessions = model?.sessions;
    const genConfig = model?.generation_config ?? {};
    const langToId: Record<string, number> = genConfig.lang_to_id ?? {};
    const entries = Object.entries(langToId);
    const Tensor = mod?.Tensor;

    if (!sessions?.model || !sessions?.decoder_model_merged || entries.length === 0 || !Tensor) {
      return null;
    }

    // 1) 判断这个窗口里到底有没有人声（整段是音乐/静音时不值得检测）
    const level = analyzeLevel(window, TARGET_SAMPLE_RATE);
    if (level.voicedSeconds < (options.minVoicedSeconds ?? 0.8)) return null;
    if (options.isAborted?.()) return null;

    // 2) 编码器
    const features = await pipe.processor(window);
    const inputFeatures = features?.input_features;
    if (!inputFeatures) return null;

    const encoded = await sessions.model.run({ input_features: toOrt(inputFeatures) });
    const hidden = encoded?.last_hidden_state ?? encoded?.[Object.keys(encoded)[0]];
    if (!hidden) return null;

    if (options.isAborted?.()) return null;

    // 3) 解码器首步：只喂 <|startoftranscript|>，取语言 token 的分布
    const feeds: Record<string, any> = {};
    if (typeof model.addPastKeyValues === 'function') {
      try {
        // 用库自己的方法造出"空 KV 缓存"（融合解码器会强制要求这些输入）
        model.addPastKeyValues(feeds, null);
      } catch {
        /* 忽略：下面的 inputNames 过滤会兜住 */
      }
    }

    const startToken = genConfig.decoder_start_token_id ?? model?.config?.decoder_start_token_id ?? 50258;
    const inputs: Record<string, any> = {
      ...feeds,
      encoder_hidden_states: toOrt(hidden),
      input_ids: toOrt(new Tensor('int64', BigInt64Array.from([BigInt(startToken)]), [1, 1])),
      use_cache_branch: toOrt(new Tensor('bool', Uint8Array.from([0]), [1])),
    };

    const needed: string[] = sessions.decoder_model_merged.inputNames ?? [];
    const filtered: Record<string, any> =
      needed.length > 0
        ? Object.fromEntries(Object.entries(inputs).filter(([key]) => needed.includes(key)))
        : inputs;

    const decoded = await sessions.decoder_model_merged.run(filtered);
    const logits = decoded?.logits;
    const dims: number[] = logits?.dims ?? [];
    const data: Float32Array | undefined = logits?.data;
    if (!dims.length || !data) return null;

    const vocab = dims[dims.length - 1];
    const offset = data.length - vocab;

    const scored = entries
      .map(([token, id]) => ({ code: String(token).slice(2, -2), logit: Number(data[offset + Number(id)]) }))
      .filter((item) => Number.isFinite(item.logit));

    if (scored.length === 0) return null;

    const max = Math.max(...scored.map((item) => item.logit));
    let total = 0;
    for (const item of scored) total += Math.exp(item.logit - max);

    scored.sort((a, b) => b.logit - a.logit);
    const ranked = scored.slice(0, 3).map((item) => ({
      code: item.code,
      label: languageLabel(item.code),
      probability: total > 0 ? Math.exp(item.logit - max) / total : 0,
    }));

    const top = ranked[0];
    if (!top || top.probability <= 0) return null;

    return { code: top.code, label: top.label, confidence: top.probability, ranked };
  } catch (err) {
    // 检测只是"锦上添花"，任何异常都不该影响识别
    console.warn('[asr] 语种检测失败，将回退到默认语言：', err);
    return null;
  }
}

/** 把多个窗口的检测结果合成一个：按置信度累加投票，同时合并候选排名 */
function mergePredictions(preds: LangPrediction[]): LangPrediction {
  const score = new Map<string, number>();
  const prob = new Map<string, number>();
  for (const p of preds) {
    score.set(p.code, (score.get(p.code) ?? 0) + p.confidence);
    for (const item of p.ranked) prob.set(item.code, (prob.get(item.code) ?? 0) + item.probability);
  }

  let bestCode = preds[0].code;
  let bestScore = -1;
  for (const [code, value] of score) {
    if (value > bestScore) {
      bestScore = value;
      bestCode = code;
    }
  }

  const totalScore = [...score.values()].reduce((a, b) => a + b, 0) || 1;
  const ranked = [...prob.entries()]
    .map(([code, probability]) => ({
      code,
      label: languageLabel(code),
      probability: probability / preds.length,
    }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 3);

  return {
    code: bestCode,
    label: languageLabel(bestCode),
    // 多个窗口"一致同意"时接近 1，分歧时降到 0.5 左右 —— 调用方据此决定要不要备选语言兜底
    confidence: bestScore / totalScore,
    ranked,
  };
}

/**
 * 检测语种。失败返回 null，调用方需自行兜底。
 *
 * 只取"全片最响的 30 秒"是不可靠的：背景音乐往往就是最响的部分，检测会被带偏，
 * 整条视频都用错误语言解码（中文视频识别出一堆波兰语就是这么来的）。
 * 因此这里**分段取多个窗口分别检测再投票**，并对结果一致的情况提前收手，避免多余开销。
 */
export async function detectLanguage(
  pipe: AnyPipe,
  samples: Float32Array,
  mod: { Tensor?: TensorCtor },
  options: DetectOptions = {},
): Promise<LangPrediction | null> {
  const windows = pickDetectionWindows(samples, 30, options.windowCount ?? 3, TARGET_SAMPLE_RATE);
  const preds: LangPrediction[] = [];

  for (const window of windows) {
    if (options.isAborted?.()) return preds.length > 0 ? mergePredictions(preds) : null;
    const pred = await detectOnce(pipe, window, mod, options);
    if (!pred) continue;
    preds.push(pred);

    // 前两个窗口结论一致且都很自信 → 不必再跑第三个（省一次编码器前向）
    if (preds.length === 2) {
      const [a, b] = preds;
      if (a.code === b.code && Math.min(a.confidence, b.confidence) >= 0.85) break;
    }
  }

  if (preds.length === 0) return null;
  return preds.length === 1 ? preds[0] : mergePredictions(preds);
}
