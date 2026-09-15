/**
 * Whisper 语种代码工具（纯逻辑，可在 Node 里单测）。
 *
 * 为什么要有这个文件：
 *   transformers.js 3.x 的 ASR pipeline **没有实现语言自动检测** —— 源码里就是一句
 *       `// TODO: Implement language detection` + `console.warn('No language specified - defaulting to English (en).')`
 *   也就是说，只要不显式传 language，**任何语言的音频都会被当成英语解码**。
 *   中文（或日/韩等）音频被按英语解码时，Whisper 会开始"编造"，输出
 *   `[Spanish]`、`(Speaking in Japanese)`、或者一小段短语无限循环之类的幻觉文本。
 *   这就是「中文视频识别出一堆外文垃圾」的根因。
 *
 *   所以语言自动检测必须由我们自己实现：见 `langDetect.ts`。
 */

/**
 * Whisper 多语种模型支持的 99 种语言代码 → 中文名。
 * 与模型 `generation_config.json` 里的 `lang_to_id` 一一对应
 * （注意：whisper-tiny/base/small 这一代**没有** `yue`（粤语））。
 */
export const WHISPER_LANGUAGE_LABELS: Record<string, string> = {
  af: '南非荷兰语',
  am: '阿姆哈拉语',
  ar: '阿拉伯语',
  as: '阿萨姆语',
  az: '阿塞拜疆语',
  ba: '巴什基尔语',
  be: '白俄罗斯语',
  bg: '保加利亚语',
  bn: '孟加拉语',
  bo: '藏语',
  br: '布列塔尼语',
  bs: '波斯尼亚语',
  ca: '加泰罗尼亚语',
  cs: '捷克语',
  cy: '威尔士语',
  da: '丹麦语',
  de: '德语',
  el: '希腊语',
  en: '英语',
  es: '西班牙语',
  et: '爱沙尼亚语',
  eu: '巴斯克语',
  fa: '波斯语',
  fi: '芬兰语',
  fo: '法罗语',
  fr: '法语',
  gl: '加利西亚语',
  gu: '古吉拉特语',
  haw: '夏威夷语',
  ha: '豪萨语',
  he: '希伯来语',
  hi: '印地语',
  hr: '克罗地亚语',
  ht: '海地克里奥尔语',
  hu: '匈牙利语',
  hy: '亚美尼亚语',
  id: '印尼语',
  is: '冰岛语',
  it: '意大利语',
  ja: '日语',
  jw: '爪哇语',
  ka: '格鲁吉亚语',
  kk: '哈萨克语',
  km: '高棉语',
  kn: '卡纳达语',
  ko: '韩语',
  la: '拉丁语',
  lb: '卢森堡语',
  ln: '林加拉语',
  lo: '老挝语',
  lt: '立陶宛语',
  lv: '拉脱维亚语',
  mg: '马达加斯加语',
  mi: '毛利语',
  mk: '马其顿语',
  ml: '马拉雅拉姆语',
  mn: '蒙古语',
  mr: '马拉地语',
  ms: '马来语',
  mt: '马耳他语',
  my: '缅甸语',
  ne: '尼泊尔语',
  nl: '荷兰语',
  nn: '新挪威语',
  no: '挪威语',
  oc: '奥克语',
  pa: '旁遮普语',
  pl: '波兰语',
  ps: '普什图语',
  pt: '葡萄牙语',
  ro: '罗马尼亚语',
  ru: '俄语',
  sa: '梵语',
  sd: '信德语',
  si: '僧伽罗语',
  sk: '斯洛伐克语',
  sl: '斯洛文尼亚语',
  sn: '绍纳语',
  so: '索马里语',
  sq: '阿尔巴尼亚语',
  sr: '塞尔维亚语',
  su: '巽他语',
  sv: '瑞典语',
  sw: '斯瓦希里语',
  ta: '泰米尔语',
  te: '泰卢固语',
  tg: '塔吉克语',
  th: '泰语',
  tk: '土库曼语',
  tl: '他加禄语',
  tr: '土耳其语',
  tt: '鞑靼语',
  uk: '乌克兰语',
  ur: '乌尔都语',
  uz: '乌兹别克语',
  vi: '越南语',
  yi: '意第绪语',
  yo: '约鲁巴语',
  zh: '中文',
};

/** 界面里使用英文名/别名，这里统一映射到 Whisper 语言代码 */
const LANGUAGE_ALIASES: Record<string, string> = {
  auto: '', // 自动检测，交由调用方处理
  chinese: 'zh',
  mandarin: 'zh',
  english: 'en',
  japanese: 'ja',
  korean: 'ko',
  cantonese: 'yue',
  french: 'fr',
  german: 'de',
  spanish: 'es',
  russian: 'ru',
  portuguese: 'pt',
  italian: 'it',
  arabic: 'ar',
  thai: 'th',
  vietnamese: 'vi',
  hindi: 'hi',
  turkish: 'tr',
  polish: 'pl',
  dutch: 'nl',
  ukrainian: 'uk',
};

/** 把界面值（英文名或语言代码）转成 Whisper 语言代码；无法识别返回 null */
export function whisperCodeOf(value: string): string | null {
  const v = (value || '').trim().toLowerCase();
  if (!v) return null;
  const alias = LANGUAGE_ALIASES[v];
  if (alias !== undefined) return alias || null;
  if (Object.prototype.hasOwnProperty.call(WHISPER_LANGUAGE_LABELS, v)) return v;
  return null;
}

/** 语言代码 → 展示名（未知代码原样返回） */
export function languageLabel(code: string): string {
  if (!code) return '';
  return WHISPER_LANGUAGE_LABELS[code] ?? code;
}

/**
 * 该语言是否被当前模型支持。
 * 模型只提供 99 种语言（例如粤语 `yue` 就不在其中）——
 * 如果硬传一个不存在的语言，transformers.js 会往 prompt 里塞 `undefined` token，
 * 模型随即开始胡言乱语。所以这里必须先校验，不支持就回退。
 */
export function isSupportedByModel(code: string, langToId: Record<string, number> | undefined): boolean {
  if (!code || !langToId) return false;
  return Object.prototype.hasOwnProperty.call(langToId, `<|${code}|>`);
}

/**
 * 自动检测失败时的兜底：按浏览器/系统语言猜一个。
 * 比"直接当成英语"靠谱得多（英语是 transformers.js 的默认值，也是幻觉的主要来源）。
 */
export function guessLanguageFromNavigator(nav?: { language?: string; languages?: readonly string[] }): string {
  const navObj = nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  const candidates: string[] = [];
  if (navObj?.language) candidates.push(navObj.language);
  if (navObj?.languages) candidates.push(...navObj.languages);
  for (const raw of candidates) {
    const base = (raw || '').split('-')[0].toLowerCase();
    if (base && Object.prototype.hasOwnProperty.call(WHISPER_LANGUAGE_LABELS, base)) return base;
  }
  return 'en';
}

/** 语种判定结果 */
export interface LangPrediction {
  /** Whisper 语言代码，例如 zh */
  code: string;
  /** 中文展示名，例如 中文 */
  label: string;
  /** 置信度 0~1 */
  confidence: number;
  /** 候选排名（含 top1），用于失败时换一个语言重试 */
  ranked: Array<{ code: string; label: string; probability: number }>;
}
