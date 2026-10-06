/**
 * standalone-glue.js —— 单文件版（standalone.html）自己的界面胶水
 *
 * 这个文件不参与插件运行，只在 build-standalone.js 生成 standalone.html 时
 * 被内联进去。它复用 sender.js / receiver.js 里的引擎与循环，只负责接 DOM。
 *
 * 单文件版独有的一件事：**同源双窗口的真实缺口反馈**。
 *   · 接收端每 600ms 通过 BroadcastChannel 广播自己缺哪些分片；
 *   · 发送端若收到同一 sessionId 的缺口，就按缺口精确补发（此时补发 100% 有效）。
 * BroadcastChannel 只在同源文档之间有效（两个 file:// 页面在 Chrome 里
 * 属于不透明 origin，多半收不到）。收不到就退回统计加权，UI 上如实显示。
 */
;(function () {
  'use strict'

  var OTP = window.OTP
  var ASQ = window.ASQ
  if (!OTP || !ASQ || !OTP.codecs) {
    document.body.textContent = '初始化失败：vendor/ 或 core/ 的脚本没有加载成功'
    return
  }

  var GAP_CHANNEL = 'asq-gap-v1'

  function $(id) {
    return document.getElementById(id)
  }
  function set(id, value) {
    var el = $(id)
    if (el) el.textContent = value == null ? '—' : String(value)
  }
  function clear(node) {
    if (node) node.textContent = ''
  }
  function show(node, visible) {
    if (node) node.hidden = !visible
  }
  function rows(dl, list) {
    if (!dl) return
    clear(dl)
    for (var i = 0; i < list.length; i++) {
      var dt = document.createElement('dt')
      dt.textContent = list[i][0]
      var dd = document.createElement('dd')
      dd.textContent = list[i][1]
      dl.appendChild(dt)
      dl.appendChild(dd)
    }
  }
  function button(label, className, onClick) {
    var b = document.createElement('button')
    b.className = className || 'btn'
    b.type = 'button'
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }
  function fillSelect(select, values, current, labeler) {
    if (!select) return
    clear(select)
    for (var i = 0; i < values.length; i++) {
      var option = document.createElement('option')
      option.value = String(values[i])
      option.textContent = labeler ? labeler(values[i]) : String(values[i])
      if (String(values[i]) === String(current)) option.selected = true
      select.appendChild(option)
    }
  }

  /* ------------------------------------------------------------------ */
  /*                              标签页切换                              */
  /* ------------------------------------------------------------------ */

  function showPane(which) {
    show($('pane-send'), which === 'send')
    show($('pane-receive'), which === 'receive')
    var sendTab = $('tab-send')
    var recvTab = $('tab-receive')
    if (sendTab) sendTab.className = 'tab' + (which === 'send' ? ' is-active' : '')
    if (recvTab) recvTab.className = 'tab' + (which === 'receive' ? ' is-active' : '')
  }

  /* ------------------------------------------------------------------ */
  /*                          缺口反馈（可选）                            */
  /* ------------------------------------------------------------------ */

  var channel = null
  var latestGap = null
  try {
    if (typeof BroadcastChannel === 'function') channel = new BroadcastChannel(GAP_CHANNEL)
  } catch (err) {
    channel = null
  }

  /* ================================================================== */
  /*                                发送端                               */
  /* ================================================================== */

  var sender = {
    bytes: null,
    name: 'data.bin',
    textMode: false,
    options: { mode: 0, symbolSize: 400, fps: 10, ecc: 'L', repeatDescriptor: 20, repairRatio: 0 },
    engine: null,
    player: null
  }

  function senderModeInfo() {
    return OTP.codecs.infoFor(sender.options.mode)
  }

  function refreshSenderControls() {
    var info = senderModeInfo()
    fillSelect($('s-mode'), [0, 1, 2], sender.options.mode, function (mode) {
      return OTP.codecs.infoFor(mode).label
    })
    fillSelect($('s-symbol'), (info.presets && info.presets.symbolSize) || [400], sender.options.symbolSize, function (v) {
      return v + ' B'
    })
    fillSelect($('s-fps'), (info.presets && info.presets.fps) || [10], sender.options.fps, function (v) {
      return v + ' fps'
    })
    set('s-blurb', info.blurb)
    set('s-repair-value', Math.round(sender.options.repairRatio * 100) + '%')
  }

  function senderPlan() {
    return ASQ.plan({
      name: sender.name,
      byteLength: sender.bytes ? sender.bytes.length : 0,
      mode: sender.options.mode,
      symbolSize: sender.options.symbolSize,
      fps: sender.options.fps,
      ecc: sender.options.ecc,
      repeatDescriptor: sender.options.repeatDescriptor,
      repairRatio: sender.options.repairRatio
    })
  }

  function renderSenderPlan() {
    var plan = senderPlan()
    if (!sender.bytes) {
      rows($('s-plan'), [['内容', '还没有选择要发送的内容']])
      return plan
    }
    var list = [
      ['文件名', plan.name],
      ['大小', OTP.protocol.formatBytes(plan.totalBytes)],
      ['模式', plan.modeLabel],
      ['分片', plan.symbolSize + ' B × ' + plan.totalSymbols + ' 片'],
      ['帧长', plan.frameLength + ' B'],
      ['QR', 'v' + plan.version + ' · ' + plan.moduleCount + '×' + plan.moduleCount]
    ]
    if (plan.loops) {
      list.push([
        '一轮',
        plan.totalItemsPerRound +
          ' 帧 / ' +
          plan.roundSecondsWithRepair.toFixed(1) +
          's' +
          (plan.repairPerRound ? '（含 ' + plan.repairPerRound + ' 补发帧）' : '')
      ])
    }
    rows($('s-plan'), list)
    return plan
  }

  function setSenderBytes(bytes, name) {
    sender.bytes = bytes
    sender.name = name
    renderSenderPlan()
    rows($('s-info'), [
      ['已选', name],
      ['大小', OTP.protocol.formatBytes(bytes.length) + '（' + bytes.length + ' 字节）'],
      ['说明', '单文件单流；文本会按 UTF-8 编码后传输']
    ])
  }

  function senderGapProvider() {
    if (!latestGap || !sender.engine) return null
    if (latestGap.sessionId !== sender.engine.sessionId) return null
    return latestGap.missing
  }

  var senderHud = {
    name: $('s-info'),
    mode: null,
    size: null,
    symbols: null,
    round: null,
    fps: null,
    version: $('s-hud-version'),
    frame: $('s-hud-frame'),
    shown: $('s-hud-shown'),
    modules: $('s-hud-modules'),
    progress: null,
    elapsed: null
  }

  function startSender() {
    if (!sender.bytes) {
      set('s-hud-frame', '先选择文件或输入文本')
      return
    }
    stopSender()
    var plan = senderPlan()
    sender.engine = ASQ.createEngine({
      data: sender.bytes,
      name: sender.name,
      mode: sender.options.mode,
      symbolSize: sender.options.symbolSize,
      fps: sender.options.fps,
      ecc: sender.options.ecc,
      repeatDescriptor: sender.options.repeatDescriptor,
      repairRatio: sender.options.repairRatio,
      gapProvider: senderGapProvider
    })
    sender.player = ASQ.createPlayer({
      canvas: $('s-code'),
      info: senderHud,
      onProgress: function (p) {
        set(
          's-hud-repair',
          p.repair === 'gap'
            ? '按接收端真实缺口'
            : p.repair === 'heuristic'
              ? '统计加权'
              : sender.options.repairRatio > 0
                ? '待机'
                : '关闭'
        )
      }
    })
    sender.player.start(sender.engine)
    set('s-hud-repair', sender.options.repairRatio > 0 ? '待机' : '关闭')
    $('s-stop').disabled = false
    $('s-start').disabled = true
    set('sa-sub', '正在播放 ' + plan.name + ' · ' + plan.modeLabel + ' · 一轮 ' + plan.roundSecondsWithRepair.toFixed(1) + 's')
  }

  function stopSender() {
    if (sender.player) {
      sender.player.stop()
      sender.player = null
    }
    $('s-stop').disabled = true
    $('s-start').disabled = false
  }

  function bindSender() {
    var fileInput = $('s-file')
    $('s-pick').addEventListener('click', function () {
      fileInput.click()
    })
    fileInput.addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0]
      if (!file) return
      ASQ.receiver.readFileBytes(file).then(function (bytes) {
        setSenderBytes(bytes, file.name)
      })
    })

    $('s-use-text').addEventListener('click', function () {
      sender.textMode = true
      show($('s-textbox'), true)
      refreshSenderText()
    })
    $('s-text').addEventListener('input', refreshSenderText)
    $('s-name').addEventListener('input', refreshSenderText)

    $('s-mode').addEventListener('change', function () {
      var defaults = OTP.codecs.defaultOptions(Number($('s-mode').value))
      sender.options.mode = Number($('s-mode').value)
      sender.options.symbolSize = defaults.symbolSize
      sender.options.fps = defaults.fps
      sender.options.repeatDescriptor = defaults.repeatDescriptor || 20
      refreshSenderControls()
      renderSenderPlan()
    })
    ;['s-symbol', 's-fps'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        sender.options.symbolSize = Number($('s-symbol').value)
        sender.options.fps = Number($('s-fps').value)
        renderSenderPlan()
      })
    })
    $('s-repair').addEventListener('input', function () {
      sender.options.repairRatio = Number($('s-repair').value) / 100
      set('s-repair-value', $('s-repair').value + '%')
      set(
        's-repair-hint',
        sender.options.repairRatio > 0
          ? '⚠ 无反馈时这只是统计加权，轮长会变长；对「接收端中途加入」这一最常见场景收益为 0 甚至为负。同源双窗口下收到真实缺口时才精确有效。'
          : '关闭。纯轮播在均匀丢帧下已是最优调度。'
      )
      renderSenderPlan()
    })

    $('s-start').addEventListener('click', startSender)
    $('s-stop').addEventListener('click', stopSender)
    $('s-full').addEventListener('click', function () {
      var canvas = $('s-code')
      if (canvas.requestFullscreen) canvas.requestFullscreen()
    })
  }

  function refreshSenderText() {
    var text = $('s-text').value || ''
    var name = $('s-name').value || 'message.txt'
    sender.textMode = true
    show($('s-textbox'), true)
    setSenderBytes(OTP.protocol.utf8Encode(text), name)
  }

  /* ================================================================== */
  /*                                接收端                               */
  /* ================================================================== */

  var receiver = {
    engine: null,
    scanner: null,
    timer: null
  }

  function renderReceiver() {
    var engine = receiver.engine
    set('r-mode', engine.modeLabel())
    set('r-backend', engine.backendNote())
    var p = engine.progress()
    set('r-progress', Math.round(p * 100) + '%')
    var bar = $('r-bar')
    if (bar) bar.style.width = Math.round(p * 100) + '%'
    set('r-received', engine.received())
    set('r-needed', engine.needed())
    set('r-rate', engine.rate().toFixed(1) + ' 帧/秒')
  }

  function receiverStatus(message, kind) {
    var el = $('r-status')
    if (!el) return
    el.textContent = message
    el.className = 'status' + (kind ? ' status--' + kind : '')
  }

  function publishGap() {
    if (!channel || !receiver.engine || !receiver.engine.hasDescriptor()) return
    if (receiver.engine.isComplete()) return
    var desc = receiver.engine.descriptor()
    try {
      channel.postMessage({
        type: 'gap',
        sessionId: desc.sessionId,
        name: desc.name,
        missing: receiver.engine.missing(400),
        received: receiver.engine.received(),
        needed: receiver.engine.needed()
      })
    } catch (err) {
      /* 忽略 */
    }
  }

  function onReceiverFrame(frame) {
    var res = receiver.engine.ingest(frame)
    if (res.kind === 'descriptor' && res.newSession) {
      receiverStatus('已锁定：' + receiver.engine.name() + '（' + receiver.engine.modeLabel() + '）', 'ok')
      publishGap()
    }
    if (res.kind === 'unsupported') {
      receiverStatus('这条流本端解不了：' + (res.reason || receiver.engine.unsupportedReason()), 'err')
    }
    renderReceiver()
    if (receiver.engine.isComplete()) {
      var bytes = receiver.engine.assemble()
      if (bytes) finishReceive(bytes)
    }
  }

  function finishReceive(bytes) {
    if (receiver.scanner) receiver.scanner.stop()
    $('r-start').disabled = false
    $('r-stop').disabled = true
    var name = receiver.engine.name() || 'received.bin'
    receiverStatus('接收完成：' + name + '（' + OTP.protocol.formatBytes(bytes.length) + '）', 'ok')
    show($('r-result-card'), true)
    set('r-result-name', name)
    set('r-result-size', OTP.protocol.formatBytes(bytes.length) + ' / ' + bytes.length + ' 字节')

    var actions = $('r-actions')
    clear(actions)
    if (ASQ.receiver.isTextLike(name, bytes)) {
      var text = OTP.protocol.utf8Decode(bytes)
      var area = $('r-result-text')
      show(area, true)
      area.value = text
      actions.appendChild(
        button('复制文本', 'btn', function () {
          if (navigator.clipboard) navigator.clipboard.writeText(text)
        })
      )
    }
    actions.appendChild(
      button('下载文件', 'btn btn--primary', function () {
        var blob = new Blob([bytes], { type: 'application/octet-stream' })
        var url = URL.createObjectURL(blob)
        var a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        setTimeout(function () {
          URL.revokeObjectURL(url)
          a.remove()
        }, 1500)
      })
    )
  }

  function receiverScanner() {
    if (!receiver.scanner) {
      receiver.scanner = ASQ.receiver.createScanner({
        canvas: $('r-work'),
        onFrame: onReceiverFrame
      })
    }
    return receiver.scanner
  }

  function startReceiverCamera() {
    var scanner = receiverScanner()
    if (!ASQ.receiver.cameraSupported()) {
      receiverStatus(
        '这个浏览器/上下文拿不到摄像头（file:// 下部分浏览器会拒绝）。请用「选择帧图片」导入每一帧。',
        'err'
      )
      return
    }
    receiverStatus('正在请求摄像头权限…')
    scanner.startCamera($('r-camera')).then(
      function () {
        $('r-start').disabled = true
        $('r-stop').disabled = false
        receiverStatus('正在扫描…把发送端的动态码对准摄像头', 'ok')
      },
      function (err) {
        receiverStatus(
          '摄像头不可用：' + ((err && err.message) || err) + ' — 请改用「选择帧图片」',
          'err'
        )
      }
    )
  }

  function importImages(files) {
    if (!files || !files.length) return
    var scanner = receiverScanner()
    var hits = 0
    var chain = Promise.resolve()
    for (var i = 0; i < files.length; i++) {
      chain = chain.then(
        (function (file) {
          return function () {
            return ASQ.receiver.loadImage(file).then(function (res) {
              if (scanner.scanSource(res.image, res.image.naturalWidth, res.image.naturalHeight)) hits++
              if (res.revoke) URL.revokeObjectURL(res.revoke)
            })
          }
        })(files[i])
      )
    }
    chain.then(
      function () {
        receiverStatus('已识别 ' + files.length + ' 张图片，其中 ' + hits + ' 张是有效帧', hits ? 'ok' : 'err')
        renderReceiver()
      },
      function (err) {
        receiverStatus('图片识别失败：' + ((err && err.message) || err), 'err')
      }
    )
  }

  function bindReceiver() {
    $('r-start').addEventListener('click', startReceiverCamera)
    $('r-stop').addEventListener('click', function () {
      if (receiver.scanner) receiver.scanner.stop()
      $('r-start').disabled = false
      $('r-stop').disabled = true
      receiverStatus('已停止')
    })
    $('r-pick').addEventListener('click', function () {
      $('r-input').click()
    })
    $('r-input').addEventListener('change', function (event) {
      importImages(event.target.files)
    })
    document.addEventListener('paste', function (event) {
      var items = (event.clipboardData && event.clipboardData.items) || []
      var files = []
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var f = items[i].getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length) {
        showPane('receive')
        importImages(files)
      }
    })
  }

  /* ================================================================== */
  /*                                 启动                                */
  /* ================================================================== */

  function boot() {
    var badge = $('sa-origin')
    if (badge) badge.textContent = location.protocol === 'file:' ? 'file://' : location.origin

    receiver.engine = ASQ.receiver.createEngine()

    bindSender()
    bindReceiver()
    refreshSenderControls()
    renderSenderPlan()
    renderReceiver()
    set('s-repair-hint', '关闭。纯轮播在均匀丢帧下已是最优调度。')

    if (channel) {
      channel.onmessage = function (event) {
        var data = event.data
        if (!data || data.type !== 'gap') return
        latestGap = data
        set('s-hud-gap', '已收到缺口反馈（缺 ' + data.missing.length + ' / ' + data.needed + '）')
      }
    } else {
      set('s-hud-gap', '当前浏览器不支持 BroadcastChannel')
    }

    receiver.timer = setInterval(function () {
      renderReceiver()
      publishGap()
    }, 600)

    $('tab-send').addEventListener('click', function () {
      showPane('send')
    })
    $('tab-receive').addEventListener('click', function () {
      showPane('receive')
    })
    $('sa-open-receiver').addEventListener('click', function () {
      window.open(location.pathname + '?mode=receive', '_blank')
    })

    var startPane = /(^|[?&])mode=receive(&|$)/.test(location.search) ? 'receive' : 'send'
    showPane(startPane)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
