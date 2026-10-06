/**
 * index.ts —— 主面板（控制台）
 *
 * 职责：选文件 / 调参数 / 显示真实的后端能力与可扫性警告 / 算出描述符与预计耗时 /
 * 拉起全屏码窗和接收窗。
 *
 * 这里刻意**不**创建 sender：createSender 会为整个文件建一份补零副本，
 * 面板只需要参数和描述符，没必要先把内存翻倍。真正建 sender 的是码窗。
 */
;(function (root) {
  'use strict'
  var RQ = (root.RQ = root.RQ || {})
  var doc = root.document
  var bridge = root.utoolsBridge || null

  var panel = null
  var backendBadge = null
  var toastEl = null
  var subtitle = null
  var progressLine = null
  var booted = false
  var toastTimer = null

  var state = {
    action: null,
    files: [],
    entry: null,
    descriptor: null,
    probe: null,
    options: null,
    analysis: null,
    slotPx: 0,
    displayId: null,
    displays: [],
    error: '',
    notice: '',
    progress: null
  }

  function OTP() {
    return root.OTP
  }

  /* ====================================================================== */
  /*                               小工具                                    */
  /* ====================================================================== */

  function el(tag, className, text) {
    var node = doc.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = String(text)
    return node
  }

  function button(label, onClick, variant) {
    var btn = el('button', 'btn' + (variant ? ' btn--' + variant : ''), label)
    btn.type = 'button'
    btn.addEventListener('click', onClick)
    return btn
  }

  function tryRun(label, fn, fallback) {
    try {
      return fn()
    } catch (err) {
      setError(label + '失败：' + String((err && err.message) || err))
      return fallback
    }
  }

  function toast(message, kind) {
    if (!toastEl) return
    toastEl.textContent = message
    toastEl.className = 'toast is-visible' + (kind ? ' toast--' + kind : '')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      toastEl.className = 'toast'
    }, 2400)
  }

  function setError(message) {
    state.error = message || ''
    render()
  }

  function basename(filePath) {
    return String(filePath).split(/[\\/]/).pop() || String(filePath)
  }

  /* ====================================================================== */
  /*                              描述符计算                                 */
  /* ====================================================================== */

  /**
   * 面板展示/传给码窗的描述符。字段与 codecs.createSender().descriptor 完全同构，
   * 只是不建 encoder：totalSymbols/blockCount 来自与 core 对齐的分块规划。
   */
  function buildDescriptor(entry, analysis) {
    return {
      sessionId: OTP().protocol.makeSessionId(entry.bytes),
      mode: state.options.mode,
      symbolSize: analysis.symbolSize,
      totalSymbols: analysis.plan.totalSymbols,
      blockCount: analysis.plan.blockCount,
      totalBytes: entry.bytes.length,
      name: entry.name
    }
  }

  /* ====================================================================== */
  /*                              状态与刷新                                 */
  /* ====================================================================== */

  function currentDisplay() {
    var list = state.displays || []
    var i
    for (i = 0; i < list.length; i++) if (list[i].id === state.displayId) return list[i]
    for (i = 0; i < list.length; i++) if (list[i].primary) return list[i]
    return list.length ? list[0] : null
  }

  /** 每个码位在目标显示器上能分到多少像素 —— 可扫性判断的输入 */
  function updateSlotPx() {
    var d = currentDisplay()
    if (!d || !d.bounds) {
      state.slotPx = 0
      return
    }
    var layout = RQ.layout.compute(state.options.multiQr, d.bounds.width, d.bounds.height, {
      hudHeight: RQ.layout.hudFor(d.bounds.height)
    })
    state.slotPx = layout.boxSize
  }

  function refresh() {
    updateSlotPx()
    buildProbe()
    var opt = state.options
    state.analysis = RQ.settings.analyze({
      bytes: state.entry ? state.entry.bytes.length : 0,
      mode: opt.mode,
      symbolSize: opt.symbolSize,
      ecc: opt.ecc,
      multiQr: opt.multiQr,
      fps: opt.fps,
      redundancy: opt.redundancy,
      slotPx: state.slotPx,
      sender: state.probe
    })
    state.descriptor = state.probe ? state.probe.descriptor : state.entry ? buildDescriptor(state.entry, state.analysis) : null
    render()
  }

  /**
   * 建一个"探针" sender，只为拿到真实的 plan / symbolSize / 描述符。
   *
   * 为什么需要：RaptorQ 走 WASM 时，symbolSize 与源块划分由内核按 RFC 6330
   * 的参数表决定，光看字节数预测不出来；而帧长/QR 版本/预计耗时全依赖它。
   * 拿到信息后立刻 free()，真正发送时的 sender 由码窗自己建。
   */
  /** 超过这个大小就不建探针了：避免在面板里为一个超大文件复制一份内存 */
  var PROBE_LIMIT_BYTES = 32 * 1024 * 1024

  function buildProbe() {
    state.probe = null
    state.probeSkipped = false
    if (!state.entry) return
    if (state.entry.bytes.length > PROBE_LIMIT_BYTES) {
      state.probeSkipped = true
      return
    }
    var opt = state.options
    var sender = tryRun('创建发送端', function () {
      return OTP().codecs.createSender(opt.mode, {
        data: state.entry.bytes,
        name: state.entry.name,
        sessionId: OTP().protocol.makeSessionId(state.entry.bytes),
        symbolSize: opt.symbolSize
      })
    })
    if (!sender) return
    state.probe = {
      plan: sender.plan,
      symbolSize: sender.descriptor.symbolSize,
      frameLength: sender.frameLength,
      descriptor: sender.descriptor,
      backend: sender.backend
    }
    if (typeof sender.free === 'function') sender.free()
  }

  /* ====================================================================== */
  /*                               文件处理                                  */
  /* ====================================================================== */

  function normalizeFiles(payload) {
    var list = Array.isArray(payload) ? payload : payload ? [payload] : []
    return list.map(function (item) {
      var path = typeof item === 'string' ? item : String((item && item.path) || '')
      var info = bridge && bridge.statPath ? bridge.statPath(path) : null
      return {
        name: (item && item.name) || basename(path),
        path: path,
        size: info && info.exists ? info.size : null,
        isDirectory: info && info.exists ? info.isDirectory : Boolean(item && item.isDirectory)
      }
    })
  }

  function loadFile(file) {
    if (!bridge || typeof bridge.readFile !== 'function') {
      setError('当前环境没有文件读取能力')
      return
    }
    if (file.isDirectory) {
      setError('这是一个文件夹，请选中文件本身')
      return
    }
    try {
      var read = bridge.readFile(file.path)
      state.entry = { name: read.name || file.name, path: file.path, bytes: read.bytes }
      state.error = ''
      state.notice = ''
      state.savedTo = ''
    } catch (err) {
      setError('读取文件失败：' + String((err && err.message) || err))
      return
    }
    refresh()
  }

  function chooseFile() {
    if (!bridge || typeof bridge.showOpenDialog !== 'function') {
      setError('当前环境不支持文件选择对话框')
      return
    }
    var picked = tryRun('打开文件选择框', function () {
      return bridge.showOpenDialog({ properties: ['openFile'] })
    })
    if (!picked || !picked.length) return
    loadFile({ name: basename(picked[0]), path: picked[0], size: null, isDirectory: false })
  }

  /* ====================================================================== */
  /*                                 动作                                    */
  /* ====================================================================== */

  function startSend() {
    if (!state.entry) {
      setError('先选一个文件')
      return
    }
    if (!bridge || typeof bridge.openSenderWindow !== 'function') {
      setError('当前环境无法创建全屏码窗')
      return
    }
    var d = currentDisplay()
    var result = bridge.openSenderWindow({
      name: state.entry.name,
      bytes: state.entry.bytes,
      mode: state.options.mode,
      symbolSize: state.analysis.symbolSize,
      fps: state.options.fps,
      ecc: state.options.ecc,
      multiQr: state.analysis.effectiveMultiQr,
      redundancy: state.options.redundancy,
      displayId: d ? d.id : null
    })
    if (result && result.ok === false) {
      setError('打开码窗失败：' + result.error)
      return
    }
    state.error = ''
    state.notice = '码窗已打开，按 ESC 关闭'
    render()
  }

  function openReceiver() {
    if (!bridge || typeof bridge.openScanWindow !== 'function') {
      setError('当前环境无法创建接收窗')
      return
    }
    var result = bridge.openScanWindow({
      multiQr: state.options.multiQr,
      backend: RQ.settings.backendInfo().label
    })
    if (result && result.ok === false) {
      setError('打开接收窗失败：' + result.error)
      return
    }
    state.error = ''
    state.notice = '接收窗已打开'
    render()
  }

  /** 面板上的参数变更 */
  function setOption(key, raw) {
    var opt = state.options
    if (key === 'mode') {
      opt.mode = Number(raw)
      var defaults = RQ.settings.defaultsFor(opt.mode)
      opt.symbolSize = defaults.symbolSize
      opt.fps = defaults.fps
      opt.ecc = defaults.ecc
      opt.multiQr = defaults.multiQr
    } else if (key === 'symbolSize') {
      opt.symbolSize = RQ.settings.clampSymbolSize(Number(raw))
    } else if (key === 'fps') {
      opt.fps = RQ.settings.clampFps(Number(raw))
    } else if (key === 'ecc') {
      opt.ecc = RQ.settings.normalizeEcc(raw)
    } else if (key === 'multiQr') {
      opt.multiQr = RQ.layout.normalizeMultiQr(Number(raw))
    } else if (key === 'redundancy') {
      opt.redundancy = RQ.settings.clampRedundancy(Number(raw))
    } else if (key === 'displayId') {
      state.displayId = raw === '' ? null : raw
      refresh()
      return
    }
    refresh()
  }

  /**
   * 进入插件：功能指令 / 文件匹配指令都从这里进来
   */
  function applyEnter(action) {
    state.action = action
    state.error = ''
    state.notice = ''
    var code = (action && action.code) || 'rq-send'
    var type = (action && action.type) || 'text'

    if (type === 'file' || type === 'files') {
      state.files = normalizeFiles(action.payload)
      var first = null
      for (var i = 0; i < state.files.length; i++) {
        if (!state.files[i].isDirectory) {
          first = state.files[i]
          break
        }
      }
      if (first) {
        loadFile(first)
        return
      }
      state.error = '匹配到的都是文件夹，请选中文件本身'
      refresh()
      return
    }

    if (code === 'rq-receive') {
      refresh()
      openReceiver()
      return
    }
    refresh()
  }

  /* ====================================================================== */
  /*                                 渲染                                    */
  /* ====================================================================== */

  function card(title, badge) {
    var root_ = el('section', 'card')
    var head = el('header', 'card__head')
    head.appendChild(el('h2', 'card__title', title))
    if (badge) head.appendChild(badge)
    var body = el('div', 'card__body')
    root_.appendChild(head)
    root_.appendChild(body)
    return { root: root_, body: body, head: head }
  }

  function kv(rows) {
    var list = el('dl', 'kv')
    rows.forEach(function (row) {
      list.appendChild(el('dt', null, row[0]))
      list.appendChild(el('dd', null, row[1] == null || row[1] === '' ? '—' : String(row[1])))
    })
    return list
  }

  function selectControl(labelText, choices, current, onChange) {
    var wrap = el('label', 'field')
    wrap.appendChild(el('span', null, labelText))
    var sel = doc.createElement('select')
    choices.forEach(function (choice) {
      var opt = doc.createElement('option')
      opt.value = String(choice.value)
      opt.textContent = String(choice.label)
      sel.appendChild(opt)
    })
    sel.value = String(current)
    sel.addEventListener('change', function () {
      onChange(sel.value)
    })
    wrap.appendChild(sel)
    return wrap
  }

  function optionsWithCurrent(values, current, suffix) {
    var out = []
    values.forEach(function (v) {
      out.push({ value: v, label: String(v) + (suffix || '') })
    })
    var key = String(current)
    var found = false
    for (var i = 0; i < out.length; i++) if (out[i].value === key || String(out[i].value) === key) found = true
    if (!found) out.unshift({ value: current, label: String(current) + (suffix || '') })
    return out
  }

  function buildFilesBlock() {
    if (!state.files.length) return null
    var list = el('ul', 'file-list')
    state.files.forEach(function (f) {
      var li = doc.createElement('li')
      li.appendChild(el('span', 'name', f.name + (f.isDirectory ? '（文件夹，已跳过）' : '')))
      li.appendChild(el('span', 'size', f.size == null ? '' : RQ.settings.formatBytes(f.size)))
      if (!f.isDirectory) {
        var current = state.entry && state.entry.path === f.path
        li.appendChild(
          button(current ? '已选中' : '选它发送', function () {
            loadFile(f)
          }, current ? 'ghost' : null)
        )
      }
      list.appendChild(li)
    })
    return list
  }

  function buildSendCard(backend) {
    var mode = state.options.mode
    var info = OTP().codecs.infoFor(mode)
    var c = card('发送', null)

    /* 文件 */
    var fileRow = el('div', 'row')
    var fileText = state.entry
      ? state.entry.name + ' · ' + RQ.settings.formatBytes(state.entry.bytes.length)
      : '还没有选择文件（也可以把文件拖进来 / 直接用「隔空发送这些文件」匹配指令）'
    fileRow.appendChild(el('span', 'hint', fileText))
    fileRow.appendChild(button('选择文件…', chooseFile, 'ghost'))
    c.body.appendChild(fileRow)

    var filesBlock = buildFilesBlock()
    if (filesBlock) c.body.appendChild(filesBlock)

    /* 参数 */
    var params = el('div', 'row')
    params.appendChild(
      selectControl(
        '模式',
        RQ.settings.modeList().map(function (m) {
          return { value: m.mode, label: m.label + (m.mode === OTP().protocol.MODE_RAPTORQ ? '（招牌）' : '') }
        }),
        mode,
        function (v) {
          setOption('mode', v)
        }
      )
    )
    params.appendChild(
      selectControl(
        '并行码数',
        [
          { value: 1, label: '1 码' },
          { value: 2, label: '2 码横排' },
          { value: 4, label: '4 码田字格（招牌）' }
        ],
        state.options.multiQr,
        function (v) {
          setOption('multiQr', v)
        }
      )
    )
    c.body.appendChild(params)

    var presets = info.presets || {}
    var params2 = el('div', 'row')
    params2.appendChild(
      selectControl(
        '切片大小',
        optionsWithCurrent(presets.symbolSize || [1400], state.options.symbolSize, ' B'),
        state.options.symbolSize,
        function (v) {
          setOption('symbolSize', v)
        }
      )
    )
    params2.appendChild(
      selectControl(
        '帧率',
        optionsWithCurrent(presets.fps || [60], state.options.fps, ' fps'),
        state.options.fps,
        function (v) {
          setOption('fps', v)
        }
      )
    )
    params2.appendChild(
      selectControl(
        '纠错等级',
        RQ.settings.ECC_LEVELS.map(function (e) {
          return { value: e, label: e }
        }),
        state.options.ecc,
        function (v) {
          setOption('ecc', v)
        }
      )
    )
    params2.appendChild(
      selectControl(
        '冗余度',
        [0, 5, 10, 15, 20, 30, 50].map(function (r) {
          return { value: r, label: r + ' %' }
        }),
        state.options.redundancy,
        function (v) {
          setOption('redundancy', v)
        }
      )
    )
    if (state.displays.length > 1) {
      params2.appendChild(
        selectControl(
          '投到哪块屏',
          state.displays.map(function (d) {
            return { value: d.id, label: d.label + (d.primary ? '（主屏）' : '') }
          }),
          state.displayId == null ? (currentDisplay() || {}).id : state.displayId,
          function (v) {
            setOption('displayId', v)
          }
        )
      )
    }
    c.body.appendChild(params2)

    /* 帧参数与预计耗时 */
    var a = state.analysis
    if (a) {
      c.body.appendChild(
        kv([
          ['模式', RQ.settings.modeName(mode)],
          ['数据帧长', a.frameLength + ' B（切片 ' + a.symbolSize + ' B）'],
          ['QR 版本', 'v' + a.version + '（' + a.modules + '×' + a.modules + ' 模块）'],
          ['并行码数', a.effectiveMultiQr + ' 码' + (a.clampedMultiQr ? '（顺序模式按分片数收窄）' : '')],
          [
            '每码像素',
            (a.scan.perSlotPx ? a.scan.perSlotPx + ' px → ' + a.scan.pxPerModule.toFixed(1) + ' px/模块' : '—')
          ],
          ['分块', a.plan.blockCount + ' 块 × 最多 ' + a.plan.symbolsPerBlock + ' 符号'],
          ['源符号数', a.plan.totalSymbols + (a.estimatedPlan ? '（预测）' : '（内核实测）')],
          [
            '冗余度',
            state.entry
              ? state.options.redundancy + ' % → 约需 ' + a.estimate.symbolsNeeded + ' 个符号'
              : state.options.redundancy + ' %'
          ],
          [
            '预计耗时',
            state.entry ? a.estimate.text + '（' + a.estimate.symbolsPerSecond + ' 符号/秒）' : '选好文件后估算'
          ],
          ['后端', backend.label + ' · ' + backend.detail]
        ])
      )

      if (state.probeSkipped) {
        c.body.appendChild(
          el(
            'p',
            'hint',
            '文件超过 ' +
              RQ.settings.formatBytes(PROBE_LIMIT_BYTES) +
              '，面板跳过了真实参数探测以避免复制一份内存；上面的源符号数/分块是预测值，WASM 后端下实际值以码窗为准。'
          )
        )
      }

      if (!a.scan.ok) {
        c.body.appendChild(
          el(
            'p',
            'warn',
            '码太密：每个模块只有 ' +
              a.scan.pxPerModule.toFixed(1) +
              ' 像素（建议 ≥ 2.5）。' +
              a.scan.advice +
              '（也可以减少并行码数，或换更小的切片）'
          )
        )
      }
      if (a.clampedMultiQr) {
        c.body.appendChild(
          el('p', 'hint', '顺序分片模式一个循环只有 ' + a.plan.totalSymbols + ' 个不同分片，并行码数已收窄到 ' + a.effectiveMultiQr + '，否则同屏会出现重复帧。')
        )
      }
    }

    if (state.descriptor) {
      var hasOti = Boolean(state.descriptor.extra && state.descriptor.extra.length === 12)
      c.body.appendChild(
        kv([
          ['会话 ID', '0x' + state.descriptor.sessionId.toString(16)],
          ['描述符', state.descriptor.totalBytes + ' B / ' + state.descriptor.totalSymbols + ' 符号 / ' + state.descriptor.blockCount + ' 块'],
          ['文件名', state.descriptor.name],
          ['解码方式', hasOti ? '带 12B OTI（RaptorQ WASM 流）' : '不带 OTI（统一按 LT 喷泉码解）']
        ])
      )
      if (hasOti) {
        c.body.appendChild(
          el('p', 'hint', '这条流由 WASM RaptorQ 编码：接收端**也必须有**可用的 WASM 内核才能解，缺内核时接收端会明确报错而不是解出乱码。想发给纯 JS 的对端，可把模式切成 LT 喷泉码。')
        )
      }
    }

    if (state.error) c.body.appendChild(el('p', 'warn warn--bad', state.error))
    if (state.notice) c.body.appendChild(el('p', 'hint ok-text', state.notice))

    var actions = el('div', 'actions')
    var sendBtn = button('开始发送（全屏码窗）', startSend, 'primary')
    sendBtn.disabled = !state.entry
    actions.appendChild(sendBtn)
    actions.appendChild(button('打开接收窗口', openReceiver))
    c.body.appendChild(actions)

    progressLine = el('p', 'hint mono', state.progress ? formatProgress(state.progress) : '')
    c.body.appendChild(progressLine)

    return c.root
  }

  function formatProgress(p) {
    if (!p) return ''
    var parts = []
    if (p.drawn != null) parts.push('已播放 ' + p.drawn + ' 帧')
    if (p.measuredFps) parts.push('实测 ' + p.measuredFps.toFixed(1) + ' fps（目标 ' + p.targetFps + '）')
    if (p.produced != null) parts.push('已编码 ' + p.produced)
    if (p.backend) parts.push('后端 ' + p.backend)
    if (p.behind) parts.push('⚠ 实测帧率低于目标，渲染跟不上')
    return parts.join(' · ')
  }

  function buildReceiveCard(backend) {
    var c = card('接收')
    c.body.appendChild(
      el('p', 'hint', '接收窗支持全部三种模式的描述符，会自动选择对应解码器：' +
        RQ.settings.modeList().map(function (m) { return m.label }).join(' / ') + '。')
    )
    c.body.appendChild(
      el('p', 'hint', '同屏多码是"分区多次识别"：整幅先试一次，再按 1 / 2 / 4 码分区分别调用 jsQR。若某个分区切偏了，可以在接收窗里手动指定分区数。')
    )
    c.body.appendChild(
      el('p', 'hint', '解码后端：' + backend.label + '。' + (backend.available
        ? 'RaptorQ 修复符号开销更低。'
        : '当前是纯 JS 的 LT 喷泉码 —— 把 Rust 核心编译到 vendor/raptorq.core.wasm 后会自动启用，不需要改代码。'))
    )
    c.body.appendChild(
      el('p', 'hint', '摄像头不可用时，接收窗支持「框选截图识别」和「导入图片识别」作为降级通道。')
    )
    var actions = el('div', 'actions')
    actions.appendChild(button('打开接收窗口', openReceiver, 'primary'))
    c.body.appendChild(actions)
    return c.root
  }

  function render() {
    var backend = RQ.settings.backendInfo()
    if (backendBadge) {
      backendBadge.textContent = backend.label
      backendBadge.className = 'badge ' + (backend.available ? 'badge--ok' : 'badge--warn')
    }
    if (subtitle) {
      subtitle.textContent = state.entry
        ? state.entry.name + ' · ' + RQ.settings.modeName(state.options.mode) + ' · ' + state.options.multiQr + ' 码并行'
        : '多码并行 · 光学隔空传输'
    }
    if (!panel) return
    panel.textContent = ''
    var cards = el('div', 'cards')
    cards.appendChild(buildSendCard(backend))
    cards.appendChild(buildReceiveCard(backend))
    panel.appendChild(cards)
  }

  /* ====================================================================== */
  /*                                 启动                                    */
  /* ====================================================================== */

  function boot() {
    if (booted) return
    booted = true
    panel = doc.getElementById('panel')
    backendBadge = doc.getElementById('rq-backend')
    toastEl = doc.getElementById('rq-toast')
    subtitle = doc.getElementById('rq-subtitle')

    state.options = RQ.settings.defaultsFor(OTP().protocol.MODE_RAPTORQ)
    state.displays = bridge && typeof bridge.displays === 'function' ? bridge.displays() || [] : []
    if (state.displays.length && state.displayId == null) {
      for (var i = 0; i < state.displays.length; i++) {
        if (state.displays[i].primary) state.displayId = state.displays[i].id
      }
    }

    if (bridge && typeof bridge.onPluginEnter === 'function') bridge.onPluginEnter(applyEnter)
    var last = bridge && typeof bridge.getLastEnterAction === 'function' ? bridge.getLastEnterAction() : null
    if (last) applyEnter(last)
    else refresh()

    // WASM 内核是异步就绪的：状态一变就把徽标和参数刷新成真实值
    if (OTP().raptorqLoader && typeof OTP().raptorqLoader.onChange === 'function') {
      OTP().raptorqLoader.onChange(function () {
        refresh()
      })
    }
  }

  if (root.addEventListener) {
    root.addEventListener('rq:sender-progress', function (event) {
      state.progress = event && event.detail ? event.detail : null
      if (progressLine) progressLine.textContent = formatProgress(state.progress)
    })
  }

  RQ.panel = {
    boot: boot,
    render: render,
    refresh: refresh,
    applyEnter: applyEnter,
    setOption: setOption,
    loadFile: loadFile,
    chooseFile: chooseFile,
    startSend: startSend,
    openReceiver: openReceiver,
    buildDescriptor: buildDescriptor,
    buildProbe: buildProbe,
    PROBE_LIMIT_BYTES: PROBE_LIMIT_BYTES,
    state: state
  }

  // 页面里自动启动；Node 测试里没有 #panel 就不会乱跑
  if (doc && typeof doc.getElementById === 'function' && doc.getElementById('panel')) boot()
})(typeof self !== 'undefined' ? self : globalThis)
