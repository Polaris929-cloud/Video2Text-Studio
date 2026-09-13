/**
 * 一键把当前项目发布到远端 GitHub 仓库。
 *
 * 背景（本机环境限制）：
 *   - hosts 把 github.com / api.github.com 指向 127.0.0.1，本地存在一个只放行特定进程的代理；
 *     结果：gh CLI 可用，但 Node 的 fetch / curl / git over HTTPS 全部不可用。
 *   - 因此这里**全程通过 `gh api`** 调用 GitHub REST + Git Data API 完成建仓与推送。
 *   - 沙箱禁止管道 stdio，所以 gh 的输出统一用「重定向到文件」的方式采集（不经过管道）。
 *
 * 用法：
 *   $env:GH_TOKEN = (gh auth token); node scripts/github-deploy.mjs [owner/repo]
 */

import { exec } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(exec);

const REPO = process.argv[2] || 'Polaris929-cloud/Video2Text-Studio';
const [OWNER, NAME] = REPO.split('/');
const BRANCH = 'main';
const ROOT = resolve(import.meta.dirname, '..');
const GH = process.platform === 'win32' ? 'gh.exe' : 'gh';
const CMD = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', '.npm-cache', '.edge-profile', 'coverage', '.vite']);
const IGNORE_FILES = new Set([
  'install.log', 'build.log', 'typecheck.log', 'selftest.log', 'preview.log', 'deploy.log',
  'dom.html', 'dom.out', 'dom.err',
]);
const IGNORE_EXT = new Set(['.log', '.tmp']);

const work = mkdtempSync(join(tmpdir(), 'v2t-deploy-'));
const bodyFile = join(work, 'body.json');
const outFile = join(work, 'out.json');
const errFile = join(work, 'err.txt');

const hasToken = Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
const verbose = process.env.DEPLOY_VERBOSE === '1';
if (!hasToken) {
  console.error('缺少凭据。请先执行：$env:GH_TOKEN = (gh auth token)');
  process.exit(1);
}

function cleanup() {
  rmSync(work, { recursive: true, force: true });
}

/**
 * 调用 gh api，返回解析后的 JSON。
 * 走 cmd.exe 重定向到文件，避免管道 stdio 被沙箱拒绝。
 *
 * 本机 GitHub 流量经过一个本地代理，偶发 502/超时，因此这里对
 * 5xx 与网络类错误做自动重试（对 4xx 不重试，那些是真实的业务错误）。
 */
async function ghApi(endpoint, { method = 'GET', body, allowStatus = [], jq } = {}) {
  const MAX_ATTEMPTS = 4;
  let lastResult = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await ghApiOnce(endpoint, { method, body, allowStatus, jq });
    lastResult = result;

    const retriable = result.status >= 500 || result.status === 0 || result.status === 429;
    if (!retriable || attempt === MAX_ATTEMPTS) return result;

    const wait = 1000 * attempt;
    console.log(`  ⟳ ${method} ${endpoint} 返回 ${result.status}，${wait}ms 后重试（${attempt}/${MAX_ATTEMPTS - 1}）`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return lastResult;
}

async function ghApiOnce(endpoint, { method = 'GET', body, allowStatus = [], jq } = {}) {
  const parts = [`"${GH}"`, 'api', `"${endpoint}"`];
  if (method !== 'GET') parts.push('--method', method);
  if (body !== undefined) {
    writeFileSync(bodyFile, JSON.stringify(body), 'utf8');
    parts.push('--input', `"${bodyFile}"`);
  }
  if (jq) parts.push('--jq', `"${jq.replace(/"/g, '\\"')}"`);
  parts.push('--include');

  const line = `${parts.join(' ')} > "${outFile}" 2> "${errFile}"`;
  try {
    // 用 exec（整条命令交给 shell）而不是 execFile：execFile 会再包一层引号，导致 cmd 报"语法不正确"
    await run(line, { windowsHide: true });
  } catch {
    // gh 非 0 退出：真正的错误在 errFile / outFile 里，下面统一解析
  }

  const raw = safeRead(outFile);
  const errText = safeRead(errFile).trim();
  if (verbose) {
    console.log(`\n[gh] ${method} ${endpoint}\n${raw.slice(0, 2000)}${errText ? `\n[stderr] ${errText.slice(0, 1000)}` : ''}`);
  }

  // 拆分 --include 产生的响应头与响应体。
  // 注意：gh 输出的响应头行尾可能是 \n 与 \r\n 混用，所以按「空行」扫描定位，而不是写死分隔符。
  let bodyStart = 0;
  {
    let i = 0;
    while (i < raw.length) {
      const nl = raw.indexOf('\n', i);
      if (nl < 0) break;
      const lineText = raw.slice(i, nl).replace(/\r$/, '');
      if (lineText === '') {
        bodyStart = nl + 1;
        break;
      }
      i = nl + 1;
    }
  }
  const head = raw.slice(0, bodyStart);
  const text = raw.slice(bodyStart);

  let status = 200;
  const statusMatches = [...head.matchAll(/^HTTP\/[\d.]+ (\d{3})/gm)];
  if (statusMatches.length) status = Number(statusMatches[statusMatches.length - 1][1]);

  let data = null;
  try {
    data = text.trim() ? JSON.parse(text) : null;
  } catch {
    data = text.trim();
  }

  if (status >= 400 && !allowStatus.includes(status)) {
    const message =
      (data && typeof data === 'object' && data.message) || errText || `HTTP ${status}`;
    throw new Error(`${method} ${endpoint} → ${status} ${message}`);
  }
  return { status, data, text };
}

function safeRead(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (IGNORE_DIRS.has(entry)) continue;
      collectFiles(full, out);
      continue;
    }
    if (!statSync(full).isFile()) continue;
    if (IGNORE_FILES.has(entry)) continue;
    const dot = entry.lastIndexOf('.');
    if (dot > 0 && IGNORE_EXT.has(entry.slice(dot).toLowerCase())) continue;
    out.push({ rel: relative(ROOT, full).split(sep).join('/'), full, size: statSync(full).size });
  }
  return out;
}

function isBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

async function ensureRepo(author, description, homepage) {
  const { status } = await ghApi(`/repos/${OWNER}/${NAME}`, { allowStatus: [404, 403, 451] });
  if (status === 200) {
    console.log(`仓库已存在：${OWNER}/${NAME}`);
    return;
  }
  console.log(`正在创建仓库 ${OWNER}/${NAME} …`);
  // auto_init 让 GitHub 生成一个初始提交：空仓库无法通过 Git Data API 创建 blob（409 Git Repository is empty）
  const { data } = await ghApi('/user/repos', {
    method: 'POST',
    body: {
      name: NAME,
      description,
      homepage,
      private: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: true,
    },
  });
  console.log(`创建成功：${data.html_url}`);
  void author;
}

async function main() {
  const { data: user } = await ghApi('/user');
  const author = {
    name: process.env.GIT_AUTHOR_NAME || user.name || user.login,
    email: process.env.GIT_AUTHOR_EMAIL || user.email || `${user.id}+${user.login}@users.noreply.github.com`,
  };
  console.log(`提交身份：${author.name} <${author.email}>`);

  const homepage = `https://${OWNER.toLowerCase()}.github.io/${NAME}/`;
  await ensureRepo(
    author,
    '🎬 浏览器内本地 Whisper 语音识别提取视频字幕，并自动总结内容导出文本文档（纯前端，视频不上传）',
    homepage,
  );

  /* ---------- 1) 先确认分支存在 ---------- */
  // 空仓库（0 提交）无法使用 Git Data API（会返回 409 Git Repository is empty），
  // 因此先用 contents API 写入一个 README 触发初始化。
  let head = await ghApi(`/repos/${OWNER}/${NAME}/git/ref/heads/${BRANCH}`, { allowStatus: [404, 409] });
  if (head.status !== 200) {
    console.log('仓库还没有提交，正在初始化…');
    await ghApi(`/repos/${OWNER}/${NAME}/contents/README.md`, {
      method: 'PUT',
      allowStatus: [409, 422],
      body: {
        message: '[skip ci] chore: 初始化仓库',
        content: Buffer.from('# init\n', 'utf8').toString('base64'),
        branch: BRANCH,
      },
    });
    for (let attempt = 0; attempt < 5 && head.status !== 200; attempt++) {
      await new Promise((r) => setTimeout(r, 1200));
      head = await ghApi(`/repos/${OWNER}/${NAME}/git/ref/heads/${BRANCH}`, { allowStatus: [404, 409] });
    }
    if (head.status !== 200) throw new Error('仓库初始化失败：分支仍未创建，请稍后重试。');
  }

  const parent = head.data.object.sha;
  const { data: parentCommit } = await ghApi(`/repos/${OWNER}/${NAME}/git/commits/${parent}`);
  const parentMessage = parentCommit?.message ?? '';
  console.log(`当前分支 ${BRANCH} → ${parent.slice(0, 10)}（${parentMessage.split('\n')[0].slice(0, 40)}）`);

  /* ---------- 2) 上传 blobs ---------- */
  const files = collectFiles(ROOT).sort((a, b) => a.rel.localeCompare(b.rel));
  console.log(`待上传文件 ${files.length} 个`);
  const tree = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const buf = readFileSync(file.full);
    const binary = isBinary(buf);
    const { data } = await ghApi(`/repos/${OWNER}/${NAME}/git/blobs`, {
      method: 'POST',
      body: binary
        ? { content: buf.toString('base64'), encoding: 'base64' }
        : { content: buf.toString('utf8'), encoding: 'utf-8' },
    });
    tree.push({ path: file.rel, mode: '100644', type: 'blob', sha: data.sha });
    process.stdout.write(`\r  上传 ${i + 1}/${files.length}  ${file.rel.slice(0, 52).padEnd(52)}`);
  }
  process.stdout.write('\n');

  /* ---------- 3) 创建 tree ---------- */
  const { data: newTree } = await ghApi(`/repos/${OWNER}/${NAME}/git/trees`, {
    method: 'POST',
    body: { tree },
  });

  /* ---------- 4) 创建 commit ---------- */
  const message = process.env.COMMIT_MESSAGE || 'feat: Video2Text Studio —— 浏览器内 Whisper 字幕提取与内容总结';
  const now = new Date().toISOString();
  const { data: commit } = await ghApi(`/repos/${OWNER}/${NAME}/git/commits`, {
    method: 'POST',
    body: {
      message,
      tree: newTree.sha,
      parents: [parent],
      author: { ...author, date: now },
      committer: { ...author, date: now },
    },
  });
  console.log(`提交已创建：${commit.sha.slice(0, 10)}`);

  /* ---------- 5) 推进分支 ---------- */
  await ghApi(`/repos/${OWNER}/${NAME}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: { sha: commit.sha, force: false },
  });
  console.log(`分支 ${BRANCH} 已更新`);

  /* ---------- 6) 启用 GitHub Pages（Actions 构建模式） ---------- */
  let pagesUrl = homepage;
  const existing = await ghApi(`/repos/${OWNER}/${NAME}/pages`, { allowStatus: [404, 409, 422, 451] });
  if (existing.status === 200) {
    pagesUrl = existing.data?.html_url || homepage;
    console.log(`Pages 已启用：${pagesUrl}`);
  } else {
    try {
      const created = await ghApi(`/repos/${OWNER}/${NAME}/pages`, {
        method: 'POST',
        body: { build_type: 'workflow' },
      });
      pagesUrl = created.data?.html_url || homepage;
      console.log(`Pages 已启用：${pagesUrl}`);
    } catch (err) {
      console.log(`未能自动启用 Pages（可手动到 Settings → Pages 选择 "GitHub Actions"）：${err.message}`);
    }
  }

  await ghApi(`/repos/${OWNER}/${NAME}`, { method: 'PATCH', body: { homepage: pagesUrl } }).catch(() => undefined);

  console.log('\n完成 ✅');
  console.log(`仓库地址：https://github.com/${OWNER}/${NAME}`);
  console.log(`在线地址：${pagesUrl}  （首次需等 Actions 构建 1~2 分钟）`);
  console.log(`提交 SHA：${commit.sha}`);
}

main()
  .catch((err) => {
    console.error('\n部署失败：', err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
