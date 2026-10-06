/**
 * utools-shim.js —— 让 uTools 插件页面在**纯浏览器**里跑起来（免登录）
 *
 * 背景：uTools 的「接入开发」和「打包 UPXS」都在开发者工具里，绕不开登录。
 * 三个插件页面本身几乎不直接依赖 uTools——它们调用的是 preload 注入的
 * `window.utoolsBridge` 和 `window.utools`。所以只要在页面脚本之前注入一份
 * **浏览器实现**，同一份页面就能在 localhost 上直接跑。
 *
 * 为什么必须用 localhost 而不是 file://：
 *   - 方案二/三的接收端要加载 vendor/raptorq.core.wasm，`file://` 下 Chromium
 *     会直接拒绝 fetch 该 scheme；
 *   - `localhost` 是安全上下文，fetch 与摄像头都能用。
 *
 * 设计要点：
 *  1. **虚拟文件系统（VFS）**：浏览器拿不到真实路径，所以 showOpenDialog 返回
 *     一个合成路径，字节存在内存里；readFile/statPath/sha/readBinary 都按它解析。
 *  2. **showOpenDialog 是同步 API，而浏览器选文件是异步的**。所以这个替身
 *     立刻返回 []，等用户真的选完文件后**派发插件进入事件**（复用插件本来就
 *     支持的 `*-send-files` 匹配指令链路）。这样不用改任何页面逻辑。
 *  3. **子窗口用同源 iframe** 承载，payload 直接走对象引用（`window.parent`），
 *     不做序列化——文件字节不需要过 JSON 或 sessionStorage。
 *  4. 整份文件包在 IIFE 里，**不产生任何顶层词法声明**：classic script 共享
 *     全局作用域，顶层 const/let 重名会让整个页面白屏（本项目踩过）。
 */
;(function () {
  'use strict'

  if (typeof window === 'undefined' || typeof document === 'undefined') return
  // 已经在 uTools 里跑就不要覆盖真实现
  if (window.__OTP_SHIM_INSTALLED__) return
  window.__OTP_SHIM_INSTALLED__ = true

  var VFS_PREFIX = '/__browser__/'
  var vfs = Object.create(null) // fakePath -> { name, bytes }
  var enterListeners = []
  var outListeners = []
  var lastEnterAction = null
  var featureCodes = { send: null, receive: null, sendFiles: null }
  var childMessages = Object.create(null)
  var lastMessage = null
  var currentOverlay = null

  /* ------------------------------------------------------------------ */
  /*                                小工具                               */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /*                          同步 SHA-256（纯 JS）                      */
  /* ------------------------------------------------------------------ */

  /**
   * 为什么需要自己实现：`crypto.subtle` **只在安全上下文可用**。
   * 用 localhost 访问时没问题，但如果你用局域网 IP（http://192.168.x.x:8000）
   * 打开，`crypto.subtle` 就是 undefined —— 此时 preload 的 `sha256Bytes`
   * 兜底就成了唯一可用的路径。所以这里给一个真的同步实现，而不是抛错的占位。
   */
  var SHA256_K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ])

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n))
  }

  function sha256Hex(input) {
    var bytes = toUint8(input)
    if (!bytes) throw new Error('sha256Bytes 需要 Uint8Array / ArrayBuffer')
    var len = bytes.length
    // 填充：0x80 + 若干 0 + 8 字节大端比特长度，总长补齐到 64 的整数倍
    var total = Math.ceil((len + 9) / 64) * 64
    var buf = new Uint8Array(total)
    buf.set(bytes)
    buf[len] = 0x80
    var bits = len * 8
    var hi = Math.floor(bits / 4294967296)
    var lo = bits >>> 0
    buf[total - 8] = (hi >>> 24) & 0xff
    buf[total - 7] = (hi >>> 16) & 0xff
    buf[total - 6] = (hi >>> 8) & 0xff
    buf[total - 5] = hi & 0xff
    buf[total - 4] = (lo >>> 24) & 0xff
    buf[total - 3] = (lo >>> 16) & 0xff
    buf[total - 2] = (lo >>> 8) & 0xff
    buf[total - 1] = lo & 0xff

    var h0 = 0x6a09e667
    var h1 = 0xbb67ae85
    var h2 = 0x3c6ef372
    var h3 = 0xa54ff53a
    var h4 = 0x510e527f
    var h5 = 0x9b05688c
    var h6 = 0x1f83d9ab
    var h7 = 0x5be0cd19
    var w = new Int32Array(64)

    for (var off = 0; off < total; off += 64) {
      for (var t = 0; t < 16; t++) {
        var i = off + t * 4
        w[t] = ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) | 0
      }
      for (t = 16; t < 64; t++) {
        var x = w[t - 15]
        var y = w[t - 2]
        var s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
        var s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
      }
      var a = h0
      var b = h1
      var c = h2
      var d = h3
      var e = h4
      var f = h5
      var g = h6
      var h = h7
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
        var ch = (e & f) ^ (~e & g)
        var t1 = (h + S1 + ch + SHA256_K[t] + w[t]) | 0
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
        var maj = (a & b) ^ (a & c) ^ (b & c)
        var t2 = (S0 + maj) | 0
        h = g
        g = f
        f = e
        e = (d + t1) | 0
        d = c
        c = b
        b = a
        a = (t1 + t2) | 0
      }
      h0 = (h0 + a) | 0
      h1 = (h1 + b) | 0
      h2 = (h2 + c) | 0
      h3 = (h3 + d) | 0
      h4 = (h4 + e) | 0
      h5 = (h5 + f) | 0
      h6 = (h6 + g) | 0
      h7 = (h7 + h) | 0
    }

    var out = ''
    var words = [h0, h1, h2, h3, h4, h5, h6, h7]
    for (var k = 0; k < 8; k++) {
      var v = words[k] >>> 0
      out += ('00000000' + v.toString(16)).slice(-8)
    }
    return out
  }

  function notify(message, kind) {
    if (window.__OTP_SHELL_TOAST__) {
      window.__OTP_SHELL_TOAST__(message, kind)
      return
    }
    console.log('[browser-shim] ' + message)
  }

  function basename(p) {
    return String(p || '').split(/[\\/]/).pop() || String(p || '')
  }

  function extname(p) {
    var b = basename(p)
    var i = b.lastIndexOf('.')
    return i > 0 ? b.slice(i + 1).toLowerCase() : ''
  }

  function toUint8(value) {
    if (!value) return null
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return null
  }

  function formatBytes(n) {
    if (n == null || isNaN(n)) return '—'
    if (n < 1024) return n + ' B'
    var u = ['KB', 'MB', 'GB']
    var v = n / 1024
    var i = 0
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024
      i++
    }
    return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i]
  }

  function formatTime(d) {
    var p = function (x) {
      return String(x).padStart(2, '0')
    }
    return (
      d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    )
  }

  function readAsBytes(file) {
    if (file.arrayBuffer) return file.arrayBuffer().then(function (b) {
      return new Uint8Array(b)
    })
    return new Promise(function (resolve, reject) {
      var fr = new FileReader()
      fr.onload = function () {
        resolve(new Uint8Array(fr.result))
      }
      fr.onerror = function () {
        reject(fr.error || new Error('读取文件失败'))
      }
      fr.readAsArrayBuffer(file)
    })
  }

  /** 把浏览器 File 对象登记进 VFS，返回合成路径 */
  function registerFile(file) {
    var fakePath = VFS_PREFIX + file.name
    vfs[fakePath] = { name: file.name, bytes: null, file: file }
    return readAsBytes(file).then(function (bytes) {
      vfs[fakePath].bytes = bytes
      return { path: fakePath, name: file.name, size: bytes.length, bytes: bytes }
    })
  }

  function lookup(p) {
    var key = String(p || '')
    if (vfs[key]) return vfs[key]
    // 宽容：允许用纯文件名命中
    var want = basename(key)
    var keys = Object.keys(vfs)
    for (var i = 0; i < keys.length; i++) {
      if (basename(keys[i]) === want) return vfs[keys[i]]
    }
    return null
  }

  /** 从 readBytes / readBinary 里区分"VFS 路径"和"相对 URL" */
  function isVfsPath(p) {
    return String(p || '').indexOf(VFS_PREFIX) === 0
  }

  /* ------------------------------------------------------------------ */
  /*                        插件指令（读 plugin.json）                    */
  /* ------------------------------------------------------------------ */

  function loadFeatureCodes() {
    // 必须是"尽力而为"：替身装不上会让整个页面全废，所以任何异常都不能往外抛。
    if (typeof fetch !== 'function') return Promise.resolve(featureCodes)
    try {
      return fetch('plugin.json')
        .then(function (r) {
          return r.ok ? r.json() : null
        })
        .then(function (json) {
          if (!json || !json.features) return featureCodes
          json.features.forEach(function (f) {
            var cmds = Array.isArray(f.cmds) ? f.cmds : []
            var hasFileCmd = cmds.some(function (c) {
              return c && typeof c === 'object' && c.type === 'files'
            })
            if (hasFileCmd) featureCodes.sendFiles = f.code
            else if (/receive|scan/i.test(f.code) && !featureCodes.receive) featureCodes.receive = f.code
            else if (/send/i.test(f.code) && !featureCodes.send) featureCodes.send = f.code
          })
          return featureCodes
        })
        .catch(function () {
          return featureCodes
        })
    } catch (err) {
      return Promise.resolve(featureCodes)
    }
  }

  /* ------------------------------------------------------------------ */
  /*                            进入事件派发                              */
  /* ------------------------------------------------------------------ */

  function dispatchEnter(code, type, payload, from) {
    var action = { code: code, type: type, payload: payload, from: from || 'main' }
    lastEnterAction = action
    enterListeners.forEach(function (fn) {
      try {
        fn(action)
      } catch (err) {
        console.error('[browser-shim] onPluginEnter 回调异常', err)
      }
    })
    try {
      window.dispatchEvent(new CustomEvent('utools:enter', { detail: action }))
    } catch (err) {
      /* 忽略 */
    }
  }

  /** 选完文件后走插件本来就有的"匹配文件"链路 */
  function sendFiles(files) {
    var list = Array.prototype.slice.call(files || [])
    if (!list.length) return
    Promise.all(list.map(registerFile)).then(function (entries) {
      if (!featureCodes.sendFiles) {
        notify('这个插件的 plugin.json 里没有 files 匹配指令，无法在浏览器里发送文件', 'err')
        return
      }
      dispatchEnter(
        featureCodes.sendFiles,
        'files',
        entries.map(function (e) {
          return { path: e.path, name: e.name, isFile: true, isDirectory: false, size: e.size }
        }),
        'panel'
      )
    })
  }

  /** 打开系统文件选择框（异步），选完派发事件 */
  function pickFiles(multiple) {
    var input = document.createElement('input')
    input.type = 'file'
    input.multiple = Boolean(multiple)
    input.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(input)
    input.addEventListener('change', function () {
      var files = input.files
      document.body.removeChild(input)
      sendFiles(files)
    })
    input.click()
  }

  /* ------------------------------------------------------------------ */
  /*                           iframe 子窗口                             */
  /* ------------------------------------------------------------------ */

  function browserEntryName(htmlName) {
    var name = String(htmlName || '').split('?')[0].split('/').pop()
    return name.replace(/\.html?$/i, '') + '.browser.html'
  }

  function openOverlay(htmlName, payload) {
    closeOverlay()
    window.__OTP_START_PAYLOAD__ = payload || null
    var frame = document.createElement('iframe')
    frame.src = browserEntryName(htmlName)
    frame.setAttribute('data-otp-overlay', '1')
    frame.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2147483000;background:#0b0b0f'
    document.body.appendChild(frame)
    currentOverlay = frame
    return frame
  }

  function closeOverlay() {
    if (currentOverlay && currentOverlay.parentNode) currentOverlay.parentNode.removeChild(currentOverlay)
    currentOverlay = null
  }

  window.__OTP_CLOSE_OVERLAY__ = closeOverlay

  window.__OTP_CHILD_MESSAGE__ = function (channel, data) {
    childMessages[channel] = data
    lastMessage = { channel: channel, data: data }
    if (typeof window.__OTP_SHELL_PROGRESS__ === 'function') {
      try {
        window.__OTP_SHELL_PROGRESS__(channel, data)
      } catch (err) {
        /* 忽略 */
      }
    }
  }

  function childHook(payload) {
    window.utoolsBridge.__setStartPayload(payload)
  }

  function fakeWindow(url, options, callback) {
    var frame = openOverlay(url, null)
    var win = {
      webContents: {
        send: function (channel, data) {
          var apply = function () {
            try {
              if (frame.contentWindow && frame.contentWindow.utoolsBridge && frame.contentWindow.utoolsBridge.__setStartPayload) {
                childHook(data)
              }
            } catch (err) {
              /* 忽略跨帧异常 */
            }
          }
          if (frame.contentWindow && frame.contentWindow.document && frame.contentWindow.document.readyState === 'complete') apply()
          else frame.addEventListener('load', apply)
        }
      },
      show: function () {},
      hide: function () {},
      focus: function () {},
      close: closeOverlay,
      destroy: closeOverlay,
      isDestroyed: function () {
        return !(currentOverlay && document.body.contains(currentOverlay))
      },
      setAlwaysOnTop: function () {},
      setFullScreen: function () {},
      isFullScreen: function () {
        return false
      },
      loadURL: function (u) {
        frame.src = u
      }
    }
    if (typeof callback === 'function') frame.addEventListener('load', function () {
      callback(win)
    })
    return win
  }

  /* ------------------------------------------------------------------ */
  /*                              截屏 / 摄像头                          */
  /* ------------------------------------------------------------------ */

  function grabDisplayFrame(callback) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      notify('这个浏览器不支持 getDisplayMedia，无法截屏；可以改用「选择帧图片」导入', 'err')
      return
    }
    navigator.mediaDevices
      .getDisplayMedia({ video: true })
      .then(function (stream) {
        var video = document.createElement('video')
        video.srcObject = stream
        video.muted = true
        return video.play().then(function () {
          return new Promise(function (resolve) {
            setTimeout(resolve, 150)
          }).then(function () {
            var canvas = document.createElement('canvas')
            canvas.width = video.videoWidth || 1280
            canvas.height = video.videoHeight || 720
            canvas.getContext('2d').drawImage(video, 0, 0)
            var url = canvas.toDataURL('image/png')
            stream.getTracks().forEach(function (t) {
              t.stop()
            })
            return url
          })
        })
      })
      .then(function (dataUrl) {
        if (typeof callback === 'function') callback(dataUrl)
      })
      .catch(function (err) {
        notify('截屏失败：' + ((err && err.message) || err), 'err')
      })
  }

  /* ------------------------------------------------------------------ */
  /*                                 utools                              */
  /* ------------------------------------------------------------------ */

  var displayFromScreen = function () {
    return {
      id: 1,
      bounds: { x: 0, y: 0, width: window.screen.width, height: window.screen.height },
      workArea: { x: 0, y: 0, width: window.screen.availWidth, height: window.screen.availHeight },
      scaleFactor: window.devicePixelRatio || 1,
      size: { width: window.screen.width, height: window.screen.height }
    }
  }

  var dbStorage = (function () {
    var KEY = '__otp_db__'
    var mem = Object.create(null)
    try {
      var raw = window.localStorage.getItem(KEY)
      if (raw) mem = JSON.parse(raw) || Object.create(null)
    } catch (err) {
      /* 无 localStorage 时退化为内存 */
    }
    function persist() {
      try {
        window.localStorage.setItem(KEY, JSON.stringify(mem))
      } catch (err) {
        /* 忽略配额错误 */
      }
    }
    return {
      setItem: function (k, v) {
        mem[k] = v
        persist()
        return true
      },
      getItem: function (k) {
        return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null
      },
      removeItem: function (k) {
        delete mem[k]
        persist()
        return true
      }
    }
  })()

  var utoolsImpl = {
    isDev: function () {
      return false
    },
    isMacOS: function () {
      return /Mac/i.test(navigator.platform || navigator.userAgent)
    },
    isWindows: function () {
      return /Win/i.test(navigator.platform || navigator.userAgent)
    },
    isLinux: function () {
      return /Linux/i.test(navigator.platform || navigator.userAgent)
    },
    getAppVersion: function () {
      return 'browser'
    },
    getAppName: function () {
      return '浏览器'
    },
    getWindowType: function () {
      return window.parent && window.parent !== window ? 'browser' : 'main'
    },
    getNativeId: function () {
      return 'browser'
    },
    getPath: function (name) {
      return VFS_PREFIX + (name || 'home')
    },
    /** 同步 API，但浏览器选文件是异步的：立刻返回 []，选完再派发进入事件 */
    showOpenDialog: function (options) {
      pickFiles(Boolean(options && options.properties && options.properties.indexOf('multiSelections') >= 0))
      return []
    },
    showSaveDialog: function (options) {
      var def = (options && options.defaultPath) || 'download.bin'
      return def
    },
    copyText: function (text) {
      var s = String(text == null ? '' : text)
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(s).catch(function () {
          notify('复制失败（浏览器可能要求 HTTPS 或用户手势）', 'err')
        })
      }
      return true
    },
    showNotification: function (body) {
      notify(String(body))
    },
    hideMainWindow: function () {
      return true
    },
    showMainWindow: function () {
      return true
    },
    outPlugin: function () {
      return true
    },
    setExpendHeight: function () {
      return true
    },
    setSubInput: function () {
      return true
    },
    removeSubInput: function () {
      return true
    },
    createBrowserWindow: fakeWindow,
    getPrimaryDisplay: displayFromScreen,
    getAllDisplays: function () {
      return [displayFromScreen()]
    },
    getCursorScreenPoint: function () {
      return { x: 0, y: 0 }
    },
    getDisplayNearestPoint: displayFromScreen,
    getDisplayMatching: displayFromScreen,
    screenCapture: grabDisplayFrame,
    desktopCaptureSources: function () {
      return Promise.reject(new Error('浏览器不支持 desktopCaptureSources'))
    },
    shellOpenPath: function () {},
    shellShowItemInFolder: function () {},
    shellOpenExternal: function (url) {
      window.open(url, '_blank', 'noopener')
    },
    shellBeep: function () {},
    showItemInFolder: function () {},
    getFileIcon: function () {
      return ''
    },
    dbStorage: dbStorage,
    onPluginEnter: function (cb) {
      if (typeof cb === 'function') enterListeners.push(cb)
    },
    onPluginOut: function (cb) {
      if (typeof cb === 'function') outListeners.push(cb)
    },
    onPluginDetach: function () {},
    onDbPull: function () {},
    onMainPush: function () {},
    sendToParent: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1)
      if (window.parent && window.parent !== window && window.parent.__OTP_CHILD_MESSAGE__) {
        window.parent.__OTP_CHILD_MESSAGE__(channel, args.length > 1 ? args : args[0])
      } else {
        window.__OTP_CHILD_MESSAGE__(channel, args.length > 1 ? args : args[0])
      }
    },
    redirect: function () {},
    isDarkColors: function () {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    },
    startDrag: function () {}
  }

  /* ------------------------------------------------------------------ */
  /*                             utoolsBridge                            */
  /* ------------------------------------------------------------------ */

  var bridgeImpl = {
    /* --- 文件读取（VFS）--- */
    readFile: function (p) {
      var entry = lookup(p)
      if (!entry) throw new Error('浏览器环境里找不到这个文件：' + p)
      if (!entry.bytes) throw new Error('文件还没读完，请稍候重试：' + entry.name)
      return { name: entry.name, bytes: entry.bytes }
    },
    readBinary: function (p) {
      // 虚拟路径 → 内存里的字节；其它（相对 URL，比如 vendor/raptorq.core.wasm）
      // → fetch。返回 Promise 是可以的：raptorq.core.js 那侧会 Promise.resolve 解包。
      if (isVfsPath(p)) {
        var entry = lookup(p)
        if (!entry || !entry.bytes) throw new Error('找不到文件：' + p)
        return entry.bytes
      }
      return fetch(p).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.arrayBuffer().then(function (b) {
          return new Uint8Array(b)
        })
      })
    },
    readVendorBytes: function (relPath) {
      return bridgeImpl.readBinary(relPath)
    },
    readImageAsDataUrl: function (p) {
      var entry = lookup(p)
      if (!entry || !entry.bytes) throw new Error('找不到图片：' + p)
      var blob = new Blob([entry.bytes])
      return new Promise(function (resolve) {
        var fr = new FileReader()
        fr.onload = function () {
          resolve(fr.result)
        }
        fr.readAsDataURL(blob)
      })
    },
    statPath: function (p) {
      var entry = lookup(p)
      if (!entry) return { path: p, name: basename(p), exists: false, isDirectory: false, size: null }
      return {
        path: p,
        name: entry.name,
        exists: true,
        isDirectory: false,
        size: entry.bytes ? entry.bytes.length : null,
        sizeText: formatBytes(entry.bytes ? entry.bytes.length : null),
        mtime: entry.file && entry.file.lastModified ? formatTime(new Date(entry.file.lastModified)) : '',
        ext: extname(entry.name)
      }
    },
    describe: function (target) {
      return bridgeImpl.statPath(typeof target === 'string' ? target : target && target.path)
    },
    sha: function (input) {
      var bytesPromise
      if (typeof input === 'string') {
        var entry = lookup(input)
        if (!entry || !entry.bytes) return Promise.reject(new Error('找不到文件：' + input))
        bytesPromise = Promise.resolve(entry.bytes)
      } else {
        bytesPromise = Promise.resolve(toUint8(input))
      }
      return bytesPromise.then(function (bytes) {
        // crypto.subtle 只在安全上下文可用（localhost 可以，局域网 IP 不行），
        // 拿不到就退回同步实现，保证行为一致。
        if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
          return window.crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
            return Array.prototype.map
              .call(new Uint8Array(digest), function (b) {
                return b.toString(16).padStart(2, '0')
              })
              .join('')
          })
        }
        return sha256Hex(bytes)
      })
    },
    /** 同步版：preload 里也是同步返回 hex 字符串，契约保持一致 */
    sha256Bytes: function (input) {
      if (typeof input === 'string') {
        var entry = lookup(input)
        if (!entry || !entry.bytes) throw new Error('找不到文件：' + input)
        return sha256Hex(entry.bytes)
      }
      return sha256Hex(input)
    },
    /** 保存：浏览器里等价于"触发下载"。返回传给它的目标路径，保证调用方拿到字符串。 */
    writeFile: function (target, bytes, name) {
      var data = toUint8(bytes)
      if (!data) throw new Error('writeFile 需要 Uint8Array')
      var fileName = name || basename(target) || 'download.bin'
      var blob = new Blob([data])
      var url = URL.createObjectURL(blob)
      var a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      setTimeout(function () {
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }, 4000)
      return target || fileName
    },
    getPath: function (name) {
      return VFS_PREFIX + (name || 'home')
    },
    showSaveDialog: function (options) {
      return ((options && options.defaultPath) || 'download.bin')
    },
    showOpenDialog: function (options) {
      return utoolsImpl.showOpenDialog(options)
    },
    /* --- 子窗口 --- */
    openSenderWindow: function (payload) {
      var frame = openOverlay('sender.html', payload)
      return { ok: true, frame: frame }
    },
    openScanWindow: function (payload) {
      var frame = openOverlay('receiver.html', payload)
      return { ok: true, frame: frame }
    },
    getStartPayload: function () {
      if (window.__OTP_START_PAYLOAD__) return window.__OTP_START_PAYLOAD__
      try {
        if (window.parent && window.parent !== window) return window.parent.__OTP_START_PAYLOAD__ || null
      } catch (err) {
        return null
      }
      return null
    },
    __setStartPayload: function (payload) {
      window.__OTP_START_PAYLOAD__ = payload
      try {
        window.dispatchEvent(new CustomEvent('otp:start', { detail: payload }))
      } catch (err) {
        /* 忽略 */
      }
    },
    sendToParent: function (channel, data) {
      utoolsImpl.sendToParent(channel, data)
    },
    getLastProgress: function () {
      if (lastMessage && /progress/i.test(lastMessage.channel)) return lastMessage.data
      return lastMessage ? lastMessage.data : null
    },
    close: function () {
      if (window.parent && window.parent !== window && window.parent.__OTP_CLOSE_OVERLAY__) {
        window.parent.__OTP_CLOSE_OVERLAY__()
      } else {
        window.close()
      }
    },
    captureScreen: grabDisplayFrame,
    screenCapture: grabDisplayFrame,
    displays: function () {
      return [displayFromScreen()]
    },
    /* --- 事件 --- */
    onPluginEnter: function (cb) {
      if (typeof cb === 'function') enterListeners.push(cb)
      return function () {
        var i = enterListeners.indexOf(cb)
        if (i >= 0) enterListeners.splice(i, 1)
      }
    },
    onPluginOut: function (cb) {
      if (typeof cb === 'function') outListeners.push(cb)
      return function () {}
    },
    getLastEnterAction: function () {
      return lastEnterAction
    },
    getLastProgressMessage: function () {
      return lastMessage
    },
    isDev: function () {
      return false
    },
    platform: 'browser',
    versions: { node: '浏览器', electron: '—' },
    /* --- 外壳用 --- */
    __pickFiles: pickFiles,
    __sendFiles: sendFiles,
    __dispatchEnter: dispatchEnter,
    __featureCodes: featureCodes
  }

  window.utools = utoolsImpl
  window.utoolsBridge = bridgeImpl

  // 指令表只是"锦上添花"（决定选完文件往哪个 code 派发），拿不到也不影响
  // 替身本身可用，所以这里再兜一层 try。
  try {
    loadFeatureCodes()
  } catch (err) {
    console.warn('[browser-shim] 读取 plugin.json 失败，将退回默认指令名', err)
  }
})()
