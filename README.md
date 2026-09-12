# 🎬 Video2Text Studio

> **导入视频 → 本地语音识别提取字幕 → 自动总结内容 → 导出文本文档。**
> 纯前端、零后端、零 API 费用。视频**不会上传到任何服务器**，语音识别在你的浏览器里完成。

[![Deploy to GitHub Pages](https://github.com/Polaris929-cloud/Video2Text-Studio/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/Polaris929-cloud/Video2Text-Studio/actions/workflows/deploy-pages.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

🌐 **在线使用**：https://polaris929-cloud.github.io/Video2Text-Studio/

---

## ✨ 功能

| 功能 | 说明 |
| --- | --- |
| 🎥 视频导入 | 拖拽或选择本地视频/音频文件，支持 MP4 / MOV / WebM / MP3 / M4A / WAV 等浏览器可解码的格式 |
| 🗣️ 语音识别 | 基于 **Whisper**（transformers.js + ONNX Runtime Web），在浏览器内本地推理，**无需 API Key** |
| 🌍 多语言 | 中文、英文、日语、韩语、粤语等 15 种语言，可自动检测 |
| ⚡ 硬件加速 | 自动优先使用 **WebGPU**，不支持时回退 WASM（CPU）；所选精度缺失时会自动换用其它精度，不会卡住 |
| 📝 字幕文稿 | 带时间戳的字幕列表，点击任意一条可跳转到视频对应位置播放，支持搜索 |
| 🧠 内容总结 | 默认**本地抽取式摘要**（TextRank/MMR + 关键词，免配置）；也可接入任意 OpenAI 兼容接口获得 AI 生成式摘要 |
| 📄 导出文档 | 一键导出 **Markdown 文本文档**、纯文本 TXT、字幕 SRT / VTT、结构化 JSON |
| 🔒 隐私优先 | 视频、音频、字幕全程留在本机；唯一的联网行为是下载模型与可选的 AI 摘要 |
| 💾 断点保留 | 识别结果自动存在浏览器本地，刷新页面不会丢；模型也会被浏览器缓存，第二次使用无需重新下载 |

---

## 🚀 快速开始

### 方式一：直接用在线版（推荐）

打开 **https://polaris929-cloud.github.io/Video2Text-Studio/** 即可，无需安装任何东西。

> 首次使用需要联网下载语音模型（Tiny 约 40 MB / Base 约 80 MB），之后会被浏览器缓存。

### 方式二：本地运行

```bash
git clone https://github.com/Polaris929-cloud/Video2Text-Studio.git
cd Video2Text-Studio
npm install
npm run dev          # 打开 http://127.0.0.1:5173
```

构建静态产物：

```bash
npm run build        # 类型检查 + 构建，输出到 dist/
npm run preview      # 本地预览构建结果
npm test             # 运行纯算法自测（导出格式 / 摘要算法）
```

`dist/` 是纯静态文件，可以丢到任意静态托管（GitHub Pages / Vercel / Netlify / Nginx）。

如果 `vite preview` 在你的机器上不可用，仓库还带了一个零依赖的静态服务器：

```bash
node scripts/serve.mjs 4173 dist   # 然后打开 http://127.0.0.1:4173/
```

### 方式三：发布 / 更新自己的仓库

```bash
node scripts/github-deploy.mjs <owner>/<repo>   # 通过 GitHub API 建仓并推送（需要 gh 已登录）
node scripts/verify-pages.mjs  <owner>/<repo>   # 轮询 Actions 与 Pages 构建结果
```

> 之所以提供这两个脚本：本机 hosts 把 `github.com` 指向了 127.0.0.1，`git`/`curl` 直连不可用，
> 只有 `gh` 的 API 通道能出去，所以用 Git Data API 完成了首次推送。
> 配好 `gh auth setup-git` 之后，日常更新直接用 `git push` 即可。

---

## 📖 使用步骤

1. 打开网站，把视频文件**拖进虚线框**（或点「选择视频文件」）。
2. 按需在 **⚙ 识别设置** 里选模型和语言：
   - 想快 → `Tiny` 或 `Base`（默认 `Base`，日常够用）
   - 中文准确率优先 → `Small` / `Large-v3-Turbo`（体积和耗时更大）
   - 明确选择视频语言（而不是「自动检测」）会更快更准
3. 点 **开始识别**，进度条会显示「提取音轨 → 加载模型 → 语音识别」三个阶段。
4. 识别完成后：
   - 左侧自动出现 **内容总结**（要点 + 关键词）；
   - 右侧是 **字幕文稿**，点击任意一条可让视频跳到那一句；
   - 用右侧导出按钮下载 **文本文档 (.md)**、**.txt**、**.srt**、**.vtt**、**.json**。
5. （可选）想用大模型生成更漂亮的摘要：点 **✨ AI 摘要**，启用后填入服务商的 Base URL / 模型 / API Key，再点「用 AI 重新总结」。

---

## 🤖 关于 AI 摘要（可选）

默认的**本地摘要**是*抽取式*的——它从文稿里挑出最有信息量的句子并去冗余，不联网、不花钱，但没有"重新组织语言"的能力。

如果你有任意一家大模型的 API Key，可以在 **✨ AI 摘要** 里接入，支持所有 **OpenAI 兼容**的 `/chat/completions` 接口，内置了这些预设：

- OpenAI（`gpt-4o-mini` 等）
- DeepSeek（`deepseek-chat`）
- 阿里云百炼 / 通义千问（`qwen-plus`）
- 月之暗面 Kimi
- 智谱 GLM
- 本地 **Ollama**（`http://localhost:11434/v1`，完全离线）

配置后长文稿会自动「分段总结 → 汇总」处理，不会超出上下文长度。

> ⚠️ **安全提示**：API Key 只保存在你自己浏览器的 `localStorage` 中。本项目是纯静态站点，没有后端，任何人都收不到你的 Key。但请注意：启用 AI 摘要后，**字幕文本会被发送给你所配置的服务商**。介意的话就不要启用，用本地摘要即可。

---

## 🧱 技术实现

```
src/
├─ App.tsx                 主界面（导入 / 进度 / 字幕 / 摘要 / 导出）
├─ types.ts                共享类型
├─ workers/
│  └─ asr.worker.ts        Web Worker：加载 Whisper 并执行识别
└─ lib/
   ├─ audio.ts             音轨提取 + 16 kHz 单声道重采样
   ├─ transcribe.ts        Worker 客户端封装、时间戳归一化
   ├─ summarize.ts         本地抽取式摘要（TextRank/MMR + 关键词）
   ├─ llm.ts               OpenAI 兼容接口的 AI 摘要
   ├─ format.ts            SRT / VTT / TXT / Markdown / JSON 导出
   ├─ constants.ts         模型与语言清单、默认设置
   └─ storage.ts           localStorage 持久化
```

几个关键设计：

- **不需要 ffmpeg.wasm。** 音轨提取直接用浏览器内置的 `decodeAudioData` + `OfflineAudioContext` 重采样，
  省掉约 30 MB 依赖，也就不需要配置 `SharedArrayBuffer` 所需的 COOP/COEP 响应头（GitHub Pages 无法自定义响应头）。
- **Whisper 单次窗口是 30 秒**，所以长视频必须切片。这里用的是**带重叠的滑窗**：下一片从「上一片最后一条字幕的结束时间」继续，
  并在拼接时做尾部/头部去重，因此不会在切片边界丢词，也不会整段重复。
- **识别跑在 Web Worker 里**，界面不会卡死；音频用 `Transferable` 传递，避免大数组拷贝。
- **模型按需从 CDN 加载**（transformers.js + ONNX Runtime Web 的 wasm），首次下载后由浏览器 `Cache Storage` 缓存。
- **构建用相对路径**（`base: './'`），因此产物可以直接部署在 `/Video2Text-Studio/` 这样的子路径下。

---

## ❓ 常见问题

<details>
<summary><b>支持多大的视频？</b></summary>

主要受内存限制，一般 1~2 小时的视频没问题。时长只影响识别耗时（大致是 `音频时长 × 0.1~1`，取决于模型与是否用上 WebGPU）。
浏览器解码超大文件时可能内存告急，建议先用工具压缩。
</details>

<details>
<summary><b>提示"无法解码音轨"怎么办？</b></summary>

说明浏览器自带的解码器不认这个文件的音轨编码。常见于 **MKV 封装**、**HEVC/H.265**、**AC-3/EAC-3** 音轨、**AVI** 老格式。
解决办法：先用格式转换工具转成 **MP4(H.264 + AAC)**，或直接提取成 **MP3 / WAV / M4A** 再上传。
</details>

<details>
<summary><b>模型下载很慢或失败？</b></summary>

模型默认从 Hugging Face 拉取。如果所在网络访问不畅，可以：
1. 换小模型（Tiny 约 40 MB）先跑通；
2. 使用带代理的网络环境后重试；
3. 克隆本仓库，把 `MODELS`（`src/lib/constants.ts`）里的模型 id 换成你自建/镜像站上的 ONNX 模型，并相应调整 `TRANSFORMERS_SOURCES`（`src/workers/asr.worker.ts`）。
</details>

<details>
<summary><b>识别很慢？</b></summary>

- 优先用 Chrome / Edge 113+，在**识别设置**里把「计算设备」设为 `WebGPU`；
- 选更小的模型（Tiny/Base）与 `q8` 精度；
- 关掉其他占用显卡的页面；
- 老电脑上 CPU 推理本来就慢，1 小时视频跑十几分钟是正常的。
</details>

<details>
<summary><b>识别结果不准？</b></summary>

1. 明确指定**视频语言**，别用自动检测；
2. 换更大的模型（Small / Large-v3-Turbo）；
3. 音质差、多人抢话、背景音乐大的素材，任何 ASR 都会掉点；
4. 识别完可以直接在导出前用搜索定位，手动修正后再复制。
</details>

<details>
<summary><b>会上传我的视频吗？</b></summary>

不会。视频文件只在你本机被 `decodeAudioData` 解码成 PCM，识别也在本机完成，没有任何上传逻辑。
你可以打开浏览器开发者工具的 Network 面板自己验证：只有模型文件和（可选的）AI 摘要请求。
</details>

---

## 🗺️ Roadmap

- [ ] 说话人分离（Speaker Diarization）
- [ ] 导出 Word (.docx) / PDF
- [ ] 字幕双语对照与翻译
- [ ] 支持直接粘贴视频链接（需要后端或 yt-dlp，欢迎 PR）
- [ ] 浏览器扩展版（在任意视频页面一键提取）

---

## 📄 License

[MIT](LICENSE) © 2026 Polaris929-cloud

语音识别模型来自 OpenAI Whisper，经 [transformers.js](https://github.com/huggingface/transformers.js) 在浏览器内运行；
模型权重遵循其各自的开源许可。
