import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { extractAudio } from './lib/audio';
import { DEFAULT_ASR, DEFAULT_LLM, ENGINE_SOURCE_OPTIONS, LANGUAGES, LLM_PRESETS, MODELS, MODEL_HOSTS } from './lib/constants';
import { buildExport, downloadText, formatClock, safeBaseName, type ExportFormat } from './lib/format';
import { summarizeLocal } from './lib/summarize';
import { summarizeWithLlm, testLlmConnection } from './lib/llm';
import { loadAsrSettings, loadLastResult, loadLlmSettings, saveAsrSettings, saveLastResult, saveLlmSettings } from './lib/storage';
import { WhisperClient } from './lib/transcribe';
import type { AsrSettings, LlmSettings, Segment, Stage, SummaryResult } from './types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const STAGE_LABEL: Record<Stage, string> = {
  idle: '等待导入视频',
  decoding: '提取音轨中',
  'loading-model': '加载语音模型',
  transcribing: '语音识别中',
  done: '识别完成',
  error: '出现问题',
};

export default function App() {
  /* ---------------- 状态 ---------------- */
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [detectedLanguage, setDetectedLanguage] = useState<string>('');
  const [audioDuration, setAudioDuration] = useState(0);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [panel, setPanel] = useState<'none' | 'asr' | 'llm'>('none');
  const [dragging, setDragging] = useState(false);

  const [asr, setAsr] = useState<AsrSettings>(() => loadAsrSettings());
  const [llm, setLlm] = useState<LlmSettings>(() => loadLlmSettings());
  const [llmTestState, setLlmTestState] = useState<{ status: 'idle' | 'busy' | 'ok' | 'fail'; message: string }>({
    status: 'idle',
    message: '',
  });

  const clientRef = useRef<WhisperClient | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef(false);

  const busy = stage === 'decoding' || stage === 'loading-model' || stage === 'transcribing';

  /* ---------------- 设置持久化 ---------------- */
  useEffect(() => saveAsrSettings(asr), [asr]);
  useEffect(() => saveLlmSettings(llm), [llm]);

  /* ---------------- 恢复上次结果 ---------------- */
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const last = loadLastResult();
    if (last && last.segments.length > 0) {
      setSegments(last.segments);
      setSummary(last.summary);
      setAudioDuration(last.duration);
      setDetectedLanguage(last.language ?? '');
      setStage('done');
      setNote(`已恢复上次的识别结果（${last.fileName}，${new Date(last.savedAt).toLocaleString()}）`);
    }
  }, []);

  /* ---------------- 自动生成本地摘要 ---------------- */
  useEffect(() => {
    if (segments.length === 0) return;
    // 只在还没有摘要（或摘要来自本地）时自动生成，避免覆盖用户已经生成的 AI 摘要
    setSummary((prev) => (prev && prev.engine === 'llm' ? prev : { ...summarizeLocal(segments), engine: 'local' }));
  }, [segments]);

  /* ---------------- 结果持久化 ---------------- */
  useEffect(() => {
    if (segments.length === 0) return;
    saveLastResult({
      fileName: file?.name ?? '上次导入的视频',
      duration: audioDuration,
      model: asr.model,
      language: detectedLanguage,
      segments,
      summary,
      savedAt: Date.now(),
    });
  }, [segments, summary, audioDuration, detectedLanguage, asr.model, file?.name]);

  /* ---------------- 组件卸载 ---------------- */
  useEffect(() => {
    return () => {
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  /* ---------------- 选择文件 ---------------- */
  const chooseFile = useCallback(
    (next: File) => {
      clientRef.current?.abort();
      setFile(next);
      setVideoUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(next);
      });
      setSegments([]);
      setSummary(null);
      setDetectedLanguage('');
      setAudioDuration(0);
      setError('');
      setProgress(0);
      setStage('idle');
      setNote('文件已就绪，点击「开始识别」');
      saveLastResult(null);
    },
    [],
  );

  /* ---------------- 开始识别 ---------------- */
  const start = useCallback(async () => {
    if (!file || busy) return;
    setError('');
    setSegments([]);
    setSummary(null);
    setStage('decoding');
    setProgress(0.05);
    setNote('正在解码音轨…');

    try {
      const audio = await extractAudio(file, (value, text) => {
        setProgress(value);
        setNote(text);
      });
      setAudioDuration(audio.duration);
      setStage('loading-model');
      setNote('正在准备语音识别模型…');

      if (!clientRef.current) clientRef.current = new WhisperClient();
      const client = clientRef.current;

      // 注意：samples 是 transferable，postMessage 之后主线程这一份会被 detach，
      // 因此下面的展示时长提前从 audio.duration 取好。
      const result = await client.transcribe(audio.samples, asr, {
        onStatus: (message) => setNote(message),
        onProgress: ({ stage: s, value, note: n }) => {
          if (s === 'load') {
            setStage('loading-model');
            setProgress(value);
            setNote(n ? `下载模型：${n}` : '正在下载模型…');
          } else {
            setStage('transcribing');
            setProgress(value);
            setNote(`语音识别中 ${n ?? `${Math.round(value * 100)}%`}`);
          }
        },
      });

      setSegments(result.segments);
      setDetectedLanguage(result.language ?? '');
      setStage('done');
      setProgress(1);
      setNote(`识别完成，共 ${result.segments.length} 条字幕`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStage('error');
      setNote('识别失败');
    }
  }, [file, busy, asr]);

  /* ---------------- 中止 ---------------- */
  const abort = useCallback(() => {
    clientRef.current?.abort();
    clientRef.current = null;
    setStage('idle');
    setProgress(0);
    setNote('已中止识别');
  }, []);

  /* ---------------- AI 摘要 ---------------- */
  const runLlmSummary = useCallback(async () => {
    if (segments.length === 0) return;
    setSummaryBusy(true);
    setError('');
    try {
      const result = await summarizeWithLlm(segments, llm, {
        onProgress: (message) => setNote(message),
      });
      setSummary(result);
      setNote('AI 摘要生成完成');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSummaryBusy(false);
    }
  }, [segments, llm]);

  /* ---------------- 导出 ---------------- */
  const exportAs = useCallback(
    (fmt: ExportFormat) => {
      if (segments.length === 0) return;
      const base = safeBaseName(file?.name ?? 'transcript');
      const { content, ext } = buildExport(
        fmt,
        {
          fileName: file?.name ?? 'transcript',
          summary,
          model: asr.model,
          language: detectedLanguage,
          duration: audioDuration,
        },
        segments,
      );
      const mime =
        fmt === 'json'
          ? 'application/json;charset=utf-8'
          : fmt === 'md'
            ? 'text/markdown;charset=utf-8'
            : 'text/plain;charset=utf-8';
      downloadText(content, `${base}.${ext}`, mime);
    },
    [segments, summary, file?.name, asr.model, detectedLanguage, audioDuration],
  );

  const copyAll = useCallback(async () => {
    const text = segments.map((s) => `[${formatClock(s.start)}] ${s.text}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setNote('已复制全文到剪贴板');
    } catch {
      setError('复制失败，请改用「下载」按钮。');
    }
  }, [segments]);

  /* ---------------- 过滤 & 联动 ---------------- */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return segments.map((s, i) => ({ ...s, _i: i }));
    return segments.map((s, i) => ({ ...s, _i: i })).filter((s) => s.text.toLowerCase().includes(q));
  }, [segments, query]);

  const seekTo = useCallback((start: number, index: number) => {
    setActiveIndex(index);
    const video = videoRef.current;
    if (video) {
      try {
        video.currentTime = start;
        void video.play().catch(() => undefined);
      } catch {
        /* 某些容器不支持随机定位 */
      }
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || segments.length === 0) return;
    const onTime = () => {
      const t = video.currentTime;
      const idx = segments.findIndex((s) => t >= s.start && t <= s.end);
      if (idx >= 0) setActiveIndex(idx);
    };
    video.addEventListener('timeupdate', onTime);
    return () => video.removeEventListener('timeupdate', onTime);
  }, [segments]);

  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIndex]);

  /* ---------------- 拖拽 ---------------- */
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) chooseFile(dropped);
    },
    [chooseFile],
  );

  const progressPercent = Math.round(progress * 100);

  /* ---------------- 渲染 ---------------- */
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">V2T</span>
          <div>
            <h1>Video2Text Studio</h1>
            <p>本地语音识别提取字幕 · 自动总结视频内容 · 导出文本文档</p>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="badge badge-green" title="语音识别完全在你的浏览器内完成">
            🔒 视频不出本机
          </span>
          <button className="btn btn-ghost" onClick={() => setPanel(panel === 'asr' ? 'none' : 'asr')}>
            ⚙ 识别设置
          </button>
          <button className="btn btn-ghost" onClick={() => setPanel(panel === 'llm' ? 'none' : 'llm')}>
            ✨ AI 摘要
          </button>
        </div>
      </header>

      {panel === 'asr' && (
        <section className="card panel">
          <h2>识别设置</h2>
          <div className="grid">
            <label>
              <span>识别模型</span>
              <select value={asr.model} onChange={(e) => setAsr({ ...asr, model: e.target.value })}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.size}
                  </option>
                ))}
              </select>
              <small>{MODELS.find((m) => m.id === asr.model)?.note}</small>
            </label>
            <label>
              <span>视频语言</span>
              <select value={asr.language} onChange={(e) => setAsr({ ...asr, language: e.target.value })}>
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
              <small>指定语言比自动检测更准、更快</small>
            </label>
            <label>
              <span>计算设备</span>
              <select value={asr.device} onChange={(e) => setAsr({ ...asr, device: e.target.value as AsrSettings['device'] })}>
                <option value="auto">自动（优先显卡 WebGPU）</option>
                <option value="wasm">CPU（兼容性最好）</option>
                <option value="webgpu">显卡 WebGPU（最快）</option>
              </select>
              <small>WebGPU 仅 Chrome/Edge 113+ 可用，失败会自动回退 CPU</small>
            </label>
            <label>
              <span>数值精度</span>
              <select value={asr.dtype} onChange={(e) => setAsr({ ...asr, dtype: e.target.value })}>
                <option value="q8">q8 · 体积小速度快（推荐）</option>
                <option value="fp16">fp16 · WebGPU 下更快</option>
                <option value="fp32">fp32 · 最精确但最慢</option>
              </select>
              <small>q8 量化会略微降低准确度，换取明显更快的速度</small>
            </label>
            <label>
              <span>切片长度（秒）</span>
              <input
                type="number"
                min={10}
                max={30}
                value={asr.chunkSeconds}
                onChange={(e) => setAsr({ ...asr, chunkSeconds: Math.max(10, Math.min(30, Number(e.target.value) || 30)) })}
              />
              <small>Whisper 单次窗口上限 30 秒</small>
            </label>
            <label>
              <span>切片重叠（秒）</span>
              <input
                type="number"
                min={0}
                max={10}
                value={asr.strideSeconds}
                onChange={(e) => setAsr({ ...asr, strideSeconds: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
              />
              <small>重叠可减少切片边界丢词</small>
            </label>
            <label>
              <span>模型下载源</span>
              <select value={asr.modelHost} onChange={(e) => setAsr({ ...asr, modelHost: e.target.value })}>
                {MODEL_HOSTS.map((h) => (
                  <option key={h.value || 'official'} value={h.value}>
                    {h.label}
                  </option>
                ))}
              </select>
              <small>若模型一直停在 0%（下载不动），多半是连不上 huggingface.co，请换镜像</small>
            </label>
            <label>
              <span>引擎 CDN 源</span>
              <select value={asr.engineSource} onChange={(e) => setAsr({ ...asr, engineSource: e.target.value })}>
                {ENGINE_SOURCE_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <small>加载不出来时换一个 CDN 试试</small>
            </label>
            <label>
              <span>本地模型目录（离线用）</span>
              <input
                value={asr.localModel ? asr.model : ''}
                disabled={!asr.localModel}
                placeholder="例如：D:/models/whisper-base"
                onChange={(e) => setAsr({ ...asr, model: e.target.value })}
              />
              <small>
                勾选下面的开关后，这里填本地文件夹路径，直接读本地 ONNX 模型，**完全不联网**
              </small>
            </label>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={asr.localModel}
              onChange={(e) => setAsr({ ...asr, localModel: e.target.checked })}
            />
            <span>从本地文件夹加载模型（绕过 huggingface.co，适合网络不通的环境）</span>
          </label>
          {asr.localModel && (
            <p className="hint">
              目录需包含 <code>config.json</code>、<code>tokenizer.json</code>、<code>preprocessor_config.json</code> 以及{' '}
              <code>onnx/encoder_model_quantized.onnx</code>、<code>onnx/decoder_model_merged_quantized.onnx</code>。
              若浏览器阻止读取（Edge/Chrome 会询问文件夹权限），请允许访问。
            </p>
          )}
          <div className="panel-footer">
            <button className="btn btn-ghost" onClick={() => setAsr(DEFAULT_ASR)}>
              恢复默认
            </button>
            <button className="btn" onClick={() => setPanel('none')}>
              完成
            </button>
          </div>
        </section>
      )}

      {panel === 'llm' && (
        <section className="card panel">
          <h2>AI 摘要（可选）</h2>
          <p className="hint">
            不填也能用：默认使用本地抽取式摘要。想要更聪明的「生成式摘要」，可在此接入任意 OpenAI 兼容接口。
            API Key 仅保存在你自己的浏览器 localStorage 中，本项目没有后端，不会收到你的 Key。
          </p>
          <label className="switch">
            <input type="checkbox" checked={llm.enabled} onChange={(e) => setLlm({ ...llm, enabled: e.target.checked })} />
            <span>启用 AI 摘要</span>
          </label>

          <div className="grid">
            <label>
              <span>服务商预设</span>
              <select
                value={LLM_PRESETS.find((p) => p.baseUrl === llm.baseUrl)?.label ?? ''}
                onChange={(e) => {
                  const preset = LLM_PRESETS.find((p) => p.label === e.target.value);
                  if (preset) setLlm({ ...llm, baseUrl: preset.baseUrl, model: preset.model });
                }}
              >
                <option value="">自定义</option>
                {LLM_PRESETS.map((p) => (
                  <option key={p.label} value={p.label}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Base URL</span>
              <input value={llm.baseUrl} onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
            </label>
            <label>
              <span>模型名称</span>
              <input value={llm.model} onChange={(e) => setLlm({ ...llm, model: e.target.value })} placeholder="gpt-4o-mini" />
            </label>
            <label>
              <span>API Key</span>
              <input
                type="password"
                value={llm.apiKey}
                onChange={(e) => setLlm({ ...llm, apiKey: e.target.value })}
                placeholder="sk-..."
                autoComplete="off"
              />
            </label>
            <label>
              <span>Temperature</span>
              <input
                type="number"
                step={0.1}
                min={0}
                max={2}
                value={llm.temperature}
                onChange={(e) => setLlm({ ...llm, temperature: Number(e.target.value) })}
              />
              <small>越低越稳定，摘要建议 0.2~0.4</small>
            </label>
          </div>

          <div className="panel-footer">
            <button
              className="btn btn-ghost"
              disabled={llmTestState.status === 'busy'}
              onClick={async () => {
                setLlmTestState({ status: 'busy', message: '测试中…' });
                try {
                  const reply = await testLlmConnection(llm);
                  setLlmTestState({ status: 'ok', message: `连接成功：${reply.slice(0, 60)}` });
                } catch (err) {
                  setLlmTestState({ status: 'fail', message: err instanceof Error ? err.message : String(err) });
                }
              }}
            >
              {llmTestState.status === 'busy' ? '测试中…' : '测试连接'}
            </button>
            <button className="btn btn-ghost" onClick={() => setLlm({ ...DEFAULT_LLM, enabled: llm.enabled })}>
              恢复默认
            </button>
            <button className="btn" onClick={() => setPanel('none')}>
              完成
            </button>
          </div>
          {llmTestState.message && (
            <p className={llmTestState.status === 'ok' ? 'ok-text' : 'err-text'}>{llmTestState.message}</p>
          )}
        </section>
      )}

      <main className="layout">
        <section className="col-left">
          <div
            className={`card dropzone ${dragging ? 'dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            {!file ? (
              <>
                <div className="dz-icon">🎬</div>
                <h2>把视频拖到这里</h2>
                <p className="hint">支持 MP4 / MOV / WebM / MKV* / MP3 / M4A / WAV 等，取决于浏览器解码能力</p>
                <label className="btn btn-primary">
                  选择视频文件
                  <input
                    type="file"
                    accept="video/*,audio/*,.mp4,.mov,.mkv,.webm,.avi,.flv,.ts,.mp3,.m4a,.wav,.aac,.flac,.ogg"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) chooseFile(f);
                      e.target.value = '';
                    }}
                  />
                </label>
              </>
            ) : (
              <div className="file-info">
                <div className="file-meta">
                  <strong title={file.name}>{file.name}</strong>
                  <span>
                    {formatBytes(file.size)}
                    {audioDuration > 0 && ` · 时长 ${formatClock(audioDuration)}`}
                    {detectedLanguage && ` · 语言 ${detectedLanguage}`}
                  </span>
                </div>
                <div className="file-actions">
                  {!busy ? (
                    <button className="btn btn-primary" onClick={start}>
                      {stage === 'done' ? '重新识别' : '开始识别'}
                    </button>
                  ) : (
                    <button className="btn btn-danger" onClick={abort}>
                      中止
                    </button>
                  )}
                  <label className="btn btn-ghost">
                    换一个文件
                    <input
                      type="file"
                      accept="video/*,audio/*"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) chooseFile(f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              </div>
            )}
          </div>

          {videoUrl && (
            <div className="card player">
              <video ref={videoRef} src={videoUrl} controls preload="metadata" />
            </div>
          )}

          {stage !== 'idle' && (
            <div className="card progress-card">
              <div className="progress-head">
                <span className={`stage stage-${stage}`}>{STAGE_LABEL[stage]}</span>
                <span className="progress-pct">{progressPercent}%</span>
              </div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${Math.max(2, progressPercent)}%` }} />
              </div>
              {note && <p className="hint note">{note}</p>}
            </div>
          )}

          {error && (
            <div className="card error-card">
              <strong>出错了</strong>
              <pre>{error}</pre>
            </div>
          )}

          {segments.length > 0 && (
            <div className="card summary-card">
              <div className="card-head">
                <h2>内容总结</h2>
                <span className={`badge ${summary?.engine === 'llm' ? 'badge-purple' : 'badge-blue'}`}>
                  {summary?.engine === 'llm' ? 'AI 生成' : '本地算法'}
                </span>
              </div>
              {summaryBusy && <p className="hint">正在生成 AI 摘要…</p>}
              {summary?.tldr && <blockquote className="tldr">{summary.tldr}</blockquote>}
              {summary && summary.bullets.length > 0 && (
                <ul className="bullets">
                  {summary.bullets.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              )}
              {summary && summary.keywords.length > 0 && (
                <div className="keywords">
                  {summary.keywords.map((k) => (
                    <span key={k} className="chip">
                      {k}
                    </span>
                  ))}
                </div>
              )}
              <div className="summary-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => setSummary({ ...summarizeLocal(segments), engine: 'local' })}
                >
                  重新生成本地摘要
                </button>
                <button
                  className="btn btn-ghost"
                  disabled={!llm.enabled || summaryBusy}
                  title={llm.enabled ? '' : '请先在「AI 摘要」中启用并填写 API Key'}
                  onClick={runLlmSummary}
                >
                  {summaryBusy ? '生成中…' : '用 AI 重新总结'}
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="col-right">
          <div className="card transcript-card">
            <div className="card-head">
              <h2>字幕文稿</h2>
              <span className="hint">{segments.length} 条</span>
            </div>

            {segments.length > 0 && (
              <>
                <div className="toolbar">
                  <input
                    className="search"
                    placeholder="搜索字幕内容…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button className="btn btn-ghost btn-sm" onClick={copyAll}>
                    复制全文
                  </button>
                </div>
                <div className="export-row">
                  <span className="hint">导出：</span>
                  {(
                    [
                      ['md', '文本文档 (.md)'],
                      ['txt', '纯文本 (.txt)'],
                      ['srt', '字幕 (.srt)'],
                      ['vtt', '字幕 (.vtt)'],
                      ['json', '数据 (.json)'],
                    ] as Array<[ExportFormat, string]>
                  ).map(([fmt, label]) => (
                    <button key={fmt} className="btn btn-ghost btn-sm" onClick={() => exportAs(fmt)}>
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="segment-list" ref={listRef}>
              {segments.length === 0 && (
                <p className="empty">
                  还没有字幕。导入视频后点击「开始识别」，识别结果会显示在这里，可以点击任意一条跳转到视频对应位置。
                </p>
              )}
              {filtered.map((s) => (
                <div
                  key={s.index}
                  data-index={s._i}
                  className={`segment ${s._i === activeIndex ? 'active' : ''}`}
                  onClick={() => seekTo(s.start, s._i)}
                >
                  <span className="ts">{formatClock(s.start)}</span>
                  <span className="txt">{s.text}</span>
                </div>
              ))}
              {segments.length > 0 && filtered.length === 0 && <p className="empty">没有匹配的字幕。</p>}
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <span>
          识别模型来自 Hugging Face 上的 Whisper（transformers.js + ONNX Runtime Web），首次使用需联网下载并缓存到浏览器；
          视频与音频<strong>全程不离开你的设备</strong>。
        </span>
        <span className="hint">Video2Text Studio · 开源静态站点</span>
      </footer>
    </div>
  );
}
