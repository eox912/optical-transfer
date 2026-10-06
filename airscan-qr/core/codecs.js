/**
 * codecs.js —— 三种编码模式的统一适配层（三个插件共用同一份）
 *
 * 三个方案的区别主要在**发送端怎么产生帧**，接收端的解码器其实是同一套。
 * 所以这里把三种模式都实现掉，每个插件都打包这一份文件：
 *   - 每个插件的发送端默认用它自己的招牌模式；
 *   - 但所有插件的接收端都支持全部三种模式。
 * 这样你才能拿 raptorqr 发、用 airscan-qr 收，做真正的交叉对比。
 *
 * 统一接口（发送端）：
 *   createSender(mode, params) -> {
 *     descriptor,                 // 交给 protocol.encodeDescriptor()
 *     frameLength,                // 数据帧总长（用来固定 QR 版本）
 *     totalFrames,                // 一个循环的长度；喷泉码为 Infinity
 *     frameCoord(i) -> {blockIndex, esi},
 *     symbol(blockIndex, esi) -> Uint8Array,
 *     backend                     // 'js' | 'wasm'
 *   }
 *
 * 统一接口（接收端）：
 *   createReceiver(descriptor) -> {
 *     add(blockIndex, esi, payload) -> boolean,
 *     progress, received, needed, isComplete, assemble()
 *   }
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./protocol.js'), require('./fountain.js'), null)
  } else {
    root.OTP = Object.assign(root.OTP || {}, {
      codecs: factory(root.OTP.protocol, root.OTP.fountain, root)
    })
  }
})(typeof self !== 'undefined' ? self : globalThis, function (protocol, fountain, rootRef) {
  'use strict'

  /**
   * RaptorQ 内核可能是后加载的（wasm 要异步取），所以不能用工厂参数把它定死，
   * 每次使用时重新解析；Node 下用 setRaptorqCore() 显式注入。
   */
  var explicitRaptorqCore = null

  function raptor() {
    if (explicitRaptorqCore) return explicitRaptorqCore
    if (rootRef && rootRef.OTP && rootRef.OTP.raptorqCore) return rootRef.OTP.raptorqCore
    return null
  }

  function setRaptorqCore(core) {
    explicitRaptorqCore = core
  }

  /* ------------------------------------------------------------------ */
  /*                            模式元信息                                */
  /* ------------------------------------------------------------------ */

  /** 数据帧总长度：固定的话所有 QR 尺寸一致，摄像头对焦/曝光不会来回抖 */
  function frameLengthFor(symbolSize) {
    return protocol.DATA_HEADER_BYTES + symbolSize + 4
  }

  var MODE_INFO = [
    {
      key: 'sequential',
      mode: protocol.MODE_SEQUENTIAL,
      label: '顺序分片轮播',
      blurb: '按序号循环播放，不做喷泉编码；丢掉的帧等下一轮补上。实现最简单、CPU 最省。',
      defaults: { symbolSize: 400, fps: 10, ecc: 'L', repeatDescriptor: 20 },
      presets: { symbolSize: [200, 300, 400, 600, 800], fps: [1, 2, 5, 10, 15, 20, 30] }
    },
    {
      key: 'fountain',
      mode: protocol.MODE_FOUNTAIN,
      label: 'LT 喷泉码',
      blurb: '发送端持续产生永不重复的编码符号，接收端凑够任意 K×(1+ε) 个即可还原，丢帧乱序天然容错。',
      defaults: { symbolSize: 1400, fps: 30, ecc: 'L', repeatDescriptor: 17 },
      presets: { symbolSize: [512, 896, 1008, 1400, 1904, 2331], fps: [10, 15, 20, 30, 45, 60] }
    },
    {
      key: 'raptorq',
      mode: protocol.MODE_RAPTORQ,
      label: 'RaptorQ (RFC 6330)',
      blurb: 'WASM 加速的 RaptorQ 核心，修复符号开销最低；WASM 不可用时自动回退到 LT 喷泉码。',
      defaults: { symbolSize: 1400, fps: 60, ecc: 'L', repeatDescriptor: 17, multiQr: 4 },
      presets: { symbolSize: [1008, 1400, 1904, 2331], fps: [30, 45, 60, 90, 120], multiQr: [1, 2, 4] }
    }
  ]

  function infoFor(mode) {
    for (var i = 0; i < MODE_INFO.length; i++) {
      if (MODE_INFO[i].mode === mode) return MODE_INFO[i]
    }
    return MODE_INFO[0]
  }

  function modeKey(mode) {
    return infoFor(mode).key
  }

  function defaultOptions(mode, overrides) {
    var base = {}
    var d = infoFor(mode).defaults
    for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) base[k] = d[k]
    if (overrides) for (var j in overrides) if (Object.prototype.hasOwnProperty.call(overrides, j)) base[j] = overrides[j]
    return base
  }

  /* ------------------------------------------------------------------ */
  /*                        接收端：顺序分片槽位                           */
  /* ------------------------------------------------------------------ */

  function SequentialReceiver(descriptor) {
    var total = descriptor.totalSymbols
    var symbolSize = descriptor.symbolSize
    var slots = new Array(total)
    var filled = 0

    return {
      total: total,
      symbolSize: symbolSize,
      get received() {
        return filled
      },
      get needed() {
        return total
      },
      get progress() {
        return total ? filled / total : 1
      },
      get isComplete() {
        return filled >= total
      },
      add: function (blockIndex, esi, payload) {
        if (esi >= total || slots[esi]) return false
        if (payload.length !== symbolSize) return false
        slots[esi] = new Uint8Array(payload)
        filled++
        return true
      },
      /** 缺哪些序号（顺序模式下可以显示"已收到 37/120"） */
      missing: function (limit) {
        var out = []
        for (var i = 0; i < total && out.length < (limit || 64); i++) if (!slots[i]) out.push(i)
        return out
      },
      assemble: function () {
        if (filled < total) return null
        var out = new Uint8Array(descriptor.totalBytes)
        var offset = 0
        for (var i = 0; i < total; i++) {
          var take = Math.min(symbolSize, descriptor.totalBytes - offset)
          if (take <= 0) break
          out.set(slots[i].subarray(0, take), offset)
          offset += take
        }
        return out
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*                        接收端：喷泉码包装                             */
  /* ------------------------------------------------------------------ */

  function FountainReceiver(descriptor) {
    var decoder = fountain.FountainDecoder(descriptor)
    return {
      total: descriptor.totalSymbols,
      symbolSize: descriptor.symbolSize,
      get received() {
        return Math.round(decoder.progress * descriptor.totalSymbols)
      },
      get needed() {
        return descriptor.totalSymbols
      },
      get progress() {
        return decoder.progress
      },
      get isComplete() {
        return decoder.isComplete
      },
      add: function (blockIndex, esi, payload) {
        return decoder.add(blockIndex, esi, payload)
      },
      missing: function () {
        return []
      },
      assemble: function () {
        return decoder.assemble()
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*                     接收端：RaptorQ（WASM 内核）                     */
  /* ------------------------------------------------------------------ */

  function RaptorQReceiver(descriptor, dec) {
    return {
      total: descriptor.totalSymbols,
      symbolSize: descriptor.symbolSize,
      backend: 'wasm',
      get received() {
        return dec.received
      },
      get needed() {
        return descriptor.totalSymbols
      },
      get progress() {
        return descriptor.totalSymbols ? Math.min(1, dec.received / descriptor.totalSymbols) : 1
      },
      get isComplete() {
        return dec.isComplete
      },
      add: function (blockIndex, esi, payload) {
        if (payload.length !== descriptor.symbolSize) return false
        return dec.add(blockIndex, esi, payload)
      },
      missing: function () {
        return []
      },
      assemble: function () {
        var out = dec.result()
        if (!out) return null
        return out.length === descriptor.totalBytes ? out : out.subarray(0, descriptor.totalBytes)
      }
    }
  }

  /**
   * 发送端用了 WASM RaptorQ、但本端没有可用的 WASM 内核时的接收器。
   * 这时**不能**偷偷用 LT 解码器（编码方式不同，会得到垃圾），必须如实报错。
   */
  function UnsupportedReceiver(descriptor, reason) {
    return {
      total: descriptor.totalSymbols,
      symbolSize: descriptor.symbolSize,
      backend: 'unavailable',
      error: reason,
      get received() {
        return 0
      },
      get needed() {
        return descriptor.totalSymbols
      },
      get progress() {
        return 0
      },
      get isComplete() {
        return false
      },
      add: function () {
        return false
      },
      missing: function () {
        return []
      },
      assemble: function () {
        return null
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*                              发送端                                 */
  /* ------------------------------------------------------------------ */

  function maxSymbolsFor(mode) {
    // 喷泉码的稠密消元是 O(K²)，单块符号数必须封顶；顺序模式没有消元，可以放宽
    return mode === protocol.MODE_SEQUENTIAL ? 4096 : 1024
  }

  /**
   * @param {number} mode protocol.MODE_*
   * @param {{data:Uint8Array, name:string, sessionId:number, symbolSize:number,
   *          maxBlockSymbols?:number}} params
   */
  function createSender(mode, params) {
    var data = params.data
    var symbolSize = params.symbolSize
    var sessionId = params.sessionId
    var name = params.name || 'data.bin'
    var maxSymbols = params.maxBlockSymbols || maxSymbolsFor(mode)
    var plan = protocol.planBlocks(data.length, symbolSize, maxSymbols)
    var backend = 'js'

    if (mode === protocol.MODE_SEQUENTIAL) {
      // 顺序模式：一块到底，esi 就是全局分片序号，播完一轮从头再来
      plan = protocol.planBlocks(data.length, symbolSize, 1 << 20)
      return {
        mode: mode,
        backend: backend,
        plan: plan,
        frameLength: frameLengthFor(symbolSize),
        totalFrames: plan.totalSymbols,
        loops: true,
        descriptor: {
          sessionId: sessionId,
          mode: mode,
          symbolSize: symbolSize,
          totalSymbols: plan.totalSymbols,
          blockCount: 1,
          totalBytes: data.length,
          name: name
        },
        frameCoord: function (index) {
          return { blockIndex: 0, esi: index % plan.totalSymbols }
        },
        symbol: function (blockIndex, esi) {
          return protocol.readSymbol(data, esi, symbolSize)
        }
      }
    }

    // ---- RaptorQ：交给 WASM 内核决定 symbol_size 与源块划分 ----
    // 不能沿用上面 planBlocks 的结果：RFC 6330 的参数表会把 K 扩展，
    // 真实结构必须以内核上报的为准，否则帧坐标会对不上。
    var rc = raptor()
    if (mode === protocol.MODE_RAPTORQ && rc && rc.isAvailable && rc.isAvailable()) {
      var rq = rc.createEncoder(data, symbolSize)
      if (rq) {
        var rqBlocks = rq.sourceBlocks
        var rqTotal = rq.totalSourceSymbols
        return {
          mode: mode,
          backend: 'wasm',
          plan: {
            totalBytes: data.length,
            symbolSize: rq.symbolSize,
            totalSymbols: rqTotal,
            blockCount: rqBlocks,
            symbolsPerBlock: rq.blockSourceSymbols.length
              ? Math.max.apply(null, rq.blockSourceSymbols)
              : rqTotal
          },
          frameLength: frameLengthFor(rq.symbolSize),
          totalFrames: Infinity,
          loops: false,
          descriptor: {
            sessionId: sessionId,
            mode: mode,
            symbolSize: rq.symbolSize,
            totalSymbols: rqTotal,
            blockCount: rqBlocks,
            totalBytes: data.length,
            name: name,
            extra: rq.oti // 12 字节 OTI
          },
          frameCoord: function (index) {
            return { blockIndex: index % rqBlocks, esi: Math.floor(index / rqBlocks) }
          },
          symbol: function (blockIndex, esi) {
            return rq.symbol(blockIndex, esi)
          },
          free: function () {
            rq.free()
          }
        }
      }
      // 内核建不出来就落到下面的 LT 回退，backend 保持 'js'（如实上报，不假装）
    }

    // ---- 喷泉码（也承担 RaptorQ 的 JS 回退）：esi 只增不减 ----
    var encoder = fountain.FountainEncoder(data, plan, sessionId)

    return {
      mode: mode,
      backend: backend,
      plan: plan,
      frameLength: frameLengthFor(symbolSize),
      totalFrames: Infinity,
      loops: false,
      descriptor: {
        sessionId: sessionId,
        mode: mode,
        symbolSize: symbolSize,
        totalSymbols: plan.totalSymbols,
        blockCount: plan.blockCount,
        totalBytes: data.length,
        name: name
      },
      frameCoord: function (index) {
        return {
          blockIndex: index % plan.blockCount,
          esi: Math.floor(index / plan.blockCount)
        }
      },
      symbol: function (blockIndex, esi) {
        return encoder.symbol(blockIndex, esi)
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*                              接收端工厂                              */
  /* ------------------------------------------------------------------ */

  function createReceiver(descriptor) {
    if (descriptor.mode === protocol.MODE_SEQUENTIAL) return SequentialReceiver(descriptor)

    var rc = raptor()
    var hasOti = Boolean(descriptor.extra && descriptor.extra.length === 12)

    if (descriptor.mode === protocol.MODE_RAPTORQ) {
      if (hasOti) {
        // 描述符里带 OTI = 发送端真的用了 WASM RaptorQ。这时**不能**回退到 LT：
        // 两种编码方式不同，硬用 LT 解只会得到垃圾数据，必须如实报错。
        if (!rc || !rc.isAvailable || !rc.isAvailable()) {
          return UnsupportedReceiver(descriptor, '这条流由 RaptorQ WASM 后端发出，本端没有可用的 WASM 内核')
        }
        var dec = rc.createDecoder(descriptor.extra)
        if (!dec) return UnsupportedReceiver(descriptor, 'RaptorQ 解码器创建失败')
        return RaptorQReceiver(descriptor, dec)
      }
      // 没有 OTI = 发送端当时回退到了 LT 喷泉码，用同一套 LT 解码器即可
      return FountainReceiver(descriptor)
    }
    return FountainReceiver(descriptor)
  }

  /** 当前 RaptorQ WASM 是否真的可用（UI 上要如实显示，不能假装） */
  function raptorqAvailable() {
    var rc = raptor()
    return Boolean(rc && rc.isAvailable && rc.isAvailable())
  }

  /** RaptorQ 内核的状态详情，供 UI 如实展示 */
  function raptorqStatus() {
    var rc = raptor()
    if (!rc) return { available: false, error: '未加载 raptorq.core.js' }
    return rc.status ? rc.status() : { available: raptorqAvailable(), error: '' }
  }

  /** 把帧长换算成"能不能扫得动"的提示（模块数 × 每模块像素） */
  function scanHint(symbolSize, ecc, qrLib, viewportPx) {
    var frameLen = frameLengthFor(symbolSize)
    var version = qrLib.versionFor(frameLen, ecc)
    var modules = qrLib.moduleCountForVersion(version) + 8 // 含静默区
    var pxPerModule = viewportPx / modules
    return {
      frameLength: frameLen,
      version: version,
      modules: modules,
      pxPerModule: pxPerModule,
      ok: pxPerModule >= 2.5,
      advice: pxPerModule >= 2.5 ? '可扫' : '码太密，建议减小切片或放大窗口'
    }
  }

  return {
    MODE_INFO: MODE_INFO,
    infoFor: infoFor,
    modeKey: modeKey,
    defaultOptions: defaultOptions,
    frameLengthFor: frameLengthFor,
    createSender: createSender,
    createReceiver: createReceiver,
    setRaptorqCore: setRaptorqCore,
    raptorqAvailable: raptorqAvailable,
    raptorqStatus: raptorqStatus,
    SequentialReceiver: SequentialReceiver,
    FountainReceiver: FountainReceiver,
    RaptorQReceiver: RaptorQReceiver,
    UnsupportedReceiver: UnsupportedReceiver,
    scanHint: scanHint
  }
})
