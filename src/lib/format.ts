/**
 * 导出格式化：TXT / SRT / VTT / Markdown / JSON。
 */

import type { Segment, SummaryResult } from '../types';

export interface ExportContext {
  fileName: string;
  summary?: SummaryResult | null;
  /** 识别所用模型 */
  model?: string;
  /** 识别语言 */
  language?: string;
  /** 音频时长（秒） */
  duration?: number;
}

/** 00:01:02,345 */
export function formatSrtTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
}

/** 00:01:02.345 */
export function formatVttTime(seconds: number): string {
  return formatSrtTime(seconds).replace(',', '.');
}

/** 00:01:02 */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function toSrt(segments: Segment[]): string {
  return segments
    .map((seg, i) => `${i + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text}\n`)
    .join('\n');
}

export function toVtt(segments: Segment[]): string {
  const body = segments
    .map((seg) => `${formatVttTime(seg.start)} --> ${formatVttTime(seg.end)}\n${seg.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** 纯文本：带可选时间戳 */
export function toTxt(segments: Segment[], withTimestamp = true): string {
  if (!withTimestamp) return segments.map((s) => s.text).join('\n');
  return segments.map((s) => `[${formatClock(s.start)}] ${s.text}`).join('\n');
}

/** 完整文本文档：元信息 + 摘要 + 关键词 + 全文 */
export function toMarkdown(ctx: ExportContext, segments: Segment[]): string {
  const lines: string[] = [];
  lines.push(`# ${ctx.fileName} · 字幕与内容总结`);
  lines.push('');
  lines.push('## 基本信息');
  lines.push('');
  lines.push(`- 源文件：\`${ctx.fileName}\``);
  if (ctx.duration) lines.push(`- 时长：${formatClock(ctx.duration)}`);
  lines.push(`- 字幕条数：${segments.length}`);
  if (ctx.language) lines.push(`- 识别语言：${ctx.language}`);
  if (ctx.model) lines.push(`- 识别模型：${ctx.model}`);
  lines.push(`- 生成时间：${new Date().toLocaleString()}`);
  lines.push('');

  if (ctx.summary && (ctx.summary.tldr || ctx.summary.bullets.length)) {
    lines.push('## 内容总结');
    lines.push('');
    if (ctx.summary.tldr) {
      lines.push(`> ${ctx.summary.tldr}`);
      lines.push('');
    }
    for (const b of ctx.summary.bullets) lines.push(`- ${b}`);
    lines.push('');
    if (ctx.summary.keywords.length) {
      lines.push(`**关键词**：${ctx.summary.keywords.join('、')}`);
      lines.push('');
    }
    lines.push(`*摘要方式：${ctx.summary.engine === 'llm' ? 'AI 大模型生成' : '本地抽取式算法'}*`);
    lines.push('');
  }

  lines.push('## 带时间戳全文');
  lines.push('');
  for (const seg of segments) {
    lines.push(`**[${formatClock(seg.start)}]** ${seg.text}`);
    lines.push('');
  }

  lines.push('## 纯文本全文');
  lines.push('');
  lines.push(segments.map((s) => s.text).join('\n'));
  lines.push('');
  return lines.join('\n');
}

export function toJson(ctx: ExportContext, segments: Segment[]): string {
  return JSON.stringify(
    {
      source: ctx.fileName,
      generatedAt: new Date().toISOString(),
      model: ctx.model,
      language: ctx.language,
      duration: ctx.duration,
      summary: ctx.summary ?? null,
      segments,
    },
    null,
    2,
  );
}

export type ExportFormat = 'txt' | 'srt' | 'vtt' | 'md' | 'json';

export function buildExport(format: ExportFormat, ctx: ExportContext, segments: Segment[]): { content: string; ext: string } {
  switch (format) {
    case 'srt':
      return { content: toSrt(segments), ext: 'srt' };
    case 'vtt':
      return { content: toVtt(segments), ext: 'vtt' };
    case 'md':
      return { content: toMarkdown(ctx, segments), ext: 'md' };
    case 'json':
      return { content: toJson(ctx, segments), ext: 'json' };
    case 'txt':
    default:
      return { content: toTxt(segments, true), ext: 'txt' };
  }
}

export function safeBaseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'transcript';
}

/** 触发浏览器下载 */
export function downloadText(content: string, filename: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
