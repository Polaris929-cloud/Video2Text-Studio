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

import { analyzeLevel, pickDetectionWindow, TARGET_SAMPLE_RATE } from './audio';
import { languageLabel, type LangPrediction } from './whisperLang';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyPipe = any;
type TensorCtor = new (type: string, data: any, dims: number[]) => any;

export interface DetectOptions {
  /** 窗口里至少要有这么多秒的有效声音才值得检测（默认 0.8 秒） */
  minVoicedSeconds?: number;
  /** 用户点了「中止」时提前退出 */
  isAborted?: () => boolean;
}

/** 库的 Tensor 与 onnxruntime 原生 tensor 都能直接喂给 session.run，这里统一一下 */
function toOrt(value: any): any {
  return value?.ort_tensor ?? value;
}

/**
 * 检测语种。失败（不支持的环境/模型结构变化）返回 null，调用方需自行兜底。
 */
export async function detectLanguage(
  pipe: AnyPipe,
  samples: Float32Array,
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

    // 1) 截取"最有声音"的 30 秒
    const window = pickDetectionWindow(samples, 30, TARGET_SAMPLE_RATE);
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
