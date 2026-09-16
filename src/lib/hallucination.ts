/**
 * Whisper 幻觉（hallucination）过滤 —— 纯逻辑，可在 Node 里单测。
 *
 * 背景：Whisper 在没有语音（纯静音、纯音乐、音轨损坏）或语言指定错误时，
 * 会"自信地"输出一些固定套路的东西，典型有两类：
 *
 *   1. 标记型：`[Spanish]`、`(Speaking in Japanese)`、`♪♪♪`、`[BLANK_AUDIO]`、
 *      `请不吝点赞订阅转发打赏支持明镜与点点栏目`、`字幕由 Amara.org 社区提供`；
 *   2. 循环型：一小段短语无限重复，例如
 *      `będziemyęgrać FER fundo MUSANG będziemyęgrać FER fundo MUSANG …`。
 *
 * 它们都不是真实语音内容，必须丢掉；否则用户看到的就是"识别出一堆看不懂的重复文本"。
 */

/** 括号类标记：整段就是一个 [xx] / (xx) / （xx） / 【xx】 */
const WRAPPED_TAG = /^[\s]*[\[\(（【〈《][^\]\)）】〉》]{0,60}[\]\)）】〉》][\s]*$/;

/** 纯符号/装饰：♪ ♫ 🎵 … 之类 */
const SYMBOLS_ONLY = /^[\s♪♫🎵🎶*#\-_=~.。、,，!！?？…]+$/;

/** 常见幻觉套话（命中且整段很短时判定为幻觉） */
const BOILERPLATE = [
  /请不吝点赞|訂閱|订阅|打赏|轉發|转发|明镜与点点|點點欄目/,
  /字幕由|字幕組|字幕组|翻譯|翻译[:：]|校对[:：]/,
  /amara\.org|subtitle|transcri(be|ption|bed) by|subtitles? by/i,
  /thanks? for watching|thank you for watching|please subscribe/i,
  /www\.[a-z0-9-]+\.(com|net|org|cn)/i,
  /^\s*♪.*♪\s*$/,
];

/** 把文本切成"词"：有空白按词切，中日韩等无空白语言按字符切 */
function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[\s]+/g, ' ').trim();
  if (!normalized) return [];
  if (/\s/.test(normalized)) return normalized.split(' ');
  return Array.from(normalized);
}

/**
 * 重复度：文本里最长的一段"重复单元"覆盖了多少比例。
 * 例如 `A B C A B C A B C` → 单元 `A B C` 出现 3 次 → 1.0。
 * 正常句子（哪怕有重复词）通常远低于 0.5。
 */
export function repetitionRatio(text: string): number {
  const tokens = tokenize(text);
  const n = tokens.length;
  if (n < 6) return 0;

  let best = 0;
  const maxSize = Math.min(15, Math.floor(n / 2));
  for (let size = 1; size <= maxSize; size++) {
    const counts = new Map<string, number>();
    for (let i = 0; i + size <= n; i++) {
      const key = tokens.slice(i, i + size).join('\u0001');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      if (count >= 3) {
        const ratio = (count * size) / n;
        if (ratio > best) best = ratio;
        // 已经很确定是循环了，没必要继续找
        if (best >= 0.9) return Math.min(1, best);
      }
    }
  }
  return Math.min(1, best);
}

/** 是否是括号/符号类幻觉标记 */
export function isArtifactTag(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return true;
  if (WRAPPED_TAG.test(t)) return true;
  if (SYMBOLS_ONLY.test(t)) return true;
  // 套话只在整段很短时才算幻觉，避免误伤正常长句
  if (t.length <= 40 && BOILERPLATE.some((re) => re.test(t))) return true;
  return false;
}

/* ── 语言一致性 / 跨语系乱码 ────────────────────────────────
 * Whisper 遇到**没有人声的段落**（背景音乐、掌声、噪声）或语言指定错误时，
 * 会"自由发挥"并跨语言乱跳，例如：
 *
 *   FamehuhnNI arbeiten Loadabolic Fraser 쭈운 thoughνΩ Vent decree reign livest
 *   Chevl coal gema造
 *
 * 这类文本既不含标记、也不构成循环重复，光靠上面两条规则**完全拦不住**，
 * 于是用户看到的就是一屏韩文、俄文、波兰语混杂的"字幕"。
 *
 * ⚠ 关键设计：**判据不能依赖"目标语言是中文"**。
 * 语种检测本身可能给出错误答案（那正是幻觉的成因之一），
 * 如果只在检测结果为 zh 时才过滤，检测一旦出错，乱码就会被全部放行。
 * 因此下面把判据拆成两部分，其中「跨语系文字混用」与目标语言无关，
 * 在任何情况下都能拦住这类乱码。
 */

/** 各文字系统的字符统计用正则 */
const SCRIPT_PATTERNS: Record<string, RegExp> = {
  /** 拉丁字母，含带变音符号的扩展拉丁（ę ç ß ż ł 等 Whisper 幻觉常见字符） */
  latin: /[A-Za-z\u00C0-\u024F]/g,
  /** 汉字（含扩展区）——"日本""咖啡"这类词算汉字，不会被误伤 */
  cjk: /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g,
  /** 日文假名 */
  kana: /[\u3040-\u30FF]/g,
  /** 韩文音节 */
  hangul: /[\uAC00-\uD7AF]/g,
  /** 西里尔字母 */
  cyrillic: /[\u0400-\u04FF]/g,
  /** 希腊字母 */
  greek: /[\u0370-\u03FF]/g,
  /** 泰文 */
  thai: /[\u0E00-\u0E7F]/g,
  /** 阿拉伯字母 */
  arabic: /[\u0600-\u06FF]/g,
  /** 希伯来字母 */
  hebrew: /[\u0590-\u05FF]/g,
};

export type ScriptName = keyof typeof SCRIPT_PATTERNS;

/** 使用西里尔字母的语系 */
const CYRILLIC_LANGS = [
  'ru',
  'uk',
  'be',
  'bg',
  'sr',
  'mk',
  'kk',
  'ky',
  'tg',
  'mn',
  'tt',
  'ba',
  'cv',
  'os',
  'uz',
  'tk',
  'sah',
];

function countScripts(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(SCRIPT_PATTERNS)) {
    out[name] = (text.match(SCRIPT_PATTERNS[name]) || []).length;
  }
  return out;
}

/**
 * 「专属文字系统」：正常情况下只会出现在特定语系的文字。
 * 中文视频里蹦出韩文 / 西里尔 / 希腊字母 → 一定是幻觉，
 * **与语种检测结果是否正确无关**（这正是它能兜住检测失败的原因）。
 *
 * minCount 的取值有讲究：韩文音节/假名/西里尔不可能作为数学符号出现，出现 1 个即可判；
 * 希腊字母则常被当作符号使用（`10Ω`、`α 粒子`），要求 ≥2 个才判，避免误伤技术类内容。
 */
const EXCLUSIVE_SCRIPTS: Array<{ script: string; languages: string[]; minCount: number }> = [
  { script: 'hangul', languages: ['ko'], minCount: 1 },
  { script: 'kana', languages: ['ja'], minCount: 1 },
  { script: 'cyrillic', languages: CYRILLIC_LANGS, minCount: 1 },
  { script: 'greek', languages: ['el'], minCount: 2 },
  { script: 'thai', languages: ['th'], minCount: 1 },
  { script: 'hebrew', languages: ['he', 'yi'], minCount: 1 },
  { script: 'arabic', languages: ['ar', 'fa', 'ur', 'ps', 'sd', 'ug'], minCount: 1 },
];

/** 目标语言期望的文字系统（未收录的语言按拉丁字母处理） */
function expectedScript(language?: string): ScriptName | null {
  if (!language) return null;
  if (language === 'zh') return 'cjk';
  if (language === 'ja') return 'kana';
  if (language === 'ko') return 'hangul';
  if (language === 'el') return 'greek';
  if (language === 'th') return 'thai';
  if (['he', 'yi'].includes(language)) return 'hebrew';
  if (['ar', 'fa', 'ur', 'ps', 'sd', 'ug'].includes(language)) return 'arabic';
  if (CYRILLIC_LANGS.includes(language)) return 'cyrillic';
  return 'latin';
}

/**
 * 这段文本是否"不可能属于目标语言"。
 *
 * 判据 1（与目标语言无关，最可靠）：出现不属于目标语系的「专属文字」，
 *   例如中文/英文结果里混进韩文音节、西里尔字母、希腊字母。
 *   30 秒内的真实语音不可能这样跨语系混用。
 * 判据 2：整段完全没有目标语言的文字，却有一长串别种文字
 *   （中文场景下即「一个汉字都没有，却是一长串拉丁词」）。
 * 判据 3：目标语言的文字只是零星点缀，别的文字压倒性多（`Chevl coal gema造`）。
 *
 * 正常的中英混说（`我们用 Python 处理数据`）汉字占多数，三条都不会命中。
 */
export function isForeignText(text: string, language?: string): boolean {
  const t = text || '';
  if (!t) return false;

  const counts = countScripts(t);
  const lang = language ?? '';

  // 判据 1：跨语系的「专属文字」—— 与检测结果对不对无关
  for (const { script, languages, minCount } of EXCLUSIVE_SCRIPTS) {
    if (counts[script] >= minCount && !languages.includes(lang)) return true;
  }

  const target = expectedScript(language);
  if (!target) return false;

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total < 8) return false;

  const expected = counts[target];

  // 判据 2：整段用错了文字系统
  if (expected === 0) return true;

  // 判据 3：目标语言文字占比不足 25% —— 正常语音不会这样
  if (expected * 3 < total - expected) return true;

  return false;
}

export interface FilterOptions {
  /** 目标语言（Whisper 代码，如 'zh'/'en'）。用于判断结果是否与目标语言一致 */
  language?: string;
}

/** 综合判断：这段文本是否应该被丢掉 */
export function looksHallucinated(text: string, options: FilterOptions = {}): boolean {
  if (isArtifactTag(text)) return true;
  if (repetitionRatio(text) >= 0.55) return true;
  // 注意：这里刻意**不再限定** "language === 'zh'"。
  // 语种检测本身可能出错，只在检测为中文时才过滤，等于检测一错就全线放行。
  if (isForeignText(text, options.language)) return true;
  return false;
}

export interface FilterOutcome<T> {
  kept: T[];
  /** 被丢掉的片段（含原因，便于界面提示与排查） */
  dropped: Array<{ item: T; reason: 'artifact' | 'repeat' | 'duplicate' | 'foreign' }>;
}

/** 去掉标点与空白后的"骨架"，用于比较两段文本是否其实一样 */
function skeleton(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 过滤单个分片的识别结果：
 *   - 标记型/循环型幻觉直接丢；
 *   - 与上一条完全相同的相邻重复丢（滑窗重叠或幻觉循环都会造成这种重复）。
 */
export function filterChunkSegments<T extends { text: string }>(
  items: T[],
  previousText?: string,
  options: FilterOptions = {},
): FilterOutcome<T> {
  const kept: T[] = [];
  const dropped: FilterOutcome<T>['dropped'] = [];
  let prev = previousText ? skeleton(previousText) : '';

  for (const item of items) {
    if (isArtifactTag(item.text)) {
      dropped.push({ item, reason: 'artifact' });
      continue;
    }
    if (repetitionRatio(item.text) >= 0.55) {
      dropped.push({ item, reason: 'repeat' });
      continue;
    }
    // 吐出了与目标语言无关的文字（韩文/西里尔/希腊…），或整段用错语言
    // —— 这不是"识别不准"，而是幻觉。判据不依赖检测结果是否正确。
    if (isForeignText(item.text, options.language)) {
      dropped.push({ item, reason: 'foreign' });
      continue;
    }
    const sk = skeleton(item.text);
    if (sk && sk === prev) {
      dropped.push({ item, reason: 'duplicate' });
      continue;
    }
    kept.push(item);
    prev = sk;
  }

  return { kept, dropped };
}

/**
 * 全片兜底：同一句话在整段结果里出现太多次（≥4 次），基本可以断定是幻觉循环
 * （真实语音不会一字不差地重复同一句四遍以上）。返回需要丢弃的下标集合。
 */
export function findGloballyRepeating<T extends { text: string }>(items: T[], minCount = 4): Set<number> {
  const groups = new Map<string, number[]>();
  items.forEach((item, index) => {
    const sk = skeleton(item.text);
    if (sk.length < 6) return; // 太短的（"对"、"嗯"）不参与判断
    const list = groups.get(sk);
    if (list) list.push(index);
    else groups.set(sk, [index]);
  });

  const drop = new Set<number>();
  for (const indexes of groups.values()) {
    if (indexes.length >= minCount) for (const i of indexes) drop.add(i);
  }
  return drop;
}
