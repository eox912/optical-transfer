/**
 * plugin.test.js —— raptorqr 的主流程测试（Node + 桩 DOM，无测试框架）
 *
 *   node test/plugin.test.js
 *
 * 覆盖规范第 6 节的 6 项，外加多码并行、WASM 诚实性、分发完整性：
 *   1. 主面板无 action 能渲染
 *   2. 匹配指令带文件进入 → 读文件 → 描述符正确
 *   3. 三种模式内存往返
 *   4. 经过真实 QR 像素的往返（RaptorQ 走真 wasm + OTI）
 *   5. 所有帧（含描述符）QR 模块数/像素尺寸一致
 *   6. 参数边界（1 字节 / 非整除切片 / 超大切片）
 *   7. 【额外】多码布局不重叠，且 4 个码位都能被独立识别出来
 *   8. 【额外】WASM 可用/缺失都如实上报，缺内核时不静默解错
 *
 * 桩 DOM 里的 canvas 会把 fillRect 真正**栅格化**成 RGBA，
 * 所以多码识别是真的走 QR 像素，不是纸上谈兵。
 *
 * 两个沙箱：
 *   ltEnv —— 不带 vendor/raptorq.core.js，验证"如实回退 LT"这条路径
 *   env   —— 带真 wasm 内核（通过 preload 的 readBinary 桥读字节），验证 WASM 路径
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const SHARED = path.join(ROOT, '..', 'shared')
const WASM_PATH = path.join(DIST, 'vendor', 'raptorq.core.wasm')

let pass = 0
let fail = 0

async function check(name, fn) {
  const t0 = Date.now()
  try {
    const extra = await fn()
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''} (${Date.now() - t0}ms)`)
    pass++
  } catch (err) {
    console.log(`  ✗ ${name} → ${(err && err.message) || err}`)
    if (process.env.RQ_TEST_STACK) console.log(err.stack)
    fail++
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function makeData(n, seed) {
  const out = new Uint8Array(n)
  let x = (seed || 987654321) >>> 0
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out[i] = (x >>> 16) & 0xff
  }
  return out
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/* ========================================================================== */
/*                              桩 DOM                                       */
/* ========================================================================== */

function createNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    type: '',
    value: '',
    disabled: false,
    hidden: false,
    src: '',
    alt: '',
    title: '',
    _text: '',
    _listeners: {},
    style: {
      _vars: {},
      setProperty(name, value) {
        this._vars[name] = value
      },
      getPropertyValue(name) {
        return this._vars[name] || ''
      }
    },
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    },
    addEventListener(type, fn) {
      ;(this._listeners[type] = this._listeners[type] || []).push(fn)
    },
    removeEventListener() {},
    setAttribute(key, value) {
      this[key] = value
    },
    dispatch(type, event) {
      ;(this._listeners[type] || []).forEach((fn) => fn(event || { target: this, type: type }))
    },
    click() {
      this.dispatch('click')
    },
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('')
    },
    set textContent(value) {
      this.children.length = 0
      this._text = value == null ? '' : String(value)
    }
  }
  return node
}

function walk(node, visit) {
  visit(node)
  node.children.forEach((child) => walk(child, visit))
}

function findAll(root, predicate) {
  const out = []
  walk(root, (n) => {
    if (predicate(n)) out.push(n)
  })
  return out
}

function findByText(root, text) {
  return findAll(root, (n) => String(n.className).indexOf('btn') >= 0 && n.textContent === text)[0]
}

function parseColor(css) {
  const matched = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(css).trim())
  if (!matched) return { r: 0, g: 0, b: 0 }
  let hex = matched[1]
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  }
}

/** 会把 fillRect 真正栅格化的 canvas 桩：drawTick 画出来的就是真像素 */
function createRecordingCanvas(width, height) {
  const node = createNode('canvas')
  node.width = width
  node.height = height
  node._buffer = null
  node._bw = -1
  node._bh = -1

  function ensure() {
    if (!node._buffer || node._bw !== node.width || node._bh !== node.height) {
      node._bw = node.width
      node._bh = node.height
      node._buffer = new Uint8ClampedArray(node.width * node.height * 4)
      for (let i = 0; i < node._buffer.length; i += 4) {
        node._buffer[i] = node._buffer[i + 1] = node._buffer[i + 2] = 255
        node._buffer[i + 3] = 255
      }
    }
    return node._buffer
  }

  node.getContext = function () {
    return {
      canvas: node,
      fillStyle: '#000000',
      strokeStyle: '#000000',
      fillRect(x, y, w, h) {
        const buf = ensure()
        const color = parseColor(this.fillStyle)
        const W = node.width
        const H = node.height
        const x0 = Math.max(0, Math.round(x))
        const y0 = Math.max(0, Math.round(y))
        const x1 = Math.min(W, Math.round(x + w))
        const y1 = Math.min(H, Math.round(y + h))
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const p = (yy * W + xx) * 4
            buf[p] = color.r
            buf[p + 1] = color.g
            buf[p + 2] = color.b
            buf[p + 3] = 255
          }
        }
      },
      drawImage() {},
      getImageData(x, y, w, h) {
        const buf = ensure()
        const out = new Uint8ClampedArray(w * h * 4)
        for (let row = 0; row < h; row++) {
          const start = ((y + row) * node.width + x) * 4
          out.set(buf.subarray(start, start + w * 4), row * w * 4)
        }
        return { data: out, width: w, height: h }
      }
    }
  }
  node.asImageData = function () {
    return { data: Uint8ClampedArray.from(ensure()), width: node.width, height: node.height }
  }
  return node
}

function createStubDom(options) {
  const opts = options || {}
  const registry = {}
  const canvasIds = opts.canvasIds || []
  const head = createNode('head')
  const scripts = []

  head.appendChild = function (el) {
    if (el && el.tagName === 'SCRIPT') scripts.push(el)
    return el
  }

  ;(opts.ids || []).forEach((id) => {
    registry[id] = canvasIds.indexOf(id) >= 0 ? createRecordingCanvas(opts.width || 1600, opts.height || 960) : createNode('div')
  })

  const windowListeners = {}
  const documentListeners = {}

  const document = {
    documentElement: { style: createNode('html').style },
    head: head,
    createElement(tag) {
      if (String(tag).toLowerCase() === 'canvas') return createRecordingCanvas(1, 1)
      return createNode(tag)
    },
    getElementById(id) {
      return registry[id] || null
    },
    getElementsByTagName() {
      return [head]
    },
    addEventListener(type, fn) {
      ;(documentListeners[type] = documentListeners[type] || []).push(fn)
    }
  }

  return { document, registry, head, scripts, windowListeners, documentListeners }
}

/* ========================================================================== */
/*                              沙箱                                         */
/* ========================================================================== */

function requireCore() {
  return {
    protocol: require(path.join(ROOT, 'core', 'protocol.js')),
    fountain: require(path.join(ROOT, 'core', 'fountain.js')),
    qr: require(path.join(ROOT, 'core', 'qr.js')),
    scan: require(path.join(ROOT, 'core', 'scan.js'))
  }
}

function loadScript(sandbox, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file })
}

/**
 * 造一个"浏览器式"沙箱。
 *   - OTP 里放共享核心（Node require 进来的同一份文件）；
 *   - 按 index.html 的顺序加载 dist 产物；
 *   - withVendorCore 时额外加载 vendor/raptorq.core.js（真 WASM 内核胶水），
 *     并通过 utoolsBridge.readBinary 提供 wasm 字节（与真实 preload 完全一致）；
 *   - codecs.js 走**浏览器分支**，每次使用时现取 OTP.raptorqCore。
 */
function createSandbox(options) {
  const opts = options || {}
  const dom = createStubDom({
    ids: opts.ids || [],
    canvasIds: opts.canvasIds || [],
    width: opts.width || 1600,
    height: opts.height || 960
  })
  const OTP = requireCore()

  const sandbox = {
    console: console,
    Buffer: Buffer,
    Date: Date,
    JSON: JSON,
    Math: Math,
    Number: Number,
    String: String,
    Boolean: Boolean,
    Array: Array,
    Object: Object,
    RegExp: RegExp,
    Set: Set,
    Map: Map,
    Error: Error,
    Promise: Promise,
    isFinite: isFinite,
    parseInt: parseInt,
    Uint8Array: Uint8Array,
    Uint8ClampedArray: Uint8ClampedArray,
    Int32Array: Int32Array,
    Uint32Array: Uint32Array,
    Float64Array: Float64Array,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    WebAssembly: typeof WebAssembly === 'undefined' ? undefined : WebAssembly,
    document: dom.document,
    navigator: opts.navigator || {},
    innerWidth: opts.width || 1600,
    innerHeight: opts.height || 960,
    devicePixelRatio: opts.dpr || 1,
    OTP: OTP,
    utoolsBridge: opts.bridge || null,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    addEventListener(type, fn) {
      ;(dom.windowListeners[type] = dom.windowListeners[type] || []).push(fn)
    },
    dispatchEvent() {},
    close() {}
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)

  // 顺序与 index.html 一致
  if (opts.withVendorCore) loadScript(sandbox, path.join(DIST, 'vendor', 'raptorq.core.js'))
  loadScript(sandbox, path.join(DIST, 'raptorq-core.js'))
  loadScript(sandbox, path.join(DIST, 'core', 'codecs.js'))
  loadScript(sandbox, path.join(DIST, 'layout.js'))
  loadScript(sandbox, path.join(DIST, 'settings.js'))
  loadScript(sandbox, path.join(DIST, 'player.js'))
  loadScript(sandbox, path.join(DIST, 'multiscan.js'))
  if (opts.withPanel) loadScript(sandbox, path.join(DIST, 'index.js'))
  if (opts.withSender) loadScript(sandbox, path.join(DIST, 'sender.js'))

  return {
    sandbox: sandbox,
    RQ: sandbox.RQ,
    OTP: OTP,
    dom: dom,
    registry: dom.registry,
    vendorScript() {
      return dom.scripts.length ? dom.scripts[dom.scripts.length - 1] : null
    }
  }
}

/**
 * 真 wasm 的字节，交给 vendor 胶水。
 * 必须是 Uint8Array：胶水层检查 `bytes.length`（ArrayBuffer 只有 byteLength）。
 * 这也正是 preload 里 readBinary 的返回值形状。
 */
function wasmBytes() {
  return new Uint8Array(fs.readFileSync(WASM_PATH))
}

function makeBridge(tag, overrides) {
  const base = {
    readFile(filePath) {
      const buf = fs.readFileSync(filePath)
      return { name: path.basename(filePath), bytes: new Uint8Array(buf) }
    },
    statPath(filePath) {
      try {
        const st = fs.statSync(filePath)
        return { exists: true, size: st.size, isDirectory: st.isDirectory(), mtime: '' }
      } catch (err) {
        return { exists: false, size: null, isDirectory: false, mtime: '' }
      }
    },
    getPath() {
      return os.tmpdir()
    },
    writeFile() {
      return ''
    },
    showSaveDialog() {
      return undefined
    },
    showOpenDialog() {
      return []
    },
    openSenderWindow(payload) {
      exported.sender[tag] = payload
      return { ok: true }
    },
    openScanWindow(payload) {
      exported.scan[tag] = payload
      return { ok: true }
    },
    displays() {
      return [{ id: 1, primary: true, label: '主屏', bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 2 }]
    },
    /** vendor/raptorq.core.js 约定的二进制读取桥：本地协议下比 fetch 可靠 */
    readBinary(url) {
      if (String(url).indexOf('raptorq.core.wasm') < 0) return null
      return wasmBytes()
    },
    readVendorWasm() {
      return wasmBytes()
    },
    isDev() {
      return false
    },
    platform: 'darwin',
    getLastEnterAction() {
      return null
    },
    onPluginEnter(fn) {
      exported.enter[tag] = fn
      return () => {}
    }
  }
  return Object.assign(base, overrides || {})
}

/** 每个沙箱各自的桥回调，按 tag 分开，避免互相串台 */
const exported = { enter: {}, sender: {}, scan: {} }

/** 内存往返：不经过像素 */
function memoryRoundTrip(codecs, protocol, mode, totalBytes, symbolSize, lossEvery) {
  const data = makeData(totalBytes, 4242)
  const sessionId = protocol.makeSessionId(data)
  const sender = codecs.createSender(mode, { data: data, name: '内存往返.bin', sessionId: sessionId, symbolSize: symbolSize })
  const receiver = codecs.createReceiver(sender.descriptor)
  assert(!receiver.error, '接收端报错：' + receiver.error)
  let index = 0
  let shown = 0
  while (!receiver.isComplete) {
    const coord = sender.frameCoord(index)
    const symbol = sender.symbol(coord.blockIndex, coord.esi)
    assert(symbol && symbol.length === sender.descriptor.symbolSize, `第 ${index} 个符号长度异常`)
    shown++
    if (!(lossEvery && shown % lossEvery === 0)) receiver.add(coord.blockIndex, coord.esi, symbol)
    index++
    if (index > 60000) throw new Error('未收敛，播放 ' + index + ' 帧')
  }
  const out = receiver.assemble()
  assert(out && out.length === totalBytes, `还原长度不符：${out && out.length} != ${totalBytes}`)
  for (let i = 0; i < totalBytes; i++) assert(out[i] === data[i], `第 ${i} 字节不符`)
  if (sender.free) sender.free()
  return { frames: shown, backend: sender.backend, symbols: sender.descriptor.totalSymbols }
}

/** 走真实 QR 像素的往返 */
function pixelRoundTrip(codecs, protocol, qr, scan, mode, totalBytes, symbolSize, lossEvery, ecc) {
  const level = ecc || 'L'
  const data = makeData(totalBytes, 777)
  const sessionId = protocol.makeSessionId(data)
  const sender = codecs.createSender(mode, { data: data, name: '像素往返.bin', sessionId: sessionId, symbolSize: symbolSize })

  // 固定版本：描述符帧（可能带 OTI）与数据帧共用一个版本
  const dataVersion = qr.versionFor(sender.frameLength, level)
  const descriptorFrame = protocol.encodeDescriptor(sender.descriptor)
  const version = Math.max(dataVersion, qr.versionFor(descriptorFrame.length, level))

  const descImg = qr.toImageData(qr.encode(descriptorFrame, level, version), { scale: 3, quiet: 4 })
  const descBack = scan.decodeFrameFromImage(protocol, descImg.data, descImg.width, descImg.height)
  assert(descBack && descBack.type === protocol.TYPE_DESCRIPTOR, '描述符帧没能过像素链路')
  assert(descBack.totalBytes === totalBytes, '描述符里的长度不对')
  assert(descBack.name === '像素往返.bin', '描述符里的文件名不对：' + descBack.name)

  const receiver = codecs.createReceiver(descBack)
  assert(!receiver.error, '接收端报错：' + receiver.error)

  let index = 0
  let shown = 0
  while (!receiver.isComplete) {
    const coord = sender.frameCoord(index)
    const symbol = sender.symbol(coord.blockIndex, coord.esi)
    const frame = protocol.encodeDataFrame(sessionId, coord.blockIndex, coord.esi, symbol)
    const img = qr.toImageData(qr.encode(frame, level, version), { scale: 3, quiet: 4 })
    shown++
    if (!(lossEvery && shown % lossEvery === 0)) {
      const parsed = scan.decodeFrameFromImage(protocol, img.data, img.width, img.height)
      assert(parsed, `第 ${shown} 帧没能过像素链路`)
      receiver.add(parsed.blockIndex, parsed.esi, parsed.payload)
    }
    index++
    if (index > 30000) throw new Error('未收敛，播放 ' + index + ' 帧')
  }
  const out = receiver.assemble()
  assert(out && out.length === totalBytes, '还原长度不符')
  for (let i = 0; i < totalBytes; i++) assert(out[i] === data[i], `第 ${i} 字节不符`)
  if (sender.free) sender.free()
  return {
    version: version,
    frames: shown,
    px: descImg.width,
    backend: sender.backend,
    otiBytes: descBack.extra ? descBack.extra.length : 0
  }
}

function listFiles(dir, base) {
  const root = base || dir
  const out = []
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, root))
    else out.push(path.relative(root, full))
  })
  return out
}

/* ========================================================================== */
/*                                 开跑                                       */
/* ========================================================================== */

;(async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raptorqr-test-'))
  const payloadPath = path.join(tmpDir, '载荷文件·demo.bin')
  const payloadBytes = makeData(4321, 31337)
  fs.writeFileSync(payloadPath, Buffer.from(payloadBytes))

  /* ---------------------------------------------------------------------- */
  console.log('\n=== 0. 造两个沙箱：无内核（LT 回退） / 带真 wasm ===')
  /* ---------------------------------------------------------------------- */

  const ltEnv = createSandbox({
    withPanel: true,
    withVendorCore: false,
    ids: ['panel', 'rq-backend', 'rq-toast', 'rq-subtitle'],
    bridge: makeBridge('lt')
  })

  const env = createSandbox({
    withPanel: true,
    withVendorCore: true,
    ids: ['panel', 'rq-backend', 'rq-toast', 'rq-subtitle'],
    bridge: makeBridge('wasm')
  })

  /** 与真实页面完全一致地加载 wasm：走 bridge.readBinary */
  async function primeCore(target) {
    const core = target.OTP.raptorqCore
    assert(core, '没有找到 OTP.raptorqCore（vendor 胶水没生效）')
    const inst = await core.load()
    assert(inst, 'wasm 加载失败：' + core.status().error)
    await tick()
    return core
  }

  await check('vendor/raptorq.core.js 通过 preload 的 readBinary 桥加载真 wasm', async () => {
    assert(fs.existsSync(WASM_PATH), 'dist/vendor/raptorq.core.wasm 不在 dist 里')
    const core = await primeCore(env)
    const st = core.status()
    assert(st.available === true, 'isAvailable 应为 true')
    assert(st.abiVersion === 1, 'ABI 版本应为 1，实际 ' + st.abiVersion)
    assert(st.wasmBytes === fs.statSync(WASM_PATH).size, 'wasmBytes 与磁盘不一致')
    assert(env.OTP.codecs.raptorqAvailable() === true, 'codecs 应当认为可用')
    return `ABI v${st.abiVersion} / ${(st.wasmBytes / 1024).toFixed(0)} KB`
  })

  /* ---------------------------------------------------------------------- */
  console.log('\n=== 1. 主面板（无内核 → 如实回退） ===')
  /* ---------------------------------------------------------------------- */

  await check('主面板无 action 时能渲染', () => {
    const panel = ltEnv.registry.panel
    assert(panel, '没有 #panel')
    const text = panel.textContent
    assert(text.indexOf('发送') >= 0, '缺少发送卡片')
    assert(text.indexOf('接收') >= 0, '缺少接收卡片')
    assert(text.indexOf('预计耗时') >= 0, '缺少预计耗时')
    assert(text.indexOf('并行码数') >= 0, '缺少并行码数')
    assert(findByText(panel, '开始发送（全屏码窗）'), '缺少开始发送按钮')
    assert(findByText(panel, '打开接收窗口'), '缺少打开接收窗口按钮')
    return '卡片渲染正常'
  })

  await check('缺 vendor 内核时后端如实显示「已回退 LT（JS）」', () => {
    const badge = ltEnv.registry['rq-backend']
    assert(badge.textContent === '已回退 LT（JS）', '徽标不诚实：' + badge.textContent)
    assert(badge.className.indexOf('badge--warn') >= 0, '回退时应当是告警色：' + badge.className)
    assert(String(ltEnv.RQ.settings.backendInfo().detail).length > 0, '应当给出不可用的原因')
    return badge.textContent
  })

  await check('匹配指令带文件进入：读文件 + 描述符正确', () => {
    assert(typeof exported.enter.lt === 'function', 'preload 没注册 onPluginEnter')
    exported.enter.lt({
      code: 'rq-send-files',
      type: 'files',
      payload: [{ isFile: true, isDirectory: false, name: '载荷文件·demo.bin', path: payloadPath }],
      from: 'panel'
    })
    const state = ltEnv.RQ.panel.state
    assert(state.entry, '没有读到文件')
    assert(state.entry.bytes.length === payloadBytes.length, '读到的字节数不对：' + state.entry.bytes.length)
    for (let i = 0; i < 32; i++) assert(state.entry.bytes[i] === payloadBytes[i], '第 ' + i + ' 字节不符')

    const descriptor = state.descriptor
    assert(descriptor, '没有算出描述符')
    assert(descriptor.totalBytes === payloadBytes.length, 'totalBytes 不对：' + descriptor.totalBytes)
    assert(descriptor.name === '载荷文件·demo.bin', 'name 不对：' + descriptor.name)

    // 无内核时面板用真实 sender 做探针，描述符必须与它完全一致
    const real = ltEnv.OTP.codecs.createSender(descriptor.mode, {
      data: payloadBytes,
      name: descriptor.name,
      sessionId: descriptor.sessionId,
      symbolSize: descriptor.symbolSize
    })
    assert(descriptor.totalSymbols === real.descriptor.totalSymbols, `totalSymbols 不一致：${descriptor.totalSymbols} != ${real.descriptor.totalSymbols}`)
    assert(descriptor.blockCount === real.descriptor.blockCount, 'blockCount 不一致')
    assert(descriptor.symbolSize === real.descriptor.symbolSize, 'symbolSize 不一致')
    assert(descriptor.sessionId === real.descriptor.sessionId, 'sessionId 不一致')
    assert(descriptor.mode === ltEnv.OTP.protocol.MODE_RAPTORQ, '默认模式应当是招牌的 RaptorQ')
    assert(!descriptor.extra || descriptor.extra.length === 0, '回退时描述符不该带 OTI')
    return `${descriptor.totalBytes}B → ${descriptor.totalSymbols} 符号 / ${descriptor.blockCount} 块`
  })

  await check('面板给出「码太密」的可见警告（走 OTP.codecs.scanHint）', () => {
    const panel = ltEnv.registry.panel
    assert(panel.textContent.indexOf('QR 版本') >= 0, '缺少 QR 版本行')
    assert(panel.textContent.indexOf('px/模块') >= 0, '缺少每模块像素')
    ltEnv.RQ.panel.state.displays = [
      { id: 1, primary: true, label: '小屏', bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 }
    ]
    ltEnv.RQ.panel.setOption('multiQr', '4')
    ltEnv.RQ.panel.setOption('symbolSize', '1400')
    const analysis = ltEnv.RQ.panel.state.analysis
    assert(analysis.scan.ok === false, '小屏 4 码 1400B 应当判为不可扫，实际 ok=' + analysis.scan.ok)
    const warns = findAll(ltEnv.registry.panel, (n) => String(n.className).indexOf('warn') >= 0)
    assert(warns.length > 0, '没有渲染出警告')
    assert(warns[0].textContent.indexOf('码太密') >= 0, '警告文案不对：' + warns[0].textContent)
    return `每码 ${analysis.scan.perSlotPx}px → ${analysis.scan.pxPerModule.toFixed(2)} px/模块`
  })

  await check('点击「开始发送」把参数与字节交给码窗', () => {
    ltEnv.RQ.panel.setOption('symbolSize', '1400')
    ltEnv.RQ.panel.setOption('multiQr', '1')
    const btn = findByText(ltEnv.registry.panel, '开始发送（全屏码窗）')
    assert(btn, '找不到开始发送按钮')
    assert(btn.disabled === false, '选了文件后按钮不该禁用')
    btn.click()
    const payload = exported.sender.lt
    assert(payload, '没有调用 openSenderWindow')
    assert(payload.name === '载荷文件·demo.bin', 'name 没传对：' + payload.name)
    assert(payload.bytes.length === payloadBytes.length, 'bytes 没传对')
    assert(payload.symbolSize === 1400, 'symbolSize 没传对')
    assert(payload.multiQr === 1, 'multiQr 没传对')
    assert(payload.mode === ltEnv.OTP.protocol.MODE_RAPTORQ, 'mode 没传对')
    return `${payload.multiQr} 码 / ${payload.symbolSize}B`
  })

  /* ---------------------------------------------------------------------- */
  console.log('\n=== 2. 主面板（有 wasm → 如实上报 + OTI） ===')
  /* ---------------------------------------------------------------------- */

  await check('有内核时徽标显示 WASM 且写明 ABI/大小', () => {
    const badge = env.registry['rq-backend']
    assert(badge.textContent === 'WASM', '徽标应为 WASM，实际 ' + badge.textContent)
    assert(badge.className.indexOf('badge--ok') >= 0, '就绪时应当是成功色：' + badge.className)
    const detail = env.RQ.settings.backendInfo().detail
    assert(detail.indexOf('ABI v1') >= 0, '详情应包含 ABI 版本：' + detail)
    return detail
  })

  await check('WASM 面板：描述符带 12 字节 OTI，且写明对端也需要内核', () => {
    // 直接驱动 WASM 沙箱的面板（它的 enter 回调注册在 exported.enter.wasm）
    env.RQ.panel.loadFile({ name: '载荷文件·demo.bin', path: payloadPath, size: payloadBytes.length, isDirectory: false })
    const state = env.RQ.panel.state
    assert(state.entry, '没有读到文件')
    const descriptor = state.descriptor
    assert(descriptor, '没有描述符')
    assert(descriptor.extra && descriptor.extra.length === 12, 'WASM 流必须带 12 字节 OTI，实际 ' + (descriptor.extra || []).length)
    assert(descriptor.symbolSize === 1400, 'symbolSize 应被内核实为 1400，实际 ' + descriptor.symbolSize)
    assert(descriptor.totalSymbols >= 3, 'totalSymbols 异常：' + descriptor.totalSymbols)
    assert(state.analysis.estimatedPlan === false, 'WASM 下应当用真实 sender 的 plan，而不是预测')
    const text = env.registry.panel.textContent
    assert(text.indexOf('带 12B OTI') >= 0, '界面没有写明描述符带 OTI')
    assert(text.indexOf('RaptorQ WASM 流') >= 0, '界面没有写明这是 WASM 流')
    assert(text.indexOf('内核实测') >= 0, '应当标明参数来自内核实测')
    return `${descriptor.totalSymbols} 符号 / symbolSize=${descriptor.symbolSize} / OTI ${descriptor.extra.length}B`
  })

  /* ---------------------------------------------------------------------- */
  console.log('\n=== 3. WASM 缺失时的诚实性 ===')
  /* ---------------------------------------------------------------------- */

  await check('缺 vendor 时加载器如实记录原因，且一切照常工作', () => {
    const script = ltEnv.vendorScript()
    assert(script, 'raptorq-core.js 没有去尝试加载 vendor 脚本')
    assert(script.src === 'vendor/raptorq.core.js', '加载的路径不对：' + script.src)
    script.onerror() // 模拟"文件不存在"
    const loaderStatus = ltEnv.OTP.raptorqLoader.status()
    assert(loaderStatus.available === false, '不该可用')
    assert(loaderStatus.error.indexOf('未找到') >= 0, '应当记录失败原因：' + loaderStatus.error)
    assert(ltEnv.OTP.codecs.raptorqAvailable() === false, 'codecs 也应当认为不可用')
    const sender = ltEnv.OTP.codecs.createSender(ltEnv.OTP.protocol.MODE_RAPTORQ, {
      data: makeData(2000),
      name: 'x',
      sessionId: 1,
      symbolSize: 400
    })
    assert(sender.backend === 'js', 'backend 必须如实报 js，实际 ' + sender.backend)
    return loaderStatus.error
  })

  await check('缺内核 + 带 OTI 的流 → 如实报 Unsupported，绝不静默解成垃圾', () => {
    const protocol = env.OTP.protocol
    const data = makeData(4000)
    // 用有内核的一端造一条真 WASM 流的描述符
    const wasmSender = env.OTP.codecs.createSender(protocol.MODE_RAPTORQ, {
      data: data,
      name: 'oti.bin',
      sessionId: protocol.makeSessionId(data),
      symbolSize: 500
    })
    assert(wasmSender.backend === 'wasm', '前置条件：应当走 wasm')
    const wasmDescriptor = wasmSender.descriptor
    if (wasmSender.free) wasmSender.free()

    // 在无内核的沙箱里收这条流
    const receiver = ltEnv.OTP.codecs.createReceiver(wasmDescriptor)
    assert(receiver.backend === 'unavailable', '应当是 unavailable，实际 ' + receiver.backend)
    assert(String(receiver.error).indexOf('RaptorQ') >= 0, '错误信息应说明原因：' + receiver.error)
    assert(receiver.isComplete === false, '不应声称完成')
    assert(receiver.add(0, 0, new Uint8Array(wasmDescriptor.symbolSize)) === false, '不应接受任何符号')
    assert(receiver.assemble() === null, '不应产出数据')

    // 会话层也要把它暴露给 UI，而不是让进度永远停在 0
    const session = ltEnv.RQ.multiscan.createSession(protocol)
    const decoded = protocol.decodeFrame(protocol.encodeDescriptor(wasmDescriptor))
    session.ingest(decoded)
    assert(session.decoderError().length > 0, '会话应当暴露解码错误')
    assert(session.decoderBackend() === 'unavailable', '会话应当如实报后端')
    assert(session.hasOti() === true, '应当识别出描述符带 OTI')
    return String(receiver.error)
  })

  /* ---------------------------------------------------------------------- */
  console.log('\n=== 4. 三种模式的内存往返 ===')
  /* ---------------------------------------------------------------------- */

  for (const [label, mode, symbolSize] of [
    ['顺序分片', env.OTP.protocol.MODE_SEQUENTIAL, 200],
    ['LT 喷泉码', env.OTP.protocol.MODE_FOUNTAIN, 400],
    ['RaptorQ（真 WASM）', env.OTP.protocol.MODE_RAPTORQ, 400]
  ]) {
    await check(`${label}：内存往返（丢帧 1/7）`, () => {
      const r = memoryRoundTrip(env.OTP.codecs, env.OTP.protocol, mode, 3000, symbolSize, 7)
      const expected = label.indexOf('RaptorQ') >= 0 ? 'wasm' : 'js'
      assert(r.backend === expected, `${label} 后端应为 ${expected}，实际 ${r.backend}`)
      return `${r.symbols} 符号 / 播放 ${r.frames} 帧 / 后端 ${r.backend}`
    })
  }

  /* ---------------------------------------------------------------------- */
  console.log('\n=== 5. 经过真实 QR 像素的往返 ===')
  /* ---------------------------------------------------------------------- */

  await check('RaptorQ(WASM)：2.4KB 过真实 QR 像素，OTI 也一起过（丢帧 1/5）', () => {
    const r = pixelRoundTrip(env.OTP.codecs, env.OTP.protocol, env.OTP.qr, env.OTP.scan, env.OTP.protocol.MODE_RAPTORQ, 2400, 200, 5, 'L')
    assert(r.backend === 'wasm', '应当走 wasm，实际 ' + r.backend)
    assert(r.otiBytes === 12, '描述符应带回 12 字节 OTI，实际 ' + r.otiBytes)
    return `v${r.version} / ${r.px}px / 播放 ${r.frames} 帧 / OTI ${r.otiBytes}B`
  })

  await check('顺序分片 + LT 喷泉码也能过真实 QR 像素', () => {
    const a = pixelRoundTrip(env.OTP.codecs, env.OTP.protocol, env.OTP.qr, env.OTP.scan, env.OTP.protocol.MODE_SEQUENTIAL, 1200, 200, 0, 'L')
    const b = pixelRoundTrip(env.OTP.codecs, env.OTP.protocol, env.OTP.qr, env.OTP.scan, env.OTP.protocol.MODE_FOUNTAIN, 1200, 200, 0, 'L')
    assert(a.backend === 'js' && b.backend === 'js', '这两种模式应当走 JS')
    return `顺序播放 ${a.frames} 帧 / LT 播放 ${b.frames} 帧（描述符都不带 OTI）`
  })

  await check('描述符能被像素链路的接收端独立解析（mode 决定解码器）', () => {
    const protocol = env.OTP.protocol
    const codecs = env.OTP.codecs
    const data = makeData(1500, 9)
    const sessionId = protocol.makeSessionId(data)
    for (const mode of [protocol.MODE_SEQUENTIAL, protocol.MODE_FOUNTAIN, protocol.MODE_RAPTORQ]) {
      const sender = codecs.createSender(mode, { data: data, name: 'x.bin', sessionId: sessionId, symbolSize: 300 })
      const version = env.RQ.settings.fixedVersionFor(sender, 'L').version
      const frame = protocol.encodeDescriptor(sender.descriptor)
      const img = env.OTP.qr.toImageData(env.OTP.qr.encode(frame, 'L', version), { scale: 3, quiet: 4 })
      const back = env.OTP.scan.decodeFrameFromImage(protocol, img.data, img.width, img.height)
      assert(back && back.mode === mode, 'mode 没还原：' + (back && back.mode))
      assert(protocol.modeName(back.mode) === protocol.modeName(mode), 'modeName 不一致')
      const receiver = codecs.createReceiver(back)
      assert(!receiver.error, '接收端报错：' + receiver.error)
      if (sender.free) sender.free()
    }
    return '三种模式的描述符都能过像素并被正确识别'
  })

  /* ---------------------------------------------------------------------- */
  console.log('\n=== 6. 固定 QR 版本 ===')
  /* ---------------------------------------------------------------------- */

  await check('所有帧（含带 OTI 的描述符）QR 模块数与像素尺寸完全一致', () => {
    const protocol = env.OTP.protocol
    const qr = env.OTP.qr
    const data = makeData(8000, 5)
    const sessionId = protocol.makeSessionId(data)
    const sender = env.OTP.codecs.createSender(protocol.MODE_RAPTORQ, {
      data: data,
      name: '一致.bin',
      sessionId: sessionId,
      symbolSize: 1400
    })
    const versionInfo = env.RQ.settings.fixedVersionFor(sender, 'L')
    const version = versionInfo.version
    assert(version === qr.versionFor(sender.frameLength, 'L'), '数据帧本来就装得下时，版本应当等于数据帧版本')

    const rows = []
    const descFrame = protocol.encodeDescriptor(sender.descriptor)
    assert(descFrame.length < sender.frameLength, '描述符应当比数据帧短')
    const descMatrix = qr.encode(descFrame, 'L', version)
    const descImg = qr.toImageData(descMatrix, { scale: 3, quiet: 4 })
    rows.push({ what: 'descriptor', version: descMatrix.version, modules: descMatrix.moduleCount, px: descImg.width, len: descFrame.length })

    for (const index of [0, 1, 2, 7, 63, 1000]) {
      const coord = sender.frameCoord(index)
      const frame = protocol.encodeDataFrame(sessionId, coord.blockIndex, coord.esi, sender.symbol(coord.blockIndex, coord.esi))
      assert(frame.length === sender.frameLength, '数据帧长不一致')
      const matrix = qr.encode(frame, 'L', version)
      const img = qr.toImageData(matrix, { scale: 3, quiet: 4 })
      rows.push({ what: 'data@' + index, version: matrix.version, modules: matrix.moduleCount, px: img.width, len: frame.length })
    }

    const first = rows[0]
    rows.forEach((row) => {
      assert(row.version === first.version, `${row.what} 版本不一致：${row.version} != ${first.version}`)
      assert(row.modules === first.modules, `${row.what} 模块数不一致：${row.modules} != ${first.modules}`)
      assert(row.px === first.px, `${row.what} 像素尺寸不一致：${row.px} != ${first.px}`)
    })
    if (sender.free) sender.free()
    return `v${first.version} / ${first.modules}×${first.modules} / ${first.px}px（描述符 ${rows[0].len}B 带 OTI，数据帧 ${rows[1].len}B）`
  })

  await check('切片极小时：固定版本取描述符与数据帧的大值，仍然一致', () => {
    const protocol = env.OTP.protocol
    const qr = env.OTP.qr
    // 故意用小切片 + 长文件名，让描述符帧比数据帧还长
    const data = makeData(400, 12)
    const sender = env.OTP.codecs.createSender(protocol.MODE_FOUNTAIN, {
      data: data,
      name: '一个特别长的中文文件名用来把描述符帧撑长.bin',
      sessionId: 5,
      symbolSize: 48
    })
    const descFrame = protocol.encodeDescriptor(sender.descriptor)
    assert(descFrame.length > sender.frameLength, `用例没构造成功：描述符 ${descFrame.length}B 应当大于数据帧 ${sender.frameLength}B`)

    const info = env.RQ.settings.fixedVersionFor(sender, 'L')
    assert(info.descriptorVersion > info.dataVersion, '描述符应当需要更高版本')
    assert(info.version === info.descriptorVersion, '固定版本应当取大值')
    // 两个都真的能编码出来，且尺寸一致
    const a = qr.toImageData(qr.encode(descFrame, 'L', info.version), { scale: 3, quiet: 4 })
    const coord = sender.frameCoord(0)
    const dataFrame = protocol.encodeDataFrame(5, coord.blockIndex, coord.esi, sender.symbol(coord.blockIndex, coord.esi))
    const b = qr.toImageData(qr.encode(dataFrame, 'L', info.version), { scale: 3, quiet: 4 })
    assert(a.width === b.width, `像素尺寸不一致：${a.width} != ${b.width}`)
    return `数据帧 v${info.dataVersion} / 描述符 v${info.descriptorVersion} → 固定 v${info.version}，都是 ${a.width}px`
  })

  /* ---------------------------------------------------------------------- */
  console.log('\n=== 7. 参数边界 ===')
  /* ---------------------------------------------------------------------- */

  await check('1 字节文件（三种模式）', () => {
    const protocol = env.OTP.protocol
    const notes = []
    for (const [label, mode] of [
      ['顺序', protocol.MODE_SEQUENTIAL],
      ['LT', protocol.MODE_FOUNTAIN],
      ['RaptorQ', protocol.MODE_RAPTORQ]
    ]) {
      const data = new Uint8Array([0x5a])
      const sender = env.OTP.codecs.createSender(mode, {
        data: data,
        name: 'one.bin',
        sessionId: protocol.makeSessionId(data),
        symbolSize: 1400
      })
      assert(sender.descriptor.totalSymbols === 1, label + ' 应当是 1 个符号，实际 ' + sender.descriptor.totalSymbols)
      const receiver = env.OTP.codecs.createReceiver(sender.descriptor)
      assert(!receiver.error, label + ' 接收端报错：' + receiver.error)
      let index = 0
      while (!receiver.isComplete) {
        const coord = sender.frameCoord(index)
        receiver.add(coord.blockIndex, coord.esi, sender.symbol(coord.blockIndex, coord.esi))
        index++
        if (index > 200) throw new Error(label + ' 未收敛')
      }
      const out = receiver.assemble()
      assert(out && out.length === 1 && out[0] === 0x5a, label + ' 还原失败')
      if (sender.free) sender.free()
      notes.push(label + '=1符号')
    }
    return notes.join(' ')
  })

  await check('非整除切片：1501B / 500B → 4 个符号，尾部补零', () => {
    const protocol = env.OTP.protocol
    const data = makeData(1501, 11)
    const sender = env.OTP.codecs.createSender(protocol.MODE_FOUNTAIN, {
      data: data,
      name: 'tail.bin',
      sessionId: 7,
      symbolSize: 500
    })
    assert(sender.descriptor.totalSymbols === 4, '应为 4 个符号，实际 ' + sender.descriptor.totalSymbols)
    const last = sender.symbol(0, 3)
    assert(last.length === 500, '最后一帧也必须 500 字节（补零）')
    assert(last[0] === data[1500], '最后一个字节应是源数据的第 1501 字节')
    assert(last[1] === 0 && last[499] === 0, '尾部应当补零')
    const r = memoryRoundTrip(env.OTP.codecs, protocol, protocol.MODE_FOUNTAIN, 1501, 500, 0)
    return `${r.symbols} 符号 / ${r.frames} 帧`
  })

  await check('超大切片：钳到 QR v40 上限并仍然能过像素', () => {
    const protocol = env.OTP.protocol
    const qr = env.OTP.qr
    const max = env.RQ.settings.maxSymbolSize()
    assert(max === protocol.MAX_FRAME_BYTES - protocol.DATA_HEADER_BYTES - 4, '上限推导不对：' + max)
    assert(env.RQ.settings.clampSymbolSize(max + 9999) === max, '超上限没有被钳住')
    const sender = env.OTP.codecs.createSender(protocol.MODE_FOUNTAIN, {
      data: makeData(3000, 3),
      name: 'big.bin',
      sessionId: 3,
      symbolSize: max
    })
    assert(sender.frameLength === protocol.MAX_FRAME_BYTES, '帧长应当刚好顶到上限：' + sender.frameLength)
    const version = qr.versionFor(sender.frameLength, 'L')
    assert(version === 40, '应当是 v40，实际 v' + version)

    const payload = sender.symbol(0, 0)
    const frame = protocol.encodeDataFrame(3, 0, 0, payload)
    const matrix = qr.encode(frame, 'L', version)
    assert(matrix.moduleCount === 177, 'v40 应为 177 模块，实际 ' + matrix.moduleCount)
    const img = qr.toImageData(matrix, { scale: 3, quiet: 4 })
    const back = env.OTP.scan.decodeFrameFromImage(protocol, img.data, img.width, img.height)
    assert(back, 'v40 帧没能过像素链路')
    for (let i = 0; i < payload.length; i++) assert(back.payload[i] === payload[i], '第 ' + i + ' 字节不符')
    return `切片上限 ${max}B → 帧长 ${protocol.MAX_FRAME_BYTES}B / v40 / ${img.width}px`
  })

  await check('无内核时的分块预测与真实 createSender 一致（守住镜像常量）', () => {
    const protocol = ltEnv.OTP.protocol
    const codecs = ltEnv.OTP.codecs
    const cases = [
      [protocol.MODE_SEQUENTIAL, 400],
      [protocol.MODE_SEQUENTIAL, 1400],
      [protocol.MODE_FOUNTAIN, 400],
      [protocol.MODE_RAPTORQ, 1400],
      [protocol.MODE_FOUNTAIN, 200]
    ]
    const sizes = [1, 400, 401, 400 * 1024, 1400 * 1025, 1400 * 3000 + 7]
    let compared = 0
    for (const [mode, symbolSize] of cases) {
      for (const bytes of sizes) {
        const data = new Uint8Array(bytes)
        const real = codecs.createSender(mode, { data: data, name: 'x', sessionId: 1, symbolSize: symbolSize })
        assert(real.backend === 'js', '这个沙箱应当没有 wasm')
        const analysis = ltEnv.RQ.settings.analyze({ bytes: bytes, mode: mode, symbolSize: symbolSize, ecc: 'L', multiQr: 1, fps: 30, redundancy: 5 })
        assert(analysis.estimatedPlan === true, '没给 sender 时应当是预测')
        assert(
          analysis.plan.totalSymbols === real.descriptor.totalSymbols,
          `totalSymbols 预测不符（${protocol.modeName(mode)}/${symbolSize}B/${bytes}B）：${analysis.plan.totalSymbols} != ${real.descriptor.totalSymbols}`
        )
        assert(
          analysis.plan.blockCount === real.descriptor.blockCount,
          `blockCount 预测不符（${protocol.modeName(mode)}/${symbolSize}B/${bytes}B）：${analysis.plan.blockCount} != ${real.descriptor.blockCount}`
        )
        compared += 2
      }
    }
    return `${compared} 项预测全部命中`
  })

  await check('顺序模式的并行码数按分片数收窄', () => {
    const protocol = env.OTP.protocol
    const s = env.RQ.settings
    assert(s.effectiveMultiQr(protocol.MODE_SEQUENTIAL, 4, 2) === 2, '只有 2 个分片时应当收窄到 2')
    assert(s.effectiveMultiQr(protocol.MODE_SEQUENTIAL, 4, 4) === 4, '有 4 个分片时应当保持 4')
    assert(s.effectiveMultiQr(protocol.MODE_SEQUENTIAL, 4, 100) === 4, '分片够多时应当保持 4')
    assert(s.effectiveMultiQr(protocol.MODE_FOUNTAIN, 4, 1) === 4, '喷泉码的 esi 无限增长，不该收窄')
    assert(s.effectiveMultiQr(protocol.MODE_RAPTORQ, 4, 1) === 4, 'RaptorQ 同理')
    return '2→2 / 4→4 / 100→4 / 喷泉→4 / RaptorQ→4'
  })

  /* ---------------------------------------------------------------------- */
  console.log('\n=== 8. 多码并行（招牌） ===')
  /* ---------------------------------------------------------------------- */

  await check('布局：1 / 2 / 4 码的码位互不重叠且在画布内', () => {
    const layout = env.RQ.layout
    const notes = []
    for (const multiQr of [1, 2, 4]) {
      for (const [w, h] of [
        [1600, 960],
        [2560, 1440],
        [1280, 720],
        [800, 600]
      ]) {
        const computed = layout.compute(multiQr, w, h, { hudHeight: layout.hudFor(h) })
        assert(computed.boxes.length === multiQr, multiQr + ' 码应当有 ' + multiQr + ' 个码位')
        assert(layout.hasOverlap(computed) === false, `${multiQr} 码在 ${w}×${h} 下有重叠`)
        assert(computed.cols === (multiQr === 1 ? 1 : 2), '列数不对')
        assert(computed.rows === (multiQr <= 2 ? 1 : 2), '行数不对')
        computed.boxes.forEach((box) => {
          assert(box.x >= 0 && box.y >= computed.hudHeight, `${multiQr} 码码位跑进 HUD 了：y=${box.y} hud=${computed.hudHeight}`)
          assert(box.x + box.size <= w, '码位超出画布右边界')
          assert(box.y + box.size <= h, '码位超出画布下边界')
          assert(box.size > 0, '码位尺寸应当为正')
        })
      }
      notes.push(multiQr + '码')
    }
    const two = layout.compute(2, 1600, 960, {})
    assert(two.boxes[0].row === two.boxes[1].row, '2 码应当横排')
    assert(two.boxes[0].col !== two.boxes[1].col, '2 码应当分列')
    const four = layout.compute(4, 1600, 960, {})
    assert(four.boxes[0].row === 0 && four.boxes[1].row === 0 && four.boxes[2].row === 1 && four.boxes[3].row === 1, '4 码应当两行')
    return notes.join(' / ') + '，边界与不重叠均通过'
  })

  /**
   * 招牌用例：N 个码位同屏 → 真像素 → 分区识别 → 每个码位各自独立解出
   * 画布尺寸模拟真实显示器（HUD 在画布上方），走的是 sender.ts 的同一套几何。
   */
  function multiQrPixelTest(multiQr, useWasm) {
    const source = useWasm ? env : ltEnv
    const width = 1600
    const height = 960
    const hud = source.RQ.layout.hudFor(height)
    const ecc = 'L'
    const data = makeData(6000, 2024)
    const protocol = source.OTP.protocol

    const sender = source.OTP.codecs.createSender(protocol.MODE_RAPTORQ, {
      data: data,
      name: '多码.bin',
      sessionId: protocol.makeSessionId(data),
      symbolSize: 200
    })
    const version = source.RQ.settings.fixedVersionFor(sender, ecc).version
    const symbolSize = sender.descriptor.symbolSize

    // 整个"窗口"= 1600×960，HUD 占顶部一条；码画在 HUD 下方
    const canvas = createRecordingCanvas(width, height)
    const ctx = canvas.getContext('2d', { alpha: false })
    const layout = source.RQ.layout.compute(multiQr, width, height, { hudHeight: hud })

    const tickData = source.RQ.player.encodeTick(sender, { ecc: ecc, version: version, multiQr: multiQr }, 0)
    assert(tickData.matrices.length === multiQr, '应当编码出 ' + multiQr + ' 个 QR 矩阵')

    const coordKeys = tickData.coords.map((c) => c.blockIndex + ':' + c.esi)
    assert(new Set(coordKeys).size === multiQr, '同屏出现了重复的符号坐标：' + coordKeys.join(','))

    ctx.fillStyle = '#0b0b0f'
    ctx.fillRect(0, 0, width, hud)
    const drawn = source.RQ.player.drawTick(ctx, layout, tickData, {})
    assert(drawn.length === multiQr, '实际画出来的码数不对：' + drawn.length)

    for (let i = 0; i < drawn.length; i++) {
      const a = drawn[i].rect
      assert(a.size > 0, '码位 ' + i + ' 没画出东西')
      assert(a.y >= hud, '码位 ' + i + ' 压到 HUD 上了')
      for (let j = i + 1; j < drawn.length; j++) {
        const b = drawn[j].rect
        const overlap = a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size
        assert(!overlap, `码位 ${i} 与 ${j} 的实际绘制区域重叠了`)
      }
    }

    const imageData = canvas.asImageData()
    const result = source.RQ.multiscan.scanRegions(protocol, imageData, { multiQr: multiQr })
    assert(result.frames.length === multiQr, `应当识别出 ${multiQr} 个帧，实际 ${result.frames.length}`)

    const found = result.frames.map((f) => f.blockIndex + ':' + f.esi).sort()
    assert(found.join(',') === coordKeys.slice().sort().join(','), '识别出的符号与画出来的不一致：' + found.join(',') + ' vs ' + coordKeys.join(','))

    const receiver = source.OTP.codecs.createReceiver(sender.descriptor)
    assert(!receiver.error, '接收端报错：' + receiver.error)
    const before = receiver.received
    result.frames.forEach((f) => receiver.add(f.blockIndex, f.esi, f.payload))
    assert(receiver.received > before, '识别出的符号没有被接收端接受')

    const scanner = source.RQ.multiscan.createScanner(protocol, { multiQr: multiQr })
    const again = scanner.scan(imageData)
    assert(again.frames.length === multiQr, '粘性扫描器没能稳定识别 ' + multiQr + ' 个码')

    if (sender.free) sender.free()
    return {
      version: version,
      symbolSize: symbolSize,
      backend: sender.backend,
      drawnRects: drawn.map((d) => d.rect.size).join('/'),
      box: layout.boxSize,
      coords: coordKeys.join(' '),
      accepted: receiver.received - before,
      needed: receiver.needed
    }
  }

  await check('多码并行：4 个码位互不重叠且各自被独立识别（真 QR 像素 / WASM）', () => {
    const r = multiQrPixelTest(4, true)
    assert(r.backend === 'wasm', '应当走 wasm，实际 ' + r.backend)
    return `v${r.version} / 切片 ${r.symbolSize}B / 码位 ${r.box}px / 实测绘制 ${r.drawnRects} / 坐标 ${r.coords}`
  })

  await check('多码并行：2 码横排同样能各自独立识别', () => {
    const r = multiQrPixelTest(2, true)
    return `v${r.version} / 码位 ${r.box}px / 实测绘制 ${r.drawnRects}`
  })

  await check('多码并行：每个码位都能推进解码（一次扫描摄入 4 个符号）', () => {
    const r = multiQrPixelTest(4, true)
    assert(r.accepted === 4, `一次扫描应当摄入 4 个符号，实际 ${r.accepted}`)
    return `一次扫描摄入 ${r.accepted}/${r.needed} 个符号`
  })

  await check('多码并行在无内核的 LT 回退路径上同样成立', () => {
    const r = multiQrPixelTest(4, false)
    assert(r.backend === 'js', '应当走 JS 回退，实际 ' + r.backend)
    return `v${r.version} / 坐标 ${r.coords}`
  })

  /* ---------------------------------------------------------------------- */
  console.log('\n=== 9. 码窗（sender） ===')
  /* ---------------------------------------------------------------------- */

  const senderEnv = createSandbox({
    withSender: true,
    withVendorCore: true,
    ids: ['code-canvas', 'hud-name', 'hud-meta', 'hud-stats', 'hud-backend', 'hud-warn'],
    canvasIds: ['code-canvas'],
    width: 1600,
    height: 960,
    bridge: makeBridge('sender', {
      getStartPayload() {
        return {
          name: '码窗.bin',
          bytes: makeData(9000, 55),
          mode: env.OTP.protocol.MODE_RAPTORQ,
          symbolSize: 400,
          fps: 60,
          ecc: 'L',
          multiQr: 4,
          redundancy: 5
        }
      },
      close() {},
      sendToParent() {}
    })
  })

  await check('码窗用真 wasm，HUD 如实显示后端与 OTI', async () => {
    await primeCore(senderEnv)
    const stats = senderEnv.RQ.sender.stats()
    assert(stats, '码窗没有创建 player')
    assert(stats.multiQr === 4, '并行码数不对：' + stats.multiQr)
    assert(stats.backend === 'wasm', '有内核时后端应为 wasm，实际 ' + stats.backend)
    assert(stats.produced > 0, 'warmup 没有产出任何 tick')
    assert(senderEnv.registry['hud-backend'].textContent === 'WASM', 'HUD 后端徽标不诚实')
    assert(senderEnv.registry['hud-meta'].textContent.indexOf('OTI 流') >= 0, 'HUD 没有说明这是 OTI 流')
    return `后端 ${stats.backend} / 并行 ${stats.multiQr} 码`
  })

  await check('码窗开局连播描述符，之后数据 tick 连续推进', () => {
    const senderApi = senderEnv.RQ.sender
    const t0 = senderApi.produceTick(0)
    const t1 = senderApi.produceTick(1)
    const t2 = senderApi.produceTick(2)
    assert(t0.descriptor === true && t1.descriptor === true && t2.descriptor === true, '开局 3 个 tick 都应当是描述符帧')

    const dataTicks = []
    for (let i = 3; i < 70 && dataTicks.length < 4; i++) {
      const t = senderApi.produceTick(i)
      if (!t.descriptor) dataTicks.push({ index: i, tick: t })
    }
    assert(dataTicks.length === 4, '取样到的数据 tick 不够：' + dataTicks.length)

    dataTicks.forEach((entry) => {
      const esis = entry.tick.coords.map((c) => c.esi)
      assert(esis.length === 4, '一个 tick 应当有 4 个码位，实际 ' + esis.length)
      assert(new Set(esis).size === 4, `tick ${entry.index} 的 4 个码位应当播不同符号：` + esis.join(','))
      assert(entry.tick.matrices.length === 4, '一个 tick 应当编码出 4 个 QR 矩阵')
    })

    for (let i = 1; i < dataTicks.length; i++) {
      const prev = dataTicks[i - 1]
      const cur = dataTicks[i]
      if (cur.index - prev.index !== 1) continue
      prev.tick.coords.forEach((coord, slot) => {
        assert(cur.tick.coords[slot].esi === coord.esi + 4, `码位 ${slot} 的 esi 推进不对：${coord.esi} → ${cur.tick.coords[slot].esi}`)
      })
    }

    let sawDescriptorAgain = false
    for (let i = 5; i < 40; i++) if (senderApi.produceTick(i).descriptor) sawDescriptorAgain = true
    assert(sawDescriptorAgain, '之后再没有插播过描述符帧')

    const hudMeta = senderEnv.registry['hud-meta'].textContent
    assert(hudMeta.indexOf('4 码并行') >= 0, 'HUD 没有显示并行码数：' + hudMeta)
    return `首帧描述符 / 数据 tick ${dataTicks[0].tick.coords.map((c) => c.esi).join(',')}`
  })

  await check('码窗画出的描述符 tick 能被扫描还原（含 OTI）', () => {
    const RQs = senderEnv.RQ
    const layout = RQs.sender.layout()
    assert(layout, '码窗没有布局')
    assert(layout.multiQr === 4, '码窗布局应当是 4 码，实际 ' + layout.multiQr)
    const canvas = senderEnv.registry['code-canvas']
    const ctx = canvas.getContext('2d', { alpha: false })
    const tickData = RQs.sender.produceTick(0)
    assert(tickData.descriptor === true, '第 0 个 tick 应当是描述符')
    const drawn = RQs.player.drawTick(ctx, layout, tickData, {})
    assert(drawn.length === 4, '描述符 tick 应当画满 4 个码位')

    const imageData = canvas.asImageData()
    const result = RQs.multiscan.scanRegions(senderEnv.OTP.protocol, imageData, { multiQr: 4 })
    assert(result.frames.length >= 1, '码窗画出的描述符一个都没识别出来')
    const frame = result.frames[0]
    assert(frame.type === senderEnv.OTP.protocol.TYPE_DESCRIPTOR, '解出来的不是描述符帧')
    assert(frame.name === '码窗.bin', '描述符里的文件名不对：' + frame.name)
    assert(frame.mode === senderEnv.OTP.protocol.MODE_RAPTORQ, '描述符里的模式不对')
    assert(frame.totalBytes === 9000, '描述符里的长度不对：' + frame.totalBytes)
    assert(frame.extra && frame.extra.length === 12, '描述符应当带 12 字节 OTI')
    return `${frame.name} / ${frame.totalBytes}B / OTI ${frame.extra.length}B / 识别 ${result.frames.length} 个码位`
  })

  /* ---------------------------------------------------------------------- */
  console.log('\n=== 10. 接收会话 ===')
  /* ---------------------------------------------------------------------- */

  await check('接收端：三种模式的描述符都能选对解码器并显示模式名', () => {
    const protocol = env.OTP.protocol
    const codecs = env.OTP.codecs
    const notes = []
    for (const [label, mode] of [
      ['顺序分片', protocol.MODE_SEQUENTIAL],
      ['LT 喷泉码', protocol.MODE_FOUNTAIN],
      ['RaptorQ', protocol.MODE_RAPTORQ]
    ]) {
      const data = makeData(2500, 6)
      const sessionId = protocol.makeSessionId(data)
      const sender = codecs.createSender(mode, { data: data, name: '会话.bin', sessionId: sessionId, symbolSize: 300 })
      const session = env.RQ.multiscan.createSession(protocol)

      const descriptorFrame = protocol.decodeFrame(protocol.encodeDescriptor(sender.descriptor))
      assert(session.ingest(descriptorFrame) === 'descriptor', label + ' 描述符没被接受')
      assert(session.modeName() === protocol.modeName(mode), label + ' 模式名不对：' + session.modeName())
      assert(session.decoderError() === '', label + ' 不该报解码错误：' + session.decoderError())
      assert(session.ingest(descriptorFrame) === 'descriptor-dup', label + ' 重复描述符应当被识别')

      let index = 0
      while (!session.isComplete()) {
        const coord = sender.frameCoord(index)
        const frame = protocol.decodeFrame(
          protocol.encodeDataFrame(sessionId, coord.blockIndex, coord.esi, sender.symbol(coord.blockIndex, coord.esi))
        )
        session.ingest(frame)
        index++
        if (index > 60000) throw new Error(label + ' 未收敛')
      }
      const out = session.assemble()
      assert(out && out.length === data.length, label + ' 组装失败')
      for (let i = 0; i < data.length; i++) assert(out[i] === data[i], label + ' 第 ' + i + ' 字节不符')
      const expectedBackend = label === 'RaptorQ' ? 'wasm' : 'js'
      assert(session.decoderBackend() === expectedBackend, label + ' 后端应为 ' + expectedBackend + '，实际 ' + session.decoderBackend())
      if (sender.free) sender.free()
      notes.push(label + '(' + session.modeName() + '/' + session.decoderBackend() + ')')
    }
    return notes.join(' / ')
  })

  await check('接收端：换一轮传输会重置，上一轮的残留帧被判 stale', () => {
    const protocol = env.OTP.protocol
    const session = env.RQ.multiscan.createSession(protocol)

    const a = makeData(1200, 21)
    const senderA = env.OTP.codecs.createSender(protocol.MODE_FOUNTAIN, {
      data: a,
      name: 'a.bin',
      sessionId: protocol.makeSessionId(a),
      symbolSize: 300
    })
    session.ingest(protocol.decodeFrame(protocol.encodeDescriptor(senderA.descriptor)))
    const coordA = senderA.frameCoord(0)
    const frameA = protocol.decodeFrame(
      protocol.encodeDataFrame(senderA.descriptor.sessionId, coordA.blockIndex, coordA.esi, senderA.symbol(coordA.blockIndex, coordA.esi))
    )
    assert(session.ingest(frameA) === 'accepted', '第一轮的帧应当被接受')

    const b = makeData(1200, 22)
    const senderB = env.OTP.codecs.createSender(protocol.MODE_FOUNTAIN, {
      data: b,
      name: 'b.bin',
      sessionId: protocol.makeSessionId(b),
      symbolSize: 300
    })
    session.ingest(protocol.decodeFrame(protocol.encodeDescriptor(senderB.descriptor)))
    assert(session.stats().resets === 1, '换轮次应当重置一次，实际 ' + session.stats().resets)
    assert(session.ingest(frameA) === 'stale', '上一轮的帧应当被判为 stale')
    assert(session.descriptor().name === 'b.bin', '描述符没有换成新的')
    return '重置 1 次，旧帧 1 个被丢弃'
  })

  await check('接收端：没有描述符时数据帧不会被误收', () => {
    const protocol = env.OTP.protocol
    const session = env.RQ.multiscan.createSession(protocol)
    const sender = env.OTP.codecs.createSender(protocol.MODE_FOUNTAIN, { data: makeData(600, 31), name: 'x', sessionId: 5, symbolSize: 300 })
    const coord = sender.frameCoord(0)
    const frame = protocol.decodeFrame(protocol.encodeDataFrame(5, coord.blockIndex, coord.esi, sender.symbol(coord.blockIndex, coord.esi)))
    assert(session.ingest(frame) === 'no-descriptor', '没有描述符时应当拒收')
    assert(session.progress() === 0, '进度应当还是 0')
  })

  /* ---------------------------------------------------------------------- */
  console.log('\n=== 11. 分发完整性 ===')
  /* ---------------------------------------------------------------------- */

  await check('core/ 与 vendor/ 与共享核心逐字节一致（dist 与插件根都要）', () => {
    let count = 0
    for (const dir of ['core', 'vendor']) {
      for (const rel of listFiles(path.join(SHARED, dir))) {
        const sharedFile = path.join(SHARED, dir, rel)
        for (const base of [ROOT, DIST]) {
          const target = path.join(base, dir, rel)
          assert(fs.existsSync(target), `缺少 ${path.relative(ROOT, target)}`)
          const a = fs.readFileSync(sharedFile)
          const b = fs.readFileSync(target)
          assert(a.length === b.length, `${path.relative(ROOT, target)} 长度与共享核心不一致`)
          assert(a.equals(b), `${path.relative(ROOT, target)} 内容与共享核心不一致（共享核心不许改）`)
          count++
        }
      }
    }
    return `${count} 个文件逐字节一致（含 raptorq.core.wasm）`
  })

  await check('HTML 里没有 CSP meta（否则本地协议下白屏）', () => {
    const htmls = listFiles(DIST).filter((f) => f.endsWith('.html'))
    assert(htmls.length >= 3, '应当有 3 个 html，实际 ' + htmls.length)
    htmls.forEach((rel) => {
      const html = fs.readFileSync(path.join(DIST, rel), 'utf8')
      assert(!/content-security-policy/i.test(html), rel + ' 里有 CSP meta')
    })
    return htmls.join(' / ')
  })

  await check('HTML 引用完整，且三个页面都引入了 vendor/raptorq.core.js', () => {
    const htmls = listFiles(DIST).filter((f) => f.endsWith('.html'))
    htmls.forEach((rel) => {
      const html = fs.readFileSync(path.join(DIST, rel), 'utf8')
      const refs = []
      const re = /(?:src|href)\s*=\s*"([^"]+)"/g
      let m
      while ((m = re.exec(html))) if (!/^(https?:|data:|#)/i.test(m[1])) refs.push(m[1])
      assert(refs.length > 0, rel + ' 没有引用任何本地资源')
      refs.forEach((ref) => assert(fs.existsSync(path.join(DIST, ref)), rel + ' 引用了不存在的 ' + ref))

      const scripts = refs.filter((r) => r.endsWith('.js'))
      assert(scripts.indexOf('vendor/raptorq.core.js') >= 0, rel + ' 没有引入 vendor/raptorq.core.js（收/发 RaptorQ 流都需要）')
      assert(scripts.indexOf('core/codecs.js') >= 0, rel + ' 没有引入 core/codecs.js')
    })
    return '3 个页面引用完整，且都带 WASM 内核'
  })

  await check('plugin.json 合法且 features[].code 唯一', () => {
    const json = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8'))
    assert(json.main === 'index.html', 'main 必须是 index.html')
    assert(json.logo === 'logo.png', 'logo 不对')
    assert(json.preload === 'preload.js', 'preload 不对')
    assert(fs.existsSync(path.join(DIST, json.logo)), 'logo 文件不存在')
    const codes = json.features.map((f) => f.code)
    assert(new Set(codes).size === codes.length, 'features[].code 有重复：' + codes.join(','))
    assert(codes.join(',') === 'rq-send,rq-receive,rq-send-files', 'feature code 不对：' + codes.join(','))
    assert(json.features[2].cmds[0].type === 'files', '第三个 feature 应当是 files 匹配指令')
    return codes.join(' / ')
  })

  await check('所有 dist 出的 js 都能解析（node --check 等价）', () => {
    const jsFiles = listFiles(DIST).filter((f) => f.endsWith('.js'))
    assert(jsFiles.length >= 12, 'dist js 数量偏少：' + jsFiles.length)
    jsFiles.forEach((rel) => {
      const code = fs.readFileSync(path.join(DIST, rel), 'utf8')
      try {
        new vm.Script(code, { filename: rel })
      } catch (err) {
        throw new Error(rel + ' 语法错误：' + err.message)
      }
    })
    return jsFiles.length + ' 个 js'
  })

  await check('dist 里没有 node_modules / sourcemap / .git', () => {
    listFiles(DIST).forEach((rel) => {
      assert(!rel.endsWith('.js.map'), '有 sourcemap：' + rel)
      assert(rel.split(path.sep).indexOf('node_modules') < 0, '有 node_modules：' + rel)
      assert(rel.split(path.sep).indexOf('.git') < 0, '有 .git：' + rel)
    })
    return '干净'
  })

  fs.rmSync(tmpDir, { recursive: true, force: true })

  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`)
  process.exitCode = fail ? 1 : 0
})()
