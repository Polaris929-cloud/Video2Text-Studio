/**
 * 音频提取：把用户导入的视频/音频文件解码成 Whisper 需要的 16 kHz 单声道 PCM。
 *
 * 全程走浏览器内置的 Web Audio API（decodeAudioData + OfflineAudioContext 重采样），
 * 因此：
 *   - 不需要 ffmpeg.wasm（省掉 ~30MB 依赖，也不需要 SharedArrayBuffer / COOP+COEP 响应头）
 *   - 文件不会离开用户的电脑
 *
 * 支持范围取决于浏览器自身能解码的容器：Chrome / Edge 支持 mp4 / m4a / webm / ogg / wav / mp3 / flac，
 * Safari 支持 mp4 / m4a / mov / wav / mp3。遇到不支持的编码时会抛出可读的错误提示。
 */

/** Whisper 固定采样率 */
export const TARGET_SAMPLE_RATE = 16000;

export interface DecodedAudio {
  /** 16 kHz 单声道 PCM */
  samples: Float32Array;
  /** 原始文件解码后的时长（秒） */
  duration: number;
  /** 原始文件声道数（仅用于展示） */
  channels: number;
  /** 原始采样率（仅用于展示） */
  sourceSampleRate: number;
}

function explainDecodeError(fileName: string, err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(
    `无法解码「${fileName}」的音轨。${raw}\n` +
      `常见原因：\n` +
      `  1. 视频使用了浏览器不支持的编码（如 MKV 封装、HEVC/AV1 音轨、AC-3 等）；\n` +
      `  2. 文件损坏或下载不完整；\n` +
      `  3. 文件过大导致内存不足。\n` +
      `建议：先用任意工具把视频转成 MP4(H.264 + AAC) 或提取为 MP3/WAV 后重试。`,
  );
}

async function decodeToAudioBuffer(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  if (arrayBuffer.byteLength === 0) {
    throw new Error(`「${file.name}」是空文件。`);
  }

  // 标准路径：AudioContext.decodeAudioData
  const Ctx: typeof AudioContext =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) {
    throw new Error('当前浏览器不支持 Web Audio API，无法提取音轨。请使用最新版 Chrome / Edge / Safari。');
  }

  const ctx = new Ctx();
  try {
    // 拷贝一份：decodeAudioData 会 detach 传入的 ArrayBuffer
    const forDecode = arrayBuffer.slice(0);
    return await ctx.decodeAudioData(forDecode);
  } catch {
    // 兜底路径：部分浏览器/容器组合下 decodeAudioData 会失败，
    // 而 OfflineAudioContext.decodeAudioData 走的是同一套解码器但行为略有差异。
    try {
      const off = new OfflineAudioContext(1, TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE);
      return await off.decodeAudioData(arrayBuffer.slice(0));
    } catch (err2) {
      throw explainDecodeError(file.name, err2);
    }
  } finally {
    // 及时释放解码器资源
    void ctx.close().catch(() => undefined);
  }
}

/**
 * 提取音轨并重采样为 16 kHz 单声道。
 * @param onProgress 0~1 的粗粒度进度回调（解码阶段无法拿到精确进度，这里按步骤给出）
 */
export async function extractAudio(file: File, onProgress?: (value: number, note: string) => void): Promise<DecodedAudio> {
  onProgress?.(0.05, '读取文件…');
  const buffer = await decodeToAudioBuffer(file);

  const duration = buffer.duration;
  const channels = buffer.numberOfChannels;
  const sourceSampleRate = buffer.sampleRate;

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('解码得到的音频时长为 0，文件可能不含音轨。');
  }

  onProgress?.(0.4, '混合声道…');
  // 先混成单声道，再交给 OfflineAudioContext 重采样
  const mono = new Float32Array(buffer.length);
  const chCount = Math.max(1, buffer.numberOfChannels);
  for (let c = 0; c < chCount; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] = mono[i] + data[i];
  }
  if (chCount > 1) {
    for (let i = 0; i < mono.length; i++) mono[i] = mono[i] / chCount;
  }

  onProgress?.(0.55, `重采样到 ${TARGET_SAMPLE_RATE} Hz…`);

  let samples: Float32Array;
  if (sourceSampleRate === TARGET_SAMPLE_RATE) {
    samples = mono;
  } else {
    // 用 OfflineAudioContext 做高质量重采样（内部带回放低通滤波，比线性插值好得多）
    const targetLength = Math.max(1, Math.ceil((duration * TARGET_SAMPLE_RATE)));
    const offline = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
    const src = offline.createBufferSource();
    const monoBuffer = offline.createBuffer(1, mono.length, sourceSampleRate);
    monoBuffer.copyToChannel(mono, 0);
    src.buffer = monoBuffer;
    src.connect(offline.destination);
    src.start(0);
    const rendered = await offline.startRendering();
    samples = rendered.getChannelData(0).slice();
  }

  onProgress?.(0.75, '音频准备完成');
  return { samples, duration, channels, sourceSampleRate };
}
