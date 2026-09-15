/**
 * 轻量自测：验证纯算法部分（不可用时不会误报），不依赖浏览器 API。
 * 运行：node scripts/selftest.mjs
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = mkdtempSync(join(tmpdir(), 'v2t-selftest-'));

// 用 esbuild（vite 自带依赖）把 TS 模块编译成 ESM 供 Node 直接运行
const entry = join(outDir, 'entry.ts');
const modules = ['summarize', 'format', 'hallucination', 'whisperLang'];
writeFileSync(
  entry,
  modules.map((m) => `export * from ${JSON.stringify(join(root, 'src/lib', `${m}.ts`).replaceAll('\\', '/'))};`).join('\n'),
  'utf8',
);

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
try {
  execSync(
    `${npx} esbuild ${JSON.stringify(entry)} --bundle --format=esm --platform=node --outfile=${JSON.stringify(
      join(outDir, 'bundle.mjs'),
    )}`,
    { stdio: 'inherit', cwd: root, shell: true },
  );
} catch {
  console.error('无法调用 esbuild，请先运行 npm install');
  process.exit(1);
}

const lib = await import(`file://${join(outDir, 'bundle.mjs').replaceAll('\\', '/')}`);

let failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
};

/* ---------- format ---------- */
console.log('\n[format]');
check('formatSrtTime(0) === 00:00:00,000', lib.formatSrtTime(0) === '00:00:00,000', lib.formatSrtTime(0));
check('formatSrtTime(3661.5)', lib.formatSrtTime(3661.5) === '01:01:01,500', lib.formatSrtTime(3661.5));
check('formatVttTime 用点号', lib.formatVttTime(1.25) === '00:00:01.250', lib.formatVttTime(1.25));
check('formatClock(75) === 01:15', lib.formatClock(75) === '01:15', lib.formatClock(75));
check('safeBaseName 去掉扩展名', lib.safeBaseName('我的 视频.final.mp4') === '我的 视频.final', lib.safeBaseName('我的 视频.final.mp4'));

const segs = [
  { index: 0, start: 0, end: 2.5, text: '大家好，今天我们聊聊浏览器里的语音识别。' },
  { index: 1, start: 2.5, end: 6, text: 'Whisper 可以直接在本地运行，不需要上传视频。' },
];
const srt = lib.toSrt(segs);
check('SRT 序号与箭头正确', srt.startsWith('1\n00:00:00,000 --> 00:00:02,500\n'), JSON.stringify(srt.slice(0, 40)));
check('SRT 含两条', srt.includes('\n2\n'));
check('VTT 头部正确', lib.toVtt(segs).startsWith('WEBVTT\n\n'));
check('TXT 带时间戳', lib.toTxt(segs).startsWith('[00:00] 大家好'));
check('TXT 不带时间戳', lib.toTxt(segs, false).split('\n').length === 2);
const md = lib.toMarkdown({ fileName: 'demo.mp4', duration: 6, model: 'x', language: 'chinese' }, segs);
check('Markdown 含标题', md.includes('# demo.mp4'));
check('Markdown 含全文小节', md.includes('## 纯文本全文'));
const js = JSON.parse(lib.toJson({ fileName: 'demo.mp4' }, segs));
check('JSON 可解析且含 segments', Array.isArray(js.segments) && js.segments.length === 2);
check('buildExport 扩展名', lib.buildExport('srt', { fileName: 'a' }, segs).ext === 'srt');

/* ---------- summarize ---------- */
console.log('\n[summarize]');
const longSegs = [
  { index: 0, start: 0, end: 3, text: '人工智能正在改变视频内容的生产方式。' },
  { index: 1, start: 3, end: 6, text: '语音识别技术让字幕制作成本大幅下降。' },
  { index: 2, start: 6, end: 9, text: '浏览器端推理可以保护用户隐私数据。' },
  { index: 3, start: 9, end: 12, text: '我们演示了如何用 Whisper 提取字幕。' },
  { index: 4, start: 12, end: 15, text: '最后把结果导出成文本文档分享给同事。' },
];
const sum = lib.summarizeLocal(longSegs);
check('生成 tldr', typeof sum.tldr === 'string' && sum.tldr.length > 0, sum.tldr);
check('生成要点', sum.bullets.length > 0 && sum.bullets.length <= 7, String(sum.bullets.length));
check('要点来自原文', sum.bullets.every((b) => longSegs.some((s) => s.text.includes(b.slice(0, 6)))));
check('生成关键词', sum.keywords.length > 0, sum.keywords.join(','));
check('关键词含「语音识别」或「字幕」', sum.keywords.some((k) => k.includes('语音') || k.includes('字幕')), sum.keywords.join(','));

const enSum = lib.summarizeLocal([
  { index: 0, start: 0, end: 3, text: 'Machine learning models are getting smaller and faster.' },
  { index: 1, start: 3, end: 6, text: 'Running machine learning in the browser protects privacy.' },
]);
check('英文也能出关键词', enSum.keywords.length > 0, enSum.keywords.join(','));

check('空输入不崩溃', lib.summarizeLocal([]).bullets.length === 0);
check('句子切分按标点', lib.buildSentences(longSegs).length >= 3, String(lib.buildSentences(longSegs).length));

/* ---------- hallucination（幻觉过滤）---------- */
console.log('\n[hallucination]');
// 用户实际遇到的那种：中文视频被当成英语解码后，输出一小段外文无限重复
const loop = 'będziemyęgrać FER fundo MUSANG '.repeat(5).trim();
check('循环型幻觉被识别', lib.looksHallucinated(loop), lib.repetitionRatio(loop).toFixed(2));
check('标记型幻觉 [Spanish]', lib.looksHallucinated('[Spanish]'));
check('标记型幻觉 (Speaking in Japanese)', lib.looksHallucinated('(Speaking in Japanese)'));
check('标记型幻觉 [BLANK_AUDIO]', lib.looksHallucinated('[BLANK_AUDIO]'));
check('符号型幻觉 ♪♪♪', lib.looksHallucinated('♪♪♪'));
check('套话幻觉（点赞订阅）', lib.looksHallucinated('请不吝点赞订阅转发打赏支持明镜与点点栏目'));
check('套话幻觉（Amara 字幕组）', lib.looksHallucinated('字幕由 Amara.org 社区提供'));
check(
  '中文长句重复也判为幻觉',
  lib.looksHallucinated('请不吝点赞订阅转发打赏支持明镜与点点栏目'.repeat(4)),
);
// 正常内容绝不能被误伤
check('正常中文不会被误判', !lib.looksHallucinated('大家好，欢迎来到云原神的动画短片第二篇，今天讲讲游戏里的角色设计。'));
check('正常英文不会被误判', !lib.looksHallucinated('And so my fellow Americans, ask not what your country can do for you.'));
check('正常重复词不会被误判', !lib.looksHallucinated('好的好的，那我们就这么说定了，明天上午九点在公司楼下见。'));
check(
  '长句中含"订阅"不误判',
  !lib.looksHallucinated('如果你想继续了解这个系列的内容，可以点击订阅按钮，我们每周更新一期视频，感谢大家的支持与陪伴。'),
);

const chunk = lib.filterChunkSegments([
  { text: '[MUSIC]' },
  { text: '这是第一句真正的内容。' },
  { text: '这是第一句真正的内容。' },
  { text: loop },
  { text: '这是第二句真正的内容。' },
]);
check('过滤后只剩真实内容', chunk.kept.length === 2, chunk.kept.map((k) => k.text).join(' | '));
check('相邻完全重复被判为 duplicate', chunk.dropped.some((d) => d.reason === 'duplicate'));
check('循环文本被判为 repeat', chunk.dropped.some((d) => d.reason === 'repeat'));

const many = Array.from({ length: 5 }, (_, i) => ({ text: '相同的一句幻觉文本内容' }));
check('全片重复的句子会被整体剔除', lib.findGloballyRepeating(many).size === 5);
check(
  '短语气词不参与全片重复判定',
  lib.findGloballyRepeating(Array.from({ length: 6 }, () => ({ text: '嗯' }))).size === 0,
);

/* ---------- whisperLang（语种映射）---------- */
console.log('\n[whisperLang]');
check("whisperCodeOf('chinese') === 'zh'", lib.whisperCodeOf('chinese') === 'zh');
check("whisperCodeOf('zh') === 'zh'", lib.whisperCodeOf('zh') === 'zh');
check("whisperCodeOf('auto') === null", lib.whisperCodeOf('auto') === null);
check("whisperCodeOf('cantonese') === 'yue'", lib.whisperCodeOf('cantonese') === 'yue');
check("languageLabel('zh') === '中文'", lib.languageLabel('zh') === '中文');
check("languageLabel('en') === '英语'", lib.languageLabel('en') === '英语');
check('语言表覆盖 99 种', Object.keys(lib.WHISPER_LANGUAGE_LABELS).length === 99, String(Object.keys(lib.WHISPER_LANGUAGE_LABELS).length));
// 模型不支持的语言必须能被识别出来（否则会往 prompt 里塞 undefined token）
check('粤语在 whisper-base 里不受支持', lib.isSupportedByModel('yue', { '<|zh|>': 50260 }) === false);
check('中文在 whisper-base 里受支持', lib.isSupportedByModel('zh', { '<|zh|>': 50260 }) === true);
check('浏览器语言兜底 zh-CN → zh', lib.guessLanguageFromNavigator({ language: 'zh-CN', languages: ['zh-CN', 'en'] }) === 'zh');
check('浏览器语言兜底 en-US → en', lib.guessLanguageFromNavigator({ language: 'en-US', languages: ['en-US'] }) === 'en');
check('未知浏览器语言兜底 en', lib.guessLanguageFromNavigator({ language: 'xx-YY' }) === 'en');

rmSync(outDir, { recursive: true, force: true });

console.log('');
if (failed > 0) {
  console.error(`自测失败：${failed} 项未通过`);
  process.exit(1);
}
console.log('自测全部通过 ✅');
