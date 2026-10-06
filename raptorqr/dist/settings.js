/**
 * settings.ts —— 参数、预估、可扫性、后端能力上报（面板与码窗共用）
 *
 * 这里只做纯计算：给一个"文件字节数 + 参数"，算出
 *   - 分块规划 / 帧长 / QR 版本 / 模块数
 *   - 每个码位分到多少像素、是否"码太密扫不动"（走 OTP.codecs.scanHint）
 *   - 按冗余度和帧率估算传输耗时
 *   - 当前后端到底是 WASM 还是回退 LT（**如实上报，不假装**）
 *
 * 刻意不主动调用 OTP.codecs.createSender()：那会为整个文件建一份补零副本，
 * 面板只是要显示参数，没必要先把内存翻一倍。代价是分块上限要跟
 * core/codecs.js 的 maxSymbolsFor() 手工对齐——测试里有一条专门断言
 * "预测的 blockCount 与真实 createSender 一致"。
 *
 * 例外：RaptorQ 走 WASM 时，symbolSize 与源块划分由内核决定（RFC 6330 的
 * 参数表会把 K 扩展），**预测不出来**。所以面板在拿到文件后会建一个探针
 * sender，读到真实 plan 后立刻 free()，再交给 analyze({sender}) 使用。
 */
;(function (root) {
  'use strict'
  var RQ = (root.RQ = root.RQ || {})

  function OTP() {
    return root.OTP
  }

  /** 与 core/codecs.js 的 maxSymbolsFor() 对齐 */
  var BLOCK_SYMBOL_LIMITS = { sequential: 4096, fountain: 1024, raptorq: 1024 }
  /** 与 core/codecs.js 里顺序模式 planBlocks(..., 1 << 20) 对齐：顺序模式永远只有一块 */
  var SEQUENTIAL_PLAN_LIMIT = 1 << 20

  var ECC_LEVELS = ['L', 'M', 'Q', 'H']
  var REDUNDANCY_RANGE = [0, 50]
  var REDUNDANCY_DEFAULT = 5

  /** 单帧能塞的最大 payload：QR v40 / ECC L 的上限减去协议头与 CRC */
  function maxSymbolSize() {
    var protocol = OTP().protocol
    return protocol.MAX_FRAME_BYTES - protocol.DATA_HEADER_BYTES - 4
  }

  function clampSymbolSize(value) {
    var v = Math.round(Number(value))
    if (!isFinite(v) || v < 16) return 16
    return Math.min(v, maxSymbolSize())
  }

  function clampFps(value) {
    var v = Math.round(Number(value))
    if (!isFinite(v) || v < 1) return 1
    return Math.min(v, 120)
  }

  function clampRedundancy(value) {
    var v = Math.round(Number(value))
    if (!isFinite(v)) return REDUNDANCY_DEFAULT
    return Math.max(REDUNDANCY_RANGE[0], Math.min(REDUNDANCY_RANGE[1], v))
  }

  function normalizeEcc(value) {
    return ECC_LEVELS.indexOf(value) >= 0 ? value : 'L'
  }

  function modeList() {
    return OTP().codecs.MODE_INFO
  }

  /** 某种模式的默认参数（取自共享核心的 MODE_INFO.defaults） */
  function defaultsFor(mode) {
    var codecs = OTP().codecs
    var defaults = codecs.infoFor(mode).defaults
    return {
      mode: mode,
      symbolSize: clampSymbolSize(defaults.symbolSize),
      fps: clampFps(defaults.fps),
      ecc: normalizeEcc(defaults.ecc),
      multiQr: defaults.multiQr ? RQ.layout.normalizeMultiQr(defaults.multiQr) : 1,
      redundancy: REDUNDANCY_DEFAULT
    }
  }

  /** 该模式下 planBlocks 的单块符号数上限（必须与 createSender 内部一致） */
  function planLimitFor(mode) {
    var protocol = OTP().protocol
    if (mode === protocol.MODE_SEQUENTIAL) return SEQUENTIAL_PLAN_LIMIT
    var key = OTP().codecs.modeKey(mode)
    return BLOCK_SYMBOL_LIMITS[key] || 1024
  }

  /**
   * 实际能并行的码数。
   * 顺序模式一个循环只有 totalSymbols 个不同分片，硬开 4 码只会让同一帧重复出现，
   * 所以按分片数收窄——这一点要在 UI 上说明，不能装作 4 码都在推进。
   */
  function effectiveMultiQr(mode, multiQr, totalSymbols) {
    var protocol = OTP().protocol
    var requested = RQ.layout.normalizeMultiQr(multiQr)
    if (mode !== protocol.MODE_SEQUENTIAL) return requested
    return Math.max(1, Math.min(requested, Math.max(1, totalSymbols)))
  }

  function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '—'
    if (seconds < 1) return '不到 1 秒'
    if (seconds < 60) return '约 ' + (seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))) + ' 秒'
    var minutes = Math.floor(seconds / 60)
    var rest = Math.round(seconds - minutes * 60)
    if (rest === 60) {
      minutes += 1
      rest = 0
    }
    return '约 ' + minutes + ' 分 ' + rest + ' 秒'
  }

  /**
   * 传输耗时预估。冗余度只影响这个估算（发送端本来就是无限播的）。
   * @param {{totalSymbols:number}} plan
   * @param {{mode:number, fps:number, multiQr:number, redundancy:number}} opts
   */
  function estimate(plan, opts) {
    var protocol = OTP().protocol
    var loops = opts.mode === protocol.MODE_SEQUENTIAL
    var totalSymbols = Math.max(1, plan.totalSymbols)
    var symbolsNeeded = loops
      ? totalSymbols
      : Math.ceil(totalSymbols * (1 + clampRedundancy(opts.redundancy) / 100))
    var perSecond = Math.max(1, clampFps(opts.fps) * Math.max(1, RQ.layout.normalizeMultiQr(opts.multiQr)))
    var seconds = symbolsNeeded / perSecond
    return {
      symbolsNeeded: symbolsNeeded,
      symbolsPerSecond: perSecond,
      seconds: seconds,
      text: formatDuration(seconds),
      loops: loops
    }
  }

  /**
   * "这个切片塞进这么多像素，扫得动吗"
   * @param {{symbolSize:number, ecc:string, multiQr:number, slotPx:number}} input
   */
  function scanReport(input) {
    var codecs = OTP().codecs
    var qr = OTP().qr
    var slots = RQ.layout.normalizeMultiQr(input.multiQr)
    var slotPx = Math.max(0, Math.round(input.slotPx || 0))
    var hint = codecs.scanHint(input.symbolSize, input.ecc, qr, slotPx)
    return {
      slots: slots,
      perSlotPx: slotPx,
      frameLength: hint.frameLength,
      version: hint.version,
      modules: hint.modules,
      pxPerModule: hint.pxPerModule,
      ok: hint.ok,
      advice: hint.advice
    }
  }

  /**
   * 只依赖"字节数 + 参数"的完整分析（面板渲染用）
   *
   * `input.sender` 可选：给一个**真实**的 sender（面板选完文件后会建一个探针），
   * 就完全以它上报的 plan / symbolSize 为准。RaptorQ WASM 后端会自己决定
   * 对齐后的 symbolSize 和源块划分，光靠字节数预测不出来，必须用它。
   *
   * @param {{bytes:number, mode:number, symbolSize:number, ecc:string,
   *          multiQr:number, fps:number, redundancy:number, slotPx?:number,
   *          sender?:any}} input
   * @returns {RQAnalysis}
   */
  function analyze(input) {
    var protocol = OTP().protocol
    var codecs = OTP().codecs
    var qr = OTP().qr

    var probe = input.sender || null
    var symbolSize = clampSymbolSize(probe ? probe.descriptor.symbolSize : input.symbolSize)
    var ecc = normalizeEcc(input.ecc)
    var bytes = Math.max(0, Math.round(Number(input.bytes) || 0))
    var limit = planLimitFor(input.mode)

    // 有真实 sender 就用它的 plan；否则按与 core 对齐的常量预测
    var plan = probe ? probe.plan : protocol.planBlocks(bytes, symbolSize, limit)
    var frameLength = probe ? probe.frameLength : codecs.frameLengthFor(symbolSize)
    var fixed = fixedVersionFor(probe, ecc)
    var version = fixed.version
    var effMulti = effectiveMultiQr(input.mode, input.multiQr, plan.totalSymbols)

    return {
      bytes: bytes,
      symbolSize: symbolSize,
      modeKey: codecs.modeKey(input.mode),
      plan: plan,
      frameLength: frameLength,
      version: version,
      modules: qr.moduleCountForVersion(version),
      symbolLimit: limit,
      estimatedPlan: !probe,
      descriptorVersion: fixed.descriptorVersion,
      dataVersion: fixed.dataVersion,
      effectiveMultiQr: effMulti,
      clampedMultiQr: effMulti !== RQ.layout.normalizeMultiQr(input.multiQr),
      scan: scanReport({
        symbolSize: symbolSize,
        ecc: ecc,
        multiQr: effMulti,
        slotPx: input.slotPx == null ? 0 : input.slotPx
      }),
      estimate: estimate(plan, {
        mode: input.mode,
        fps: input.fps,
        multiQr: effMulti,
        redundancy: input.redundancy
      })
    }
  }

  /**
   * 固定 QR 版本。
   *
   * 规则是"所有帧共用一个版本"，而这个版本必须同时装得下：
   *   - 数据帧（长度 = frameLength）
   *   - 描述符帧（长度 = 19 + 文件名 + OTI(12) + 4，RaptorQ 会带 OTI）
   * 切片很小时描述符反而更长（文件名上限 255 字节），所以要取两者的大值。
   * 不这么做的话，描述符帧会溢出到更高版本 → 像素尺寸跳变 → 摄像头反复重对焦，
   * 甚至直接抛"容量不足"。
   *
   * @returns {{version:number, dataVersion:number, descriptorVersion:number}}
   */
  function fixedVersionFor(sender, ecc) {
    var protocol = OTP().protocol
    var qr = OTP().qr
    var level = normalizeEcc(ecc)

    var dataVersion = qr.versionFor(sender ? sender.frameLength : 1, level)
    var descriptorVersion = dataVersion
    if (sender) {
      var descriptorFrame = protocol.encodeDescriptor(sender.descriptor)
      descriptorVersion = qr.versionFor(descriptorFrame.length, level)
    }
    return {
      version: Math.max(dataVersion, descriptorVersion),
      dataVersion: dataVersion,
      descriptorVersion: descriptorVersion
    }
  }

  /**
   * 后端能力的**如实**上报。UI 直接显示 label，不允许自己编。
   * 优先问共享核心（它才是真正的判定方），再补上加载器记录的失败原因。
   */
  function backendInfo() {
    var codecs = OTP().codecs
    var loader = OTP().raptorqLoader

    var available = false
    var error = ''
    var abiVersion
    var wasmBytes

    try {
      if (typeof codecs.raptorqStatus === 'function') {
        var inner = codecs.raptorqStatus()
        available = Boolean(inner && inner.available)
        error = (inner && inner.error) || ''
        abiVersion = inner && inner.abiVersion
        wasmBytes = inner && inner.wasmBytes
      } else {
        available = Boolean(codecs.raptorqAvailable && codecs.raptorqAvailable())
      }
    } catch (err) {
      available = false
      error = String((err && err.message) || err)
    }

    var loaderStatus = loader && typeof loader.status === 'function' ? loader.status() : null
    if (!error && loaderStatus) error = loaderStatus.error || ''
    var state = loaderStatus ? loaderStatus.state : 'unknown'

    if (available) {
      var parts = []
      if (abiVersion != null) parts.push('ABI v' + abiVersion)
      if (wasmBytes) parts.push(Math.round(wasmBytes / 1024) + ' KB')
      return {
        available: true,
        state: state,
        label: 'WASM',
        detail: 'Rust→WASM RaptorQ 核心已启用' + (parts.length ? '（' + parts.join(' / ') + '）' : ''),
        tone: 'ok'
      }
    }
    return {
      available: false,
      state: state,
      label: '已回退 LT（JS）',
      detail: error || '未检测到 vendor/raptorq.core.js',
      tone: 'warn'
    }
  }

  /** 接收端显示"当前收到的是哪种模式" */
  function modeName(mode) {
    return OTP().protocol.modeName(mode)
  }

  function formatBytes(n) {
    return OTP().protocol.formatBytes(n)
  }

  RQ.settings = {
    ECC_LEVELS: ECC_LEVELS,
    REDUNDANCY_RANGE: REDUNDANCY_RANGE,
    REDUNDANCY_DEFAULT: REDUNDANCY_DEFAULT,
    BLOCK_SYMBOL_LIMITS: BLOCK_SYMBOL_LIMITS,
    SEQUENTIAL_PLAN_LIMIT: SEQUENTIAL_PLAN_LIMIT,
    maxSymbolSize: maxSymbolSize,
    clampSymbolSize: clampSymbolSize,
    clampFps: clampFps,
    clampRedundancy: clampRedundancy,
    normalizeEcc: normalizeEcc,
    modeList: modeList,
    defaultsFor: defaultsFor,
    planLimitFor: planLimitFor,
    effectiveMultiQr: effectiveMultiQr,
    formatDuration: formatDuration,
    estimate: estimate,
    scanReport: scanReport,
    analyze: analyze,
    fixedVersionFor: fixedVersionFor,
    backendInfo: backendInfo,
    modeName: modeName,
    formatBytes: formatBytes
  }
})(typeof self !== 'undefined' ? self : globalThis)
