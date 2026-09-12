/**
 * 检查 Pages 构建结果与线上站点是否可访问。
 *
 * 用法：node scripts/verify-pages.mjs [owner/repo]
 */

import { exec } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(exec);
const REPO = process.argv[2] || 'Polaris929-cloud/Video2Text-Studio';
const SITE = `https://${REPO.split('/')[0].toLowerCase()}.github.io/${REPO.split('/')[1]}/`;

function gh(args) {
  const out = join(process.env.TEMP, `v2t-gh-${randomUUID()}.json`);
  // 走文件重定向而非管道：沙箱禁止管道 stdio
  return run(`gh ${args} > "${out}" 2>&1`, { windowsHide: true })
    .catch(() => undefined)
    .then(() => {
      const text = readFileSync(out, 'utf8');
      return text;
    });
}

async function waitForRuns() {
  for (let i = 0; i < 60; i++) {
    const out = await gh(`run list --repo ${REPO} --limit 3 --json status,conclusion,displayTitle,createdAt,url`);
    let runs = [];
    try {
      runs = JSON.parse(out);
    } catch {
      console.log(`  (第 ${i + 1} 次查询未取得结果，重试…)`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const run0 = runs[0];
    if (run0 && (run0.status === 'completed' || run0.status === 'failure')) {
      return run0;
    }
    console.log(`  [${i + 1}] 状态：${run0?.status ?? '未知'} …`);
    await new Promise((r) => setTimeout(r, 10000));
  }
  return null;
}

const latest = await waitForRuns();
if (latest) {
  console.log(`\nActions 结果：${latest.status} / ${latest.conclusion}`);
  console.log(`  标题：${latest.displayTitle}`);
  console.log(`  链接：${latest.url}`);
} else {
  console.log('\n未在时限内等到运行结束。');
}

// 用 gh api 抓取静态站点（gh 是唯一能出网的通道）
let ok = false;
for (let i = 0; i < 30; i++) {
  const out = await gh(`api "repos/${REPO}/pages/builds/latest"`);
  let info = null;
  try {
    info = JSON.parse(out);
  } catch {
    /* ignore */
  }
  if (info?.status === 'built') {
    console.log(`\nPages 构建状态：built  (${info.created_at})`);
    ok = true;
    break;
  }
  console.log(`  [${i + 1}] Pages 构建状态：${info?.status ?? '未知'}`);
  await new Promise((r) => setTimeout(r, 10000));
}

console.log(`\n站点地址：${SITE}`);
console.log(`请用浏览器直接打开上面的地址确认（本项目环境无法启动浏览器验证）。`);
writeFileSync(join(process.env.TEMP, 'v2t-pages-result.txt'), `${ok}\n${SITE}\n`, 'utf8');
