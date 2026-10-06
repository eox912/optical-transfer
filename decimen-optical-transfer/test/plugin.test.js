#!/usr/bin/env node
/**
 * test/plugin.test.js —— decimen-optical-transfer 的 Node + 桩 DOM 测试
 *
 * 覆盖规范第 6 节的 6 项，外加 SHA-256 校验失败必须报错、以及
 * "带 OTI 的真 RaptorQ 流" 的诚实降级 / WASM 可用时的完整解码。
 *
 * 做法（沿用第一轮 demo-utools-plugin 验证过的桩写法）：
 *   - 用 CJS 加载 dist/core 与 dist/vendor 里的**共享核心原样代码**；
 *   - 在一个 vm 沙箱里装好桩 DOM / 桩 utools / 假 electron，
 *     然后把 dist/preload.js 与插件自身的 classic script 按 HTML 里的顺序跑起来；
 *   - 于是测试跑的是真实产物，不是另写一份逻辑。
 *
 * 运行：node test/plugin.test.js（退出码非 0 即失败）
 */
'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const nodeCrypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

/* ================================================================== */
/*                        1. 共享核心（原样代码）                       */
/* ================================================================== */

const protocol = require(path.join(DIST, 'core', 'protocol.js'))
const fountain = require(path.join(DIST, 'core', 'fountain.js'))
const qr = require(path.join(DIST, 'core', 'qr.js'))
const scan = require(path.join(DIST, 'core', 'scan.js'))
const codecs = require(path.join(DIST, 'core', 'codecs.js'))
const OTP = { protocol, fountain, qr, scan, codecs }

/* ================================================================== */
/*                            2. 桩 DOM                                */
/* ================================================================== */

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    className: '',
    type: '',
    src: '',
    alt: '',
    title: '',
    value: '',
    selected: false,
    disabled: false,
    hidden: false,
    style: {},
    _text: '',
    listeners: {},
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    },
    addEventListener(type, fn) {
      ;(this.listeners[type] = this.listeners[type] || []).push(fn)
    },
    removeEventListener(type, fn) {
      const list = this.listeners[type] || []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('')
    },
    set textContent(value) {
      this.children.length = 0
      this._text = value == null ? '' : String(value)
    },
    click() {
      ;(this.listeners.click || []).forEach((fn) => fn({ target: this }))
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
  walk(root, (node) => {
    if (predicate(node)) out.push(node)
  })
  return out
}

function findByText(root, text) {
  return findAll(root, (n) => n.className.indexOf('btn') >= 0 && n.textContent === text)[0]
}

/* ================================================================== */
/*                          3. vm 沙箱装配                             */
/* ================================================================== */

const APP_SCRIPTS = ['util.js', 'protocol-ext.js', 'session.js', 'stream.js', 'dom.js', 'index.js']

/** 三个页面里出现过的元素 id：必须在跑页面脚本之前就存在，
    否则页面的 render() 会因为 getElementById 返回 null 而直接 return */
const PAGE_IDS = [
  'panel', 'hero-sub', 'engine-badge', 'toast', 'boot-error',
  'hud', 'qr', 'close',
  'video', 'probe', 'cam-empty', 'cam-fps',
  'mode-badge', 'hash-badge', 'actions', 'stats', 'note', 'bar'
]

function createHarness(options) {
  const opts = options || {}
  const registry = Object.create(null)
  const windowListeners = Object.create(null)
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-test-'))
  const openedWindows = []

  function byId(id) {
    if (!registry[id]) registry[id] = makeNode('div')
    return registry[id]
  }

  PAGE_IDS.forEach((id) => {
    registry[id] = makeNode('div')
  })

  const document = {
    documentElement: { scrollHeight: 600 },
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => registry[id] || null,
    addEventListener: () => {},
    removeEventListener: () => {}
  }

  const utools = {
    __enter: null,
    onPluginEnter(cb) {
      utools.__enter = cb
    },
    onPluginOut() {},
    getPath(name) {
      return path.join(tmpRoot, name)
    },
    getPrimaryDisplay() {
      return { bounds: { x: 0, y: 0, width: 1440, height: 900 } }
    },
    createBrowserWindow(url, config, callback) {
      const win = {
        url: url,
        config: config,
        sent: [],
        closed: false,
        shown: false,
        isDestroyed() {
          return false
        },
        close() {
          this.closed = true
        },
        show() {
          this.shown = true
        },
        setAlwaysOnTop() {},
        webContents: {
          send(channel, payload) {
            win.sent.push({ channel: channel, payload: payload })
          }
        }
      }
      openedWindows.push(win)
      if (callback) setTimeout(() => callback(), 0)
      return win
    },
    sendToParent() {},
    showSaveDialog() {
      return undefined
    },
    showOpenDialog() {
      return undefined
    },
    showNotification() {},
    isDev: () => true,
    getAppVersion: () => '9.9.9',
    getAppName: () => 'uTools'
  }

  const fakeRequire = (name) => {
    if (name === 'fs') return fs
    if (name === 'os') return os
    if (name === 'path') return path
    if (name === 'crypto') return nodeCrypto
    if (name === 'electron') return { ipcRenderer: { on() {}, send() {} } }
    throw new Error('桩 require 不认识：' + name)
  }

  const sandbox = {
    document: document,
    utools: utools,
    console: console,
    require: fakeRequire,
    process: process,
    Buffer: Buffer,
    crypto: nodeCrypto.webcrypto,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    CustomEvent: CustomEvent,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    __tmpRoot: tmpRoot,
    /* Electron 里 preload 是 CJS 包装过的，__dirname 就是插件目录（dist/）。
       桩环境必须一样，否则 readVendorBytes 没法定位插件内的 wasm。 */
    __dirname: DIST,
    __filename: path.join(DIST, 'preload.js'),
    module: { exports: {} },
    exports: {},
    addEventListener(type, fn) {
      ;(windowListeners[type] = windowListeners[type] || []).push(fn)
    },
    removeEventListener(type, fn) {
      const list = windowListeners[type] || []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    dispatchEvent(event) {
      ;(windowListeners[event.type] || []).forEach((fn) => fn(event))
      return true
    },
    innerWidth: 1440,
    innerHeight: 900
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  /* 共享核心照 HTML 的顺序挂到沙箱全局上（浏览器里就是 window.OTP） */
  sandbox.OTP = OTP

  const run = (rel) => vm.runInContext(fs.readFileSync(path.join(DIST, rel), 'utf8'), sandbox, { filename: rel })

  /* 先跑插件自己的 preload（真的那个），拿到真的 utoolsBridge */
  run(opts.preload || 'preload.js')
  ;(opts.appScripts || APP_SCRIPTS).forEach(run)

  return {
    sandbox: sandbox,
    DOT: sandbox.DOT,
    bridge: sandbox.utoolsBridge,
    utools: utools,
    document: document,
    byId: byId,
    panel: byId('panel'),
    openedWindows: openedWindows,
    tmpRoot: tmpRoot,
    run: run,
    cleanup() {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  }
}

/* ================================================================== */
/*                            4. 小工具                                */
/* ================================================================== */

const results = []

function test(name, fn) {
  results.push({ name: name, fn: fn })
}

async function runAll() {
  let passed = 0
  let failed = 0
  for (const item of results) {
    const started = Date.now()
    try {
      await item.fn()
      passed++
      console.log('  ✓ ' + item.name + '  (' + (Date.now() - started) + 'ms)')
    } catch (err) {
      failed++
      console.log('  ✗ ' + item.name)
      console.log('      ' + String((err && err.stack) || err).split('\n').slice(0, 6).join('\n      '))
    }
  }
  console.log('')
  console.log((failed ? '✗' : '✅') + ' ' + passed + ' 通过 / ' + failed + ' 失败')
  return failed
}

function section(title) {
  console.log('')
  console.log('=== ' + title + ' ===')
}

function sha256Hex(bytes) {
  return nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

function makeData(length, seed) {
  const out = new Uint8Array(length)
  let x = (seed || 12345) >>> 0
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out[i] = (x >>> 16) & 0xff
  }
  return out
}

/** 模拟接收端的落盘目标：按偏移写入，最后能整体取回 */
function makeSink(totalBytes) {
  const buffer = new Uint8Array(totalBytes)
  const info = { writeAtCalls: 0, writeAllCalls: 0, finishCalls: 0, written: 0, offsets: [] }
  return {
    buffer: buffer,
    info: info,
    writeAt(offset, bytes) {
      buffer.set(bytes, offset)
      info.writeAtCalls++
      info.offsets.push(offset)
      info.written += bytes.length
      return bytes.length
    },
    writeAll(bytes) {
      buffer.set(bytes.subarray(0, Math.min(bytes.length, totalBytes)), 0)
      info.writeAllCalls++
      info.written += Math.min(bytes.length, totalBytes)
      return bytes.length
    },
    finish() {
      info.finishCalls++
      return true
    }
  }
}

/** 走真实 QR 像素：编码 → 像素 → jsQR → 解帧 */
function throughPixels(frameBytes, ecc, version, scale) {
  const encoded = qr.encode(frameBytes, ecc, version)
  const image = qr.toImageData(encoded, { scale: scale || 3, quiet: 4 })
  return scan.decodeFrameFromImage(protocol, image.data, image.width, image.height)
}

function assertSameBytes(actual, expected, label) {
  assert.ok(actual, label + '：没有结果')
  assert.strictEqual(actual.length, expected.length, label + '：长度不一致')
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(label + '：第 ' + i + ' 字节不一致（' + actual[i] + ' vs ' + expected[i] + '）')
    }
  }
}

/* ================================================================== */
/*                              5. 测试                                */
/* ================================================================== */

const harness = createHarness()
/** 接收窗的 preload 才有落盘管道（openSink/writeAt/tempPathFor）*/
const receiverHarness = createHarness({ preload: 'receiver-preload.js', appScripts: [] })
const DOT = harness.DOT
const S = DOT.session
const STREAM = DOT.stream
const EXT = DOT.ext

/* ------------------------- 0. 交付物与规范硬性项 ------------------------- */

test('交付物齐全：plugin.json / 三个页面 / core / vendor / logo，且 HTML 无 CSP meta', () => {
  const required = [
    'plugin.json',
    'logo.png',
    'preload.js',
    'index.html',
    'sender.html',
    'receiver.html',
    'index.js',
    'sender.js',
    'receiver.js',
    'sender-preload.js',
    'receiver-preload.js',
    'core/protocol.js',
    'core/fountain.js',
    'core/qr.js',
    'core/scan.js',
    'core/codecs.js',
    'vendor/qrcode-generator.js',
    'vendor/jsQR.js',
    'vendor/raptorq.core.js',
    'vendor/raptorq.core.wasm'
  ]
  required.forEach((rel) => {
    assert.ok(fs.existsSync(path.join(DIST, rel)), '缺少 dist/' + rel)
  })

  const pluginJson = JSON.parse(fs.readFileSync(path.join(DIST, 'plugin.json'), 'utf8'))
  assert.strictEqual(pluginJson.main, 'index.html')
  const codes = pluginJson.features.map((f) => f.code)
  assert.strictEqual(new Set(codes).size, codes.length, 'feature code 必须唯一')
  assert.ok(codes.indexOf('dot-send-files') >= 0, '缺少匹配指令 dot-send-files')

  for (const page of ['index.html', 'sender.html', 'receiver.html']) {
    const html = fs.readFileSync(path.join(DIST, page), 'utf8')
    assert.ok(
      !/<meta[^>]*http-equiv\s*=\s*["']?Content-Security-Policy/i.test(html),
      page + ' 不该有 CSP meta（规范第 3 节坑 1）'
    )
  }
})

test('产物是 classic script，没有残留 ESM import/export（本地协议下模块脚本会被 CORS 拦）', () => {
  for (const rel of fs.readdirSync(DIST).filter((f) => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(DIST, rel), 'utf8')
    assert.ok(!/^[ \t]*(import[ {(]|export[ {(])/m.test(code), 'dist/' + rel + ' 里有运行时 ESM 语法')
  }
})

/* ------------------------- 1. 主面板无 action 渲染 ------------------------- */

test('主面板在无 action 时能渲染出全部卡片', () => {
  const text = harness.panel.textContent
  assert.ok(text.indexOf('发送') >= 0, '缺少发送卡片')
  assert.ok(text.indexOf('接收') >= 0, '缺少接收卡片')
  assert.ok(text.indexOf('限制与实现说明') >= 0, '缺少说明卡片')
  assert.ok(text.indexOf('LT 喷泉码') >= 0, '缺少模式选择')
  assert.strictEqual(harness.byId('engine-badge').textContent, 'JS 内核（无 WASM）')
})

/* --------------------- 2. 匹配指令带文件 → 描述符 --------------------- */

test('匹配指令进入：读文件并算出正确描述符（totalBytes / totalSymbols / name / SHA-256）', async () => {
  const name = '光码测试-报告 v2.bin'
  const filePath = path.join(harness.tmpRoot, name)
  const data = makeData(5000, 7)
  fs.writeFileSync(filePath, Buffer.from(data))

  harness.utools.__enter({
    code: 'dot-send-files',
    type: 'files',
    payload: [{ isFile: true, isDirectory: false, name: name, path: filePath }]
  })
  const plan = await DOT.state.pending

  assert.ok(plan, '没有算出 plan')
  assert.strictEqual(plan.name, name, '文件名必须原样保留（字符串必须走 utf8Encode）')
  assert.strictEqual(plan.totalBytes, 5000)
  assert.strictEqual(plan.symbolSize, 1400)
  assert.strictEqual(plan.totalSymbols, Math.ceil(5000 / 1400))
  assert.strictEqual(plan.digestHex, sha256Hex(data), 'SHA-256 必须与 Node crypto 一致')
  assert.strictEqual(plan.digestBackend.indexOf('WebCrypto'), 0, '应走 WebCrypto')

  const descriptor = protocol.decodeFrame(plan.descriptorFrame)
  assert.strictEqual(descriptor.type, protocol.TYPE_DESCRIPTOR)
  assert.strictEqual(descriptor.name, name, '描述符里的中文文件名必须能原样解回来')
  assert.strictEqual(descriptor.totalBytes, 5000)
  assert.strictEqual(descriptor.totalSymbols, plan.totalSymbols)
  assert.ok(descriptor.flags & protocol.FLAG_SHA256, '描述符必须声明 FLAG_SHA256')
  assert.strictEqual(descriptor.extra.length, 32, '摘要必须是 32 字节 extra')
  assert.strictEqual(EXT.toHex(descriptor.extra), plan.digestHex, '描述符里的摘要必须就是 SHA-256')
  assert.strictEqual(EXT.digestFromDescriptor(descriptor), plan.digestHex)

  assert.ok(harness.panel.textContent.indexOf(name) >= 0, '面板上要显示文件名')
  assert.ok(harness.panel.textContent.indexOf(plan.digestHex) >= 0, '面板上要显示摘要')
})

test('发送端帧序列：描述符帧按 repeatDescriptor 间隔重复，数据帧连续不重复', async () => {
  const data = makeData(900, 11)
  const handle = S.createSenderHandle({
    bytes: data,
    name: 'seq.bin',
    mode: protocol.MODE_FOUNTAIN,
    symbolSize: 300,
    fps: 30,
    ecc: 'L',
    repeatDescriptor: 4,
    digestHex: sha256Hex(data)
  })
  const kinds = []
  const esis = []
  for (let i = 0; i < 20; i++) {
    const step = handle.next()
    kinds.push(step.kind)
    if (step.kind === 'data') esis.push(step.esi)
  }
  assert.deepStrictEqual(
    kinds,
    ['descriptor', 'data', 'data', 'data', 'data', 'descriptor', 'data', 'data', 'data', 'data', 'descriptor', 'data', 'data', 'data', 'data', 'descriptor', 'data', 'data', 'data', 'data'],
    '描述符间隔不对：' + kinds.join(',')
  )
  assert.deepStrictEqual(esis.slice(0, 4), [0, 1, 2, 3], 'esi 必须递增')
})

/* ------------------- 3. 三种模式的内存往返（不经过像素） ------------------- */

test('三种模式的内存往返都能还原字节（含 LT 逐块落盘写入）', async () => {
  const data = makeData(4000, 21)
  const digestHex = sha256Hex(data)
  const modes = [
    { mode: protocol.MODE_SEQUENTIAL, symbolSize: 400, label: '顺序分片' },
    { mode: protocol.MODE_FOUNTAIN, symbolSize: 512, label: 'LT 喷泉码' },
    { mode: protocol.MODE_RAPTORQ, symbolSize: 512, label: 'RaptorQ（无 WASM → LT 回退）' }
  ]
  for (const item of modes) {
    const handle = S.createSenderHandle({
      bytes: data,
      name: 'round.bin',
      mode: item.mode,
      symbolSize: item.symbolSize,
      fps: 30,
      ecc: 'L',
      repeatDescriptor: 17,
      digestHex: digestHex
    })
    const descriptor = protocol.decodeFrame(handle.descriptorFrame)
    assert.strictEqual(descriptor.name, 'round.bin')
    assert.strictEqual(descriptor.extra.length, 32, item.label + '：摘要没进描述符')

    const sink = makeSink(data.length)
    const receiver = STREAM.createStreamReceiver(descriptor, sink)
    assert.strictEqual(receiver.digestHex, digestHex, item.label + '：描述符里的摘要没被取出来')
    assert.strictEqual(receiver.unsupported, false, item.label + '：不该是解不了的状态')

    let frames = 0
    const limit = handle.loops ? 4 * handle.totalSymbols + 100 : 40 * handle.totalSymbols + 200
    while (!receiver.isComplete && frames < limit) {
      const step = handle.next()
      frames++
      if (step.kind !== 'data') continue
      receiver.feed(protocol.decodeFrame(step.bytes))
    }
    assert.ok(receiver.isComplete, item.label + '：没有收齐（播放 ' + frames + ' 帧）')

    const tail = receiver.assemble()
    if (tail) sink.writeAll(tail)
    assertSameBytes(sink.buffer, data, item.label)
    assert.strictEqual(receiver.progress, 1, item.label + '：进度应为 1')
  }
})

test('LT 流式路径：数据量跨多块时，每解出一块立刻写一次（边收边落盘）', () => {
  const data = makeData(200 * 300, 31) /* 200 个符号，maxBlockSymbols=64 → 4 块 */
  const handle = S.createSenderHandle({
    bytes: data,
    name: 'blocks.bin',
    mode: protocol.MODE_FOUNTAIN,
    symbolSize: 300,
    fps: 30,
    ecc: 'L',
    repeatDescriptor: 50,
    digestHex: sha256Hex(data),
    maxBlockSymbols: 64
  })
  assert.strictEqual(handle.blockCount, 4, '构造出的块数不对：' + handle.blockCount)

  const descriptor = protocol.decodeFrame(handle.descriptorFrame)
  const sink = makeSink(data.length)
  const receiver = STREAM.createStreamReceiver(descriptor, sink)
  assert.strictEqual(receiver.streaming, true, 'LT 应该走流式路径')
  assert.strictEqual(receiver.blockCount, 4)

  const flushCallsWhen = []
  let frames = 0
  let lastDone = 0
  while (!receiver.isComplete && frames < 20000) {
    const step = handle.next()
    frames++
    if (step.kind !== 'data') continue
    receiver.feed(protocol.decodeFrame(step.bytes))
    if (receiver.blocksDone > lastDone) {
      lastDone = receiver.blocksDone
      flushCallsWhen.push({ blocks: lastDone, writeAtCalls: sink.info.writeAtCalls })
    }
  }
  assert.ok(receiver.isComplete, '没有收齐')
  assert.strictEqual(sink.info.writeAtCalls, 4, '应该正好逐块写了 4 次，实际 ' + sink.info.writeAtCalls)
  assert.strictEqual(sink.info.writeAllCalls, 0, '流式路径不该再整体写一次')
  assert.strictEqual(flushCallsWhen.length, 4, '每块完成都应触发一次落盘')
  assertSameBytes(sink.buffer, data, '多块逐块落盘')
})

/* --------------------- 4. 经过真实 QR 像素的往返 --------------------- */

test('经过真实 QR 像素的往返：描述符帧 / 数据帧都能被 jsQR 解回', () => {
  const data = makeData(2500, 41)
  const handle = S.createSenderHandle({
    bytes: data,
    name: 'px.bin',
    mode: protocol.MODE_FOUNTAIN,
    symbolSize: 512,
    fps: 30,
    ecc: 'L',
    repeatDescriptor: 17,
    digestHex: sha256Hex(data)
  })

  const descFrame = throughPixels(handle.descriptorFrame, handle.ecc, handle.version, 3)
  assert.ok(descFrame, '描述符帧没能过像素链路')
  assert.strictEqual(descFrame.type, protocol.TYPE_DESCRIPTOR)
  assert.strictEqual(descFrame.totalBytes, data.length)
  assert.strictEqual(EXT.toHex(descFrame.extra), handle.digestHex, '像素回来后摘要仍在')

  /* 整个文件都走像素 */
  const sink = makeSink(data.length)
  const receiver = STREAM.createStreamReceiver(descFrame, sink)
  let frames = 0
  while (!receiver.isComplete && frames < 5000) {
    const step = handle.next()
    frames++
    if (step.kind !== 'data') continue
    const decoded = throughPixels(step.bytes, handle.ecc, handle.version, 3)
    assert.ok(decoded, '第 ' + frames + ' 帧没能过像素链路')
    assert.strictEqual(decoded.blockIndex, step.blockIndex)
    assert.strictEqual(decoded.esi, step.esi)
    receiver.feed(decoded)
  }
  assert.ok(receiver.isComplete, '靠像素没能收齐（播放 ' + frames + ' 帧）')
  const tail = receiver.assemble()
  if (tail) sink.writeAll(tail)
  assertSameBytes(sink.buffer, data, '像素链路往返')
})

/* ------------------ 5. 所有帧（含描述符）模块数一致 ------------------ */

test('固定 QR 版本：描述符帧与数据帧的模块数完全一致', () => {
  const data = makeData(3000, 51)
  const handle = S.createSenderHandle({
    bytes: data,
    name: 'same.bin',
    mode: protocol.MODE_FOUNTAIN,
    symbolSize: 1400,
    fps: 30,
    ecc: 'L',
    repeatDescriptor: 17,
    digestHex: sha256Hex(data)
  })

  const descriptor = protocol.decodeFrame(handle.descriptorFrame)
  const counts = new Set()
  counts.add(qr.encode(handle.descriptorFrame, handle.ecc, handle.version).moduleCount)
  assert.strictEqual(descriptor.extra.length, 32)

  for (let i = 0; i < 6; i++) {
    const step = handle.next()
    if (step.kind !== 'data') continue
    counts.add(qr.encode(step.bytes, handle.ecc, handle.version).moduleCount)
  }
  assert.strictEqual(counts.size, 1, '模块数不一致：' + Array.from(counts).join(', '))
  assert.strictEqual(Array.from(counts)[0], handle.moduleCount, '与上报的 moduleCount 不一致')
  assert.strictEqual(handle.version, 27, '1400B 帧应当是 Version 27（125×125）')
})

test('固定 QR 版本：小切片 + 超长中文文件名（描述符比数据帧还长）时仍然一致', () => {
  const longName = '很长很长很长的文件名'.repeat(12) + '.bin' /* > 200 字节 */
  const data = makeData(600, 61)
  const handle = S.createSenderHandle({
    bytes: data,
    name: longName,
    mode: protocol.MODE_SEQUENTIAL,
    symbolSize: 200,
    fps: 10,
    ecc: 'L',
    repeatDescriptor: 20,
    digestHex: sha256Hex(data)
  })
  const descriptor = protocol.decodeFrame(handle.descriptorFrame)
  assert.ok(descriptor.extra.length === 32, '摘要必须在')
  assert.ok(
    handle.descriptorFrame.length > handle.frameLength,
    '这个用例就是要让描述符帧比数据帧长（描述符 ' +
      handle.descriptorFrame.length +
      ' vs 数据 ' +
      handle.frameLength +
      '）'
  )
  const counts = new Set()
  counts.add(qr.encode(handle.descriptorFrame, handle.ecc, handle.version).moduleCount)
  for (let i = 0; i < 5; i++) {
    const step = handle.next()
    if (step.kind !== 'data') continue
    counts.add(qr.encode(step.bytes, handle.ecc, handle.version).moduleCount)
  }
  assert.strictEqual(counts.size, 1, '模块数不一致：' + Array.from(counts).join(', '))
})

/* --------------------------- 6. 参数边界 --------------------------- */

test('参数边界：1 字节文件、非整除切片、超大切片、64MB 上限', () => {
  /* 1 字节 */
  const one = new Uint8Array([0x42])
  const h1 = S.createSenderHandle({
    bytes: one,
    name: 'one.bin',
    mode: protocol.MODE_FOUNTAIN,
    symbolSize: 1400,
    fps: 30,
    ecc: 'L',
    repeatDescriptor: 17,
    digestHex: sha256Hex(one)
  })
  assert.strictEqual(h1.totalSymbols, 1)
  assert.strictEqual(h1.totalBytes, 1)
  const sink1 = makeSink(1)
  const r1 = STREAM.createStreamReceiver(protocol.decodeFrame(h1.descriptorFrame), sink1)
  while (!r1.isComplete) {
    const step = h1.next()
    if (step.kind === 'data') r1.feed(protocol.decodeFrame(step.bytes))
  }
  const t1 = r1.assemble()
  if (t1) sink1.writeAll(t1)
  assert.strictEqual(sink1.buffer[0], 0x42, '1 字节文件的还原结果不对')

  /* 非整除切片：5000 / 512 = 9.76 → 10 个符号，最后一帧补零 */
  const uneven = makeData(5000, 71)
  const h2 = S.createSenderHandle({
    bytes: uneven,
    name: 'uneven.bin',
    mode: protocol.MODE_FOUNTAIN,
    symbolSize: 512,
    fps: 30,
    ecc: 'L',
    repeatDescriptor: 17,
    digestHex: sha256Hex(uneven)
  })
  assert.strictEqual(h2.totalSymbols, Math.ceil(5000 / 512))
  const sink2 = makeSink(uneven.length)
  const r2 = STREAM.createStreamReceiver(protocol.decodeFrame(h2.descriptorFrame), sink2)
  while (!r2.isComplete) {
    const step = h2.next()
    if (step.kind === 'data') r2.feed(protocol.decodeFrame(step.bytes))
  }
  const t2 = r2.assemble()
  if (t2) sink2.writeAll(t2)
  assertSameBytes(sink2.buffer, uneven, '非整除切片')

  /* 超大切片：2331B 是合法上限档位 */
  const h3 = S.createSenderHandle({
    bytes: makeData(5000, 72),
    name: 'big.bin',
    mode: protocol.MODE_FOUNTAIN,
    symbolSize: 2331,
    fps: 30,
    ecc: 'L',
    repeatDescriptor: 17,
    digestHex: sha256Hex(makeData(5000, 72))
  })
  assert.strictEqual(h3.frameLength, protocol.DATA_HEADER_BYTES + 2331 + 4)
  assert.ok(h3.version <= 40)

  /* 超出 QR 容量必须被拦住（而不是抛出莫名其妙的字符串） */
  assert.throws(
    () =>
      S.createSenderHandle({
        bytes: makeData(10, 73),
        name: 'x.bin',
        mode: protocol.MODE_FOUNTAIN,
        symbolSize: 3000,
        fps: 30,
        ecc: 'L',
        repeatDescriptor: 17,
        digestHex: ''
      }),
    /切片过大/,
    '超出 QR 上限的切片必须报错'
  )

  /* 64MB 上限 */
  assert.doesNotThrow(() => S.assertSendableSize(64 * 1024 * 1024))
  assert.throws(() => S.assertSendableSize(64 * 1024 * 1024 + 1), /64MB/)
})

/* --------------------- 7. SHA-256 校验失败必须报错 --------------------- */

test('SHA-256：一致时通过，不一致时必须报错且 UI 显示"校验失败"', () => {
  const data = makeData(1234, 81)
  const good = sha256Hex(data)
  const tampered = new Uint8Array(data)
  tampered[500] ^= 0xff
  const bad = sha256Hex(tampered)

  const ok = S.verifyDigest(good, good)
  assert.strictEqual(ok.status, 'match')
  assert.strictEqual(S.checksumBadge('match').label, '校验通过')

  const mismatch = S.verifyDigest(bad, good)
  assert.strictEqual(mismatch.status, 'mismatch')
  assert.strictEqual(mismatch.ok, false)
  assert.strictEqual(S.checksumBadge('mismatch').label, '校验失败')
  assert.strictEqual(S.checksumBadge('mismatch').kind, 'bad')

  assert.throws(() => S.assertDigest(bad, good), /SHA-256 校验失败/, '不一致必须抛错')
  assert.doesNotThrow(() => S.assertDigest(good, good))

  /* 发送端没给摘要时要说"未提供"，而不是假装通过 */
  assert.strictEqual(S.verifyDigest(good, '').status, 'unavailable')
  assert.strictEqual(S.checksumBadge('unavailable').label, '发送端未提供摘要')

  /* 篡改字节后，走完整链路也要能查出问题 */
  const handle = S.createSenderHandle({
    bytes: data,
    name: 'sha.bin',
    mode: protocol.MODE_FOUNTAIN,
    symbolSize: 512,
    fps: 30,
    ecc: 'L',
    repeatDescriptor: 17,
    digestHex: good
  })
  const descriptor = protocol.decodeFrame(handle.descriptorFrame)
  const sink = makeSink(data.length)
  const receiver = STREAM.createStreamReceiver(descriptor, sink)
  while (!receiver.isComplete) {
    const step = handle.next()
    if (step.kind === 'data') receiver.feed(protocol.decodeFrame(step.bytes))
  }
  const tail = receiver.assemble()
  if (tail) sink.writeAll(tail)
  /* 先破坏落盘内容，再按接收端的做法校验 */
  sink.buffer[17] ^= 0x01
  assert.throws(() => S.assertDigest(sha256Hex(sink.buffer), receiver.digestHex), /SHA-256 校验失败/)
})

/* ------------- 8. 真 RaptorQ（带 OTI）：诚实降级 + WASM 可用时能解 ------------- */

test('带 OTI 的真 RaptorQ：没有 WASM 时如实报"解不了"，绝不偷偷用 LT 解', () => {
  const rc = require(path.join(DIST, 'vendor', 'raptorq.core.js'))
  const wasm = fs.readFileSync(path.join(DIST, 'vendor', 'raptorq.core.wasm'))
  assert.ok(!rc.isAvailable(), '这个用例开始时 WASM 应当是未加载状态')

  /* 为了拿到"真 RaptorQ 描述符"，临时把内核挂上，再用它造一个 OTI 描述符 */
  return rc
    .loadFromBytes(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength))
    .then(() => {
      assert.ok(rc.isAvailable(), 'WASM 应该能加载起来')
      codecs.setRaptorqCore(rc)
      const data = makeData(3000, 91)
      const sender = codecs.createSender(protocol.MODE_RAPTORQ, {
        data: data,
        name: 'rq.bin',
        sessionId: 0x2222,
        symbolSize: 1400
      })
      assert.strictEqual(sender.backend, 'wasm')
      assert.strictEqual(sender.descriptor.extra.length, 12, '真 RaptorQ 的描述符要带 12 字节 OTI')
      const descriptor = protocol.decodeFrame(protocol.encodeDescriptor(sender.descriptor))
      assert.strictEqual(EXT.hasOti(descriptor), true)
      assert.strictEqual(EXT.digestFromDescriptor(descriptor), null, 'OTI 不能被当成摘要')

      /* 现在把内核摘掉，模拟"本端没有 WASM"的接收端 */
      codecs.setRaptorqCore(null)
      assert.strictEqual(codecs.raptorqAvailable(), false)
      const sink = makeSink(data.length)
      const receiver = STREAM.createStreamReceiver(descriptor, sink)
      assert.strictEqual(receiver.unsupported, true, '必须如实报"解不了"')
      assert.strictEqual(receiver.streaming, false, '真 RaptorQ 绝不能走 LT 流式路径')
      assert.ok(/WASM/.test(receiver.error), '错误信息里要说清是 WASM 的问题：' + receiver.error)
      assert.strictEqual(receiver.add(0, 0, new Uint8Array(1400)), false, '解不了就不能假装收下')

      /* 再装回去，同一个描述符就该能正常解出来 */
      codecs.setRaptorqCore(rc)
      const sink2 = makeSink(data.length)
      const receiver2 = STREAM.createStreamReceiver(descriptor, sink2)
      assert.strictEqual(receiver2.unsupported, false)
      let frames = 0
      while (!receiver2.isComplete && frames < 200) {
        const coord = sender.frameCoord(frames)
        receiver2.add(coord.blockIndex, coord.esi, sender.symbol(coord.blockIndex, coord.esi))
        frames++
      }
      assert.ok(receiver2.isComplete, '装上 WASM 后应当能解真 RaptorQ')
      const tail = receiver2.assemble()
      if (tail) sink2.writeAll(tail)
      assertSameBytes(sink2.buffer, data, '真 RaptorQ（WASM）往返')
      if (sender.free) sender.free()
    })
})

test('三种模式都能过真实 QR 像素被接收端解出（含真 RaptorQ + WASM）', () => {
  const rc = require(path.join(DIST, 'vendor', 'raptorq.core.js'))
  assert.ok(rc.isAvailable(), '上一个用例已经把 WASM 加载好了')
  codecs.setRaptorqCore(rc)

  const modes = [
    { mode: protocol.MODE_SEQUENTIAL, symbolSize: 400 },
    { mode: protocol.MODE_FOUNTAIN, symbolSize: 512 },
    { mode: protocol.MODE_RAPTORQ, symbolSize: 512 }
  ]
  for (const item of modes) {
    const data = makeData(1600, 100 + item.mode)
    const handle = S.createSenderHandle({
      bytes: data,
      name: 'mode' + item.mode + '.bin',
      mode: item.mode,
      symbolSize: item.symbolSize,
      fps: 30,
      ecc: 'L',
      repeatDescriptor: 17,
      digestHex: sha256Hex(data)
    })
    const descFrame = throughPixels(handle.descriptorFrame, handle.ecc, handle.version, 3)
    assert.ok(descFrame, '模式 ' + item.mode + ' 的描述符帧没能过像素链路')
    assert.strictEqual(
      protocol.modeName(descFrame.mode),
      protocol.modeName(item.mode),
      '接收端必须能显示当前模式名称'
    )

    const sink = makeSink(data.length)
    const receiver = STREAM.createStreamReceiver(descFrame, sink)
    assert.strictEqual(receiver.unsupported, false, '模式 ' + item.mode + ' 应当是能解的')
    let frames = 0
    while (!receiver.isComplete && frames < 5000) {
      const step = handle.next()
      frames++
      if (step.kind !== 'data') continue
      const decoded = throughPixels(step.bytes, handle.ecc, handle.version, 3)
      assert.ok(decoded, '模式 ' + item.mode + ' 第 ' + frames + ' 帧没能过像素链路')
      receiver.feed(decoded)
    }
    assert.ok(receiver.isComplete, '模式 ' + item.mode + ' 靠像素没能收齐')
    const tail = receiver.assemble()
    if (tail) sink.writeAll(tail)
    assertSameBytes(sink.buffer, data, '模式 ' + item.mode + ' 像素往返')
    assert.strictEqual(receiver.digestHex, sha256Hex(data), '模式 ' + item.mode + ' 摘要应随描述符到达')
  }
})

/* --------------------------- 9. uTools 集成 --------------------------- */

test('uTools 集成：panel 能开全屏码窗并下发发送参数，接收窗也能开', async () => {
  const name = 'open.bin'
  const filePath = path.join(harness.tmpRoot, name)
  fs.writeFileSync(filePath, Buffer.from(makeData(2000, 111)))
  harness.utools.__enter({
    code: 'dot-send-files',
    type: 'files',
    payload: [{ isFile: true, isDirectory: false, name: name, path: filePath }]
  })
  const plan = await DOT.state.pending
  assert.ok(plan)

  harness.openedWindows.length = 0
  const startBtn = findByText(harness.panel, '开始隔空发送')
  assert.ok(startBtn, '找不到「开始隔空发送」按钮')
  startBtn.click()

  assert.strictEqual(harness.openedWindows.length, 1, '应当开了一个码窗')
  const win = harness.openedWindows[0]
  assert.strictEqual(win.url, 'sender.html')
  assert.strictEqual(win.config.webPreferences.preload, 'sender-preload.js')
  assert.strictEqual(win.config.closeable, true, '子窗口必须 closeable:true 才能关')
  await new Promise((resolve) => setTimeout(resolve, 5))
  const start = win.sent.find((m) => m.channel === 'otp:start')
  assert.ok(start, '码窗必须收到 otp:start')
  assert.strictEqual(start.payload.filePath, filePath)
  assert.strictEqual(start.payload.digestHex, sha256Hex(makeData(2000, 111)))
  assert.strictEqual(start.payload.sessionId, plan.sessionId)
  assert.strictEqual(start.payload.repeatDescriptor, plan.repeatDescriptor)
})

test('uTools 集成：接收指令会打开接收窗并指向 receiver-preload', () => {
  harness.openedWindows.length = 0
  harness.utools.__enter({ code: 'dot-receive', type: 'text', payload: '', from: 'main' })
  assert.strictEqual(harness.openedWindows.length, 1)
  const win = harness.openedWindows[0]
  assert.strictEqual(win.url, 'receiver.html')
  assert.strictEqual(win.config.webPreferences.preload, 'receiver-preload.js')
})

test('preload 的 Node 能力：readFile / statFile / sha256File 可用（主窗口）', async () => {
  const target = path.join(harness.tmpRoot, 'io.bin')
  const data = makeData(3000, 121)
  fs.writeFileSync(target, Buffer.from(data))

  const read = harness.bridge.readFile(target)
  assert.strictEqual(read.name, 'io.bin')
  assertSameBytes(read.bytes, data, 'readFile')
  assert.strictEqual(harness.bridge.statFile(target).bytes, 3000)
  assert.strictEqual(await harness.bridge.sha256File(target), sha256Hex(data))

})

test('接收窗 preload：边收边落盘管道（openSink/writeAt）+ 流式校验 + 搬移 + wasm 读取', async () => {
  const b = receiverHarness.bridge
  const data = makeData(3000, 131)
  const sinkPath = b.tempPathFor('io.bin', 0x1234)
  assert.ok(sinkPath.indexOf('s1234-') >= 0, '临时文件名应带会话号：' + sinkPath)

  b.openSink(sinkPath, data.length)
  assert.strictEqual(fs.statSync(sinkPath).size, data.length, '应当先按总长建好文件')
  /* 故意乱序、分三段写，模拟"每解出一块就写对应偏移" */
  b.writeAt(1000, data.subarray(1000, 2000))
  b.writeAt(0, data.subarray(0, 1000))
  b.writeAt(2000, data.subarray(2000))
  b.closeSink()
  assert.strictEqual(await b.sha256File(sinkPath), sha256Hex(data), '逐块落盘的内容不对')

  const moved = path.join(receiverHarness.tmpRoot, 'moved.bin')
  b.moveFile(sinkPath, moved)
  assert.ok(fs.existsSync(moved), 'moveFile 之后目标文件应存在')
  assert.ok(!fs.existsSync(sinkPath), 'moveFile 之后临时文件应消失')

  const vendor = b.readVendorBytes('vendor/raptorq.core.wasm')
  assert.ok(vendor.length > 1000, 'readVendorBytes 应当读出 wasm')
  assert.strictEqual(vendor[0], 0x00, 'wasm 魔数首字节')
  assert.strictEqual(vendor[1], 0x61, 'wasm 魔数（\\0asm）')
  assert.throws(() => b.readVendorBytes('../../package.json'), /路径越界/)
})

/* ================================================================== */
/*                              6. 主流程                              */
/* ================================================================== */

;(async () => {
  console.log('decimen-optical-transfer · plugin.test.js（Node + 桩 DOM，跑真实 dist 产物）')
  console.log('Node ' + process.version + ' · dist 在 ' + path.relative(process.cwd(), DIST))
  const failed = await runAll()
  harness.cleanup()
  receiverHarness.cleanup()
  process.exit(failed ? 1 : 0)
})()
