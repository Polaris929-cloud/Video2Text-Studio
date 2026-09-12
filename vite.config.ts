import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' —— 让构建产物使用相对路径，可直接部署在
// GitHub Pages 的任意子路径（https://<user>.github.io/<repo>/）下。
export default defineConfig({
  base: './',
  plugins: [react()],
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
