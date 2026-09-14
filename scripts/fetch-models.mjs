/**
 * 把内置 Whisper 模型下载到站点目录（默认 public/models），让模型与站点同源。
 *
 * 为什么需要这一步：
 *   huggingface.co 在国内连不上（TCP 被阻断，浏览器连第一个字节都收不到），
 *   而 hf-mirror 之类的镜像站返回的 CORS 响应头只允许 huggingface.co，
 *   第三方站点（GitHub Pages）在浏览器里跨域取模型会被直接拦截。
 *   把模型文件放到站点自己的目录下，这两个问题就都不存在了。
 *
 * 用法：
 *   node scripts/fetch-models.mjs                # → public/models
 *   node scripts/fetch-models.mjs dist/models    # → 指定目录
 *   ONLY=onnx-community/whisper-tiny node scripts/fetch-models.mjs
 *
 * 说明：
 *   - 会依次尝试 huggingface.co / hf-mirror.net / aifasthub.com / hf-mirror.com，
 *     自动用第一个能通的（CI 在美国用官方源，国内用镜像）。
 *   - 已存在且大小一致的文件会跳过，可反复执行（配合 CI 缓存）。
 *   - 只内置 q8 量化精度（体积最小、质量够用）；其它精度仍走在线来源。
 */

import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { rm } from 'node:fs/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = resolve(ROOT, process.argv[2] || 'public/models');

/** 内置模型清单（保持 id 与 transformers.js 使用的一致） */
const MODELS = [
  { id: 'onnx-community/whisper-tiny', label: 'Whisper Tiny · q8' },
  { id: 'onnx-community/whisper-base', label: 'Whisper Base · q8' },
];

/** 必需文件：缺任何一个，这个模型就算没下成功 */
const REQUIRED_FILES = [
  'config.json',
  'tokenizer.json',
  'preprocessor_config.json',
  'generation_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

/** 可选文件：有就一起下，没有也不影响 */
const OPTIONAL_FILES = ['tokenizer_config.json', 'special_tokens_map.json', 'vocab.json', 'merges.txt'];

const HOSTS = [
  'https://huggingface.co/',
  'https://hf-mirror.net/',
  'https://aifasthub.com/',
  'https://hf-mirror.com/',
];

const REQUEST_TIMEOUT = 30_000;

const only = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const models = only.length > 0 ? MODELS.filter((m) => only.includes(m.id)) : MODELS;

function timeout(ms, message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

const fmtMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/** 找一个能用的模型源 */
async function pickHost(modelId) {
  for (const host of HOSTS) {
    const url = `${host}${modelId}/resolve/main/config.json`;
    const { signal, cancel } = timeout(15_000, 'probe timeout');
    try {
      const res = await fetch(url, { signal });
      if (res.ok) {
        const text = await res.text();
        if (text.trimStart().startsWith('{')) {
          console.log(`  可用来源：${host.replace(/\/$/, '')}`);
          return host;
        }
      }
      await res.body?.cancel().catch(() => undefined);
    } catch {
      /* 换下一个 */
    } finally {
      cancel();
    }
  }
  return null;
}

/** 下载单个文件；返回 'ok' | 'missing' | 抛错 */
async function downloadFile(hosts, modelId, file, target) {
  // 已存在且非空的文件直接跳过（配合 CI 缓存可大幅省时间）
  try {
    const info = await stat(target);
    if (info.size > 0 && !process.env.FORCE_DOWNLOAD) {
      console.log(`  ✓ 已存在 ${file}（${fmtMB(info.size)}）`);
      return 'ok';
    }
  } catch {
    /* 不存在，继续下载 */
  }

  let lastError = '';

  for (const host of hosts) {
    const url = `${host}${modelId}/resolve/main/${file}`;
    const { signal, cancel } = timeout(600_000, 'download timeout');
    const part = `${target}.part`;
    try {
      const res = await fetch(url, { signal });
      if (res.status === 404) {
        cancel();
        return 'missing';
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        cancel();
        continue;
      }

      const total = Number(res.headers.get('content-length')) || 0;
      await mkdir(dirname(target), { recursive: true });

      let written = 0;
      let lastLog = 0;
      const stream = createWriteStream(part);
      const source = Readable.fromWeb(res.body);
      source.on('data', (chunk) => {
        written += chunk.length;
        const now = Date.now();
        if (now - lastLog > 3000) {
          lastLog = now;
          const pct = total > 0 ? ` ${Math.round((written / total) * 100)}%` : '';
          console.log(`    ↓ ${file}${pct} ${fmtMB(written)}${total > 0 ? `/${fmtMB(total)}` : ''}`);
        }
      });

      await pipeline(source, stream);
      cancel();

      if (total > 0 && written !== total) {
        await rm(part, { force: true });
        lastError = `大小不一致（收到 ${written} / 期望 ${total}）`;
        continue;
      }
      if (written === 0) {
        await rm(part, { force: true });
        lastError = '下载内容为空';
        continue;
      }

      await rm(target, { force: true });
      await rename(part, target);
      console.log(`  ✓ ${file}（${fmtMB(written)}）`);
      return 'ok';
    } catch (err) {
      cancel();
      await rm(`${target}.part`, { force: true }).catch(() => undefined);
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(`下载 ${file} 失败：${lastError}`);
}

const summary = [];

for (const model of models) {
  console.log(`\n▶ ${model.label}（${model.id}）`);
  const host = await pickHost(model.id);
  if (!host) {
    console.error(`  ✗ 没有任何来源可用，跳过 ${model.id}`);
    summary.push({ id: model.id, ok: false, reason: '所有来源都不可达' });
    continue;
  }

  const hosts = [host, ...HOSTS.filter((h) => h !== host)];
  const targetDir = join(OUT_DIR, model.id);
  let bytes = 0;
  let failed = false;

  for (const file of REQUIRED_FILES) {
    try {
      const result = await downloadFile(hosts, model.id, file, join(targetDir, file));
      if (result === 'missing') {
        console.error(`  ✗ 缺失必需文件 ${file}`);
        failed = true;
      }
    } catch (err) {
      console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
      failed = true;
    }
  }

  for (const file of OPTIONAL_FILES) {
    try {
      await downloadFile(hosts, model.id, file, join(targetDir, file));
    } catch {
      console.log(`  · 可选文件 ${file} 未取得，忽略`);
    }
  }

  for (const file of REQUIRED_FILES) {
    try {
      bytes += (await stat(join(targetDir, file))).size;
    } catch {
      /* 已在上面的分支统计过失败 */
    }
  }

  summary.push({ id: model.id, ok: !failed, bytes });
  console.log(`  → ${failed ? '不完整' : '完成'}：${fmtMB(bytes)}（q8）`);
}

const okCount = summary.filter((s) => s.ok).length;
await mkdir(OUT_DIR, { recursive: true });
await writeFile(
  join(OUT_DIR, 'manifest.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      dtype: 'q8',
      models: summary,
    },
    null,
    2,
  ),
  'utf8',
);

console.log(`\n内置模型目录：${OUT_DIR}`);
console.log(`结果：${okCount}/${summary.length} 个模型可用`);
if (okCount === 0) {
  console.error('⚠️ 一个模型都没下到，请检查网络 / 代理设置。');
  process.exit(1);
}
