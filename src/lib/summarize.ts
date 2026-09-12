/**
 * 本地摘要：不依赖任何 API，纯浏览器算法。
 *
 * 流程：
 *   1. 归一化：合并碎片化的 ASR 片段，按标点切成句子；
 *   2. 关键词：中文按「二元/三元字组 + 词频」、英文按单词词频统计，并过滤停用词；
 *   3. 打分：句子得分 = 关键词权重命中 + 位置权重 + 长度惩罚；
 *   4. 去冗余：MMR（最大边际相关）挑选互不重复的句子；
 *   5. 按原文顺序输出要点，得到「抽取式」摘要。
 *
 * 说明：本地摘要是抽取式的（原文句子重排），没有大模型时也能给出可用结果；
 * 想要真正的生成式摘要，请在「AI 摘要」里配置 OpenAI 兼容接口。
 */

import type { Segment } from '../types';

const STOPWORDS_ZH = new Set([
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '一个', '我们', '你们', '他们',
  '这个', '那个', '这些', '那些', '这样', '那样', '什么', '怎么', '为什么', '因为', '所以', '但是', '然后',
  '可以', '这样', '如果', '还是', '已经', '可能', '没有', '不是', '就是', '一下', '一些', '非常', '其实',
  '大家', '现在', '时候', '东西', '问题', '地方', '事情', '这里', '那里', '自己', '的话', '之后', '之前',
  '而且', '并且', '还有', '只是', '这种', '那种', '一样', '一起', '一直', '一定', '出来',
]);

const STOPWORDS_EN = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'so', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing', 'have', 'has', 'had',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'them', 'his', 'her', 'its', 'our', 'your', 'their', 'this',
  'that', 'these', 'those', 'there', 'here', 'what', 'which', 'who', 'whom', 'how', 'why', 'when', 'where',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'not', 'no', 'yes', 'just',
  'about', 'into', 'over', 'after', 'before', 'also', 'very', 'really', 'like', 'get', 'got', 'going', 'go',
  'okay', 'ok', 'yeah', 'well', 'know', 'think', 'see', 'want', 'one', 'two', 'now', 'out', 'up', 'down',
]);

export interface LocalSummary {
  tldr: string;
  bullets: string[];
  keywords: string[];
}

export interface SummarizeOptions {
  /** 需要抽取的要点条数 */
  maxBullets?: number;
  /** 关键词个数 */
  maxKeywords?: number;
}

/** 把 ASR 片段拼成连续文本，并按句子切分 */
export function buildSentences(segments: Segment[]): string[] {
  const joined = segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');

  if (!joined) return [];

  // 先按句末标点切；中文标点后的空格是可选的
  const rough = joined
    .split(/(?<=[。！？!?；;…])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean);

  // 过长的句子（ASR 常常没有标点）再按逗号 / 长度切一刀
  const sentences: string[] = [];
  for (const s of rough) {
    if (s.length <= 120) {
      sentences.push(s);
      continue;
    }
    const parts = s.split(/(?<=[，,、])\s*/u);
    let buffer = '';
    for (const p of parts) {
      if ((buffer + p).length > 90 && buffer) {
        sentences.push(buffer.trim());
        buffer = p;
      } else {
        buffer += p;
      }
    }
    if (buffer.trim()) sentences.push(buffer.trim());
  }
  return sentences.filter((s) => s.length >= 4);
}

/** 关键词抽取 */
export function extractKeywords(text: string, maxKeywords = 12): string[] {
  const counts = new Map<string, number>();

  const bump = (token: string, weight = 1) => {
    if (!token) return;
    counts.set(token, (counts.get(token) ?? 0) + weight);
  };

  // 英文单词
  const enWords = text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  for (const w of enWords) {
    if (STOPWORDS_EN.has(w)) continue;
    bump(w);
  }

  // 中文：滑动窗口取 2~4 字组，长组权重更高（近似「词」）
  const zhRuns = text.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const run of zhRuns) {
    for (let n = 4; n >= 2; n--) {
      for (let i = 0; i + n <= run.length; i++) {
        const gram = run.slice(i, i + n);
        if (STOPWORDS_ZH.has(gram)) continue;
        // 首尾是停用字的多半是跨词噪声
        if (STOPWORDS_ZH.has(gram[0]) && STOPWORDS_ZH.has(gram[gram.length - 1])) continue;
        bump(gram, n >= 3 ? 1.6 : 1);
      }
    }
  }

  const scored = [...counts.entries()]
    .map(([term, count]) => {
      // 频率 × 长度加成；长度 1 的英文词权重低
      const lengthBonus = /^[a-z'-]+$/.test(term) ? (term.length >= 6 ? 1.25 : 1) : 1 + (term.length - 2) * 0.12;
      return { term, score: count * lengthBonus };
    })
    .filter((x) => (x.term.length <= 6 || /^[a-z'-]+$/.test(x.term)))
    .sort((a, b) => b.score - a.score);

  // 去掉被更长关键词包含的短词
  const picked: string[] = [];
  for (const { term } of scored) {
    if (picked.some((p) => p.includes(term) || term.includes(p))) continue;
    picked.push(term);
    if (picked.length >= maxKeywords) break;
  }
  return picked;
}

function termFrequency(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  const tokens = [
    ...(text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter((w) => !STOPWORDS_EN.has(w)),
    ...(text.match(/[\u4e00-\u9fa5]{2,4}/g) ?? []).filter((w) => !STOPWORDS_ZH.has(w)),
  ];
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w) dot += v * w;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** MMR 去冗余挑选 */
function mmrSelect(sentences: string[], scores: number[], k: number): number[] {
  const tfs = sentences.map(termFrequency);
  const selected: number[] = [];
  const remaining = new Set(sentences.map((_, i) => i));

  while (selected.length < k && remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (const i of remaining) {
      let maxSim = 0;
      for (const j of selected) {
        maxSim = Math.max(maxSim, cosine(tfs[i], tfs[j]));
      }
      const value = scores[i] - 0.55 * maxSim;
      if (value > bestScore) {
        bestScore = value;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }
  return selected.sort((a, b) => a - b);
}

/** 主入口：对字幕片段生成本地摘要 */
export function summarizeLocal(segments: Segment[], options: SummarizeOptions = {}): LocalSummary {
  const maxBullets = options.maxBullets ?? 7;
  const maxKeywords = options.maxKeywords ?? 12;

  const sentences = buildSentences(segments);
  const fullText = segments.map((s) => s.text).join(' ');
  const keywords = extractKeywords(fullText, maxKeywords);

  if (sentences.length === 0) {
    return { tldr: '', bullets: [], keywords };
  }

  // 关键词权重
  const keywordWeight = new Map(keywords.map((k, i) => [k, keywords.length - i]));

  const scores = sentences.map((sentence, i) => {
    let score = 0;
    for (const [kw, weight] of keywordWeight) {
      if (sentence.includes(kw)) score += weight;
    }
    // 位置权重：开头更可能是主题句
    const positionBoost = i < 3 ? 1.25 : i < Math.max(5, sentences.length * 0.15) ? 1.1 : 1;
    // 长度惩罚：太短信息少，太长不适合做要点
    const len = sentence.length;
    const lengthPenalty = len < 8 ? 0.4 : len > 110 ? 0.8 : 1;
    return (score / Math.sqrt(len || 1)) * positionBoost * lengthPenalty;
  });

  const picked = mmrSelect(sentences, scores, Math.min(maxBullets, sentences.length));
  const bullets = picked.map((i) => sentences[i]);

  // TL;DR：取分数最高的句子，并压缩长度
  let bestIdx = 0;
  for (let i = 1; i < sentences.length; i++) {
    if (scores[i] > scores[bestIdx]) bestIdx = i;
  }
  let tldr = sentences[bestIdx] ?? '';
  if (tldr.length > 120) tldr = `${tldr.slice(0, 118)}…`;

  return { tldr, bullets, keywords };
}
