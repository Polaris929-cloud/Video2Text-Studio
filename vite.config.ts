import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 读取构建信息并注入前端。
 * 页脚会显示「版本 <短提交号>」，用来一眼确认浏览器里跑的是不是最新版
 * —— 排查「改了但看起来没生效」时，先看这里。
 */
function readBuildInfo() {
  let commit = 'dev';
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    // 不在 git 仓库中（例如下载的源码压缩包）时保留 dev
  }
  const time = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return { commit, time };
}

const BUILD_INFO = readBuildInfo();

// base: './' —— 让构建产物使用相对路径，可直接部署在
// GitHub Pages 的任意子路径（https://<user>.github.io/<repo>/）下。
export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(BUILD_INFO.commit),
    __BUILD_TIME__: JSON.stringify(BUILD_INFO.time),
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  preview: {
    port: 4173,
    host: '127.0.0.1',
  },
});
