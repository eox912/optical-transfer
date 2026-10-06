/**
 * receiver.js —— airscan-qr 接收端：解帧摄入 + 摄像头/图片扫描 + 界面
 *
 * 和 sender.js 一样，这里只依赖 OTP 全局；渲染与扫码循环抽成可复用件，
 * standalone.html 复用 createEngine / createScanner，只是自己接 DOM。
 *
 * 能力如实上报（PLUGIN-SPEC §7）：
 *   本插件没有 RaptorQ 的 WASM 核。收到 MODE_RAPTORQ 描述符时，
 *   OTP.codecs.createReceiver 会回退到 LT 解码器——只有当发送端**也**处于
 *   LT 回退状态时才收得全。这一点会在界面上明确标出来，不假装支持。
 */
;(function (root) {
  'use strict'

  var ASQ = (root.ASQ = root.ASQ || {})

  function core() {
    var o = root.OTP
    if (!o || !o.protocol || !o.scan || !o.codecs) {
      throw new Error('OTP 未加载：请先按 vendor → core（codecs 最后）的顺序引入脚本')
    }
    return o
  }

  var TEXT_EXT = [
    'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'yml', 'yaml',
    'js', 'mjs', 'cjs', 'ts', 'css', 'html', 'htm', 'ini', 'conf', 'cfg', 'sh', 'py', 'go', 'rs'
  ]

  function extOf(name) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''))
    return m ? m[1].toLowerCase() : ''
  }

  /* ------------------------------------------------------------------ */
  /*                              解码引擎                               */
  /* ------------------------------------------------------------------ */

  /**
   * 摄入 protocol.decodeFrame() 解出的帧，维护解码进度。
   * 三种模式共用：createReceiver 会凭描述符帧自己选解码器。
   */
  function createEngine() {
    var OTP = core()
    var protocol = OTP.protocol
    var receiver = null
    var descriptor = null
    var result = null
    var startedAt = null
    var stats = {
      seen: 0,
      accepted: 0,
      duplicate: 0,
      stale: 0,
      noDescriptor: 0,
      unsupported: 0,
      sessions: 0
    }
    var recent = [] // 最近成功帧的时间戳，算有效帧率

    function reset() {
      receiver = null
      descriptor = null
      result = null
      startedAt = null
      recent = []
      stats = { seen: 0, accepted: 0, duplicate: 0, stale: 0, noDescriptor: 0, unsupported: 0, sessions: 0 }
    }

    function attach(desc) {
      descriptor = desc
      receiver = OTP.codecs.createReceiver(desc)
      stats.sessions++
      startedAt = Date.now()
      recent = []
    }

    function rate() {
      if (recent.length < 2) return 0
      var span = (recent[recent.length - 1] - recent[0]) / 1000
      return span > 0 ? (recent.length - 1) / span : 0
    }

    return {
      /**
       * @param {object} frame protocol.decodeFrame() 的产物
       * @returns {{kind:string, accepted?:boolean, complete?:boolean, newSession?:boolean}}
       */
      ingest: function (frame) {
        stats.seen++
        if (!frame) return { kind: 'noise' }

        if (frame.type === protocol.TYPE_DESCRIPTOR) {
          var isNew =
            !descriptor ||
            descriptor.sessionId !== frame.sessionId ||
            descriptor.totalBytes !== frame.totalBytes ||
            descriptor.symbolSize !== frame.symbolSize
          if (isNew) {
            attach(frame)
            return { kind: 'descriptor', newSession: true }
          }
          return { kind: 'descriptor' }
        }

        if (frame.type === protocol.TYPE_DATA) {
          if (!receiver) {
            stats.noDescriptor++
            return { kind: 'no-descriptor' }
          }
          if (descriptor.sessionId !== frame.sessionId) {
            stats.stale++
            return { kind: 'stale-session' }
          }
          if (receiver.backend === 'unavailable') {
            // 发送端用了真 RaptorQ（描述符带 OTI），本端没有 WASM 内核。
            // 这时候不能装作在收，也不能偷偷用 LT 解（编码方式不同，只会得到垃圾）。
            stats.unsupported++
            return { kind: 'unsupported', reason: receiver.error || '' }
          }
          var accepted = receiver.add(frame.blockIndex, frame.esi, frame.payload)
          if (accepted) {
            stats.accepted++
            recent.push(Date.now())
            if (recent.length > 120) recent.shift()
          } else {
            stats.duplicate++
          }
          var complete = receiver.isComplete
          if (complete && !result) result = receiver.assemble()
          return { kind: accepted ? 'accepted' : 'duplicate', accepted: accepted, complete: complete }
        }

        return { kind: 'unknown' }
      },

      hasDescriptor: function () {
        return Boolean(descriptor)
      },
      /** 当前收到的是哪种模式（UI 必须显示） */
      mode: function () {
        return descriptor ? descriptor.mode : null
      },
      modeKey: function () {
        return descriptor ? OTP.codecs.modeKey(descriptor.mode) : null
      },
      modeLabel: function () {
        return descriptor ? OTP.codecs.infoFor(descriptor.mode).label : '等待描述符帧…'
      },
      /** 这条流本端根本解不了（例如真 RaptorQ 而本插件没有 WASM 核） */
      unsupported: function () {
        return Boolean(receiver && receiver.backend === 'unavailable')
      },
      unsupportedReason: function () {
        return receiver && receiver.error ? receiver.error : ''
      },
      backendKind: function () {
        return receiver && receiver.backend ? receiver.backend : 'js'
      },
      /**
       * 如实上报后端能力（PLUGIN-SPEC §7"不许假装"）：
       *   · 顺序 / LT        → js 解码
       *   · RaptorQ 有 OTI   → 说明发送端用了 WASM RaptorQ，本端没有 → 解不了
       *   · RaptorQ 无 OTI   → 发送端当时也回退到了 LT，本端用同一套 LT 解码
       */
      backendNote: function () {
        if (!descriptor) return '解码后端：js（等待描述符）'
        if (descriptor.mode === protocol.MODE_RAPTORQ) {
          var hasOti = Boolean(descriptor.extra && descriptor.extra.length === 12)
          if (hasOti && !OTP.codecs.raptorqAvailable()) {
            return (
              '⚠ 这条流由 RaptorQ WASM 后端发出（描述符带 OTI），本插件不含 WASM 内核 → 无法解码。' +
              '请换用 raptorqr 插件接收，或让发送端切到 LT 喷泉码/顺序分片。'
            )
          }
          if (hasOti) return '解码后端：WASM RaptorQ'
          return '解码后端：js（发送端为 LT 回退，本端用同一套 LT 解码）'
        }
        return descriptor.mode === protocol.MODE_FOUNTAIN
          ? '解码后端：js（LT 喷泉码）'
          : '解码后端：js（顺序分片）'
      },
      descriptor: function () {
        return descriptor
      },
      name: function () {
        return descriptor ? descriptor.name : ''
      },
      totalBytes: function () {
        return descriptor ? descriptor.totalBytes : 0
      },
      symbolSize: function () {
        return descriptor ? descriptor.symbolSize : 0
      },
      received: function () {
        return receiver ? receiver.received : 0
      },
      needed: function () {
        return receiver ? receiver.needed : 0
      },
      progress: function () {
        return receiver ? receiver.progress : 0
      },
      isComplete: function () {
        return Boolean(receiver && receiver.isComplete)
      },
      /** 顺序模式下可枚举缺失序号（喷泉码返回空数组） */
      missing: function (limit) {
        return receiver && receiver.missing ? receiver.missing(limit || 64) : []
      },
      assemble: function () {
        if (!result && receiver && receiver.isComplete) result = receiver.assemble()
        return result
      },
      rate: rate,
      elapsedMs: function () {
        return startedAt ? Date.now() - startedAt : 0
      },
      stats: function () {
        return {
          seen: stats.seen,
          accepted: stats.accepted,
          duplicate: stats.duplicate,
          stale: stats.stale,
          noDescriptor: stats.noDescriptor,
          unsupported: stats.unsupported,
          sessions: stats.sessions
        }
      },
      reset: reset
    }
  }

  /* ------------------------------------------------------------------ */
  /*                               扫描器                                */
  /* ------------------------------------------------------------------ */

  function cameraSupported() {
    return Boolean(
      typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function'
    )
  }

  /**
   * @param {{canvas:HTMLCanvasElement, maxWidth?:number, minIntervalMs?:number,
   *          onFrame:function, onTick?:function, now?:function}} config
   */
  function createScanner(config) {
    var OTP = core()
    var canvas = config.canvas
    var maxWidth = config.maxWidth || 640
    var minInterval = config.minIntervalMs == null ? 66 : config.minIntervalMs
    var now = config.now || function () { return Date.now() }
    var video = null
    var stream = null
    var rafId = null
    var running = false
    var lastScanAt = 0
    var ticks = 0

    function scanSource(source, width, height) {
      var image = OTP.scan.drawScaled(canvas, source, width, height, maxWidth)
      var frame = OTP.scan.decodeFrameFromImage(
        OTP.protocol,
        image.data,
        image.width,
        image.height
      )
      if (frame && config.onFrame) config.onFrame(frame)
      return frame
    }

    function loop() {
      if (!running) return
      rafId = root.requestAnimationFrame
        ? root.requestAnimationFrame(loop)
        : setTimeout(loop, 16)
      var t = now()
      if (t - lastScanAt < minInterval) return
      lastScanAt = t
      var w = video.videoWidth
      var h = video.videoHeight
      if (!w || !h) return
      ticks++
      var frame = scanSource(video, w, h)
      if (config.onTick) config.onTick({ ticks: ticks, hit: Boolean(frame) })
    }

    return {
      /** 打开摄像头并开始扫描 */
      startCamera: function (videoEl, constraints) {
        video = videoEl || video
        if (!cameraSupported()) {
          return Promise.reject(new Error('当前环境没有 navigator.mediaDevices.getUserMedia'))
        }
        var opts = constraints || {
          audio: false,
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
        }
        return navigator.mediaDevices.getUserMedia(opts).then(function (s) {
          stream = s
          video.srcObject = s
          video.setAttribute('playsinline', 'true')
          var played = typeof video.play === 'function' ? video.play() : null
          running = true
          lastScanAt = 0
          loop()
          return played || true
        })
      },
      stop: function () {
        running = false
        if (rafId != null) {
          if (root.cancelAnimationFrame) root.cancelAnimationFrame(rafId)
          else clearTimeout(rafId)
          rafId = null
        }
        if (stream) {
          var tracks = stream.getTracks ? stream.getTracks() : []
          for (var i = 0; i < tracks.length; i++) {
            try {
              tracks[i].stop()
            } catch (err) {
              /* 忽略 */
            }
          }
          stream = null
        }
        if (video) video.srcObject = null
      },
      isRunning: function () {
        return running
      },
      ticks: function () {
        return ticks
      },
      /** 静态图片路径（无摄像头降级）：把一帧图片喂进去 */
      scanSource: scanSource,
      /** 直接喂 ImageData */
      scanImageData: function (imageData) {
        var frame = OTP.scan.decodeFrameFromImage(
          OTP.protocol,
          imageData.data,
          imageData.width,
          imageData.height
        )
        if (frame && config.onFrame) config.onFrame(frame)
        return frame
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*                              小工具                                 */
  /* ------------------------------------------------------------------ */

  /** 读 File/Blob 为 Uint8Array（Chromium 91 起 Blob.arrayBuffer 可用） */
  function readFileBytes(file) {
    if (file && typeof file.arrayBuffer === 'function') {
      return file.arrayBuffer().then(function (buf) {
        return new Uint8Array(buf)
      })
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader()
      reader.onload = function () {
        resolve(new Uint8Array(reader.result))
      }
      reader.onerror = function () {
        reject(reader.error || new Error('读取文件失败'))
      }
      reader.readAsArrayBuffer(file)
    })
  }

  /** 读 File 为 HTMLImageElement（走 objectURL，用完要 revoke） */
  function loadImage(fileOrUrl) {
    return new Promise(function (resolve, reject) {
      var url = typeof fileOrUrl === 'string' ? fileOrUrl : URL.createObjectURL(fileOrUrl)
      var img = new Image()
      img.onload = function () {
        resolve({ image: img, url: url, revoke: typeof fileOrUrl === 'string' ? null : url })
      }
      img.onerror = function () {
        reject(new Error('图片解码失败：' + (typeof fileOrUrl === 'string' ? fileOrUrl : fileOrUrl.name)))
      }
      img.src = url
    })
  }

  /** dataURL → HTMLImageElement */
  function loadDataUrl(dataUrl) {
    return loadImage(dataUrl)
  }

  /** 判断是不是"可以当文本看"的结果 */
  function isTextLike(name, bytes) {
    if (TEXT_EXT.indexOf(extOf(name)) < 0) return false
    var head = bytes.subarray(0, Math.min(bytes.length, 4096))
    var text = ''
    try {
      text = core().protocol.utf8Decode(head)
    } catch (err) {
      return false
    }
    return text.indexOf('\ufffd') < 0
  }

  ASQ.receiver = {
    TEXT_EXT: TEXT_EXT,
    extOf: extOf,
    createEngine: createEngine,
    createScanner: createScanner,
    cameraSupported: cameraSupported,
    readFileBytes: readFileBytes,
    loadImage: loadImage,
    loadDataUrl: loadDataUrl,
    isTextLike: isTextLike
  }

  /* ================================================================== */
  /*                     receiver.html 页面控制器                        */
  /* ================================================================== */

  function bootReceiverPage() {
    var OTP = core()
    var bridge = root.utoolsBridge || {}
    var engine = createEngine()
    var scanner = null
    var payload = {}
    var reportTimer = null

    function $(id) {
      return document.getElementById(id)
    }

    var els = {
      video: $('camera'),
      canvas: $('work'),
      mode: $('mode'),
      backend: $('backend'),
      progress: $('progress-text'),
      bar: $('progress-bar'),
      received: $('received'),
      needed: $('needed'),
      rate: $('rate'),
      elapsed: $('elapsed'),
      status: $('status'),
      fallback: $('fallback'),
      result: $('result'),
      resultName: $('result-name'),
      resultSize: $('result-size'),
      resultText: $('result-text'),
      actions: $('result-actions'),
      fileInput: $('image-input'),
      warn: $('warn')
    }

    function text(el, value) {
      if (el) el.textContent = value
    }

    function setStatus(message, kind) {
      text(els.status, message)
      if (els.status) els.status.className = 'status' + (kind ? ' status--' + kind : '')
    }

    function renderStats() {
      text(els.mode, engine.modeLabel())
      text(els.backend, engine.backendNote())
      var p = engine.progress()
      text(els.progress, Math.round(p * 100) + '%')
      if (els.bar) els.bar.style.width = Math.round(p * 100) + '%'
      text(els.received, String(engine.received()))
      text(els.needed, String(engine.needed()))
      text(els.rate, engine.rate().toFixed(1) + ' 帧/秒')
      text(els.elapsed, (engine.elapsedMs() / 1000).toFixed(0) + 's')
    }

    function finish(bytes) {
      var name = engine.name() || 'received.bin'
      setStatus('接收完成：' + name + '（' + OTP.protocol.formatBytes(bytes.length) + '）', 'ok')
      if (els.result) els.result.hidden = false
      text(els.resultName, name)
      text(els.resultSize, OTP.protocol.formatBytes(bytes.length) + ' / ' + bytes.length + ' 字节')

      if (els.actions) {
        els.actions.textContent = ''
        if (isTextLike(name, bytes)) {
          var asText = OTP.protocol.utf8Decode(bytes)
          if (els.resultText) {
            els.resultText.hidden = false
            els.resultText.value = asText
          }
          var copyBtn = document.createElement('button')
          copyBtn.className = 'btn'
          copyBtn.textContent = '复制文本'
          copyBtn.addEventListener('click', function () {
            if (root.utools && root.utools.copyText) root.utools.copyText(asText)
          })
          els.actions.appendChild(copyBtn)
        }
        var saveBtn = document.createElement('button')
        saveBtn.className = 'btn btn--primary'
        saveBtn.textContent = '保存到文件'
        saveBtn.addEventListener('click', function () {
          saveBytes(name, bytes)
        })
        els.actions.appendChild(saveBtn)
      }
      if (bridge.sendToParent) {
        bridge.sendToParent('otp:progress', { done: true, name: name, bytes: bytes.length })
      }
    }

    function saveBytes(name, bytes) {
      var target = null
      if (bridge.showSaveDialog) {
        target = bridge.showSaveDialog({
          title: '保存收到的文件',
          defaultPath: name,
          buttonLabel: '保存'
        })
      }
      if (!target) return
      try {
        if (bridge.writeFile) bridge.writeFile(target, bytes)
        setStatus('已保存到 ' + target, 'ok')
      } catch (err) {
        setStatus('保存失败：' + ((err && err.message) || err), 'err')
      }
    }

    function onFrame(frame) {
      var res = engine.ingest(frame)
      if (res.kind === 'descriptor' && res.newSession) {
        setStatus('已锁定传输：' + engine.name() + '（' + engine.modeLabel() + '）', 'ok')
      }
      if (res.kind === 'unsupported') {
        setStatus('这条流本端解不了：' + (res.reason || engine.unsupportedReason()), 'err')
      }
      renderStats()
      if (engine.isComplete()) {
        var bytes = engine.assemble()
        if (bytes) {
          if (scanner) scanner.stop()
          finish(bytes)
        }
      }
    }

    function startCamera() {
      scanner = createScanner({ canvas: els.canvas, onFrame: onFrame })
      if (!cameraSupported()) {
        showFallback('当前环境不支持摄像头（navigator.mediaDevices 不可用）')
        return
      }
      setStatus('正在请求摄像头权限…')
      scanner.startCamera(els.video).then(
        function () {
          if (els.fallback) els.fallback.hidden = true
          setStatus('正在扫描…把发送端的动态码对准摄像头', 'ok')
        },
        function (err) {
          showFallback('摄像头不可用：' + ((err && err.message) || err))
        }
      )
    }

    function showFallback(reason) {
      setStatus(reason + ' — 已切换到降级路径', 'err')
      if (els.fallback) els.fallback.hidden = false
      if (els.warn) els.warn.hidden = false
    }

    function scanImageFiles(files) {
      if (!files || !files.length) return
      var chain = Promise.resolve()
      var hits = 0
      for (var i = 0; i < files.length; i++) {
        chain = chain.then(
          (function (file) {
            return function () {
              return loadImage(file).then(function (res) {
                if (scanner) {
                  if (scanner.scanSource(res.image, res.image.naturalWidth, res.image.naturalHeight)) hits++
                }
                if (res.revoke) URL.revokeObjectURL(res.revoke)
              })
            }
          })(files[i])
        )
      }
      chain.then(
        function () {
          setStatus('已识别 ' + files.length + ' 张图片，其中 ' + hits + ' 张是有效帧', hits ? 'ok' : 'err')
          renderStats()
        },
        function (err) {
          setStatus('图片识别失败：' + ((err && err.message) || err), 'err')
        }
      )
    }

    function captureScreen() {
      if (!bridge.captureScreen) {
        setStatus('当前窗口拿不到截图能力', 'err')
        return
      }
      bridge.captureScreen().then(
        function (dataUrl) {
          if (!dataUrl) return
          return loadDataUrl(dataUrl).then(function (res) {
            if (scanner) scanner.scanSource(res.image, res.image.naturalWidth, res.image.naturalHeight)
            if (res.revoke) URL.revokeObjectURL(res.revoke)
            setStatus('截图已识别，可继续截图补齐缺失帧', 'ok')
            renderStats()
          })
        },
        function (err) {
          setStatus('截图失败：' + ((err && err.message) || err), 'err')
        }
      )
    }

    /* ---------------------------- 事件绑定 ---------------------------- */

    if (els.fileInput) {
      els.fileInput.addEventListener('change', function (event) {
        scanImageFiles(event.target.files)
      })
    }
    var pickBtn = $('pick-image')
    if (pickBtn && els.fileInput) {
      pickBtn.addEventListener('click', function () {
        els.fileInput.click()
      })
    }
    var captureBtn = $('capture-screen')
    if (captureBtn) captureBtn.addEventListener('click', captureScreen)
    var retryBtn = $('retry-camera')
    if (retryBtn) retryBtn.addEventListener('click', startCamera)
    var closeBtn = $('close-window')
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        if (bridge.close) bridge.close()
      })
    }

    if (root.addEventListener) {
      root.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && bridge.close) bridge.close()
      })
      root.addEventListener('paste', function (event) {
        var items = (event.clipboardData && event.clipboardData.items) || []
        var files = []
        for (var i = 0; i < items.length; i++) {
          if (items[i].type && items[i].type.indexOf('image') === 0) {
            var f = items[i].getAsFile()
            if (f) files.push(f)
          }
        }
        if (files.length) scanImageFiles(files)
      })
    }

    /* ------------------------------ 启动 ------------------------------ */

    // 描述符帧可能先于页面脚本到达，这里补取一次
    if (bridge.getStartPayload) payload = bridge.getStartPayload() || {}
    var auto = payload.mode !== 'image'
    scanner = createScanner({ canvas: els.canvas, onFrame: onFrame })
    renderStats()
    if (auto) startCamera()
    else showFallback('已选择图片识别模式')

    reportTimer = setInterval(function () {
      renderStats()
    }, 500)
    root.__ASQ_RECEIVER_STOP__ = function () {
      if (reportTimer) clearInterval(reportTimer)
      if (scanner) scanner.stop()
    }
  }

  if (root.__ASQ_RECEIVER_PAGE__ && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootReceiverPage)
    } else {
      bootReceiverPage()
    }
  }

  ASQ.receiver.bootPage = bootReceiverPage
})(typeof self !== 'undefined' ? self : this)
