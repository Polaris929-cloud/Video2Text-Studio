/**
 * 可选 AI 摘要：调用任意 OpenAI 兼容的 /chat/completions 接口。
 *
 * 这是整个项目里唯一会发起网络请求、且会把文字发给第三方的功能，
 * 因此在 UI 上是**默认关闭**的，必须用户自己打开并填写 API Key。
 * Key 只保存在浏览器 localStorage，不会上传到本项目（本项目没有后端）。
 */

import type { LlmSettings, Segment, SummaryResult } from '../types';

const CHUNK_CHARS = 6000;

export interface LlmCallbacks {
  onProgress?: (message: string) => void;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return 'https://api.openai.com/v1';
  // 允许用户只填到域名
  if (/\/v\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

async function chatCompletion(
  settings: LlmSettings,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  { json = false, maxTokens = 1200 }: { json?: boolean; maxTokens?: number } = {},
): Promise<string> {
  const endpoint = `${normalizeBaseUrl(settings.baseUrl)}/chat/completions`;
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    temperature: settings.temperature,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `无法连接 AI 接口（${endpoint}）。请检查网络、Base URL 是否正确，以及该服务是否允许浏览器跨域调用（CORS）。\n原始错误：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI 接口返回 ${res.status}：${text.slice(0, 400) || res.statusText}`);
  }

  const data = await res.json().catch(() => null);
  const content: string | undefined = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`AI 接口返回内容为空：${JSON.stringify(data).slice(0, 300)}`);
  }
  return content;
}

const SYSTEM_PROMPT = `你是一个专业的内容分析师。用户会给你一段视频的语音识别文稿（可能带有识别错误、口语化重复、缺少标点）。
请严格基于文稿内容输出 JSON，不要编造文稿中没有的信息。JSON 结构：
{
  "tldr": "一句话概括（不超过 80 字）",
  "bullets": ["要点1", "要点2", "..."],
  "keywords": ["关键词1", "关键词2", "..."]
}
要求：bullets 5~8 条，每条 15~40 字，按内容逻辑排序；keywords 6~12 个。全部使用简体中文输出。`;

function splitByLength(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[。！？!?；;\n])/u);
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > size && buf) {
      chunks.push(buf);
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) chunks.push(buf);
  return chunks;
}

function parseJsonLoose(text: string): { tldr?: string; bullets?: string[]; keywords?: string[] } {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* fallthrough */
      }
    }
    // 完全无法解析时，退化为按行拆分
    return {
      tldr: '',
      bullets: cleaned
        .split('\n')
        .map((l) => l.replace(/^[-*\d.、\s]+/, '').trim())
        .filter((l) => l.length > 3)
        .slice(0, 8),
      keywords: [],
    };
  }
}

/**
 * 用大模型生成摘要。长文稿会自动分段总结再汇总（map-reduce）。
 */
export async function summarizeWithLlm(
  segments: Segment[],
  settings: LlmSettings,
  callbacks: LlmCallbacks = {},
): Promise<SummaryResult> {
  if (!settings.apiKey.trim()) {
    throw new Error('请先填写 API Key。');
  }
  if (!settings.model.trim()) {
    throw new Error('请先填写模型名称（例如 gpt-4o-mini、deepseek-chat、qwen-plus）。');
  }

  const transcript = segments
    .map((s) => s.text)
    .join('\n')
    .trim();
  if (!transcript) throw new Error('没有可用于总结的字幕内容。');

  const chunks = splitByLength(transcript, CHUNK_CHARS);
  let material: string;

  if (chunks.length === 1) {
    material = transcript;
  } else {
    callbacks.onProgress?.(`文稿较长，分 ${chunks.length} 段总结中…`);
    const partials: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      callbacks.onProgress?.(`正在总结第 ${i + 1}/${chunks.length} 段…`);
      const part = await chatCompletion(
        settings,
        [
          { role: 'system', content: '你是内容分析师。请用简体中文分点提炼这段视频文稿的要点，保留关键事实、数字与结论，不要评论。' },
          { role: 'user', content: `这是第 ${i + 1}/${chunks.length} 部分文稿：\n\n${chunks[i]}` },
        ],
        { maxTokens: 800 },
      );
      partials.push(part);
    }
    material = partials.join('\n\n');
  }

  callbacks.onProgress?.('正在生成最终摘要…');
  const raw = await chatCompletion(
    settings,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `以下是视频文稿${chunks.length > 1 ? '（分段要点汇总）' : ''}：\n\n${material}` },
    ],
    { json: true, maxTokens: 1500 },
  );

  const parsed = parseJsonLoose(raw);
  const bullets = (parsed.bullets ?? []).map((b) => String(b).trim()).filter(Boolean);
  const keywords = (parsed.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);

  return {
    tldr: String(parsed.tldr ?? '').trim() || bullets[0] || '',
    bullets,
    keywords,
    engine: 'llm',
  };
}

/** 连通性测试：设置面板里的「测试连接」 */
export async function testLlmConnection(settings: LlmSettings): Promise<string> {
  const reply = await chatCompletion(
    settings,
    [
      { role: 'system', content: '你是一个连通性测试助手，只回复「连接成功」四个字。' },
      { role: 'user', content: '测试' },
    ],
    { maxTokens: 20 },
  );
  return reply.trim();
}
