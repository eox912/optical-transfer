/**
 * index.js —— airscan-qr 主控制面板
 *
 * 职责：选文件/拖文件/发文本 → 调参数 → 看传输计划 → 开全屏码窗 → 看进度。
 *
 * 两个必须守住的点：
 *   · 文本一律先 OTP.protocol.utf8Encode() 再进协议层（qrcode 的 stringToBytes
 *     被覆写成 latin1，直接塞 JS 字符串会把中文按位截断，PLUGIN-SPEC §3.2）。
 *   · 计划用 ASQ.plan()（只按字节数算），不会为了预览去构建喷泉编码器，
 *     所以 64MB 的文件也不会在面板上卡住。
 */
;(function (root) {
  'use strict'

  var OTP = root.OTP
  if (!OTP || !OTP.protocol || !OTP.codecs) {
    throw new Error('OTP 未加载：index.html 必须先引入 vendor/ 与 core/ 下的脚本')
  }
  var ASQ = root.ASQ
  var bridge = root.utoolsBridge || {}
  var api = root.utools || null

  var REPAIR_HINT_OFF =
    '智能补发：关闭。纯轮播在均匀丢帧下已是最优调度——轮长最短，接收端补齐的等待也最短。'
  var REPAIR_HINT_ON =
    '智能补发：每轮播完后追加若干「最久未播」的分片。⚠ 光学信道是单向的，发送端拿不到接收端的真实缺口，' +
    '这只是统计加权：轮长会相应变长（见上方「一轮」），对「接收端在周期中段加入」这一最常见场景收益为 0 甚至为负。' +
    '只有同浏览器双窗口（standalone.html）能拿到真实缺口时才精确有效。'

  /* ------------------------------------------------------------------ */
  /*                                 状态                                */
  /* ------------------------------------------------------------------ */

  var state = {
    items: [], // {path?, name, size?, bytes?, file?}
    activeIndex: -1,
    activeBytes: null,
    activeErrorMessage: '',
    textMode: false,
    plan: null,
    options: {
      mode: OTP.protocol.MODE_SEQUENTIAL,
      symbolSize: 400,
      fps: 10,
      ecc: 'L',
      repeatDescriptor: 20,
      repairRatio: 0
    }
  }

  function $(id) {
    return root.document ? root.document.getElementById(id) : null
  }

  /**
   * 往元素里写文本。
   * 注意：这里**不能**叫 setText —— 下面还有一个「设置要发送的文本」的
   * setText(text, name)，同名会被后面的函数声明覆盖，导致 renderPlan 递归调用自己。
   */
  function writeText(id, value) {
    var el = $(id)
    if (el) el.textContent = value == null ? '' : String(value)
  }

  function clearNode(node) {
    if (node) node.textContent = ''
  }

  var toastTimer = null
  function announce(message, kind) {
    var el = $('toast')
    if (!el) return
    el.textContent = message
    el.className = 'toast is-visible' + (kind ? ' toast--' + kind : '')
    if (root.clearTimeout) root.clearTimeout(toastTimer)
    if (root.setTimeout) {
      toastTimer = root.setTimeout(function () {
        el.className = 'toast'
      }, 2600)
    }
  }

  /* ------------------------------------------------------------------ */
  /*                              计划与渲染                             */
  /* ------------------------------------------------------------------ */

  function viewportPx() {
    var screenInfo = root.screen
    if (screenInfo && screenInfo.width && screenInfo.height) {
      return Math.min(screenInfo.width, screenInfo.height)
    }
    return 1080
  }

  function modeInfo() {
    return OTP.codecs.infoFor(state.options.mode)
  }

  /** 只按字节数算计划，不需要文件内容 */
  function computePlan() {
    var bytes = state.activeBytes
    state.plan = ASQ.plan({
      name: activeName(),
      byteLength: bytes ? bytes.length : 0,
      mode: state.options.mode,
      symbolSize: state.options.symbolSize,
      fps: state.options.fps,
      ecc: state.options.ecc,
      repeatDescriptor: state.options.repeatDescriptor,
      repairRatio: state.options.repairRatio
    })
    return state.plan
  }

  function activeName() {
    if (state.textMode) {
      var nameEl = $('text-name')
      return (nameEl && nameEl.value) || 'message.txt'
    }
    var item = state.items[state.activeIndex]
    return item ? item.name : 'data.bin'
  }

  function planRows(plan) {
    if (!plan || !state.activeBytes) {
      return [['内容', '还没有选择要发送的内容'], ['提示', '拖入文件、选择文件，或改用文本']]
    }
    var rows = [
      ['文件名', plan.name],
      ['大小', OTP.protocol.formatBytes(plan.totalBytes) + '（' + plan.totalBytes + ' 字节）'],
      ['编码模式', plan.modeLabel],
      ['分片大小', plan.symbolSize + ' B'],
      ['分片数', String(plan.totalSymbols)],
      [
        '帧长',
        plan.frameLength +
          ' B（' +
          OTP.protocol.DATA_HEADER_BYTES +
          'B 帧头 + ' +
          plan.symbolSize +
          'B 符号 + 4B CRC，不含描述符帧）'
      ],
      ['QR 版本', 'v' + plan.version + ' · ' + plan.moduleCount + '×' + plan.moduleCount]
    ]
    if (plan.loops) {
      rows.push([
        '一轮',
        plan.totalItemsPerRound +
          ' 帧 / ' +
          plan.roundSecondsWithRepair.toFixed(1) +
          's（含 ' +
          plan.descriptorsPerRound +
          ' 个描述符帧' +
          (plan.repairPerRound ? ' + ' + plan.repairPerRound + ' 个补发帧' : '') +
          '）'
      ])
    } else {
      rows.push(['播放', '喷泉码：持续产生不重复的编码符号，不循环'])
    }
    rows.push(['解码后端', 'js（本插件不含 WASM 核）'])
    return rows
  }

  function renderPlan() {
    var plan = computePlan()
    var dl = $('plan')
    if (dl) {
      clearNode(dl)
      var rows = planRows(plan)
      for (var i = 0; i < rows.length; i++) {
        var dt = root.document.createElement('dt')
        dt.textContent = rows[i][0]
        var dd = root.document.createElement('dd')
        dd.textContent = rows[i][1]
        dl.appendChild(dt)
        dl.appendChild(dd)
      }
    }

    var hint = ''
    if (state.activeBytes && plan) {
      var scanInfo = OTP.codecs.scanHint(
        plan.symbolSize,
        plan.ecc,
        OTP.qr,
        viewportPx()
      )
      hint =
        '按 ' +
        viewportPx() +
        'px 的码窗估算：每模块 ' +
        scanInfo.pxPerModule.toFixed(1) +
        'px → ' +
        scanInfo.advice +
        '。一轮的耗时就是接收端中途加入后最坏情况下的补齐等待时间，想更快就加大分片或提高帧率。'
    }
    writeText('plan-hint', hint)

    var repairHintEl = $('repair-hint')
    if (repairHintEl) {
      repairHintEl.textContent = state.options.repairRatio > 0 ? REPAIR_HINT_ON : REPAIR_HINT_OFF
    }
    return plan
  }

  function renderPayload() {
    var info = $('payload-info')
    if (!info) return
    clearNode(info)
    var rows
    if (state.activeErrorMessage) {
      rows = [['读取失败', state.activeErrorMessage]]
    } else if (state.textMode) {
      var textEl = $('text-input')
      var text = (textEl && textEl.value) || ''
      rows = [
        ['内容类型', '文本'],
        ['字节数', String(OTP.protocol.utf8Encode(text).length) + ' 字节（UTF-8）'],
        ['接收端文件名', activeName()]
      ]
    } else if (state.activeIndex >= 0 && state.items[state.activeIndex]) {
      var item = state.items[state.activeIndex]
      rows = [
        ['内容类型', '文件'],
        ['已选', item.name],
        [
          '大小',
          state.activeBytes
            ? OTP.protocol.formatBytes(state.activeBytes.length)
            : item.size == null
              ? '未知'
              : OTP.protocol.formatBytes(item.size)
        ],
        ['来源路径', item.path || '（来自拖拽/文件选择框，无本地路径）']
      ]
      if (state.items.length > 1) {
        rows.push([
          '注意',
          '协议是「单文件单流」，一次只发一个文件；上面列表里点一下可以换另一个（共 ' +
            state.items.length +
            ' 个）'
        ])
      }
    } else {
      rows = [['内容类型', '尚未选择']]
    }
    for (var i = 0; i < rows.length; i++) {
      var dt = root.document.createElement('dt')
      dt.textContent = rows[i][0]
      var dd = root.document.createElement('dd')
      dd.textContent = rows[i][1]
      info.appendChild(dt)
      info.appendChild(dd)
    }
  }

  function renderFileList() {
    var list = $('file-list')
    if (!list) return
    clearNode(list)
    if (state.textMode || !state.items.length) return
    for (var i = 0; i < state.items.length; i++) {
      ;(function (index) {
        var item = state.items[index]
        var li = root.document.createElement('li')
        li.className = 'file-row' + (index === state.activeIndex ? ' is-active' : '')
        var name = root.document.createElement('span')
        name.className = 'file-row__name'
        name.textContent = item.name
        var size = root.document.createElement('span')
        size.className = 'file-row__size'
        size.textContent = item.size == null ? '' : OTP.protocol.formatBytes(item.size)
        li.appendChild(name)
        li.appendChild(size)
        li.addEventListener('click', function () {
          selectItem(index)
        })
        list.appendChild(li)
      })(i)
    }
  }

  /* ------------------------------------------------------------------ */
  /*                              参数控件                               */
  /* ------------------------------------------------------------------ */

  function fillSelect(id, values, current, labeler) {
    var select = $(id)
    if (!select) return
    // 当前值必须出现在候选里，否则浏览器会把 select 落到第一项，
    // 之后 syncOptionsFromControls() 就会把参数悄悄改掉（比如描述符间隔 17 → 8）
    var list = values.slice()
    if (current != null && list.indexOf(current) < 0) list.push(current)
    list.sort(function (a, b) {
      return Number(a) - Number(b)
    })
    clearNode(select)
    for (var i = 0; i < list.length; i++) {
      var option = root.document.createElement('option')
      option.value = String(list[i])
      option.textContent = labeler ? labeler(list[i]) : String(list[i])
      if (String(list[i]) === String(current)) option.selected = true
      select.appendChild(option)
    }
  }

  function refreshOptionControls() {
    var info = modeInfo()
    var presets = info.presets || {}
    var defaults = info.defaults || {}

    fillSelect('opt-mode', [0, 1, 2], state.options.mode, function (mode) {
      return OTP.codecs.infoFor(mode).label
    })
    fillSelect(
      'opt-symbol',
      presets.symbolSize || [400],
      state.options.symbolSize,
      function (v) {
        return v + ' B'
      }
    )
    fillSelect(
      'opt-fps',
      presets.fps || [10],
      state.options.fps,
      function (v) {
        return v + ' fps'
      }
    )
    fillSelect('opt-ecc', ['L', 'M', 'Q', 'H'], state.options.ecc)
    fillSelect('opt-repeat', [8, 12, 20, 30, 45], state.options.repeatDescriptor, function (v) {
      return '每 ' + v + ' 帧'
    })

    var blurb = $('mode-blurb')
    if (blurb) blurb.textContent = info.blurb
    var repeatValue = $('repair-value')
    if (repeatValue) repeatValue.textContent = Math.round(state.options.repairRatio * 100) + '%'
    if (defaults.ecc && !state.options.__eccTouched) state.options.ecc = defaults.ecc
  }

  function applyModeDefaults(mode) {
    var defaults = OTP.codecs.defaultOptions(mode)
    state.options.mode = mode
    state.options.symbolSize = defaults.symbolSize
    state.options.fps = defaults.fps
    state.options.ecc = defaults.ecc || 'L'
    state.options.repeatDescriptor = defaults.repeatDescriptor || 20
    state.options.repairRatio = 0
    var repair = $('opt-repair')
    if (repair) repair.value = '0'
    refreshOptionControls()
  }

  function readControlValue(id, fallback) {
    var el = $(id)
    if (!el || el.value == null || el.value === '') return fallback
    return el.value
  }

  function syncOptionsFromControls() {
    state.options.mode = Number(readControlValue('opt-mode', state.options.mode))
    state.options.symbolSize = Number(readControlValue('opt-symbol', state.options.symbolSize))
    state.options.fps = Number(readControlValue('opt-fps', state.options.fps))
    state.options.ecc = readControlValue('opt-ecc', state.options.ecc)
    state.options.repeatDescriptor = Number(
      readControlValue('opt-repeat', state.options.repeatDescriptor)
    )
    var repair = $('opt-repair')
    if (repair) state.options.repairRatio = Number(repair.value || 0) / 100
    var repairValue = $('repair-value')
    if (repairValue) repairValue.textContent = Math.round(state.options.repairRatio * 100) + '%'
  }

  /* ------------------------------------------------------------------ */
  /*                              内容读取                               */
  /* ------------------------------------------------------------------ */

  function readBytes(item) {
    if (item.bytes) return Promise.resolve(item.bytes)
    if (item.path && bridge.readFile) {
      try {
        return Promise.resolve(bridge.readFile(item.path).bytes)
      } catch (err) {
        /* 落到下面的 blob 读法 */
      }
    }
    if (item.file && typeof item.file.arrayBuffer === 'function') {
      return item.file.arrayBuffer().then(function (buf) {
        return new Uint8Array(buf)
      })
    }
    return Promise.reject(new Error('读不到内容：' + item.name))
  }

  function setItems(items, options) {
    state.items = items || []
    state.textMode = false
    state.activeIndex = state.items.length ? 0 : -1
    state.activeBytes = null
    state.activeErrorMessage = ''
    var textBox = $('text-box')
    if (textBox) textBox.hidden = true
    var dropText = $('dropzone-text')
    if (dropText) {
      dropText.textContent = state.items.length
        ? '已选 ' + state.items.length + ' 项（协议是单文件单流，点列表切换要发哪一个）'
        : '把文件拖到这里，或点下面的按钮'
    }
    var clearBtn = $('clear-payload')
    if (clearBtn) clearBtn.hidden = !state.items.length
    renderFileList()
    if (state.activeIndex < 0) {
      renderPayload()
      renderPlan()
      return Promise.resolve(null)
    }
    return selectItem(0, options)
  }

  function selectItem(index, options) {
    if (index < 0 || index >= state.items.length) return Promise.resolve(null)
    state.activeIndex = index
    state.activeErrorMessage = ''
    renderFileList()
    var item = state.items[index]
    return readBytes(item).then(
      function (bytes) {
        state.activeBytes = bytes
        item.bytes = bytes
        if (!item.size) item.size = bytes.length
        if (options && options.silent !== true) {
          announce('已选 ' + item.name + '（' + OTP.protocol.formatBytes(bytes.length) + '）')
        }
        renderPayload()
        renderPlan()
        return bytes
      },
      function (err) {
        state.activeBytes = null
        state.activeErrorMessage = (err && err.message) || String(err)
        renderPayload()
        renderPlan()
        return null
      }
    )
  }

  function setText(text, name) {
    state.textMode = true
    state.items = []
    state.activeIndex = -1
    var textBox = $('text-box')
    if (textBox) textBox.hidden = false
    var textEl = $('text-input')
    if (textEl && text != null) textEl.value = text
    var nameEl = $('text-name')
    if (nameEl && name) nameEl.value = name
    var clearBtn = $('clear-payload')
    if (clearBtn) clearBtn.hidden = false
    renderFileList()
    refreshTextPayload()
    return state.activeBytes
  }

  function refreshTextPayload() {
    var textEl = $('text-input')
    var text = (textEl && textEl.value) || ''
    // 关键：字符串必须走 utf8Encode，不能直接进协议层
    state.activeBytes = OTP.protocol.utf8Encode(text)
    renderPayload()
    renderPlan()
    return state.activeBytes
  }

  /* ------------------------------------------------------------------ */
  /*                              发送 / 接收                            */
  /* ------------------------------------------------------------------ */

  /** 构造给码窗的 payload：文件只传路径（大文件不走 IPC），文本直接传字符串 */
  function buildSenderPayload() {
    if (!state.activeBytes) return null
    var options = {
      mode: state.options.mode,
      symbolSize: state.options.symbolSize,
      fps: state.options.fps,
      ecc: state.options.ecc,
      repeatDescriptor: state.options.repeatDescriptor,
      repairRatio: state.options.repairRatio
    }
    var item = state.items[state.activeIndex]
    if (state.textMode) {
      var textEl = $('text-input')
      return {
        name: activeName(),
        source: { kind: 'text', text: (textEl && textEl.value) || '' },
        options: options
      }
    }
    if (item && item.path) {
      return { name: item.name, source: { kind: 'file', path: item.path }, options: options }
    }
    return null
  }

  function startSend() {
    if (!state.activeBytes) {
      announce('先选一个文件或输入文本', 'err')
      return false
    }
    var payload = buildSenderPayload()
    if (!payload) {
      announce('这个来源拿不到本地路径，请用「选择文件」或拖拽文件，或改用文本', 'err')
      return false
    }
    if (!bridge.openSenderWindow) {
      announce('当前环境没有码窗能力（需要在 uTools 里运行）', 'err')
      return false
    }
    bridge.openSenderWindow(payload)
    var card = $('progress-card')
    if (card) card.hidden = false
    announce('已打开全屏码窗，把接收端对准屏幕')
    return true
  }

  function openReceiver() {
    if (!bridge.openScanWindow) {
      announce('当前环境没有接收窗口能力（需要在 uTools 里运行）', 'err')
      return false
    }
    bridge.openScanWindow({ mode: 'camera' })
    return true
  }

  function onProgress(progress) {
    var card = $('progress-card')
    if (card) card.hidden = false
    var bar = $('progress-bar')
    var ratio = progress && typeof progress.progress === 'number' ? progress.progress : 0
    if (bar) bar.style.width = Math.round(ratio * 100) + '%'
    var info = $('progress-info')
    if (!info) return
    clearNode(info)
    var rows = [
      ['已播放', (progress && progress.shown ? progress.shown : 0) + ' 帧'],
      ['播放进度', Math.round(ratio * 100) + '%'],
      ['当前帧', (progress && progress.label) || '—'],
      ['补发状态', (progress && progress.repair) || '—']
    ]
    for (var i = 0; i < rows.length; i++) {
      var dt = root.document.createElement('dt')
      dt.textContent = rows[i][0]
      var dd = root.document.createElement('dd')
      dd.textContent = rows[i][1]
      info.appendChild(dt)
      info.appendChild(dd)
    }
  }

  /* ------------------------------------------------------------------ */
  /*                              事件分发                               */
  /* ------------------------------------------------------------------ */

  function handleEnter(action) {
    var code = (action && action.code) || 'asq-send'
    var type = (action && action.type) || 'text'
    var payload = action && action.payload

    if (code === 'asq-receive') {
      openReceiver()
      return Promise.resolve(null)
    }
    if (code === 'asq-send-files' && (type === 'file' || type === 'files')) {
      var raw = Array.isArray(payload) ? payload : payload ? [payload] : []
      var files = []
      var skipped = 0
      for (var i = 0; i < raw.length; i++) {
        var entry = raw[i]
        if (typeof entry === 'string') {
          files.push({ path: entry, name: baseName(entry) })
          continue
        }
        if (!entry) continue
        if (entry.isDirectory) {
          skipped++
          continue
        }
        files.push({ path: entry.path, name: entry.name || baseName(entry.path) })
      }
      if (skipped > 0) announce('已忽略 ' + skipped + ' 个文件夹（协议只能传文件）', 'err')
      if (files.length) {
        return setItems(files)
      }
    }
    renderPlan()
    return Promise.resolve(null)
  }

  function baseName(filePath) {
    return String(filePath).split(/[\\/]/).pop() || String(filePath)
  }

  /* ------------------------------------------------------------------ */
  /*                                启动                                 */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    var pick = $('pick-file')
    var input = $('file-input')
    if (pick && input) {
      pick.addEventListener('click', function () {
        if (typeof input.click === 'function') input.click()
      })
      input.addEventListener('change', function (event) {
        var files = (event.target && event.target.files) || []
        var items = []
        for (var i = 0; i < files.length; i++) {
          items.push({ name: files[i].name, size: files[i].size, file: files[i], path: files[i].path })
        }
        if (items.length) setItems(items)
      })
    }

    var dropzone = $('dropzone')
    if (dropzone) {
      dropzone.addEventListener('dragover', function (event) {
        if (event.preventDefault) event.preventDefault()
        dropzone.className = 'dropzone is-over'
      })
      dropzone.addEventListener('dragleave', function () {
        dropzone.className = 'dropzone'
      })
      dropzone.addEventListener('drop', function (event) {
        if (event.preventDefault) event.preventDefault()
        dropzone.className = 'dropzone'
        var files = (event.dataTransfer && event.dataTransfer.files) || []
        var items = []
        for (var i = 0; i < files.length; i++) {
          items.push({ name: files[i].name, size: files[i].size, file: files[i], path: files[i].path })
        }
        if (items.length) setItems(items)
      })
    }

    var toggleText = $('toggle-text')
    if (toggleText) {
      toggleText.addEventListener('click', function () {
        if (state.textMode) {
          setItems(state.items)
        } else {
          setText('', 'message.txt')
        }
      })
    }

    var clearBtn = $('clear-payload')
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        state.items = []
        state.activeIndex = -1
        state.activeBytes = null
        state.textMode = false
        var textBox = $('text-box')
        if (textBox) textBox.hidden = true
        clearBtn.hidden = true
        renderFileList()
        renderPayload()
        renderPlan()
      })
    }

    var textEl = $('text-input')
    if (textEl) {
      textEl.addEventListener('input', function () {
        syncOptionsFromControls()
        refreshTextPayload()
      })
    }
    var nameEl = $('text-name')
    if (nameEl) {
      nameEl.addEventListener('input', function () {
        renderPayload()
      })
    }

    var modeSelect = $('opt-mode')
    if (modeSelect) {
      modeSelect.addEventListener('change', function () {
        applyModeDefaults(Number(modeSelect.value))
        renderPlan()
      })
    }
    ;['opt-symbol', 'opt-fps', 'opt-ecc', 'opt-repeat'].forEach(function (id) {
      var el = $(id)
      if (el) {
        el.addEventListener('change', function () {
          syncOptionsFromControls()
          renderPlan()
        })
      }
    })
    var repair = $('opt-repair')
    if (repair) {
      repair.addEventListener('input', function () {
        syncOptionsFromControls()
        renderPlan()
      })
    }

    var start = $('start-send')
    if (start) start.addEventListener('click', startSend)
    var receiver = $('open-receiver')
    if (receiver) receiver.addEventListener('click', openReceiver)

    if (root.addEventListener) {
      root.addEventListener('otp:progress', function (event) {
        onProgress(event.detail)
      })
    }
  }

  function boot() {
    var badge = $('env-badge')
    if (badge) badge.textContent = api && api.isDev && api.isDev() ? 'DEV' : api ? 'PROD' : 'WEB'

    applyModeDefaults(OTP.protocol.MODE_SEQUENTIAL)
    bindEvents()
    renderPayload()
    renderPlan()

    if (api && typeof api.onPluginEnter === 'function') {
      api.onPluginEnter(handleEnter)
    } else {
      handleEnter(null)
    }
    if (bridge.getLastProgress) {
      var last = bridge.getLastProgress()
      if (last) onProgress(last)
    }
  }

  var panel = {
    state: state,
    computePlan: computePlan,
    renderPlan: renderPlan,
    renderPayload: renderPayload,
    setItems: setItems,
    selectItem: selectItem,
    setText: setText,
    refreshTextPayload: refreshTextPayload,
    buildSenderPayload: buildSenderPayload,
    startSend: startSend,
    openReceiver: openReceiver,
    onProgress: onProgress,
    handleEnter: handleEnter,
    applyModeDefaults: applyModeDefaults,
    syncOptionsFromControls: syncOptionsFromControls,
    boot: boot
  }
  root.ASQ = ASQ || {}
  root.ASQ.panel = panel

  if (root.document) boot()
})(typeof self !== 'undefined' ? self : this)
