/**
 * receiver.ts —— 接收窗（摄像头扫码 + 两种降级通道）
 *
 * 识别管线：
 *   摄像头帧 → 降采样到 ≤1280px → 整幅试一次 → 按分区多次调用 jsQR（见 multiscan.js）
 *   → 解帧 → 喂给 OTP.codecs.createReceiver(描述符自己选的解码器) → 收齐后组装
 *
 * 三种模式（顺序分片 / LT 喷泉码 / RaptorQ）都靠描述符帧自动选解码器，
 * UI 上会显示当前收到的是哪种模式。
 *
 * 诚实提示（UI 里也写了）：jsQR 一次只认一个码，多码是"分区多次识别"。
 * 摄像头不可用时可以退回「框选截图识别」/「导入图片识别」，截到的帧会进入同一个会话，
 * 所以反复截图同样能把文件凑齐。
 */
;(function (root) {
  'use strict'
  var RQ = (root.RQ = root.RQ || {})
  var doc = root.document
  var bridge = root.utoolsBridge || null

  var els = {}
  var video = null
  var stream = null
  var scanCanvas = null
  var scanner = null
  var session = null
  var scanTimer = null
  var running = false
  var slotsChoice = 0
  var idleScans = 0
  var receivedBytes = null
  var lastFrameSize = ''
  var lastStrategy = '—'
  var savedPath = ''

  var SCAN_INTERVAL_ACTIVE = 66 // ≈15 次/秒
  var SCAN_INTERVAL_IDLE = 160
  var MAX_SCAN_WIDTH = 1280

  /* ---------------------------------------------------------------------- */
  /*                                 工具                                    */
  /* ---------------------------------------------------------------------- */

  function setHint(text) {
    if (els.hint) els.hint.textContent = text
  }

  function setText(node, text) {
    if (node) node.textContent = text == null ? '—' : String(text)
  }

  function describeCameraError(err) {
    var name = (err && err.name) || ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'uTools 没有摄像头权限。请在系统设置 → 隐私与安全性 → 摄像头里给 uTools 打开权限后重开窗口；也可以直接用下面的截图/导入通道。'
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return '没有找到可用的摄像头。可以改用下面的截图/导入通道。'
    }
    if (name === 'NotReadableError') {
      return '摄像头被其它程序占用了。关掉占用摄像头的程序再试，或改用下面的截图/导入通道。'
    }
    return '摄像头启动失败：' + String((err && err.message) || err || '未知错误') + '。可以改用下面的截图/导入通道。'
  }

  function strategyLabel() {
    var preferred = scanner ? scanner.preferredLayout() : -1
    if (preferred < 0 || !lastFrameSize) return slotsChoice === 0 ? '自动（尚未锁定分区）' : slotsChoice + ' 码分区（尚未锁定）'
    var parts = lastFrameSize.split('x')
    var layouts = RQ.layout.candidateLayouts(Number(parts[0]), Number(parts[1]), slotsChoice)
    var used = layouts[preferred]
    if (!used) return '—'
    return used.multiQr + ' 码分区（' + used.cols + '×' + used.rows + '）'
  }

  /* ---------------------------------------------------------------------- */
  /*                              状态刷新                                   */
  /* ---------------------------------------------------------------------- */

  function updateStatus() {
    var backend = RQ.settings.backendInfo()
    var descriptor = session.descriptor()
    var decoderError = session.decoderError ? session.decoderError() : ''

    if (descriptor) {
      setText(els.mode, session.modeName() + (session.hasOti && session.hasOti() ? ' · OTI' : ''))
      els.mode.className = 'badge ' + (decoderError ? 'badge--bad' : 'badge--ok')
      setText(els.name, descriptor.name)
      setText(els.size, RQ.settings.formatBytes(descriptor.totalBytes))
      var received = session.received()
      var needed = session.needed()
      var percent = session.progress() * 100
      setText(els.count, decoderError ? '解不了这条流' : received + ' / ' + needed + ' 个符号（' + percent.toFixed(1) + '%）')
      setText(els.strategy, strategyLabel())
      setText(els.frame, lastFrameSize || '—')
      if (els.progress) els.progress.style.width = Math.max(0, Math.min(100, percent)) + '%'
      if (els.progressWrap) els.progressWrap.className = 'progress' + (session.isComplete() ? ' is-done' : '')
      if (savedPath) setText(els.hint, '已保存到 ' + savedPath)
    } else {
      els.mode.className = 'badge'
      setText(els.mode, '等待描述符')
      setText(els.strategy, strategyLabel())
      setText(els.frame, lastFrameSize || '—')
    }

    // 解码器**实际用的**是哪个后端，以及本端能力，两件事分开如实显示
    var inUse = session.decoderBackend ? session.decoderBackend() : ''
    var parts = []
    if (inUse === 'wasm') parts.push('RaptorQ（WASM 内核）')
    else if (inUse === 'unavailable') parts.push('缺 WASM 内核，收不了')
    else if (inUse === 'js') parts.push('LT 喷泉码 / 顺序分片（JS）')
    parts.push('本端 ' + backend.label)
    setText(els.backend, parts.join(' · '))

    if (decoderError) setHint(decoderError + '。把发送端的模式切成「LT 喷泉码」就能用纯 JS 收（代价是修复符号开销略高）。')
  }

  /* ---------------------------------------------------------------------- */
  /*                              摄入与完成                                 */
  /* ---------------------------------------------------------------------- */

  function ingest(frames) {
    if (!frames || !frames.length) return false
    for (var i = 0; i < frames.length; i++) session.ingest(frames[i])
    updateStatus()
    if (session.isComplete()) {
      onComplete()
      return true
    }
    return true
  }

  function onComplete() {
    running = false
    if (scanTimer) {
      clearTimeout(scanTimer)
      scanTimer = null
    }
    var bytes = session.assemble()
    if (!bytes) {
      setHint('所有符号都到齐了，但组装失败（可能是描述符与数据不匹配），请重新开始。')
      return
    }
    receivedBytes = bytes
    if (els.save) els.save.disabled = false
    setHint('已收齐 ' + RQ.settings.formatBytes(bytes.length) + '，点「保存文件」落盘。')
  }

  function save() {
    if (!receivedBytes) return
    var descriptor = session.descriptor()
    var name = (descriptor && descriptor.name) || 'received.bin'
    var target = null
    if (bridge && typeof bridge.showSaveDialog === 'function') {
      var dir = bridge && typeof bridge.getPath === 'function' ? bridge.getPath('downloads') : ''
      target = bridge.showSaveDialog({
        title: '保存接收到的文件',
        defaultPath: dir ? dir + '/' + name : name,
        buttonLabel: '保存'
      })
    }
    if (!target) {
      setHint('已取消保存。文件还在内存里，可以再点一次「保存文件」。')
      return
    }
    try {
      var written = bridge.writeFile(target, receivedBytes, name)
      savedPath = written
      setHint('已保存到 ' + written)
      if (bridge.sendToParent) bridge.sendToParent('otp:saved', { path: written, name: name, size: receivedBytes.length })
    } catch (err) {
      setHint('写入失败：' + String((err && err.message) || err))
    }
  }

  function resetAll() {
    savedPath = ''
    receivedBytes = null
    idleScans = 0
    if (els.save) els.save.disabled = true
    if (els.progress) els.progress.style.width = '0%'
    session.reset()
    if (scanner) scanner.reset()
    lastStrategy = '—'
    updateStatus()
    setHint(running ? '已重置，继续对准发送端。' : '已重置。')
  }

  /* ---------------------------------------------------------------------- */
  /*                              摄像头                                     */
  /* ---------------------------------------------------------------------- */

  function listCameras() {
    var md = root.navigator && root.navigator.mediaDevices
    if (!md || typeof md.enumerateDevices !== 'function' || !els.camera) return
    md.enumerateDevices()
      .then(function (list) {
        var cams = []
        for (var i = 0; i < list.length; i++) if (list[i].kind === 'videoinput') cams.push(list[i])
        if (!cams.length) return
        els.camera.textContent = ''
        var def = doc.createElement('option')
        def.value = ''
        def.textContent = '默认摄像头'
        els.camera.appendChild(def)
        cams.forEach(function (cam, index) {
          var opt = doc.createElement('option')
          opt.value = cam.deviceId || ''
          opt.textContent = cam.label || '摄像头 ' + (index + 1)
          els.camera.appendChild(opt)
        })
      })
      .catch(function () {
        /* 拿不到列表就用默认摄像头 */
      })
  }

  function startCamera(deviceId) {
    var md = root.navigator && root.navigator.mediaDevices
    if (!md || typeof md.getUserMedia !== 'function') {
      setHint('当前环境没有摄像头 API（navigator.mediaDevices 缺失）。请用下面的截图 / 导入通道。')
      return
    }
    stopCamera()
    var constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
    }
    md.getUserMedia(constraints)
      .then(function (mediaStream) {
        stream = mediaStream
        video.srcObject = mediaStream
        var played = video.play()
        if (played && typeof played.catch === 'function') played.catch(function () {})
        setHint('已启动摄像头，把发送端的二维码流对准画面（同屏多码时让所有码都进画面）。')
        listCameras()
        running = true
        idleScans = 0
        loop()
      })
      .catch(function (err) {
        setHint(describeCameraError(err))
      })
  }

  function stopCamera() {
    running = false
    if (scanTimer) {
      clearTimeout(scanTimer)
      scanTimer = null
    }
    if (stream) {
      try {
        var tracks = stream.getTracks ? stream.getTracks() : []
        for (var i = 0; i < tracks.length; i++) tracks[i].stop()
      } catch (err) {
        /* ignore */
      }
      stream = null
    }
  }

  /* ---------------------------------------------------------------------- */
  /*                              扫描循环                                   */
  /* ---------------------------------------------------------------------- */

  function loop() {
    if (!running) return
    var started = Date.now()
    var gotFrames = false
    try {
      gotFrames = scanCameraFrame()
    } catch (err) {
      setHint('识别出错：' + String((err && err.message) || err))
    }
    var spent = Date.now() - started
    if (gotFrames) idleScans = 0
    else idleScans += 1
    var target = idleScans > 20 ? SCAN_INTERVAL_IDLE : SCAN_INTERVAL_ACTIVE
    scanTimer = setTimeout(loop, Math.max(0, target - spent))
  }

  function scanCameraFrame() {
    if (!video || !video.videoWidth || !video.videoHeight) return false
    var imageData = root.OTP.scan.drawScaled(scanCanvas, video, video.videoWidth, video.videoHeight, MAX_SCAN_WIDTH)
    lastFrameSize = imageData.width + 'x' + imageData.height
    var result = scanner.scan(imageData)
    if (!result.frames.length) {
      updateStatus()
      return false
    }
    return ingest(result.frames)
  }

  /* ---------------------------------------------------------------------- */
  /*                          降级：截图 / 导入图片                           */
  /* ---------------------------------------------------------------------- */

  function imageToImageData(img) {
    var width = img.naturalWidth || img.width
    var height = img.naturalHeight || img.height
    var ratio = width > MAX_SCAN_WIDTH ? MAX_SCAN_WIDTH / width : 1
    var canvas = doc.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * ratio))
    canvas.height = Math.max(1, Math.round(height * ratio))
    var ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return ctx.getImageData(0, 0, canvas.width, canvas.height)
  }

  function imageFromDataUrl(dataUrl) {
    return new Promise(function (resolve, reject) {
      if (typeof root.Image !== 'function') {
        reject(new Error('当前环境没有 Image 构造器'))
        return
      }
      var img = new root.Image()
      img.onload = function () {
        try {
          resolve(imageToImageData(img))
        } catch (err) {
          reject(err)
        }
      }
      img.onerror = function () {
        reject(new Error('图片解码失败'))
      }
      img.src = dataUrl
    })
  }

  /** 一张静态图可能只有 1 个码，也可能有 4 个：这里把全部候选分区都试一遍 */
  function ingestFromImageData(imageData, source) {
    lastFrameSize = imageData.width + 'x' + imageData.height
    var result = RQ.multiscan.scanRegions(root.OTP.protocol, imageData, { multiQr: slotsChoice })
    if (!result.frames.length) {
      setHint(source + '里没有识别到本插件的二维码帧（别的二维码会被 CRC 丢掉）。')
      return
    }
    ingest(result.frames)
    if (!savedPath) {
      setHint(source + '摄入 ' + result.frames.length + ' 帧；反复截取可以让同一个会话慢慢凑齐。')
    }
  }

  function captureOnce() {
    if (!bridge || typeof bridge.screenCapture !== 'function') {
      setHint('当前环境不支持截图识别。')
      return
    }
    var ok = bridge.screenCapture(function (dataUrl) {
      if (!dataUrl) {
        setHint('截图已取消。')
        return
      }
      imageFromDataUrl(dataUrl)
        .then(function (imageData) {
          ingestFromImageData(imageData, '截图')
        })
        .catch(function (err) {
          setHint('处理截图失败：' + String((err && err.message) || err))
        })
    })
    if (!ok) setHint('截图通道不可用。')
  }

  function importImage() {
    if (!bridge || typeof bridge.showOpenDialog !== 'function') {
      setHint('当前环境不支持导入图片。')
      return
    }
    var picked = bridge.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]
    })
    if (!picked || !picked.length) return
    var dataUrl
    try {
      dataUrl = bridge.readImageAsDataUrl(picked[0])
    } catch (err) {
      setHint('读取图片失败：' + String((err && err.message) || err))
      return
    }
    imageFromDataUrl(dataUrl)
      .then(function (imageData) {
        ingestFromImageData(imageData, '导入的图片')
      })
      .catch(function (err) {
        setHint('处理图片失败：' + String((err && err.message) || err))
      })
  }

  /* ---------------------------------------------------------------------- */
  /*                                 启动                                    */
  /* ---------------------------------------------------------------------- */

  function rebuildScanner() {
    scanner = RQ.multiscan.createScanner(root.OTP.protocol, { multiQr: slotsChoice })
    updateStatus()
  }

  function boot() {
    video = doc.getElementById('rx-video')
    if (!video) return

    els.hint = doc.getElementById('rx-hint')
    els.mode = doc.getElementById('rx-mode')
    els.name = doc.getElementById('rx-name')
    els.size = doc.getElementById('rx-size')
    els.count = doc.getElementById('rx-count')
    els.backend = doc.getElementById('rx-backend')
    els.strategy = doc.getElementById('rx-strategy')
    els.frame = doc.getElementById('rx-frame')
    els.progress = doc.getElementById('rx-progress')
    els.progressWrap = doc.getElementById('rx-progress-wrap')
    els.save = doc.getElementById('rx-save')
    els.reset = doc.getElementById('rx-reset')
    els.slots = doc.getElementById('rx-slots')
    els.camera = doc.getElementById('rx-camera')
    els.capture = doc.getElementById('rx-capture')
    els.importBtn = doc.getElementById('rx-import')

    scanCanvas = doc.createElement('canvas')
    session = RQ.multiscan.createSession(root.OTP.protocol)
    rebuildScanner()

    if (els.save) els.save.addEventListener('click', save)
    if (els.reset) els.reset.addEventListener('click', resetAll)
    if (els.capture) els.capture.addEventListener('click', captureOnce)
    if (els.importBtn) els.importBtn.addEventListener('click', importImage)
    if (els.slots) {
      els.slots.addEventListener('change', function () {
        slotsChoice = Number(els.slots.value) || 0
        rebuildScanner()
      })
    }
    if (els.camera) {
      els.camera.addEventListener('change', function () {
        startCamera(els.camera.value || '')
      })
    }
    if (root.addEventListener) {
      root.addEventListener('beforeunload', stopCamera)
    }

    updateStatus()
    startCamera('')
  }

  RQ.receiver = {
    boot: boot,
    session: function () {
      return session
    },
    scanner: function () {
      return scanner
    },
    /** 测试/调试用：直接喂一张 ImageData（跳过摄像头） */
    ingestFromImageData: ingestFromImageData,
    save: save,
    reset: resetAll
  }

  boot()
})(typeof self !== 'undefined' ? self : globalThis)
