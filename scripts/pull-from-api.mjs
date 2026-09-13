/**
 * 把远端某个提交的整棵树同步到本地工作区（逐字节）。
 *
 * 用途：本机 git over HTTPS 不稳定时，用 GitHub API 拉取内容，
 * 让本地工作区与远端完全一致，避免后续操作基于陈旧内容。
 *
 * 用法：
 *   $env:GH_TOKEN = (gh auth token)
 *   node --use-system-ca scripts/pull-from-api.mjs [owner/repo] [ref]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = process.argv[2] || 'Polaris929-cloud/Video2Text-Studio';
const REF = process.argv[3] || 'main';
const API = 'https://api.github.com';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('请先设置 GH_TOKEN（$env:GH_TOKEN = (gh auth token)）');
  process.exit(1);
}

async function api(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'v2t-pull',
    },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const ref = await api(`/repos/${REPO}/git/ref/heads/${REF}`);
const commit = await api(`/repos/${REPO}/git/commits/${ref.object.sha}`);
console.log(`远端 ${REF} = ${ref.object.sha.slice(0, 10)}  tree = ${commit.tree.sha.slice(0, 10)}`);

const tree = await api(`/repos/${REPO}/git/trees/${commit.tree.sha}?recursive=1`);
if (tree.truncated) console.warn('⚠ 树被截断（仓库过大），结果可能不完整');

const blobs = (tree.tree ?? []).filter((e) => e.type === 'blob');
console.log(`共 ${blobs.length} 个文件，开始写入…`);

let n = 0;
for (const entry of blobs) {
  const blob = await api(`/repos/${REPO}/git/blobs/${entry.sha}`);
  const buf = Buffer.from(blob.content, 'base64');
  const dest = join(ROOT, entry.path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  n++;
  process.stdout.write(`\r  ${n}/${blobs.length}  ${entry.path.slice(0, 56).padEnd(56)}`);
}
process.stdout.write('\n');

// 清掉远端已删除、本地还残留的受版本控制文件
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);
const remotePaths = new Set(blobs.map((b) => b.path));
const stale = tracked.filter((p) => !remotePaths.has(p));
for (const p of stale) {
  try {
    rmSync(join(ROOT, p), { force: true });
    console.log(`  已删除本地多余文件: ${p}`);
  } catch {
    /* ignore */
  }
}

console.log('\n完成。远端内容已同步到本地工作区。');
