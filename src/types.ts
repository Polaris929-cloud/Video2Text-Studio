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

/** 语言是怎么定下来的：手动指定 / 自动检测 / 检测失败后的兜底 */
export type LanguageSource = 'manual' | 'auto' | 'fallback';

/** Worker → 主线程 消息 */
export type WorkerOutMessage =
  | {
      type: 'progress';
      stage: 'load' | 'transcribe';
      value: number;
      note?: string;
      /** 加载阶段细分：探测来源 / 下载中 / 编译初始化（编译阶段没有百分比可言，界面改用动态条） */
      phase?: 'probe' | 'download' | 'compile';
    }
  | { type: 'status'; message: string }
  | {
      type: 'result';
      segments: RawSegment[];
      /** Whisper 语言代码，例如 zh */
      language?: string;
      /** 语言展示名，例如 中文 */
      languageLabel?: string;
      /** 语言是怎么定下来的 */
      languageSource?: LanguageSource;
      /** 自动检测的置信度（0~1） */
      languageConfidence?: number;
      /** 被过滤掉的疑似幻觉片段数 */
      filtered?: number;
      /** 因整片静音被跳过的分片数 */
      skippedSilentChunks?: number;
      duration: number;
    }
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
      /** 用户首选的模型来源：auto / site / hf / hf-mirror.net / aifasthub / custom */
      modelSource: string;
      /** 自定义模型地址（modelSource === 'custom' 时生效） */
      customModelHost: string;
      /** 站点自带模型目录的绝对地址（主线程算好，同源，最可靠） */
      siteBase: string;
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
  /** 模型来源：auto（自动探测）/ site（本站同源）/ hf / hf-mirror.net / aifasthub / hf-mirror.com / custom */
  modelSource: string;
  /** 自定义模型地址（modelSource === 'custom' 时生效） */
  customModelHost: string;
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
