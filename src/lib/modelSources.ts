/**
 * 模型来源（下载源）定义与纯函数工具。
 *
 * 背景 —— 为什么需要这一层：
 *   1. huggingface.co 在国内**完全连不上**（TCP 被阻断，浏览器连第一个字节都收不到），
 *      而 transformers.js 的 fetch 没有超时，于是界面会永远停在 0%，看起来像"卡死"。
 *   2. hf-mirror / aifasthub 这类镜像站虽然能连，但它们返回的响应头是
 *      `Access-Control-Allow-Origin: https://huggingface.co`，
 *      第三方站点（GitHub Pages）在浏览器里跨域 fetch 会被 CORS 直接拦截。
 *   3. 因此最可靠的做法是：**把模型文件和站点放在同一个源上**（本站同源），
 *      既没有 CORS 问题，也不依赖任何被墙的域名。
 *
 * 这个模块只放"纯逻辑"（URL 拼装、来源排序、精度回退链），
 * 方便在 Node 里直接单测（见 scripts/selftest.mjs）。
 */

export type ModelSourceKind = 'site' | 'remote' | 'custom';

export interface ModelSourceSpec {
  /** 稳定标识，会存进 localStorage */
  id: string;
  /** 界面展示名 */
  label: string;
  /**
   * transformers.js 的 remoteHost，**必须以 / 结尾**。
   * 配合 remotePathTemplate，最终地址为 base + 模板替换后的路径 + 文件名。
   */
  base: string;
  kind: ModelSourceKind;
  /** 一句话说明，用于界面提示 */
  note: string;
  /** 该来源专用的路径模板（缺省用官方模板） */
  pathTemplate?: string;
}

/** 站点自带模型目录（相对于站点根，由 deploy 流程把模型文件下载到这里） */
export const SITE_MODELS_DIR = 'models/';

/** transformers.js 默认的路径模板（Hugging Face Hub 结构） */
export const REMOTE_PATH_TEMPLATE = '{model}/resolve/{revision}/';
/** 站点自带模型的目录结构：models/<model-id>/<文件名> */
export const SITE_PATH_TEMPLATE = '{model}/';
/** ModelScope 的路径结构：models/<model-id>/resolve/master/<文件名> */
export const MODELSCOPE_PATH_TEMPLATE = '{model}/resolve/master/';

/** "自动"模式下按顺序尝试的候选源 */
export const MODEL_SOURCE_CANDIDATES: ModelSourceSpec[] = [
  {
    id: 'modelscope',
    label: '魔搭 ModelScope（国内直连，推荐）',
    base: 'https://www.modelscope.cn/models/',
    kind: 'remote',
    pathTemplate: MODELSCOPE_PATH_TEMPLATE,
    note: '阿里云域名 + 国内 LFS CDN，浏览器可直接跨域读取，实测比 GitHub Pages / jsDelivr 快一个数量级',
  },
  {
    id: 'site',
    label: '本站同源',
    base: './models/', // 运行时会被替换成绝对地址
    kind: 'site',
    note: '模型随站点一起部署；国内访问 GitHub Pages 通常较慢，作为兜底',
  },
  {
    id: 'hf',
    label: 'Hugging Face 官方',
    base: 'https://huggingface.co/',
    kind: 'remote',
    note: '官方源；国内通常连不上（需要代理）',
  },
  {
    id: 'hf-mirror.net',
    label: '镜像 hf-mirror.net',
    base: 'https://hf-mirror.net/',
    kind: 'remote',
    note: '浏览器跨域会被它的响应头拦掉（多见于代理/命令行场景）',
  },
  {
    id: 'aifasthub',
    label: '镜像 aifasthub.com',
    base: 'https://aifasthub.com/',
    kind: 'remote',
    note: '浏览器跨域会被它的响应头拦掉',
  },
  {
    id: 'hf-mirror.com',
    label: '镜像 hf-mirror.com',
    base: 'https://hf-mirror.com/',
    kind: 'remote',
    note: '域名本身也经常无法访问',
  },
];

/** 界面下拉框选项（含自定义） */
export const MODEL_SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: '自动（推荐：依次探测，用能通的那个）' },
  ...MODEL_SOURCE_CANDIDATES.filter((s) => s.id !== 'site').map((s) => ({ value: s.id, label: `固定使用：${s.label}` })),
  { value: 'site', label: '固定使用：本站同源模型' },
  { value: 'custom', label: '自定义地址（自己搭的镜像）' },
];

export const DEFAULT_MODEL_SOURCE = 'auto';

/** 把用户填的自定义地址规整成合法的 remoteHost（补协议、补结尾斜杠） */
export function normalizeHost(raw: string): string {
  const value = (raw || '').trim();
  if (!value) return '';
  let url = value;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!url.endsWith('/')) url += '/';
  return url;
}

/** 把站点自带的模型目录解析成绝对地址（同源，不用管站点部署在哪个子路径） */
export function resolveSiteBase(documentBaseUri: string, dir: string = SITE_MODELS_DIR): string {
  try {
    return new URL(dir, documentBaseUri).href;
  } catch {
    return '';
  }
}

/**
 * 生成实际要尝试的来源顺序。
 *
 * @param preference 用户设置：auto / site / hf / ... / custom
 * @param customHost 自定义地址（preference === 'custom' 时使用）
 * @param siteBase   站点自带模型目录的绝对地址
 *
 * 规则：
 *   - 用户指定了某个源 → 它排在最前面，**其余候选仍然兜底**（某天镜像挂了也不至于卡死）；
 *   - 没指定（auto）→ 同源优先，其次官方，最后镜像。
 */
export function buildSourceChain(preference: string, customHost: string, siteBase: string): ModelSourceSpec[] {
  const resolved = MODEL_SOURCE_CANDIDATES.map((s) => (s.id === 'site' ? { ...s, base: siteBase || s.base } : s));

  const custom: ModelSourceSpec | null = (() => {
    const base = normalizeHost(customHost);
    if (!base) return null;
    return { id: 'custom', label: '自定义地址', base, kind: 'custom', note: base };
  })();

  let preferred: ModelSourceSpec | undefined;
  if (preference === 'custom') preferred = custom ?? undefined;
  else if (preference && preference !== 'auto') preferred = resolved.find((s) => s.id === preference);

  const head: ModelSourceSpec[] = [];
  if (preferred) head.push(preferred);
  // 自定义地址即使不作为首选，也放在兜底链最后（用户既然填了，多半是有用的）
  if (custom && custom !== preferred) head.push(custom);

  const rest = resolved.filter((s) => s.id !== preferred?.id && s.base);
  const chain = [...head, ...rest];

  // 去重（按 base）
  const seen = new Set<string>();
  return chain.filter((s) => {
    if (!s.base || seen.has(s.base)) return false;
    seen.add(s.base);
    return true;
  });
}

/**
 * 精度回退链：只回退一跳，避免"选了个小精度、结果去下 1GB 的 fp32"。
 * q8 → fp32；fp32 → q8（先试小的）；fp16 → q8。
 */
export function buildDtypeChain(dtype: string): string[] {
  const chain = [dtype || 'q8'];
  const fallback = dtype === 'fp32' ? 'q8' : 'fp32';
  if (!chain.includes(fallback)) chain.push(fallback);
  return chain;
}

/** 设备回退链 */
export function buildDeviceChain(device: string, hasWebGpu: boolean): string[] {
  if (device === 'wasm') return ['wasm'];
  if (device === 'webgpu') return ['webgpu', 'wasm'];
  return hasWebGpu ? ['webgpu', 'wasm'] : ['wasm'];
}

export function pathTemplateFor(source: ModelSourceSpec): string {
  if (source.pathTemplate) return source.pathTemplate;
  return source.kind === 'site' ? SITE_PATH_TEMPLATE : REMOTE_PATH_TEMPLATE;
}

/**
 * 某个文件的完整地址。
 * 必须与传给 transformers.js 的 remoteHost / remotePathTemplate 完全一致，
 * 否则「探测通过、真正下载时 404」，又是一种"卡住"。
 */
export function modelFileUrl(source: ModelSourceSpec, model: string, file: string, revision = 'main'): string {
  const path = pathTemplateFor(source).replaceAll('{model}', model).replaceAll('{revision}', revision);
  return `${source.base}${path}${file}`;
}
