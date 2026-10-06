/**
 * sender.js —— airscan-qr 发送端：分片计划 + 播放调度 + 码窗渲染循环
 *
 * 这个文件同时被两处使用：
 *   1. sender.html（uTools 全屏码窗）—— 控制器从 utoolsBridge 取 payload
 *   2. standalone.html              —— 控制器拿到的是页面表单里的文件/文本
 * 所以这里只依赖 OTP 全局，不依赖任何 uTools API；渲染循环被抽成
 * ASQ.createPlayer()，两边共用同一份代码，避免行为漂移。
 *
 * ── 关于"智能补发" ───────────────────────────────────────────────
 * 光学信道是单向的，发送端拿不到接收端的真实缺口。本文件提供两档：
 *   · repairRatio > 0 且 gapProvider 返回真实缺口 → 按缺口精确补发（有效）
 *   · repairRatio > 0 但没有反馈           → 按 staleness 加权补发（统计规律）
 * 加权补发会把轮长拉长 repairPerRound 帧；对"接收端在周期中段加入"这一
 * 最常见场景，纯轮播（repairRatio = 0）在数学上已是最优，所以默认是 0。
 * UI 会如实显示当前是哪一档，不假装有反向信道。
 */
;(function (root) {
  'use strict'

  var ASQ = (root.ASQ = root.ASQ || {})

  function core() {
    var o = root.OTP
    if (!o || !o.protocol || !o.qr || !o.codecs) {
      throw new Error('OTP 未加载：请先按 vendor → core（codecs 最后）的顺序引入脚本')
    }
    return o
  }

  /* ------------------------------------------------------------------ */
  /*                            默认参数（方案一）                        */
  /* ------------------------------------------------------------------ */

  var DEFAULTS = {
    mode: 0, // MODE_SEQUENTIAL
    symbolSize: 400,
    fps: 10,
    ecc: 'L',
    repeatDescriptor: 20,
    repairRatio: 0
  }

  /** 方案一的参数范围（UI 用，也是边界测试的依据） */
  var LIMITS = {
    symbolSize: { min: 200, max: 800, step: 100 },
    fps: { min: 1, max: 30, step: 1 },
    repeatDescriptor: { min: 4, max: 60, step: 1 },
    repairRatio: { min: 0, max: 0.5, step: 0.05 }
  }

  /* ------------------------------------------------------------------ */
  /*                                计划                                 */
  /* ------------------------------------------------------------------ */

  function maxSymbolsFor(mode) {
    // 顺序模式没有消元，可以一块到底；喷泉码单块符号数必须封顶
    return mode === core().protocol.MODE_SEQUENTIAL ? 1 << 20 : 1024
  }

  function normalize(options) {
    var opt = options || {}
    var protocol = core().protocol
    var mode = opt.mode == null ? DEFAULTS.mode : opt.mode
    var symbolSize = opt.symbolSize == null ? DEFAULTS.symbolSize : opt.symbolSize
    var repeatDescriptor =
      opt.repeatDescriptor == null ? DEFAULTS.repeatDescriptor : opt.repeatDescriptor
    return {
      name: opt.name || 'data.bin',
      mode: mode,
      symbolSize: Math.max(1, Math.round(symbolSize)),
      fps: opt.fps == null ? DEFAULTS.fps : opt.fps,
      ecc: opt.ecc || DEFAULTS.ecc,
      repeatDescriptor: Math.max(2, Math.round(repeatDescriptor)),
      repairRatio: opt.repairRatio == null ? DEFAULTS.repairRatio : opt.repairRatio,
      byteLength: opt.byteLength == null ? (opt.data ? opt.data.length : 0) : opt.byteLength,
      sessionId: opt.sessionId,
      modeLabel: core().codecs.infoFor(mode).label,
      isSequential: mode === protocol.MODE_SEQUENTIAL
    }
  }

  /**
   * 只算计划，不需要文件内容（主面板预览用）。
   * @returns {object} 计划摘要，见下方字段
   */
  function plan(options) {
    var opt = normalize(options)
    var protocol = core().protocol
    var qr = core().qr

    var planBlocks = protocol.planBlocks(opt.byteLength, opt.symbolSize, maxSymbolsFor(opt.mode))
    var totalSymbols = planBlocks.totalSymbols
    var blockCount = opt.isSequential ? 1 : planBlocks.blockCount
    var descriptor = {
      sessionId: opt.sessionId == null ? 0 : opt.sessionId,
      mode: opt.mode,
      symbolSize: opt.symbolSize,
      totalSymbols: totalSymbols,
      blockCount: blockCount,
      totalBytes: opt.byteLength,
      name: opt.name
    }
    var descriptorFrame = protocol.encodeDescriptor(descriptor)
    var frameLength = protocol.DATA_HEADER_BYTES + opt.symbolSize + 4
    var version = qr.versionFor(frameLength, opt.ecc)
    var moduleCount = qr.moduleCountForVersion(version)

    // 每 repeatDescriptor 个播放项里插 1 个描述符帧 → 一轮的播放项总数
    var d = opt.repeatDescriptor
    var itemsPerRound = totalSymbols + Math.ceil(totalSymbols / (d - 1))
    var descriptorsPerRound = Math.ceil(itemsPerRound / d)
    var repairPerRound = opt.repairRatio > 0 ? Math.max(1, Math.round(totalSymbols * opt.repairRatio)) : 0
    var otherRounds = opt.isSequential ? 0 : Infinity // 喷泉码没有"轮"

    return {
      name: opt.name,
      mode: opt.mode,
      modeKey: core().codecs.modeKey(opt.mode),
      modeLabel: opt.modeLabel,
      symbolSize: opt.symbolSize,
      ecc: opt.ecc,
      fps: opt.fps,
      repeatDescriptor: d,
      repairRatio: opt.repairRatio,
      totalBytes: opt.byteLength,
      totalSymbols: totalSymbols,
      blockCount: blockCount,
      symbolsPerBlock: planBlocks.symbolsPerBlock,
      frameLength: frameLength,
      descriptorFrameBytes: descriptorFrame.length,
      version: version,
      moduleCount: moduleCount,
      descriptorFrame: descriptorFrame,
      itemsPerRound: itemsPerRound,
      descriptorsPerRound: descriptorsPerRound,
      repairPerRound: repairPerRound,
      totalItemsPerRound: itemsPerRound + repairPerRound,
      roundSeconds: itemsPerRound / opt.fps,
      roundSecondsWithRepair: (itemsPerRound + repairPerRound) / opt.fps,
      loops: otherRounds === 0,
      backend: 'js'
    }
  }

  /* ------------------------------------------------------------------ */
  /*                              播放调度                               */
  /* ------------------------------------------------------------------ */

  /**
   * 用真实 sender 上报的结构校正计划。
   * 必须做：RaptorQ 的 WASM 内核会改写 symbolSize 与源块划分，
   * 只有以 sender.descriptor 为准，UI 上显示的帧长/版本/分片数才不会骗人。
   */
  function refineSummary(summary, sender, descriptorFrame, ecc) {
    var qrLib = core().qr
    var descriptor = sender.descriptor
    summary.symbolSize = descriptor.symbolSize
    summary.totalSymbols = descriptor.totalSymbols
    summary.blockCount = descriptor.blockCount
    summary.frameLength = sender.frameLength
    summary.version = qrLib.versionFor(sender.frameLength, ecc)
    summary.moduleCount = qrLib.moduleCountForVersion(summary.version)
    summary.descriptorFrame = descriptorFrame
    summary.descriptorFrameBytes = descriptorFrame.length
    summary.backend = sender.backend
    var d = summary.repeatDescriptor
    summary.itemsPerRound = descriptor.totalSymbols + Math.ceil(descriptor.totalSymbols / (d - 1))
    summary.descriptorsPerRound = Math.ceil(summary.itemsPerRound / d)
    summary.repairPerRound =
      summary.repairRatio > 0 ? Math.max(1, Math.round(descriptor.totalSymbols * summary.repairRatio)) : 0
    summary.totalItemsPerRound = summary.itemsPerRound + summary.repairPerRound
    summary.roundSeconds = summary.itemsPerRound / summary.fps
    summary.roundSecondsWithRepair = summary.totalItemsPerRound / summary.fps
    return summary
  }

  /**
   * @param {{data:Uint8Array, name:string, mode:number, symbolSize:number, fps:number,
   *          ecc:string, repeatDescriptor:number, repairRatio:number,
   *          gapProvider?:function():number[]|null, sessionId?:number}} options
   */
  function createEngine(options) {
    var opt = normalize(options)
    var OTP = core()
    var protocol = OTP.protocol
    var data = options.data || new Uint8Array(0)
    var sessionId =
      opt.sessionId == null && options.sessionId == null
        ? protocol.makeSessionId(data)
        : options.sessionId

    var sender = OTP.codecs.createSender(opt.mode, {
      data: data,
      name: opt.name,
      sessionId: sessionId,
      symbolSize: opt.symbolSize
    })

    var descriptorFrame = protocol.encodeDescriptor(sender.descriptor)
    var summary = refineSummary(
      plan({
        name: opt.name,
        mode: opt.mode,
        symbolSize: opt.symbolSize,
        fps: opt.fps,
        ecc: opt.ecc,
        repeatDescriptor: opt.repeatDescriptor,
        repairRatio: opt.repairRatio,
        byteLength: data.length,
        sessionId: sessionId
      }),
      sender,
      descriptorFrame,
      opt.ecc
    )

    var total = sender.totalFrames // 顺序模式 = 分片数；喷泉码 = Infinity
    var loops = Boolean(sender.loops)
    var itemCounter = 0 // 含描述符帧的播放项计数
    var dataCounter = 0 // 只数数据帧
    var cursor = 0 // 顺序模式：本轮位置
    var cycleCount = 0
    var repairQueue = []
    var repairSource = 'off'
    var repairsSent = 0
    var lastPlayedAt = loops ? new Float64Array(total) : null
    var gapProvider = typeof options.gapProvider === 'function' ? options.gapProvider : null

    function markPlayed(index) {
      if (lastPlayedAt && index < lastPlayedAt.length) lastPlayedAt[index] = dataCounter
    }

    /** 挑这一轮要额外补发的序号 */
    function pickRepair() {
      var count = Math.max(1, Math.round(total * opt.repairRatio))
      var gaps = gapProvider ? gapProvider() : null
      if (gaps && gaps.length) {
        // 有真实反馈：按缺口补，个数以缺口为准（这是唯一"精确有效"的情形）
        repairSource = 'gap'
        var uniq = []
        for (var g = 0; g < gaps.length; g++) {
          var idx = gaps[g]
          if (idx >= 0 && idx < total && uniq.indexOf(idx) < 0) uniq.push(idx)
        }
        return uniq.slice(0, Math.max(count, uniq.length))
      }
      if (!lastPlayedAt) return []
      // 无反馈：统计加权——最久没播的优先，并列时取小序号
      repairSource = 'heuristic'
      var order = []
      for (var i = 0; i < total; i++) order.push(i)
      order.sort(function (a, b) {
        return lastPlayedAt[a] - lastPlayedAt[b] || a - b
      })
      return order.slice(0, count)
    }

    function nextSequentialIndex() {
      if (repairQueue.length > 0) return { index: repairQueue.shift(), repair: true }
      if (cursor >= total) {
        cursor = 0
        cycleCount++
        if (opt.repairRatio > 0) {
          repairQueue = pickRepair()
          if (repairQueue.length > 0) return { index: repairQueue.shift(), repair: true }
        }
      }
      return { index: cursor++, repair: false }
    }

    return {
      plan: summary,
      sessionId: sessionId,
      sender: sender,
      /** 下一个播放项：{kind:'descriptor'|'data', bytes, key, index?, coord?, label} */
      next: function () {
        var item = itemCounter++
        if (item % opt.repeatDescriptor === 0) {
          return {
            kind: 'descriptor',
            bytes: descriptorFrame,
            key: 'descriptor',
            label: '描述符帧',
            itemIndex: item
          }
        }
        var index = null
        var coord
        if (loops) {
          var pick = nextSequentialIndex()
          index = pick.index
          if (pick.repair) repairsSent++
          coord = sender.frameCoord(index)
          markPlayed(index)
        } else {
          coord = sender.frameCoord(dataCounter)
        }
        dataCounter++
        return {
          kind: 'data',
          // 必须包成完整的数据帧（magic/type/sessionId/block/esi/CRC），
          // 直接把 symbol() 的原始符号发出去接收端是解不出来的
          bytes: protocol.encodeDataFrame(
            sessionId,
            coord.blockIndex,
            coord.esi,
            sender.symbol(coord.blockIndex, coord.esi)
          ),
          // 缓存键必须能区分每一帧：顺序模式用分片序号，喷泉码用 (块, esi)
          key: index == null ? 'b' + coord.blockIndex + 'e' + coord.esi : 'i' + index,
          index: index,
          coord: coord,
          label: index == null ? '符号 ' + coord.esi : '分片 ' + index,
          itemIndex: item
        }
      },
      stats: function () {
        return {
          itemCounter: itemCounter,
          dataCounter: dataCounter,
          cycleCount: cycleCount,
          repairSource: repairSource,
          repairsSent: repairsSent
        }
      },
      /** 供 UI 显示：当前补发档位（off / heuristic / gap） */
      repairMode: function () {
        if (opt.repairRatio <= 0) return 'off'
        return gapProvider ? 'gap-or-heuristic' : 'heuristic'
      },
      total: total,
      loops: loops,
      /** 已播放的比例（顺序模式按本轮位置算，喷泉码按已播数据帧/理论所需帧算） */
      progress: function () {
        if (loops) return total ? Math.min(1, dataCounter / (total + summary.repairPerRound)) : 1
        return total ? Math.min(1, dataCounter / total) : 1
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*                           QR 渲染（带缓存）                          */
  /* ------------------------------------------------------------------ */

  /**
   * 固定版本渲染：所有帧（含描述符）都用同一个 version，
   * 这样每帧像素尺寸完全一致，摄像头不会因为码大小跳变而反复重对焦。
   */
  function createRenderer(planInfo, cacheSize) {
    var OTP = core()
    var limit = cacheSize || 48
    var cache = new Map()

    function matrixFor(bytes, key) {
      var hit = cache.get(key)
      if (hit) return hit
      var qr = OTP.qr.encode(bytes, planInfo.ecc, planInfo.version)
      if (cache.size >= limit) {
        var oldest = cache.keys().next()
        if (!oldest.done) cache.delete(oldest.value)
      }
      cache.set(key, qr)
      return qr
    }

    return {
      /** 描述符帧与数据帧都走这里，保证 moduleCount 完全一致 */
      matrixFor: matrixFor,
      clear: function () {
        cache.clear()
      },
      get size() {
        return cache.size
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*                            码窗渲染循环                             */
  /* ------------------------------------------------------------------ */

  /**
   * @param {{canvas:HTMLCanvasElement, info:Object<string,HTMLElement>,
   *          onProgress?:function, onFinish?:function, now?:function}} config
   */
  function createPlayer(config) {
    var OTP = core()
    var canvas = config.canvas
    var info = config.info || {}
    var now = config.now || function () { return Date.now() }
    var timer = null
    var running = false
    var engine = null
    var renderer = null
    var shown = 0
    var startedAt = 0
    var lastProgressAt = 0
    var currentItem = null

    function set(key, text) {
      if (info[key]) info[key].textContent = text
    }

    function resize() {
      var dpr = 1
      var w = canvas.clientWidth || canvas.width || 720
      var h = canvas.clientHeight || canvas.height || 720
      var side = Math.max(160, Math.min(w, h))
      if (canvas.width !== side || canvas.height !== side) {
        canvas.width = side
        canvas.height = side
      }
      return side
    }

    function draw(item) {
      var side = resize()
      var ctx = canvas.getContext('2d', { alpha: false })
      var qr = renderer.matrixFor(item.bytes, item.key)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, side, side)
      OTP.qr.drawInto(ctx, qr, 0, 0, side, { quiet: 2, dark: '#000000', light: '#ffffff' })
      return qr
    }

    function step() {
      timer = null
      if (!running) return
      var item = engine.next()
      currentItem = item
      var qr = draw(item)
      shown++

      set('frame', item.label)
      set('shown', String(shown))
      set('modules', qr.moduleCount + '×' + qr.moduleCount)
      var p = engine.progress()
      set('progress', Math.round(p * 100) + '%')
      set('elapsed', ((now() - startedAt) / 1000).toFixed(0) + 's')

      var t = now()
      if (config.onProgress && t - lastProgressAt >= 500) {
        lastProgressAt = t
        config.onProgress({
          shown: shown,
          progress: p,
          label: item.label,
          elapsedMs: t - startedAt,
          repair: engine.stats().repairSource
        })
      }

      var interval = Math.max(1, Math.round(1000 / engine.plan.fps))
      timer = setTimeout(step, interval)
    }

    return {
      start: function (theEngine) {
        engine = theEngine
        renderer = createRenderer(engine.plan)
        running = true
        shown = 0
        startedAt = now()
        lastProgressAt = 0
        set('name', engine.plan.name)
        set('mode', engine.plan.modeLabel)
        set('size', OTP.protocol.formatBytes(engine.plan.totalBytes))
        set('symbols', String(engine.plan.totalSymbols))
        set('round', engine.plan.roundSeconds.toFixed(1) + 's')
        set('fps', String(engine.plan.fps))
        set('version', 'v' + engine.plan.version)
        step()
      },
      stop: function () {
        running = false
        if (timer) clearTimeout(timer)
        timer = null
        if (config.onFinish) config.onFinish({ shown: shown })
      },
      isRunning: function () {
        return running
      },
      currentItem: function () {
        return currentItem
      },
      stats: function () {
        return { shown: shown }
      }
    }
  }

  ASQ.sender = {
    DEFAULTS: DEFAULTS,
    LIMITS: LIMITS,
    plan: plan,
    createEngine: createEngine,
    createRenderer: createRenderer,
    createPlayer: createPlayer
  }
  ASQ.plan = plan
  ASQ.createEngine = createEngine
  ASQ.createRenderer = createRenderer
  ASQ.createPlayer = createPlayer
  ASQ.refineSummary = refineSummary

  /* ================================================================== */
  /*                      sender.html 页面控制器                         */
  /* ================================================================== */

  /** 把 payload.source 解析成字节。字符串一律走 utf8Encode（PLUGIN-SPEC §3.2） */
  function resolveSource(OTP, bridge, source) {
    if (!source) throw new Error('没有传输内容')
    if (source.kind === 'text') {
      return OTP.protocol.utf8Encode(String(source.text == null ? '' : source.text))
    }
    if (source.kind === 'file') {
      if (!bridge || !bridge.readFile) throw new Error('当前窗口没有读文件能力')
      return bridge.readFile(source.path).bytes
    }
    throw new Error('未知的传输内容类型：' + source.kind)
  }

  function repairLabel(mode) {
    if (mode === 'off') return '智能补发：关闭（纯轮播，轮长最短）'
    if (mode === 'gap') return '智能补发：按接收端真实缺口'
    if (mode === 'heuristic') return '智能补发：统计加权（无反向信道）'
    return '智能补发：待机'
  }

  function bootSenderPage() {
    var OTP = core()
    var bridge = root.utoolsBridge || {}
    var player = null
    var engine = null
    var lastReport = 0

    function $(id) {
      return document.getElementById(id)
    }

    function set(id, value) {
      var el = $(id)
      if (el) el.textContent = value
    }

    var baseInfo = {
      name: $('hud-name'),
      mode: $('hud-mode'),
      size: $('hud-size'),
      symbols: $('hud-symbols'),
      round: $('hud-round'),
      fps: $('hud-fps'),
      version: $('hud-version'),
      frame: $('hud-frame'),
      shown: $('hud-shown'),
      modules: $('hud-modules'),
      progress: $('hud-progress'),
      elapsed: $('hud-elapsed')
    }

    function report(progress) {
      set('hud-repair', repairLabel(progress.repair))
      if (!bridge.sendToParent) return
      var t = Date.now()
      if (t - lastReport < 500) return
      lastReport = t
      bridge.sendToParent('otp:progress', {
        shown: progress.shown,
        progress: progress.progress,
        label: progress.label,
        repair: progress.repair,
        name: engine ? engine.plan.name : '',
        mode: engine ? engine.plan.modeLabel : ''
      })
    }

    function start(payload) {
      var canvas = $('code')
      if (!canvas) return
      var bytes
      try {
        bytes = resolveSource(OTP, bridge, payload && payload.source)
      } catch (err) {
        set('hud-frame', '启动失败：' + ((err && err.message) || err))
        set('hud-hint', '按 Esc 关闭')
        return
      }
      var opt = (payload && payload.options) || {}
      engine = ASQ.createEngine({
        data: bytes,
        name: (payload && payload.name) || 'data.bin',
        mode: opt.mode == null ? DEFAULTS.mode : opt.mode,
        symbolSize: opt.symbolSize == null ? DEFAULTS.symbolSize : opt.symbolSize,
        fps: opt.fps == null ? DEFAULTS.fps : opt.fps,
        ecc: opt.ecc || DEFAULTS.ecc,
        repeatDescriptor:
          opt.repeatDescriptor == null ? DEFAULTS.repeatDescriptor : opt.repeatDescriptor,
        repairRatio: opt.repairRatio == null ? DEFAULTS.repairRatio : opt.repairRatio,
        gapProvider: typeof payload.gapProvider === 'function' ? payload.gapProvider : null
      })
      player = ASQ.createPlayer({
        canvas: canvas,
        info: baseInfo,
        onProgress: report,
        onFinish: function () {
          set('hud-frame', '已停止')
        }
      })
      player.start(engine)
      set('hud-repair', repairLabel(engine.repairMode()))
      set(
        'hud-hint',
        '按 Esc 或点击右上角关闭 · 一轮 ' +
          engine.plan.totalItemsPerRound +
          ' 帧 / ' +
          engine.plan.roundSecondsWithRepair.toFixed(1) +
          's'
      )
    }

    function close() {
      if (player) player.stop()
      if (bridge.close) bridge.close()
    }

    if (root.addEventListener) {
      root.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') close()
      })
      root.addEventListener('otp:start', function (event) {
        start(event.detail)
      })
    }
    var closeBtn = $('close-code')
    if (closeBtn) closeBtn.addEventListener('click', close)
    var toggleBtn = $('toggle-hud')
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        var hud = $('hud')
        if (hud) hud.classList.toggle('hud--hidden')
      })
    }

    // 页面可能晚于 'otp:start' 就绪，补取一次
    if (bridge.getStartPayload) {
      var cached = bridge.getStartPayload()
      if (cached) start(cached)
    }
  }

  if (root.__ASQ_SENDER_PAGE__ && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootSenderPage)
    } else {
      bootSenderPage()
    }
  }

  ASQ.sender.bootPage = bootSenderPage
})(typeof self !== 'undefined' ? self : this)
