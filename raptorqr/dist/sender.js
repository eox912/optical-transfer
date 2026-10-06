/**
 * sender.ts —— 全屏码窗
 *
 * 一块画布上同时播 N 个（1 / 2 / 4）二维码，每个码位独立推进自己的 frameCoord：
 * 第 t 次刷新时，第 i 个码位播全局第 (t*N + i) 帧。
 *
 * 描述符帧会按固定间隔插播（并且首帧就是描述符），保证接收端随时对准都能锁定。
 * 所有帧（含描述符）都用**同一个固定 QR 版本**渲染，像素尺寸恒定，
 * 摄像头不会因为码大小跳变而反复重对焦。
 *
 * HUD 在画布上方单独一条，通过 CSS 变量 --hud 与布局对齐，绝不压在码上。
 */
;(function (root) {
  'use strict'
  var RQ = (root.RQ = root.RQ || {})
  var doc = root.document
  var bridge = root.utoolsBridge || null

  var els = {}
  var player = null
  var sender = null
  var opts = null
  var encodeOpts = null
  var hudTimer = null
  var watchdog = null
  var started = false
  var pending = null
  var scanHint = null
  var produceTickRef = null

  /* ---------------------------------------------------------------------- */

  function setWarn(text) {
    if (!els.warn) return
    if (text) {
      els.warn.textContent = text
      els.warn.hidden = false
    } else {
      els.warn.hidden = true
    }
  }

  function setStyleVar(name, value) {
    try {
      var style = doc.documentElement && doc.documentElement.style
      if (style && typeof style.setProperty === 'function') style.setProperty(name, value)
    } catch (err) {
      /* 没有 CSS 环境就算了，不影响码流 */
    }
  }

  function hudHeightPx() {
    return RQ.layout.hudFor(root.innerHeight)
  }

  function applyHudHeight() {
    var hudPx = hudHeightPx()
    setStyleVar('--hud', hudPx + 'px')
    return hudPx
  }

  /* ---------------------------------------------------------------------- */

  /** 可扫性：跟面板用同一套比例算法，所以两边给出的 px/模块 是一致的 */
  function computeScanHint() {
    var hudPx = hudHeightPx()
    var dipLayout = RQ.layout.compute(opts.multiQr, root.innerWidth, root.innerHeight - hudPx, { hudHeight: 0 })
    return RQ.settings.scanReport({
      symbolSize: opts.symbolSize,
      ecc: opts.ecc,
      multiQr: opts.multiQr,
      slotPx: dipLayout.boxSize
    })
  }

  /** 画布尺寸跟随窗口（设备像素），HUD 高度按比例算 */
  function layoutCanvas() {
    if (!player) return null
    var hudPx = applyHudHeight()
    return player.resize(root.innerWidth, root.innerHeight - hudPx, 0)
  }

  /* ---------------------------------------------------------------------- */

  /** 打开码窗时最多等多久 wasm 就绪（等不到就用 LT 回退，HUD 会如实显示） */
  var CORE_WAIT_MS = 1500

  /**
   * 码窗刚打开时，wasm 可能还在异步实例化。这时直接建 sender 会悄悄退回 LT，
   * 而面板上明明写着 WASM —— 两边不一致。所以先等内核自己的 load() promise
   * （它永不 reject），并留一个 setTimeout 兜底，避免万一 promise 不 settle 时码窗空白。
   */
  function start(payload) {
    if (started || pending) return
    if (!payload || !payload.bytes || !payload.bytes.length) {
      if (els.name) els.name.textContent = '没有收到数据'
      if (els.meta) els.meta.textContent = '请回主面板重新点「开始发送」'
      setWarn('码窗没有拿到文件字节。')
      return
    }
    pending = payload

    var core = root.OTP.raptorqCore
    var loader = root.OTP.raptorqLoader
    if (payload.mode === root.OTP.protocol.MODE_RAPTORQ && core && typeof core.load === 'function' && !core.isAvailable()) {
      if (loader && typeof loader.ensure === 'function') loader.ensure()
      var settled = false
      var proceed = function () {
        if (settled) return
        settled = true
        begin(pending)
      }
      try {
        core.load().then(proceed, proceed)
      } catch (err) {
        proceed()
      }
      setTimeout(proceed, CORE_WAIT_MS)
      return
    }
    begin(pending)
  }

  function begin(payload) {
    if (started) return
    started = true
    pending = null
    if (watchdog) {
      clearTimeout(watchdog)
      watchdog = null
    }

    var protocol = root.OTP.protocol
    opts = {
      mode: payload.mode == null ? protocol.MODE_RAPTORQ : payload.mode,
      symbolSize: RQ.settings.clampSymbolSize(payload.symbolSize),
      fps: RQ.settings.clampFps(payload.fps),
      ecc: RQ.settings.normalizeEcc(payload.ecc),
      multiQr: RQ.layout.normalizeMultiQr(payload.multiQr),
      redundancy: RQ.settings.clampRedundancy(payload.redundancy)
    }

    try {
      sender = root.OTP.codecs.createSender(opts.mode, {
        data: payload.bytes,
        name: payload.name || 'data.bin',
        sessionId: protocol.makeSessionId(payload.bytes),
        symbolSize: opts.symbolSize
      })
    } catch (err) {
      setWarn('创建发送端失败：' + String((err && err.message) || err))
      return
    }

    // 顺序模式一个循环的分片数有限，并行码数要收窄，否则同屏会重复
    opts.multiQr = RQ.settings.effectiveMultiQr(opts.mode, opts.multiQr, sender.totalFrames)

    var version
    var versionInfo
    try {
      // 固定版本必须同时装得下数据帧和描述符帧（RaptorQ 的描述符还多 12 字节 OTI）。
      // 切片很小时描述符反而更长，所以取两者的大值，保证所有帧像素尺寸一致。
      versionInfo = RQ.settings.fixedVersionFor(sender, opts.ecc)
      version = versionInfo.version
    } catch (err) {
      setWarn('切片太大，QR 装不下：' + String((err && err.message) || err))
      return
    }
    encodeOpts = { ecc: opts.ecc, version: version, multiQr: opts.multiQr }
    scanHint = computeScanHint()

    /* HUD 静态信息 */
    if (els.name) els.name.textContent = sender.descriptor.name
    if (els.meta) {
      els.meta.textContent =
        RQ.settings.modeName(opts.mode) +
        ' · 切片 ' + opts.symbolSize + 'B · ' + opts.multiQr + ' 码并行 · v' + version +
        ' (' + root.OTP.qr.moduleCountForVersion(version) + '×' + root.OTP.qr.moduleCountForVersion(version) + ')' +
        ' · 目标 ' + opts.fps + 'fps'
    }
    if (els.backend) {
      els.backend.textContent = sender.backend === 'wasm' ? 'WASM' : '已回退 LT（JS）'
      els.backend.className = 'badge ' + (sender.backend === 'wasm' ? 'badge--ok' : 'badge--warn')
    }
    if (sender.backend === 'wasm' && els.meta) {
      // 诚实提示：WASM RaptorQ 流对接收端有要求
      els.meta.textContent += ' · OTI 流（接收端需 WASM 内核）'
    }

    /* 描述符插播间隔：沿用共享核心给该模式的 repeatDescriptor */
    var info = root.OTP.codecs.infoFor(opts.mode)
    var descriptorEvery = Math.max(2, info.defaults.repeatDescriptor || 17)
    var dataTick = 0
    var produceTick = function (tickIndex) {
      // 开局连播 3 个 tick 描述符，之后按间隔插播
      if (tickIndex < 3 || tickIndex % descriptorEvery === 0) {
        return RQ.player.encodeDescriptorTick(sender, encodeOpts, tickIndex)
      }
      var tick = RQ.player.encodeTick(sender, encodeOpts, dataTick)
      dataTick += 1
      return tick
    }
    produceTickRef = produceTick

    player = RQ.player.createPlayer({
      canvas: els.canvas,
      sender: sender,
      ecc: opts.ecc,
      version: version,
      multiQr: opts.multiQr,
      fps: opts.fps,
      queueCapacity: Math.max(2, opts.multiQr),
      produceTick: produceTick
    })
    layoutCanvas()
    player.start()

    if (scanHint && !scanHint.ok) {
      setWarn(
        '码太密：每个模块只有 ' + scanHint.pxPerModule.toFixed(1) + ' 像素（建议 ≥ 2.5）。' +
        scanHint.advice + '——也可以在面板里减小切片或并行码数。'
      )
    } else if (versionInfo && versionInfo.descriptorVersion > versionInfo.dataVersion) {
      // 诚实提示：这里是被描述符帧（长文件名 / OTI）顶上去的版本
      setWarn(
        '描述符帧比数据帧长，固定版本取到了 v' + version + '（数据帧本来只需 v' +
        versionInfo.dataVersion + '）；所有帧仍保持同一版本。'
      )
    }

    hudTimer = setInterval(updateHud, 500)
    updateHud()
  }

  /* ---------------------------------------------------------------------- */

  function updateHud() {
    if (!player) return
    var stats = player.stats()
    if (els.stats) {
      els.stats.textContent =
        '已播放 ' + stats.drawn + ' 帧 · 实测 ' + stats.measuredFps.toFixed(1) + '/' + stats.targetFps +
        ' fps · 队列 ' + stats.queued + '/' + stats.queueCapacity
    }

    var warnings = []
    if (scanHint && !scanHint.ok) {
      warnings.push('码太密：每模块 ' + scanHint.pxPerModule.toFixed(1) + 'px（建议 ≥ 2.5），' + scanHint.advice)
    }
    if (stats.behind) {
      warnings.push(
        '实测帧率低于目标：QR 编码跟不上（每次约 ' + stats.encodeMs.toFixed(1) + 'ms）。' +
        '降低并行码数或切片大小可以提上来。'
      )
    }
    if (stats.encodeErrors) warnings.push('编码失败 ' + stats.encodeErrors + ' 次：' + stats.error)
    setWarn(warnings.join('　|　'))

    if (bridge && typeof bridge.sendToParent === 'function') {
      bridge.sendToParent('otp:progress', {
        drawn: stats.drawn,
        produced: stats.produced,
        measuredFps: stats.measuredFps,
        targetFps: stats.targetFps,
        queued: stats.queued,
        behind: stats.behind,
        backend: sender ? sender.backend : ''
      })
    }
  }

  /* ---------------------------------------------------------------------- */

  function onKeyDown(event) {
    if (!event || event.key !== 'Escape') return
    if (hudTimer) clearInterval(hudTimer)
    if (player) player.stop()
    // WASM 内核占的是 wasm 堆内存，关窗时显式释放
    if (sender && typeof sender.free === 'function') {
      try {
        sender.free()
      } catch (err) {
        /* 释放失败不影响关闭 */
      }
    }
    if (bridge && typeof bridge.close === 'function') bridge.close()
    else if (root.close) root.close()
  }

  function boot() {
    els.canvas = doc.getElementById('code-canvas')
    if (!els.canvas) return
    els.name = doc.getElementById('hud-name')
    els.meta = doc.getElementById('hud-meta')
    els.stats = doc.getElementById('hud-stats')
    els.backend = doc.getElementById('hud-backend')
    els.warn = doc.getElementById('hud-warn')

    applyHudHeight()

    if (root.addEventListener) {
      root.addEventListener('otp:start', function (event) {
        start(event && event.detail ? event.detail : null)
      })
      root.addEventListener('resize', function () {
        layoutCanvas()
      })
    }
    if (doc.addEventListener) doc.addEventListener('keydown', onKeyDown)

    // 页面可能比事件晚就绪：先补取缓存，再挂一个看门狗
    var last = bridge && typeof bridge.getStartPayload === 'function' ? bridge.getStartPayload() : null
    if (last) start(last)
    else {
      watchdog = setTimeout(function () {
        if (!started && !pending) start(null)
      }, 3000)
    }
  }

  RQ.sender = {
    boot: boot,
    start: start,
    begin: begin,
    updateHud: updateHud,
    stats: function () {
      return player ? player.stats() : null
    },
    scanHint: function () {
      return scanHint
    },
    /** 供测试/调试观察当前布局 */
    layout: function () {
      return player ? player.layout() : null
    },
    /** 供测试/调试按 tick 序号取帧（与码窗实际播放的是同一个闭包） */
    produceTick: function (index) {
      return produceTickRef ? produceTickRef(index) : null
    }
  }

  boot()
})(typeof self !== 'undefined' ? self : globalThis)
