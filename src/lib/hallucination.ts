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

/** 综合判断：这段文本是否应该被丢掉 */
export function looksHallucinated(text: string): boolean {
  if (isArtifactTag(text)) return true;
  if (repetitionRatio(text) >= 0.55) return true;
  return false;
}

export interface FilterOutcome<T> {
  kept: T[];
  /** 被丢掉的片段（含原因，便于界面提示与排查） */
  dropped: Array<{ item: T; reason: 'artifact' | 'repeat' | 'duplicate' }>;
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
export function filterChunkSegments<T extends { text: string }>(items: T[], previousText?: string): FilterOutcome<T> {
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
