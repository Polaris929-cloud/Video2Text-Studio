/**
 * 全局常量：模型清单、语言清单、默认设置。
 */

import type { AsrSettings, LanguageOption, LlmSettings, ModelSpec } from '../types';
import { DEFAULT_MODEL_SOURCE } from './modelSources';

/**
 * 模型来自 Hugging Face 上 ONNX 化的 Whisper（Xenova / onnx-community 出品），
 * 首次使用时会由浏览器下载并缓存（Cache Storage），之后离线也能用。
 */
export const MODELS: ModelSpec[] = [
  { id: 'onnx-community/whisper-tiny', label: 'Tiny · 最快', size: '约 40 MB', note: '速度优先，适合试跑与长视频粗剪' },
  { id: 'onnx-community/whisper-base', label: 'Base · 均衡', size: '约 80 MB', note: '速度与准确度平衡，日常推荐' },
  { id: 'onnx-community/whisper-small', label: 'Small · 更准', size: '约 250 MB', note: '中文识别明显更好，速度较慢' },
  { id: 'onnx-community/whisper-large-v3-turbo', label: 'Large-v3-Turbo · 最准', size: '约 800 MB', note: '准确度最高，需要较好的显卡与耐心' },
  { id: 'Xenova/whisper-tiny', label: 'Xenova Tiny（备用源）', size: '约 40 MB', note: '当 onnx-community 源不可用时改用' },
];

export const LANGUAGES: LanguageOption[] = [
  { value: 'auto', label: '自动检测' },
  { value: 'chinese', label: '中文' },
  { value: 'english', label: 'English' },
  { value: 'japanese', label: '日本語' },
  { value: 'korean', label: '한국어' },
  { value: 'cantonese', label: '粤语' },
  { value: 'french', label: 'Français' },
  { value: 'german', label: 'Deutsch' },
  { value: 'spanish', label: 'Español' },
  { value: 'russian', label: 'Русский' },
  { value: 'portuguese', label: 'Português' },
  { value: 'italian', label: 'Italiano' },
  { value: 'arabic', label: 'العربية' },
  { value: 'thai', label: 'ไทย' },
  { value: 'vietnamese', label: 'Tiếng Việt' },
];

export const DEFAULT_ASR: AsrSettings = {
  model: 'onnx-community/whisper-base',
  language: 'auto',
  device: 'auto',
  dtype: 'q8',
  engineSource: 'auto',
  modelSource: DEFAULT_MODEL_SOURCE,
  customModelHost: '',
  chunkSeconds: 30,
  strideSeconds: 5,
};

/**
 * 站点自带的同源模型（由 scripts/fetch-models.mjs 在构建时下载到 public/models/）。
 * 这些模型不依赖 huggingface.co，国内可直接使用。
 */
export const BUILTIN_MODELS: string[] = ['onnx-community/whisper-tiny', 'onnx-community/whisper-base'];

/** 引擎 CDN 候选 */
export const ENGINE_SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: '自动（jsDelivr，最稳）' },
  { value: 'jsdelivr', label: 'jsDelivr' },
  { value: 'unpkg', label: 'unpkg' },
  { value: 'esmsh', label: 'esm.sh' },
];

export const DEFAULT_LLM: LlmSettings = {
  enabled: false,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.3,
};

export const LLM_PRESETS: Array<{ label: string; baseUrl: string; model: string }> = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '阿里云百炼(通义千问)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
];

export const STORAGE_KEYS = {
  asr: 'v2t.asr.v1',
  llm: 'v2t.llm.v1',
  lastResult: 'v2t.lastResult.v1',
  /** 长视频识别过程中的中转存档，用于中断后续跑 */
  checkpoint: 'v2t.checkpoint.v1',
} as const;
