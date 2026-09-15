/// <reference types="vite/client" />

/** 构建时由 vite.config.ts 通过 define 注入：当前提交的短哈希 */
declare const __BUILD_COMMIT__: string;

/** 构建时由 vite.config.ts 通过 define 注入：构建时间（UTC） */
declare const __BUILD_TIME__: string;
