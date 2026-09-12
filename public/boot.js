/**
 * 启动守卫（原样拷贝到构建产物，不经过打包）。
 *
 * 目的：把"白屏"变成"看得见的错误"。
 *   - 老浏览器不支持 ES Module → 直接提示
 *   - 主 JS 加载失败（网络/缓存过期/被拦截）→ 显示失败的文件名
 *   - 运行时报错 → 把错误消息显示在页面上
 *
 * 注意：这个文件不能依赖任何打包工具，必须是能直接在浏览器跑的普通 JS。
 */
(function () {
  'use strict';

  // 老浏览器：支持 ES Module 的浏览器都会执行 module 脚本
  if (!('noModule' in HTMLScriptElement.prototype)) {
    show(
      '浏览器版本过低',
      '本工具的语音识别依赖 WebAssembly 与 ES Module，需要 Chrome / Edge 90+、Firefox 89+ 或 Safari 15+。请升级浏览器后重试。',
    );
    return;
  }

  var shown = false;

  function show(title, message, detail) {
    if (shown) return;
    shown = true;
    var root = document.getElementById('root');
    if (!root) return;
    root.innerHTML =
      '<div class="boot-fallback">' +
      '<h1>⚠️ ' +
      escapeHtml(title) +
      '</h1>' +
      '<p class="boot-msg">' +
      escapeHtml(message) +
      '</p>' +
      (detail ? '<pre class="boot-detail">' + escapeHtml(detail) + '</pre>' : '') +
      '<p class="boot-hint">可以尝试：按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> 强制刷新（清掉过期缓存）；' +
      '或按 <kbd>F12</kbd> 打开控制台查看完整错误。</p>' +
      '</div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 主 JS 加载失败：错误信息里会带上那个 js 的地址
  window.addEventListener(
    'error',
    function (ev) {
      var target = ev.target;
      if (target && target.tagName === 'SCRIPT' && target.src) {
        show(
          '主程序加载失败',
          '没能加载 ' + target.src + '。常见原因：网络不稳定、浏览器缓存里的旧版本已失效、或代理/拦截插件拦下了这个文件。',
          ev.message || '',
        );
        return;
      }
      if (ev.message) {
        show('页面运行出错', ev.message, (ev.filename || '') + (ev.lineno ? ':' + ev.lineno : ''));
      }
    },
    true,
  );

  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev.reason;
    var msg = reason && reason.message ? reason.message : String(reason);
    show('页面运行出错（未处理的异步错误）', msg, reason && reason.stack ? String(reason.stack).slice(0, 500) : '');
  });

  // 兜底：如果 15 秒后 React 仍未挂载，说明确实卡住了
  window.setTimeout(function () {
    var root = document.getElementById('root');
    if (root && root.querySelector('.boot-loading')) {
      show(
        '页面加载超时',
        '主程序 15 秒内没有完成加载。通常是网络较慢或被拦截，也可能是浏览器缓存了旧版本。',
      );
    }
  }, 15000);
})();
