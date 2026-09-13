/**
 * 直接用 GitHub REST API（Node 内置 fetch）部署仓库内容。
 *
 * 为什么不用 gh CLI：本机 GitHub 流量经过一个不稳的本地代理，
 * `gh api` 会间歇性返回 502；而 Node 直连配合重试稳定得多。
 * 若遇到 TLS 报错，请用 `node --use-system-ca` 运行（使用系统证书库）。
 *
 * 流程：blobs → tree → commit → 更新 ref → 启用 Pages
 *
 * 用法：
 *   $env:GH_TOKEN = (gh auth token)
 *   node --use-system-ca scripts/deploy-api.mjs [owner/repo] [branch]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = process.argv[2] || 'Polaris929-cloud/Video2Text-Studio';
const BRANCH = process.argv[3] || 'main';
const [OWNER, NAME] = REPO.split('/');
const API = 'https://api.github.com';

const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', '.npm-cache', '.edge-profile', '.edge-dbg', '.edge-dom', 'coverage', '.vite']);
const IGNORE_FILES = new Set([
  'install.log', 'build.log', 'typecheck.log', 'selftest.log', 'preview.log', 'deploy.log', 'sync.log',
  'dom.html', 'dom.out', 'dom.err', 'local-dom.html', 'edge-dom.err', 'edge.err', 'edge.out', 'pup.log',
]);
const IGNORE_EXT = new Set(['.log', '.tmp']);

const TOKEN = (() => {
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (process.env[k]) return process.env[k];
  }
  console.error('缺少凭据：请先执行 $env:GH_TOKEN = (gh auth token)');
  process.exit(1);
})();

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'v2t-deploy',
};

/**
 * 带退避重试的 API 调用。
 *
 * 本机 GitHub 流量经过一个本地代理，实测约 10% 的请求会抽到 502（响应体为空），
 * 尤其是连接刚建立的头几个请求。因此这里：
 *   - 读请求重试 10 次、写请求 6 次（避免重复写造成意外）
 *   - 退避 1.5s / 3s / 4.5s … 最长 9s
 *   - 调用前先做一次连通性预热
 */
async function api(path, { method = 'GET', body, allowStatus = [], attempts } = {}) {
  const maxAttempts = attempts ?? (method === 'GET' ? 10 : 6);
  let last = null;

  for (let i = 1; i <= maxAttempts; i++) {
    let res = null;
    let err = null;
    try {
      res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
        method,
        headers: { ...HEADERS, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) {
      err = e;
    }

    if (err) {
      last = { status: 0, data: null, error: err };
      if (i === maxAttempts) break;
      console.log(`  ⟳ ${method} ${path} 网络错误（${err.message}），重试 ${i}/${maxAttempts - 1}`);
      await new Promise((r) => setTimeout(r, Math.min(9000, 1500 * i)));
      continue;
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    last = { status: res.status, data };

    const retriable = res.status >= 500 || res.status === 429;
    if (!retriable || i === maxAttempts) break;
    console.log(`  ⟳ ${method} ${path} → ${res.status}，重试 ${i}/${maxAttempts - 1}`);
    await new Promise((r) => setTimeout(r, Math.min(9000, 1500 * i)));
  }

  if (last.status >= 400 && !allowStatus.includes(last.status)) {
    const msg = last.data && typeof last.data === 'object' ? last.data.message : String(last.data);
    throw new Error(`${method} ${path} → ${last.status} ${msg}`);
  }
  if (last.status === 0) {
    throw new Error(`${method} ${path} 网络失败：${last.error?.message}`);
  }
  return last;
}

/** 预热：本机代理在连接刚建立时最容易返回 502，先打一次把链路激活 */
async function warmUp() {
  for (let i = 1; i <= 8; i++) {
    try {
      const res = await fetch(`${API}/user`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      if (res.status === 200) {
        await res.json();
        if (i > 1) console.log(`  链路预热成功（第 ${i} 次尝试）`);
        return;
      }
      console.log(`  ⟳ 链路预热 ${i}/8 → ${res.status}`);
    } catch (e) {
      console.log(`  ⟳ 链路预热 ${i}/8 → ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log('  ⚠ 链路预热未成功，继续尝试部署（重试机制仍会生效）');
}

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (IGNORE_DIRS.has(entry)) continue;
      collectFiles(full, out);
      continue;
    }
    if (!info.isFile()) continue;
    if (IGNORE_FILES.has(entry)) continue;
    const dot = entry.lastIndexOf('.');
    if (dot > 0 && IGNORE_EXT.has(entry.slice(dot).toLowerCase())) continue;
    out.push({ rel: relative(ROOT, full).split(sep).join('/'), full });
  }
  return out;
}

function isBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

/* ---------------- 主流程 ---------------- */
console.log('预热 GitHub API 链路…');
await warmUp();

const me = (await api('/user')).data;
const author = {
  name: process.env.GIT_AUTHOR_NAME || me.name || me.login,
  email: process.env.GIT_AUTHOR_EMAIL || me.email || `${me.id}+${me.login}@users.noreply.github.com`,
};
console.log(`提交身份：${author.name} <${author.email}>`);

const homepage = `https://${OWNER.toLowerCase()}.github.io/${NAME}/`;
const existing = await api(`/repos/${OWNER}/${NAME}`, { allowStatus: [404] });
if (existing.status === 200) {
  console.log(`仓库已存在：${OWNER}/${NAME}`);
} else {
  console.log(`创建仓库 ${OWNER}/${NAME} …`);
  await api('/user/repos', {
    method: 'POST',
    body: {
      name: NAME,
      description: '🎬 浏览器内本地 Whisper 语音识别提取视频字幕，并自动总结内容导出文本文档（纯前端，视频不上传）',
      homepage,
      private: false,
      has_issues: true,
      auto_init: true,
    },
  });
}

/* 1) 确保分支存在（空仓库不能用 Git Data API） */
let ref = await api(`/repos/${OWNER}/${NAME}/git/ref/heads/${BRANCH}`, { allowStatus: [404, 409] });
if (ref.status !== 200) {
  console.log('初始化仓库…');
  await api(`/repos/${OWNER}/${NAME}/contents/README.md`, {
    method: 'PUT',
    allowStatus: [409, 422],
    body: {
      message: '[skip ci] chore: 初始化仓库',
      content: Buffer.from('# init\n', 'utf8').toString('base64'),
      branch: BRANCH,
    },
  });
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    ref = await api(`/repos/${OWNER}/${NAME}/git/ref/heads/${BRANCH}`, { allowStatus: [404, 409] });
    if (ref.status === 200) break;
  }
  if (ref.status !== 200) throw new Error('仓库初始化失败：分支仍未创建');
}
const parent = ref.data.object.sha;
const parentCommit = (await api(`/repos/${OWNER}/${NAME}/git/commits/${parent}`)).data;
console.log(`当前 ${BRANCH} → ${parent.slice(0, 10)}（${(parentCommit.message || '').split('\n')[0].slice(0, 40)}）`);

/* 2) 上传 blobs */
const files = collectFiles(ROOT).sort((a, b) => a.rel.localeCompare(b.rel));
console.log(`待上传文件 ${files.length} 个`);
const tree = [];
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const buf = readFileSync(f.full);
  const binary = isBinary(buf);
  const r = await api(`/repos/${OWNER}/${NAME}/git/blobs`, {
    method: 'POST',
    body: binary ? { content: buf.toString('base64'), encoding: 'base64' } : { content: buf.toString('utf8'), encoding: 'utf-8' },
  });
  tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: r.data.sha });
  process.stdout.write(`\r  上传 ${i + 1}/${files.length}  ${f.rel.slice(0, 52).padEnd(52)}`);
}
process.stdout.write('\n');

/* 3) tree → commit → ref */
const newTree = (await api(`/repos/${OWNER}/${NAME}/git/trees`, { method: 'POST', body: { tree } })).data;
const message = process.env.COMMIT_MESSAGE || 'feat: Video2Text Studio —— 浏览器内 Whisper 字幕提取与内容总结';
const now = new Date().toISOString();
const commit = (
  await api(`/repos/${OWNER}/${NAME}/git/commits`, {
    method: 'POST',
    body: {
      message,
      tree: newTree.sha,
      parents: [parent],
      author: { ...author, date: now },
      committer: { ...author, date: now },
    },
  })
).data;
console.log(`提交已创建：${commit.sha.slice(0, 10)}`);

await api(`/repos/${OWNER}/${NAME}/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
console.log(`分支 ${BRANCH} 已更新`);

/* 4) Pages */
let pagesUrl = homepage;
const pages = await api(`/repos/${OWNER}/${NAME}/pages`, { allowStatus: [404, 409, 422] });
if (pages.status === 200) {
  pagesUrl = pages.data?.html_url || homepage;
  console.log(`Pages 已启用：${pagesUrl}`);
} else {
  try {
    const created = await api(`/repos/${OWNER}/${NAME}/pages`, { method: 'POST', body: { build_type: 'workflow' } });
    pagesUrl = created.data?.html_url || homepage;
    console.log(`Pages 已启用：${pagesUrl}`);
  } catch (err) {
    console.log(`未能自动启用 Pages：${err.message}`);
  }
}

await api(`/repos/${OWNER}/${NAME}`, { method: 'PATCH', body: { homepage: pagesUrl } }).catch(() => undefined);

console.log('\n完成 ✅');
console.log(`仓库：https://github.com/${OWNER}/${NAME}`);
console.log(`在线：${pagesUrl}`);
console.log(`tree: ${newTree.sha}`);
console.log(`提交: ${commit.sha}`);
