/**
 * native.js（桌面版） —— 渲染进程侧的原生能力封装
 *
 * **文件名和接口都刻意与安卓版的 `native.js` 保持一致**，这样
 * `index.html` / `app.css` / `app.js` 三个文件可以在两个平台上**原样复用**，
 * 不需要任何条件分支。构建脚本会把这一份写进 www/ 顶掉安卓那份。
 *
 * 与安卓版的对应关系：
 *   KeepAwake（Capacitor 插件）      → powerSaveBlocker（Electron 内置）
 *   ScreenBrightness（Capacitor 插件）→ Windows WMI（macOS 没有标准命令行 API，如实报告不可用）
 *   Filesystem + Share               → 原生保存对话框 + 在文件管理器中定位
 *   <input type=file>                → 原生文件选择对话框
 */
;(function () {
  'use strict'

  var d = window.desktop
  // 不在 Electron 里（比如被当普通网页打开）就什么都不做，由浏览器替身层接管
  if (!d) return
  if (window.Native && window.Native.__desktop) return

  var PLATFORM_LABEL = {
    win32: 'Windows',
    darwin: 'macOS',
    linux: 'Linux',
    android: '安卓',
    ios: 'iOS'
  }

  function toBytes(value) {
    if (!value) return null
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return null
  }

  /**
   * app.js 里 `var awake = Native.keepAwake(true)` 是**同步**取返回值的，
   * 而 IPC 只能异步。所以返回一个"先给乐观值、随后被真实值覆盖"的 thenable：
   * 同步调用者立刻拿到形状正确的对象，`await` 调用者拿到真实结果。
   *
   * ⚠️ 这里有个坑：**解析结果本身绝不能再是 thenable**。
   * 早期版本直接 `return optimistic`（而 optimistic 自己带 `then`），
   * 于是 promise 解析回自己 → 自我解析的 thenable 循环 → V8 直接 SIGTRAP 崩溃
   * 整个 Electron 进程（栈里只看到 node 内部的 `_v8_internal_Node_Print`，
   * 极难定位）。所以 then 里要返回一个**去掉 then/catch 的纯对象**。
   */
  function keepAwakeThenable(on) {
    var optimistic = { keepAwake: !!on, brightness: false, errors: [] }

    function plain(actual) {
      var errors = (actual && actual.errors) || []
      if (errors.length) console.warn('[keepAwake]', errors.join('；'))
      return {
        keepAwake: Boolean(actual && actual.keepAwake),
        brightness: Boolean(actual && actual.brightness),
        errors: errors
      }
    }

    var settled = d.keepAwake(on).then(function (actual) {
      var result = plain(actual)
      // 让同步调用者也能看到真实值（对象引用不变）
      optimistic.keepAwake = result.keepAwake
      optimistic.brightness = result.brightness
      optimistic.errors = result.errors
      return result // ← 纯对象，不带 then，避免自我解析
    })

    optimistic.then = function (onOk, onErr) {
      return settled.then(onOk, onErr)
    }
    optimistic.catch = function (onErr) {
      return settled.catch(onErr)
    }
    return optimistic
  }

  window.Native = {
    __desktop: true,

    isNative: function () {
      return true
    },

    keepAwake: keepAwakeThenable,

    pickFile: function (accept) {
      var wantsImage = Boolean(accept && String(accept).indexOf('image') >= 0)
      return d.pickFile({ image: wantsImage }).then(function (file) {
        if (!file) return null
        var bytes = toBytes(file.bytes)
        return { name: file.name, bytes: bytes, size: bytes ? bytes.length : 0, path: file.path }
      })
    },

    saveFile: function (name, bytes) {
      var data = toBytes(bytes)
      return d.saveFile(name || 'received.bin', data).then(function (res) {
        if (!res || res.cancelled) return { saved: false, cancelled: true }
        return { saved: Boolean(res.saved), uri: res.uri, mode: res.mode || 'native-path' }
      })
    },

    enterFullscreen: function () {
      return d.fullscreen(true)
    },

    exitFullscreen: function () {
      return d.fullscreen(false)
    },

    /** 无摄像头时的降级：抓一张整屏图（返回 dataURL），交给接收端解帧 */
    captureScreen: function () {
      return d.captureScreen()
    },

    reveal: function (filePath) {
      return d.reveal(filePath)
    },

    displays: function () {
      return d.displays()
    },

    envInfo: function () {
      // 同步：平台信息由 preload 以常量形式挂在 window.desktop 上
      return {
        native: true,
        platform: d.platform,
        platformLabel: PLATFORM_LABEL[d.platform] || d.platform,
        versions: d.versions,
        plugins: {
          KeepAwake: true, // powerSaveBlocker，Electron 内置
          ScreenBrightness: d.platform === 'win32', // 只有 Windows 有 WMI
          Filesystem: true,
          Share: true
        },
        secureContext: true,
        hasCamera: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
      }
    }
  }

  // 给 raptorq.core.js 用的 wasm 读取入口（走 fs，比 fetch 稳，打包后路径也确定）
  window.__readVendor = function (relPath) {
    return d.readVendor(relPath)
  }
})()
