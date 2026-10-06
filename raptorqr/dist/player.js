/**
 * player.ts —— 多码并行的编码与绘制
 *
 * 分工：
 *   tickCoords()  算出"第 tickIndex 次刷新时，N 个码位各自该播第几帧"
 *                 —— 每个码位独立推进自己的 frameCoord：全局第 (t*N + i) 帧
 *   encodeTick()  把这 N 帧各自编码成 QR 矩阵（这一步是纯 CPU 瓶颈）
 *   drawTick()    用 OTP.qr.drawInto() 把 N 个码画到同一张 canvas 的不同区域
 *   createPlayer() rAF 主循环 + 编码队列 + 实测帧率
 *
 * 为什么要队列：QR 编码（尤其 v27 的 125×125）比一次 canvas 绘制贵得多。
 * 4 码 60fps 意味着每秒要编 240 个 v27 矩阵，纯 JS 一定跑不到。
 * 所以把"编码"和"显示"解耦：后台按能力尽量编码，前台按目标帧率取用，
 * 取不到就跳过这一次刷新（underrun），并把**实测帧率**如实报给 UI，
 * 而不是假装达到了 60fps。
 */
;(function (root) {
  'use strict'
  var RQ = (root.RQ = root.RQ || {})

  /**
   * 第 tickIndex 次刷新时，N 个码位各自的符号坐标。
   * 用全局帧号 tick*N+i 而不是"每个码位自己的计数器"，
   * 这样同屏 N 个码一定互不相同，接收端也不会重复摄入同一符号。
   */
  function tickCoords(sender, multiQr, tickIndex) {
    var mq = RQ.layout.normalizeMultiQr(multiQr)
    var out = []
    for (var i = 0; i < mq; i++) {
      var index = tickIndex * mq + i
      var coord = sender.frameCoord(index)
      out.push({ index: index, blockIndex: coord.blockIndex, esi: coord.esi })
    }
    return out
  }

  /**
   * 编码一个 tick 的帧（顺序模式最后一轮分片可能不足 N 个不同符号，这里不特殊处理：
   * 重复的坐标对接收端无害，会被去重丢弃）
   */
  function encodeTick(sender, opts, tickIndex) {
    var protocol = root.OTP.protocol
    var qr = root.OTP.qr
    var coords = tickCoords(sender, opts.multiQr, tickIndex)
    var sessionId = sender.descriptor.sessionId
    var matrices = []
    for (var i = 0; i < coords.length; i++) {
      var coord = coords[i]
      var symbol = sender.symbol(coord.blockIndex, coord.esi)
      if (!symbol) continue
      var frame = protocol.encodeDataFrame(sessionId, coord.blockIndex, coord.esi, symbol)
      // 固定 version：所有帧（含描述符）像素尺寸一致，摄像头不会来回重对焦
      matrices.push(qr.encode(frame, opts.ecc, opts.version))
    }
    return { tickIndex: tickIndex, coords: coords, matrices: matrices }
  }

  /** 编码描述符帧（码窗开局先播它，接收端靠它自建解码器） */
  function encodeDescriptorMatrix(sender, opts) {
    var protocol = root.OTP.protocol
    var bytes = protocol.encodeDescriptor(sender.descriptor)
    return root.OTP.qr.encode(bytes, opts.ecc, opts.version)
  }

  /**
   * 一个"全是描述符"的 tick：N 个码位画同一张描述符矩阵。
   * 这样晚加入 / 刚对准的接收端几乎立刻就能锁定，代价只是偶尔少播 N 个数据符号。
   */
  function encodeDescriptorTick(sender, opts, tickIndex) {
    var matrix = encodeDescriptorMatrix(sender, opts)
    var mq = RQ.layout.normalizeMultiQr(opts.multiQr)
    var coords = []
    var matrices = []
    for (var i = 0; i < mq; i++) {
      coords.push({ index: -1, blockIndex: -1, esi: -1 })
      matrices.push(matrix)
    }
    return { tickIndex: tickIndex, descriptor: true, coords: coords, matrices: matrices }
  }

  /**
   * 把一个 tick 画到 canvas 上
   * @returns {Array<{index:number, rect:{x:number,y:number,size:number}, coords:RQTickCoord}>}
   */
  function drawTick(ctx, layout, tick, opts) {
    var qr = root.OTP.qr
    var options = opts || {}
    ctx.fillStyle = options.background || '#0b0b0f'
    ctx.fillRect(0, 0, layout.width, layout.height)

    var drawn = []
    var count = Math.min(tick.matrices.length, layout.boxes.length)
    for (var i = 0; i < count; i++) {
      var box = layout.boxes[i]
      var size = qr.drawInto(ctx, tick.matrices[i], box.x, box.y, box.size, {
        quiet: options.quiet == null ? 2 : options.quiet,
        dark: options.dark || '#000000',
        light: options.light || '#ffffff'
      })
      drawn.push({
        index: box.index,
        rect: RQ.layout.drawnRect(box, size),
        coords: tick.coords[i]
      })
    }
    return drawn
  }

  /**
   * 码窗播放器
   * @param {{canvas:any, sender:any, ecc:string, version:number, multiQr:number, fps:number,
   *          dpr?:number, queueCapacity?:number, schedule?:Function,
   *          requestFrame?:Function, cancelFrame?:Function, now?:Function}} options
   */
  function createPlayer(options) {
    var canvas = options.canvas
    var ctx = canvas.getContext('2d', { alpha: false })
    var sender = options.sender
    var multiQr = RQ.layout.normalizeMultiQr(options.multiQr)
    var fps = RQ.settings.clampFps(options.fps)
    var encodeOpts = { ecc: options.ecc, version: options.version, multiQr: multiQr }
    var queueCapacity = options.queueCapacity == null ? Math.max(2, multiQr) : Math.max(1, options.queueCapacity)
    var schedule =
      options.schedule ||
      function (fn) {
        return setTimeout(fn, 0)
      }
    var requestFrame =
      options.requestFrame ||
      function (fn) {
        return root.requestAnimationFrame(fn)
      }
    var cancelFrame =
      options.cancelFrame ||
      function (id) {
        return root.cancelAnimationFrame(id)
      }
    var now =
      options.now ||
      function () {
        return Date.now()
      }
    /**
     * 一个 tick 的帧从哪来。默认就是纯数据帧；
     * 码窗会传入自己的 produceTick，用来按固定间隔插描述符帧。
     */
    var produceTick =
      options.produceTick ||
      function (index) {
        return encodeTick(sender, encodeOpts, index)
      }

    var layout = null
    var queue = []
    var produced = 0
    var drawn = 0
    var underruns = 0
    var encodeMs = 0
    var encodeErrors = 0
    var lastError = ''
    var running = false
    var rafId = null
    var interval = 1000 / fps
    var lastDrawAt = -Infinity
    var lastDrawn = []
    var lastCoords = []
    var stamps = []

    function resize(cssWidth, cssHeight, hudCssHeight) {
      var dpr = options.dpr == null ? root.devicePixelRatio || 1 : options.dpr
      canvas.width = Math.max(1, Math.round(cssWidth * dpr))
      canvas.height = Math.max(1, Math.round(cssHeight * dpr))
      layout = RQ.layout.compute(multiQr, canvas.width, canvas.height, {
        hudHeight: hudCssHeight ? Math.round(hudCssHeight * dpr) : 0
      })
      return layout
    }

    function measuredFps() {
      if (stamps.length < 2) return 0
      var first = stamps[0]
      var last = stamps[stamps.length - 1]
      if (last <= first) return 0
      return ((stamps.length - 1) * 1000) / (last - first)
    }

    function recordStamp(stamp) {
      stamps.push(stamp)
      while (stamps.length > 2 && stamp - stamps[0] > 2000) stamps.shift()
    }

    function pump() {
      if (!running) return
      if (queue.length >= queueCapacity) return
      var started = now()
      try {
        queue.push(produceTick(produced))
        produced += 1
      } catch (err) {
        // 坑 #3：qrcode-generator 容量溢出时抛的是字符串，不能用 err.message
        encodeErrors += 1
        lastError = String((err && err.message) || err)
        return
      }
      encodeMs = encodeMs * 0.7 + (now() - started) * 0.3
      schedule(pump)
    }

    /** 单次刷新：不发 rAF，只做"该画就画"的决定（测试可直接驱动它） */
    function tick(stamp) {
      var at = typeof stamp === 'number' ? stamp : now()
      if (at - lastDrawAt < interval - 1) return false
      lastDrawAt = at
      var next = queue.shift()
      if (!next) {
        underruns += 1
        pump()
        return false
      }
      drawn += 1
      lastDrawn = drawTick(ctx, layout, next, options)
      lastCoords = next.coords
      recordStamp(at)
      pump()
      return true
    }

    function frame(stamp) {
      if (!running) return
      rafId = requestFrame(frame)
      tick(stamp)
    }

    /** 先把队列灌一点，避免开场第一帧是空的 */
    function warmup(count) {
      var limit = count == null ? queueCapacity : count
      for (var i = 0; i < limit; i++) {
        if (queue.length >= queueCapacity) break
        try {
          queue.push(produceTick(produced))
          produced += 1
        } catch (err) {
          encodeErrors += 1
          lastError = String((err && err.message) || err)
          break
        }
      }
    }

    return {
      resize: resize,
      layout: function () {
        return layout
      },
      warmup: warmup,
      start: function () {
        if (running) return
        running = true
        lastDrawAt = -Infinity
        stamps = []
        warmup()
        rafId = requestFrame(frame)
      },
      stop: function () {
        running = false
        if (rafId != null && cancelFrame) cancelFrame(rafId)
        rafId = null
      },
      isRunning: function () {
        return running
      },
      tick: tick,
      drawNow: function () {
        var next = queue.shift()
        if (!next) return false
        drawn += 1
        lastDrawn = drawTick(ctx, layout, next, options)
        lastCoords = next.coords
        return true
      },
      stats: function () {
        var measured = measuredFps()
        return {
          targetFps: fps,
          measuredFps: measured,
          drawn: drawn,
          produced: produced,
          queued: queue.length,
          queueCapacity: queueCapacity,
          underruns: underruns,
          encodeMs: encodeMs,
          encodeErrors: encodeErrors,
          error: lastError,
          /** 实测明显低于目标 → UI 要如实提示"渲染跟不上" */
          behind: measured > 0 && measured < fps * 0.9,
          multiQr: multiQr,
          backend: sender.backend,
          lastCoords: lastCoords,
          drawnRects: lastDrawn
        }
      }
    }
  }

  RQ.player = {
    tickCoords: tickCoords,
    encodeTick: encodeTick,
    encodeDescriptorMatrix: encodeDescriptorMatrix,
    encodeDescriptorTick: encodeDescriptorTick,
    drawTick: drawTick,
    createPlayer: createPlayer
  }
})(typeof self !== 'undefined' ? self : globalThis)
