/**
 * app.js —— 安卓 App 主逻辑（发送 + 接收双角色）
 *
 * 直接复用三个 uTools 插件同一份共享核心（`core/codecs.js` 等），
 * 所以这里的模式、帧格式、喷泉码、RaptorQ 与桌面端完全互通：
 * **手机可以收电脑发的码，电脑也能收手机发的码。**
 */
;(function () {
  'use strict'

  var protocol = OTP.protocol
  var qr = OTP.qr
  var scan = OTP.scan
  var codecs = OTP.codecs
  var raptorq = OTP.raptorqCore

  var $ = function (id) {
    return document.getElementById(id)
  }

  var ECC = 'L'
  var el = {
    tabSend: $('tab-send'),
    tabRecv: $('tab-recv'),
    envBadge: $('env-badge'),
    viewSend: $('view-send'),
    viewRecv: $('view-recv'),
    pick: $('pick'),
    fileInfo: $('file-info'),
    mode: $('mode'),
    modeBlurb: $('mode-blurb'),
    slice: $('slice'),
    sliceVal: $('slice-val'),
    fps: $('fps'),
    fpsVal: $('fps-val'),
    planInfo: $('plan-info'),
    start: $('start'),
    codeview: $('codeview'),
    codeCanvas: $('code-canvas'),
    codeHud: $('code-hud'),
    stop: $('stop'),
    video: $('video'),
    scanCanvas: $('scan-canvas'),
    recvHud: $('recv-hud'),
    recvMode: $('recv-mode'),
    recvBar: $('recv-bar'),
    recvStats: $('recv-stats'),
    camStart: $('cam-start'),
    save: $('save'),
    importFrame: $('import-frame'),
    toast: $('toast')
  }

  /* ====================================================================== */
  /*                               通用工具                                 */
  /* ====================================================================== */

  var toastTimer = null
  function toast(message, kind) {
    el.toast.textContent = message
    el.toast.className = 'toast is-on' + (kind ? ' is-' + kind : '')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      el.toast.className = 'toast'
    }, 2600)
  }

  function safe(label, fn) {
    try {
      return fn()
    } catch (err) {
      console.error('[' + label + ']', err)
      toast(label + '：' + ((err && err.message) || err), 'err')
      return undefined
    }
  }

  function modeInfo(key) {
    for (var i = 0; i < codecs.MODE_INFO.length; i++) {
      if (codecs.MODE_INFO[i].key === key) return codecs.MODE_INFO[i]
    }
    return codecs.MODE_INFO[0]
  }

  function currentMode() {
    return modeInfo(el.mode.value)
  }

  function currentOptions() {
    var info = currentMode()
    var sizes = info.presets.symbolSize
    var fpsList = info.presets.fps
    return {
      symbolSize: sizes[Math.min(Number(el.slice.value), sizes.length - 1)],
      fps: fpsList[Math.min(Number(el.fps.value), fpsList.length - 1)],
      repeatDescriptor: info.defaults.repeatDescriptor || 17
    }
  }

  function formatBytes(n) {
    return protocol.formatBytes(n)
  }

  /* ====================================================================== */
  /*                              发送端状态                                */
  /* ====================================================================== */

  var sendState = {
    file: null,
    sender: null,
    timer: null,
    version: 1,
    index: 0,
    frames: 0,
    fpsActual: 0,
    encodeMsAvg: 0,
    startedAt: 0
  }

  function refreshModePresets() {
    var info = currentMode()
    el.slice.min = '0'
    el.slice.max = String(info.presets.symbolSize.length - 1)
    el.fps.min = '0'
    el.fps.max = String(info.presets.fps.length - 1)
    el.slice.value = String(Math.max(0, info.presets.symbolSize.indexOf(info.defaults.symbolSize)))
    el.fps.value = String(Math.max(0, info.presets.fps.indexOf(info.defaults.fps)))
    el.modeBlurb.textContent = info.blurb
    updatePresetLabels()
  }

  function updatePresetLabels() {
    var opt = currentOptions()
    el.sliceVal.textContent = opt.symbolSize + ' B'
    el.fpsVal.textContent = opt.fps + ' fps'
    refreshPlan()
  }

  /** 显示传输计划。RaptorQ 的真实分块由 WASM 内核决定，所以建一个探针 sender 读真实值再释放。 */
  function refreshPlan() {
    if (!sendState.file) {
      el.planInfo.textContent = '选文件后显示传输计划'
      return
    }
    var opt = currentOptions()
    var info = currentMode()
    var probe = safe('建立发送计划', function () {
      return codecs.createSender(info.mode, {
        data: sendState.file.bytes,
        name: sendState.file.name,
        sessionId: protocol.makeSessionId(sendState.file.bytes),
        symbolSize: opt.symbolSize
      })
    })
    if (!probe) return
    var frames = probe.totalFrames === Infinity ? '持续生成' : probe.totalFrames + ' 帧/轮'
    var backend = probe.backend === 'wasm' ? 'RaptorQ (WASM)' : 'JS'
    var seconds = probe.totalFrames === Infinity ? '—' : (probe.totalFrames / opt.fps).toFixed(1) + ' s/轮'
    el.planInfo.textContent =
      '符号 ' +
      probe.descriptor.totalSymbols +
      ' 个 × ' +
      probe.descriptor.symbolSize +
      ' B，' +
      probe.descriptor.blockCount +
      ' 块，' +
      frames +
      '，零丢包约 ' +
      seconds +
      '，后端 ' +
      backend
    if (probe.free) probe.free()
  }

  function pickFile() {
    Native.pickFile()
      .then(function (file) {
        if (!file) return
        sendState.file = file
        el.fileInfo.textContent = file.name + ' · ' + formatBytes(file.size)
        el.start.disabled = false
        refreshPlan()
      })
      .catch(function (err) {
        toast('选择文件失败：' + ((err && err.message) || err), 'err')
      })
  }

  function fitCanvas(canvas) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2)
    var w = Math.max(1, Math.floor(window.innerWidth * dpr))
    var h = Math.max(1, Math.floor(window.innerHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    canvas.style.width = window.innerWidth + 'px'
    canvas.style.height = window.innerHeight + 'px'
    return { w: w, h: h }
  }

  function startSending() {
    if (!sendState.file) return
    var opt = currentOptions()
    var info = currentMode()

    var sender = safe('创建发送端', function () {
      return codecs.createSender(info.mode, {
        data: sendState.file.bytes,
        name: sendState.file.name,
        sessionId: protocol.makeSessionId(sendState.file.bytes),
        symbolSize: opt.symbolSize
      })
    })
    if (!sender) return

    // ---- 固定 QR 版本：数据帧与描述符帧必须同尺寸，否则摄像头会反复重对焦 ----
    var descFrame = protocol.encodeDescriptor(sender.descriptor)
    var version = Math.max(qr.versionFor(sender.frameLength, ECC), qr.versionFor(descFrame.length, ECC))

    sendState.sender = sender
    sendState.version = version
    sendState.index = 0
    sendState.frames = 0
    sendState.startedAt = Date.now()
    sendState.encodeMsAvg = 0

    el.codeview.hidden = false
    Native.enterFullscreen()
    var awake = Native.keepAwake(true)
    if (awake.errors && awake.errors.length && Native.isNative()) {
      console.warn('[keepAwake]', awake.errors)
    }

    var ctx = el.codeCanvas.getContext('2d', { alpha: false })
    var target = 1000 / opt.fps

    function renderOne() {
      var size = fitCanvas(el.codeCanvas)
      var canvasRect = el.codeCanvas.getBoundingClientRect()
      var hudRect = el.codeHud.getBoundingClientRect()
      var stopRect = el.stop.getBoundingClientRect()
      var scale = size.h / canvasRect.height
      var inset = Math.ceil(Math.max(
        hudRect.bottom - canvasRect.top + 16,
        canvasRect.bottom - stopRect.top + 16,
        0
      ) * scale)
      var box = Math.max(0, Math.min(size.w, size.h - 2 * inset))

      var isDescriptor = sendState.index % opt.repeatDescriptor === 0
      var frame
      if (isDescriptor) {
        frame = protocol.encodeDescriptor(sendState.sender.descriptor)
      } else {
        var coord = sendState.sender.frameCoord(sendState.index)
        var sym = sendState.sender.symbol(coord.blockIndex, coord.esi)
        if (!sym) return
        frame = protocol.encodeDataFrame(
          sendState.sender.descriptor.sessionId,
          coord.blockIndex,
          coord.esi,
          sym
        )
      }

      var matrix = qr.encode(frame, ECC, version)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, size.w, size.h)
      if (box > 0) {
        qr.drawInto(ctx, matrix, Math.floor((size.w - box) / 2), Math.floor((size.h - box) / 2), box, { quiet: 2 })
      }
      return isDescriptor
    }

    function loop() {
      var t0 = performance.now()
      sendState.frames++

      // 实时帧率（如实显示，跟不上就明确告诉用户）
      var elapsed = (Date.now() - sendState.startedAt) / 1000
      sendState.fpsActual = elapsed > 0 ? sendState.frames / elapsed : 0

      var coord = sendState.sender.frameCoord(sendState.index)
      el.codeHud.textContent =
        info.label +
        ' · ' +
        (sendState.sender.backend === 'wasm' ? 'WASM' : 'JS') +
        ' · v' + version +
        ' · ' + opt.symbolSize + 'B' +
        ' · 目标 ' + opt.fps + 'fps 实测 ' + sendState.fpsActual.toFixed(1) +
        ' · 编码 ' + sendState.encodeMsAvg.toFixed(1) + 'ms' +
        ' · 帧 ' + sendState.frames +
        ' · 块 ' + coord.blockIndex + '/esi ' + coord.esi

      if (sendState.fpsActual < opt.fps * 0.75 && sendState.frames > opt.fps * 2) {
        el.codeHud.textContent += '  ⚠ 渲染跟不上，建议降帧率或减小切片'
      }

      renderOne()
      var dt = performance.now() - t0
      sendState.encodeMsAvg = sendState.encodeMsAvg * 0.85 + dt * 0.15
      sendState.index++

      // 漂移补偿：把编码耗时从间隔里扣掉
      sendState.timer = setTimeout(loop, Math.max(0, target - dt))
    }

    loop()
    toast('开始发送：屏幕已设为常亮最亮，请对准接收端摄像头', 'ok')
  }

  function stopSending() {
    if (sendState.timer) clearTimeout(sendState.timer)
    sendState.timer = null
    if (sendState.sender && sendState.sender.free) {
      safe('释放发送端', function () {
        sendState.sender.free()
      })
    }
    sendState.sender = null
    el.codeview.hidden = true
    Native.exitFullscreen()
    Native.keepAwake(false)
  }

  /* ====================================================================== */
  /*                              接收端状态                                */
  /* ====================================================================== */

  var recvState = {
    stream: null,
    receiver: null,
    sessionId: null,
    mode: null,
    /** 描述符帧里带的原始文件名——落盘时要保留它，别再丢成 received.bin */
    name: null,
    result: null,
    scanning: false,
    lastDescriptorAt: 0,
    framesScanned: 0,
    accepted: 0,
    startedAt: 0
  }

  function describeRecvMode(descriptor) {
    var key = codecs.modeKey(descriptor.mode)
    var info = modeInfo(key)
    return (
      info.label +
      ' · 会话 ' + descriptor.sessionId.toString(16) +
      ' · ' + descriptor.symbolSize + 'B/符号 · ' +
      descriptor.totalSymbols + ' 符号 · ' +
      formatBytes(descriptor.totalBytes)
    )
  }

  function handleFrame(frame) {
    if (!frame) return
    if (frame.type === protocol.TYPE_DESCRIPTOR) {
      recvState.lastDescriptorAt = Date.now()
      // 会话或模式变了就（重）建解码器；同一个描述符重播时自愈——
      // 这样"内核晚就绪"或"中途加入"都能自动恢复。
      if (recvState.sessionId !== frame.sessionId || !recvState.receiver) {
        recvState.sessionId = frame.sessionId
        recvState.mode = frame.mode
        recvState.name = frame.name || null
        recvState.result = null
        recvState.accepted = 0
        recvState.receiver = codecs.createReceiver(frame)
        el.save.disabled = true
        el.recvMode.textContent = describeRecvMode(frame)
        if (recvState.receiver.error) {
          el.recvHud.textContent = '无法解码：' + recvState.receiver.error
          toast(recvState.receiver.error, 'err')
        }
      }
      return
    }

    if (!recvState.receiver) return
    var receiver = recvState.receiver
    if (receiver.isComplete) return
    if (receiver.add(frame.blockIndex, frame.esi, frame.payload)) {
      recvState.accepted++
    }

    if (receiver.isComplete) {
      recvState.result = receiver.assemble()
      el.recvBar.style.width = '100%'
      el.save.disabled = !recvState.result
      el.recvHud.textContent = '✅ 接收完成，可以保存了'
      toast('接收完成：' + formatBytes(recvState.result ? recvState.result.length : 0), 'ok')
    }
  }

  function updateRecvStats() {
    var receiver = recvState.receiver
    if (!receiver) return
    var pct = Math.round(receiver.progress * 100)
    el.recvBar.style.width = Math.min(100, pct) + '%'
    var elapsed = (Date.now() - recvState.startedAt) / 1000
    var rate = elapsed > 0 ? recvState.framesScanned / elapsed : 0
    el.recvStats.textContent =
      pct + '% · 有效 ' + recvState.accepted + '/' + receiver.needed +
      ' · 扫帧 ' + recvState.framesScanned +
      ' · ' + rate.toFixed(1) + ' fps' +
      (receiver.backend ? ' · 后端 ' + receiver.backend : '')
  }

  function scanLoop() {
    if (!recvState.stream) return
    var video = el.video
    if (video.readyState >= 2 && !recvState.scanning) {
      recvState.scanning = true
      var maxWidth = 900 // 降采样：手机上 jsQR 在大图上太慢
      var vw = video.videoWidth || 1280
      var vh = video.videoHeight || 720
      var scale = vw > maxWidth ? maxWidth / vw : 1
      var w = Math.max(1, Math.round(vw * scale))
      var h = Math.max(1, Math.round(vh * scale))
      var canvas = el.scanCanvas
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      var ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
      ctx.drawImage(video, 0, 0, vw, vh, 0, 0, w, h)
      var image = ctx.getImageData(0, 0, w, h)
      recvState.framesScanned++
      var frame = scan.decodeFrameFromImage(protocol, image.data, w, h)
      recvState.scanning = false
      handleFrame(frame)
      if (recvState.receiver) {
        updateRecvStats()
        if (!el.recvHud.textContent.indexOf('✅') === 0) {
          el.recvHud.textContent =
            w + '×' + h + ' · ' + (frame ? '已定位二维码' : '正在寻找二维码…')
        }
      } else {
        el.recvHud.textContent = frame ? '收到帧，等待描述符…' : w + '×' + h + ' · 正在寻找二维码…'
      }
    }
    requestAnimationFrame(scanLoop)
  }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('这个环境没有摄像头 API，请用「导入帧图片」', 'err')
      return
    }
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      })
      .then(function (stream) {
        recvState.stream = stream
        recvState.startedAt = Date.now()
        el.video.srcObject = stream
        el.video.play().catch(function () {})
        el.camStart.textContent = '停止摄像头'
        el.recvHud.textContent = '摄像头已开启'
        requestAnimationFrame(scanLoop)
      })
      .catch(function (err) {
        var msg = (err && err.message) || String(err)
        toast('摄像头打不开：' + msg, 'err')
        el.recvHud.textContent = '摄像头不可用：' + msg + '\n可改用「导入帧图片」'
      })
  }

  function stopCamera() {
    if (recvState.stream) {
      recvState.stream.getTracks().forEach(function (t) {
        t.stop()
      })
    }
    recvState.stream = null
    el.video.srcObject = null
    el.camStart.textContent = '开启摄像头'
    el.recvHud.textContent = '已停止'
  }

  function saveReceived() {
    if (!recvState.result) return
    // 文件名来自描述符帧（协议里本来就带着原名），落盘时保留它
    var fileName = recvState.name || 'received.bin'
    Native.saveFile(fileName, recvState.result)
      .then(function (res) {
        if (res && res.cancelled) {
          toast('已取消保存')
          return
        }
        // 各平台的"保存"语义不同（安卓写 Documents / 桌面选路径 / 浏览器下载），
        // 所以文案用中立说法，具体位置以返回值为准。
        toast('已保存：' + ((res && res.uri) || fileName), 'ok')
      })
      .catch(function (err) {
        toast('保存失败：' + ((err && err.message) || err), 'err')
      })
  }

  /** 摄像头不可用时的降级：导入一张帧图片来解帧 */
  function importFrame() {
    Native.pickFile('image/*')
      .then(function (file) {
        if (!file) return
        var blob = new Blob([file.bytes])
        var url = URL.createObjectURL(blob)
        var img = new Image()
        img.onload = function () {
          var canvas = document.createElement('canvas')
          canvas.width = img.naturalWidth
          canvas.height = img.naturalHeight
          var ctx = canvas.getContext('2d')
          ctx.drawImage(img, 0, 0)
          var image = ctx.getImageData(0, 0, canvas.width, canvas.height)
          var frame = scan.decodeFrameFromImage(protocol, image.data, canvas.width, canvas.height)
          URL.revokeObjectURL(url)
          if (!frame) {
            toast('这张图里没解出有效帧（可能不是本协议的二维码）', 'err')
            return
          }
          handleFrame(frame)
          toast('已摄入一帧，继续导入下一帧即可推进进度', 'ok')
        }
        img.onerror = function () {
          URL.revokeObjectURL(url)
          toast('图片读取失败', 'err')
        }
        img.src = url
      })
      .catch(function (err) {
        toast('导入失败：' + ((err && err.message) || err), 'err')
      })
  }

  /* ====================================================================== */
  /*                                启动                                    */
  /* ====================================================================== */

  function switchTab(which) {
    var send = which === 'send'
    el.tabSend.className = 'tab' + (send ? ' is-on' : '')
    el.tabRecv.className = 'tab' + (send ? '' : ' is-on')
    el.viewSend.className = 'view' + (send ? ' is-on' : '')
    el.viewRecv.className = 'view' + (send ? '' : ' is-on')
    if (!send) {
      el.recvHud.textContent = recvState.stream ? '摄像头已开启' : '点下方「开启摄像头」'
    }
  }

  function boot() {
    // 模式下拉
    codecs.MODE_INFO.forEach(function (info) {
      var opt = document.createElement('option')
      opt.value = info.key
      opt.textContent = info.label
      el.mode.appendChild(opt)
    })
    // 默认用 RaptorQ（开销最低）；没有 WASM 时 codecs 会自动回退并如实上报
    el.mode.value = 'raptorq'
    refreshModePresets()

    el.tabSend.addEventListener('click', function () {
      switchTab('send')
    })
    el.tabRecv.addEventListener('click', function () {
      switchTab('recv')
    })
    el.mode.addEventListener('change', refreshModePresets)
    el.slice.addEventListener('input', updatePresetLabels)
    el.fps.addEventListener('input', updatePresetLabels)
    el.pick.addEventListener('click', pickFile)
    el.start.addEventListener('click', startSending)
    el.stop.addEventListener('click', stopSending)
    el.camStart.addEventListener('click', function () {
      if (recvState.stream) stopCamera()
      else startCamera()
    })
    el.save.addEventListener('click', saveReceived)
    el.importFrame.addEventListener('click', importFrame)

    // 离开页面时恢复屏幕设置
    window.addEventListener('pagehide', function () {
      stopSending()
      stopCamera()
    })

    // 环境徽标：如实显示有没有原生能力
    var env = Native.envInfo()
    var missing = Object.keys(env.plugins).filter(function (k) {
      return !env.plugins[k]
    })
    // 平台名由各平台的 native.js 提供（安卓/iOS/Windows/macOS/Linux）；
    // 纯浏览器下 native.js 是替身层，没有 platformLabel，需要兜底。
    var PLATFORM_LABEL = {
      win32: 'Windows',
      darwin: 'macOS',
      linux: 'Linux',
      android: '安卓',
      ios: 'iOS'
    }
    var platformLabel = env.platformLabel || PLATFORM_LABEL[env.platform] || (env.native ? '原生' : '浏览器')
    el.envBadge.textContent =
      platformLabel + (missing.length ? ' · 缺 ' + missing.join('/') : ' · 原生齐备')
    if (!env.secureContext) {
      el.envBadge.textContent += ' · 非安全上下文'
    }

    // WASM 内核：加载失败会静默降级，UI 上如实反映
    var p = raptorq && raptorq.load ? raptorq.load() : Promise.resolve(null)
    Promise.resolve(p).then(function () {
      if (!raptorq || !raptorq.isAvailable()) {
        var st = codecs.raptorqStatus()
        console.warn('[raptorqr] WASM 未就绪：' + (st.error || '未知'))
        el.envBadge.textContent += ' · WASM 未启用'
      } else {
        el.envBadge.textContent += ' · WASM ' + (raptorq.status().wasmBytes / 1024).toFixed(0) + 'KB'
      }
      refreshPlan()
    })
  }

  // 暴露给测试：导出内部函数，便于在 Node 里做桩测试
  window.__APP__ = {
    boot: boot,
    handleFrame: handleFrame,
    currentOptions: currentOptions,
    refreshModePresets: refreshModePresets,
    modeInfo: modeInfo,
    formatBytes: formatBytes,
    state: { send: sendState, recv: recvState }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
