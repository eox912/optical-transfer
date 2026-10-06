/**
 * native.js（浏览器扩展版） —— Chrome / Edge MV3 扩展页面的能力封装
 *
 * **文件名和接口刻意与安卓版、桌面版的 `native.js` 完全一致**，所以
 * `index.html` / `app.css` / `app.js` 三个文件在三个平台上**原样复用**，
 * 一个字都不用改（构建脚本会把这一份写进 dist/ 顶掉安卓那份）。
 *
 * 与其它平台的对应关系：
 *   KeepAwake（Capacitor 插件）        → **Screen Wake Lock API**（标准，不需要额外权限）
 *   ScreenBrightness（Capacitor 插件） → ✗ 浏览器拿不到，**如实报告不可用**
 *   Filesystem + Share                 → showSaveFilePicker（真"另存为"）/ chrome.downloads
 *   沉浸式全屏                          → **Document Picture-in-Picture（系统级置顶码窗）**，退回 Fullscreen API
 *   原生文件对话框                      → <input type=file>（扩展页面里同样能调起）
 *
 * 三条设计原则，和前两个平台一致：
 *
 *   1. **能用标准 API 就不用 chrome.* 专有 API。** 常亮用 Screen Wake Lock 而不是
 *      `chrome.power`（后者是 Chrome 专有、平台支持不一致、还要多要一个权限）。
 *      于是 manifest 的 permissions 只有 `["downloads"]` 一项。
 *   2. **每一处都做能力探测 + 降级链**，拿不到就退到下一档，并且**如实上报**，
 *      绝不假装成功（亮度就是如实报"浏览器拿不到"）。
 *   3. **不碰共用 UI。** 需要读页面时只读稳定的 DOM 契约（`#code-canvas` / `#stop`），
 *      并把这条契约写进测试，而不是偷偷改 app.js。
 */
;(function () {
  'use strict'

  if (window.Native && window.Native.__extension) return

  var CHROME = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id ? chrome : null

  var BRIGHTNESS_NOTE =
    '屏幕亮度：浏览器扩展拿不到系统级亮度接口（安卓版 / Windows 桌面版才有），请手动把屏幕调到最亮'

  function isExtension() {
    if (CHROME) return true
    if (typeof location === 'undefined' || !location.protocol) return false
    return location.protocol === 'chrome-extension:' || location.protocol === 'moz-extension:'
  }

  function platformLabel() {
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
    if (isExtension()) return /Edg\//.test(ua) ? 'Edge 扩展' : 'Chrome 扩展'
    return '浏览器'
  }

  /* ====================================================================== */
  /*                     一、屏幕常亮（Screen Wake Lock）                    */
  /* ====================================================================== */

  /**
   * 发送端的关键：息屏会**直接中断光学传输**。
   * 扩展页面是安全上下文且可见，所以标准的 Wake Lock API 就能拿到。
   *
   * 注意：wake lock 在文档转为 hidden 时会被**自动释放**，切回来要重新申请，
   * 所以这里挂了一个 visibilitychange 兜底（不挂的话"切走再切回"就再也不常亮了）。
   */
  var wakeSentinel = null
  var wakeWanted = false
  var wakeError = null

  function requestWakeLock() {
    if (typeof navigator === 'undefined' || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') {
      wakeError = '这个环境没有 Screen Wake Lock API，屏幕可能会自动息屏'
      return Promise.resolve(false)
    }
    if (wakeSentinel) return Promise.resolve(true)
    return Promise.resolve(navigator.wakeLock.request('screen')).then(
      function (sentinel) {
        wakeSentinel = sentinel
        wakeError = null
        if (sentinel && typeof sentinel.addEventListener === 'function') {
          sentinel.addEventListener('release', function () {
            if (wakeSentinel === sentinel) wakeSentinel = null
          })
        }
        return true
      },
      function (err) {
        wakeError = '申请屏幕常亮失败：' + ((err && err.message) || err)
        return false
      }
    )
  }

  function releaseWakeLock() {
    var sentinel = wakeSentinel
    wakeSentinel = null
    if (!sentinel) return Promise.resolve({ keepAwake: false, brightness: false, errors: [] })
    try {
      var p = sentinel.release()
      return Promise.resolve(p).then(
        function () {
          return { keepAwake: false, brightness: false, errors: [] }
        },
        function () {
          return { keepAwake: false, brightness: false, errors: [] }
        }
      )
    } catch (err) {
      return Promise.resolve({ keepAwake: false, brightness: false, errors: [] })
    }
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      // 文档重新可见且仍然"想要常亮"时补申请一次（wake lock 已被系统释放）
      if (wakeWanted && !wakeSentinel && document.visibilityState === 'visible') requestWakeLock()
    })
  }

  /**
   * ⚠️ 与桌面版同一个坑：app.js 里 `var awake = Native.keepAwake(true)` 是**同步**
   * 取返回值的，而 Wake Lock 只能异步。所以返回一个"先给乐观值、随后被真实值覆盖"
   * 的 thenable。**解析结果本身绝不能再是 thenable**，否则 promise 解析回自己 →
   * 自我解析死循环（桌面版上曾让整个 Electron 进程 SIGTRAP 崩溃）。
   */
  function keepAwakeThenable(on) {
    var optimistic = {
      keepAwake: false,
      brightness: false,
      // 同步就要能看到的错误：调用方（app.js）是同步读 errors 的
      errors: on ? [BRIGHTNESS_NOTE] : []
    }

    wakeWanted = Boolean(on)
    var work = on
      ? requestWakeLock().then(function (ok) {
          return { keepAwake: ok, brightness: false, errors: ok ? [] : [wakeError] }
        })
      : releaseWakeLock()

    var settled = work.then(function (actual) {
      var extra = (actual && actual.errors) || []
      var errors = on ? [BRIGHTNESS_NOTE].concat(extra) : []
      optimistic.keepAwake = Boolean(actual && actual.keepAwake)
      optimistic.brightness = Boolean(actual && actual.brightness)
      optimistic.errors = errors
      // ← 返回纯对象（不带 then），避免自我解析
      return { keepAwake: optimistic.keepAwake, brightness: optimistic.brightness, errors: errors }
    })

    optimistic.then = function (onOk, onErr) {
      return settled.then(onOk, onErr)
    }
    optimistic.catch = function (onErr) {
      return settled.catch(onErr)
    }
    return optimistic
  }

  /* ====================================================================== */
  /*                  二、置顶码窗（Document Picture-in-Picture）            */
  /* ====================================================================== */

  /**
   * 这是扩展版相对"localhost 浏览器模式"最值钱的一项：**码窗真的浮在其它应用之上**。
   *
   * `chrome.windows` 没有 alwaysOnTop，但 Document PiP（Chrome/Edge 116+）
   * 开出来的窗口按定义就是系统级置顶的，而且可以指定尺寸。
   *
   * 实现上**不搬 DOM**，而是在 PiP 窗口里放一块 canvas，每帧把主窗口那块
   * `#code-canvas` 直接位拷贝过去：
   *   - 搬 DOM 会让 app.js 里的 `window.innerWidth` / `getBoundingClientRect()`
   *     分处两个文档，尺寸换算立刻错乱（app.js 是共用 UI，不能改）；
   *   - 位拷贝是 1:1 像素，且**共用 UI 一行都不用动**。
   *
   * 代价（如实写在 README 里）：主窗口那个标签页如果被切到后台，浏览器会节流
   * `requestAnimationFrame`/`setTimeout`，编码循环会掉到 ~1fps，传输就停了。
   * 所以 PiP 模式的用法是"**这个标签页保持在前台**，码窗浮在上面给你同时用别的应用"。
   */
  var pipWindow = null
  var pipLoop = null

  function pipSupported() {
    return Boolean(window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === 'function')
  }

  function requestPipWindow() {
    var availW = (typeof screen !== 'undefined' && screen.availWidth) || 1280
    var availH = (typeof screen !== 'undefined' && screen.availHeight) || 800
    return window.documentPictureInPicture.requestWindow({
      // 尽量开大：码越大，摄像头越好认
      width: Math.max(320, Math.round(Math.min(availW * 0.92, 1400))),
      height: Math.max(240, Math.round(Math.min(availH * 0.92, 1000))),
      preferInitialWindowPlacement: true
    })
  }

  /** 用户直接关掉码窗 = 停止发送（点主窗口的停止按钮，走 app.js 自己的收尾逻辑） */
  function stopFromCodeWindow() {
    var btn = document.getElementById('stop')
    if (btn && typeof btn.click === 'function') btn.click()
  }

  function buildPipChrome(win) {
    var doc = win.document
    doc.title = '光学隔空传输 · 码窗'
    if (doc.body) doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden;width:100vw;height:100vh'

    var canvas = doc.createElement('canvas')
    canvas.setAttribute('id', 'pip-canvas')
    canvas.style.cssText =
      'display:block;width:100vw;height:100vh;object-fit:contain;background:#000;image-rendering:pixelated'
    doc.body.appendChild(canvas)

    var hud = doc.createElement('div')
    hud.setAttribute('id', 'pip-hud')
    hud.textContent = '把接收端摄像头对准这个窗口 · 码窗已置顶'
    hud.style.cssText =
      'position:fixed;left:0;right:0;top:0;padding:6px 10px;font:12px/1.5 system-ui,sans-serif;' +
      'color:#9be29b;background:rgba(0,0,0,.55);pointer-events:none;text-align:center'
    doc.body.appendChild(hud)

    var stop = doc.createElement('button')
    stop.setAttribute('id', 'pip-stop')
    stop.type = 'button'
    stop.textContent = '停止'
    stop.style.cssText =
      'position:fixed;right:10px;bottom:10px;padding:8px 18px;font:14px system-ui,sans-serif;' +
      'color:#fff;background:rgba(220,50,50,.9);border:0;border-radius:6px;cursor:pointer;opacity:.75'
    stop.addEventListener('click', stopFromCodeWindow)
    doc.body.appendChild(stop)

    return canvas
  }

  function setupPipWindow(win) {
    pipWindow = win
    var canvas = buildPipChrome(win)
    var ctx = canvas.getContext('2d', { alpha: false })
    // PiP 窗口一定有 requestAnimationFrame，但降级到主窗口的也无妨
    var raf = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : window.requestAnimationFrame
    var caf = typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : window.cancelAnimationFrame

    function mirror() {
      if (!pipWindow || pipWindow !== win) return
      var src = document.getElementById('code-canvas')
      // 源画布由共用 UI 按设备像素比铺满主窗口；这里 1:1 拷贝，CSS 负责适配显示
      if (src && src.width && src.height) {
        if (canvas.width !== src.width || canvas.height !== src.height) {
          canvas.width = src.width
          canvas.height = src.height
        }
        try {
          ctx.drawImage(src, 0, 0)
        } catch (err) {
          /* 尺寸竞态时跳过这一帧即可 */
        }
      }
      pipLoop = raf(mirror)
    }
    mirror()

    win.addEventListener('pagehide', function () {
      if (pipLoop && caf) caf(pipLoop)
      pipLoop = null
      // exitFullscreen() 是**先清引用再 close**，所以它触发的 pagehide 走到这里时
      // `pipWindow !== win`，不会误判成"用户关掉了码窗"；只有用户自己关窗才会命中。
      // 即便真重复点一次停止也是幂等的（app.js 的 stopSending 容忍重复调用）。
      var closedByUser = pipWindow === win
      pipWindow = null
      if (closedByUser) stopFromCodeWindow()
    })
  }

  function requestFullscreenFallback() {
    var el = document.documentElement
    var fn = el.requestFullscreen || el.webkitRequestFullscreen
    if (!fn) return Promise.resolve(false)
    try {
      var p = fn.call(el)
      return p && p.then
        ? p.then(
            function () {
              return true
            },
            function () {
              return false
            }
          )
        : Promise.resolve(true)
    } catch (err) {
      return Promise.resolve(false)
    }
  }

  function enterFullscreen() {
    // 已经开着码窗就别再动它（重复 start 时不该把码窗关了）
    if (pipWindow && !pipWindow.closed) return Promise.resolve(true)

    if (pipSupported()) {
      try {
        return Promise.resolve(requestPipWindow()).then(
          function (win) {
            setupPipWindow(win)
            return true
          },
          function (err) {
            // PiP 需要用户手势；拿不到就如实退回普通全屏，而不是什么都不做
            console.warn('[pip] 置顶码窗打不开，退回全屏：' + ((err && err.message) || err))
            return requestFullscreenFallback()
          }
        )
      } catch (err) {
        console.warn('[pip] 置顶码窗抛异常，退回全屏：' + ((err && err.message) || err))
      }
    }
    return requestFullscreenFallback()
  }

  function exitFullscreen() {
    // 先清引用再 close：pagehide 回调里才不会把这次"主动关闭"误判成用户关窗
    var win = pipWindow
    pipWindow = null
    if (win && !win.closed) {
      try {
        win.close()
      } catch (err) {
        /* 已经关了就算了 */
      }
    }
    var fn = document.exitFullscreen || document.webkitExitFullscreen
    if (fn) {
      try {
        var p = fn.call(document)
        if (p && p.then) {
          return p.then(
            function () {
              return true
            },
            function () {
              return true
            }
          )
        }
      } catch (err) {
        /* 不在全屏里，正常 */
      }
    }
    return Promise.resolve(true)
  }

  /* ====================================================================== */
  /*                              三、文件选择                               */
  /* ====================================================================== */

  /** <input type=file>：扩展页面里同样能调起系统文件选择器，不需要任何权限 */
  function pickFile(accept) {
    return new Promise(function (resolve) {
      var input = document.createElement('input')
      input.type = 'file'
      if (accept) input.accept = accept
      input.style.cssText = 'position:fixed;left:-9999px;top:0'
      document.body.appendChild(input)

      var done = false
      function finish(result) {
        if (done) return
        done = true
        if (input.parentNode) input.parentNode.removeChild(input)
        resolve(result)
      }

      input.addEventListener('change', function () {
        var f = input.files && input.files[0]
        if (!f) return finish(null)
        var reader = f.arrayBuffer
          ? f.arrayBuffer().then(function (b) {
              return new Uint8Array(b)
            })
          : new Promise(function (res) {
              var fr = new FileReader()
              fr.onload = function () {
                res(new Uint8Array(fr.result))
              }
              fr.readAsArrayBuffer(f)
            })
        reader.then(
          function (bytes) {
            finish({ name: f.name, bytes: bytes, size: bytes.length })
          },
          function () {
            finish(null)
          }
        )
      })
      // Chrome 113+ 会为"用户取消"派发 cancel 事件；没有它旧版本会一直挂着不 resolve
      input.addEventListener('cancel', function () {
        finish(null)
      })

      input.click()
    })
  }

  /* ====================================================================== */
  /*                              四、保存文件                               */
  /* ====================================================================== */

  function blobDownload(name, data) {
    var url = URL.createObjectURL(new Blob([data]))
    var a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a)
      URL.revokeObjectURL(url)
    }, 4000)
    return { saved: false, uri: name, mode: 'browser-download' }
  }

  /** 第二档：chrome.downloads 的"另存为"，会弹出浏览器的保存对话框（能选路径） */
  function saveViaDownloads(name, data) {
    if (!CHROME || !CHROME.downloads || typeof CHROME.downloads.download !== 'function') {
      return Promise.resolve(blobDownload(name, data))
    }
    var url = URL.createObjectURL(new Blob([data]))
    var p
    try {
      p = CHROME.downloads.download({ url: url, filename: name, saveAs: true })
    } catch (err) {
      p = Promise.reject(err)
    }
    return Promise.resolve(p).then(
      function (downloadId) {
        setTimeout(function () {
          URL.revokeObjectURL(url)
        }, 60000)
        return { saved: true, uri: name, mode: 'chrome-downloads', downloadId: downloadId }
      },
      function (err) {
        URL.revokeObjectURL(url)
        var msg = (err && err.message) || String(err)
        if (/cancel/i.test(msg)) return { saved: false, cancelled: true }
        console.warn('[save] chrome.downloads 失败，退回普通下载：' + msg)
        return blobDownload(name, data)
      }
    )
  }

  /**
   * 保存接收到的文件。三档降级：
   *   1. **showSaveFilePicker**（File System Access）—— 真"另存为"对话框，路径由用户定
   *   2. `chrome.downloads.download({saveAs:true})` —— 浏览器的保存对话框
   *   3. Blob + <a download> —— 直接落进下载目录（与安卓版在浏览器里的降级一致）
   *
   * 用户取消必须返回 `{cancelled:true}`：app.js 靠这个字段区分"取消"和"失败"。
   */
  function saveFile(name, bytes) {
    var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0)
    var fileName = name || 'received.bin'

    if (typeof window.showSaveFilePicker === 'function') {
      var handleP
      try {
        handleP = window.showSaveFilePicker({ suggestedName: fileName })
      } catch (err) {
        return Promise.resolve(saveViaDownloads(fileName, data))
      }
      return Promise.resolve(handleP).then(
        function (handle) {
          return handle
            .createWritable()
            .then(function (writable) {
              return writable.write(data).then(function () {
                return writable.close()
              })
            })
            .then(function () {
              return { saved: true, uri: handle.name || fileName, mode: 'file-system-access' }
            })
        },
        function (err) {
          if (err && err.name === 'AbortError') return { saved: false, cancelled: true }
          console.warn('[save] 另存为失败，退回下载：' + ((err && err.message) || err))
          return saveViaDownloads(fileName, data)
        }
      )
    }
    return saveViaDownloads(fileName, data)
  }

  /* ====================================================================== */
  /*                              五、自检信息                               */
  /* ====================================================================== */

  function envInfo() {
    return {
      native: isExtension(),
      platform: isExtension() ? 'chrome-extension' : 'web',
      platformLabel: platformLabel(),
      plugins: {
        // 屏幕常亮：标准 Screen Wake Lock
        KeepAwake: Boolean(typeof navigator !== 'undefined' && navigator.wakeLock && navigator.wakeLock.request),
        // 置顶码窗：Document Picture-in-Picture
        AlwaysOnTop: pipSupported(),
        // 保存到指定路径：File System Access（否则只能走浏览器下载）
        SaveToPath: typeof window.showSaveFilePicker === 'function',
        // 亮度：浏览器**拿不到**，如实报 false（UI 上会显示"缺 ScreenBrightness"）
        ScreenBrightness: false
      },
      secureContext: Boolean(window.isSecureContext),
      hasCamera: Boolean(typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    }
  }

  window.Native = {
    __extension: true,

    isNative: isExtension,

    keepAwake: keepAwakeThenable,

    pickFile: pickFile,

    saveFile: saveFile,

    enterFullscreen: enterFullscreen,

    exitFullscreen: exitFullscreen,

    envInfo: envInfo
  }
})()
