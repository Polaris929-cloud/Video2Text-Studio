/** 一条字幕片段。start / end 单位为秒。 */
export interface Segment {
  index: number;
  start: number;
  end: number;
  text: string;
}

/** Whisper 模型规格。 */
export interface ModelSpec {
  /** transformers.js 使用的 Hugging Face 模型 id */
  id: string;
  /** 界面展示名 */
  label: string;
  /** 大致下载体积，用于提示用户 */
  size: string;
  /** 速度 / 准确度说明 */
  note: string;
}

/** 支持的语言（value 为 Whisper 的 language token） */
export interface LanguageOption {
  value: string;
  label: string;
}

/** 进度阶段 */
export type Stage = 'idle' | 'decoding' | 'loading-model' | 'transcribing' | 'done' | 'error';

/** Worker → 主线程 消息 */
export type WorkerOutMessage =
  | { type: 'progress'; stage: 'load' | 'transcribe'; value: number; note?: string }
  | { type: 'status'; message: string }
  | { type: 'result'; segments: RawSegment[]; language?: string; duration: number }
  | { type: 'error'; message: string };

/** Worker 输出的原始片段（时间戳可能为 null 表示未知） */
export interface RawSegment {
  text: string;
  timestamp: [number, number | null] | null;
}

/** 主线程 → Worker 消息 */
export type WorkerInMessage =
  | {
      type: 'transcribe';
      audio: Float32Array;
      model: string;
      language: string;
      dtype: string;
      device: string;
      /** 单个分片时长（秒） */
      chunkSeconds: number;
      /** 分片重叠时长（秒），用于避免边界丢词 */
      strideSeconds: number;
      /** 引擎 CDN 源 */
      engineSource: string;
      /** 模型下载源（镜像） */
      modelHost: string;
      /** 是否从本地文件夹加载模型（完全离线） */
      localModel: boolean;
    }
  | { type: 'abort' };

/** 摘要结果 */
export interface SummaryResult {
  /** 一句话概述（本地摘要为抽取式核心句） */
  tldr: string;
  /** 要点列表 */
  bullets: string[];
  /** 关键词 */
  keywords: string[];
  /** 生成方式 */
  engine: 'local' | 'llm';
}

/** 语音识别设置 */
export interface AsrSettings {
  model: string;
  language: string;
  device: 'auto' | 'wasm' | 'webgpu';
  dtype: string;
  /** 引擎 CDN 源：auto / jsdelivr / unpkg / esmsh */
  engineSource: string;
  /** 模型下载源（镜像），空字符串表示官方 huggingface.co */
  modelHost: string;
  /** 是否从本地文件夹加载模型（完全离线，不需要下载） */
  localModel: boolean;
  chunkSeconds: number;
  strideSeconds: number;
}

/** LLM 设置（OpenAI 兼容接口） */
export interface LlmSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}
