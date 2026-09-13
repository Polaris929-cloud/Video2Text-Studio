/**
 * 通过 GitHub API 把某个远端提交"重建"到本地仓库，使本地与远端对齐。
 *
 * 适用场景：git over HTTPS 不可用（本机 schannel 取不到凭据）时，
 * 用 API 完成了推送，但本地 git 还没有那次提交。
 *
 * 做法：
 *   1. gh api 读取远端提交的 tree / message / author
 *   2. 本地用同一 tree 指定的 parent 创建 commit（不重新计算内容）
 *   3. 把本地分支指向它
 *
 * 用法：node scripts/sync-local.mjs [owner/repo] [branch]
 */

import { exec, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(exec);
const ROOT = resolve(import.meta.dirname, '..');
const REPO = process.argv[2] || 'Polaris929-cloud/Video2Text-Studio';
const BRANCH = process.argv[3] || 'main';

function ghJson(endpoint) {
  const out = join(process.env.TEMP, `v2t-sync-${randomUUID()}.json`);
  try {
    execSync(`gh api "${endpoint}" > "${out}" 2>nul`, { windowsHide: true, shell: 'cmd.exe' });
    return JSON.parse(readFileSync(out, 'utf8'));
  } catch (err) {
    throw new Error(`gh api ${endpoint} 失败: ${err.message}`);
  }
}

function git(args) {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim();
}

const remoteSha = ghJson(`/repos/${REPO}/git/ref/heads/${BRANCH}`).object.sha;
const remote = ghJson(`/repos/${REPO}/git/commits/${remoteSha}`);
console.log(`远端 ${BRANCH} = ${remoteSha.slice(0, 10)}`);
console.log(`  tree    : ${remote.tree.sha.slice(0, 10)}`);
console.log(`  message : ${remote.message.split('\n')[0]}`);

const localHead = git('rev-parse HEAD');
if (localHead === remoteSha) {
  console.log('本地已经与远端一致，无需处理。');
  process.exit(0);
}

// 把远端 tree 拉进本地对象库（tree 里引用的 blob 已存在于本地：内容完全相同）
let treeSha;
try {
  git(`cat-file -e ${remote.tree.sha}`);
  treeSha = remote.tree.sha;
  console.log('本地已有该 tree 对象，直接复用。');
} catch {
  throw new Error(
    `本地缺少 tree 对象 ${remote.tree.sha}。请先让本地工作区与远端内容一致（例如重新克隆），再运行本脚本。`,
  );
}

const author = remote.author ?? {};
const committer = remote.committer ?? author;
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: author.name ?? '',
  GIT_AUTHOR_EMAIL: author.email ?? '',
  GIT_AUTHOR_DATE: author.date ?? new Date().toISOString(),
  GIT_COMMITTER_NAME: committer.name ?? '',
  GIT_COMMITTER_EMAIL: committer.email ?? '',
  GIT_COMMITTER_DATE: committer.date ?? new Date().toISOString(),
};

// 写入 message 到临时文件，避免转义问题
const msgFile = join(process.env.TEMP, `v2t-msg-${randomUUID()}.txt`);
writeFileSync(msgFile, remote.message, 'utf8');

const newSha = execSync(`git commit-tree ${treeSha} -p ${localHead} -F "${msgFile}"`, {
  cwd: ROOT,
  encoding: 'utf8',
  env,
}).trim();

git(`update-ref refs/heads/${BRANCH} ${newSha}`);
console.log(`\n本地已重建提交：${newSha.slice(0, 10)}`);

if (newSha === remoteSha) {
  console.log('✅ 本地提交哈希与远端完全一致（内容、作者、时间都对上了）');
} else {
  console.log(`ℹ️ 本地哈希 ${newSha.slice(0, 10)} 与远端 ${remoteSha.slice(0, 10)} 不同（时间戳格式差异），但 tree 一致、内容相同。`);
}

console.log('\n当前本地 log:');
console.log(git('log --oneline -3'));
