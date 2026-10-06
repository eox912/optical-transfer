/**
 * plugin.test.js —— airscan-qr 的主流程测试（Node + 桩 DOM）
 *
 *   node airscan-qr/test/plugin.test.js
 *
 * 覆盖 PLUGIN-SPEC 第 6 节要求的 6 项，外加发送端调度/智能补发/诚实上报等。
 * 关键点：**不是语法检查**——界面走桩 DOM 真跑，传输走真实 QR 像素真跑。
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')

/* -------------------------------------------------------------------------- */
/*                         核心：与插件里是同一份字节                          */
/* -------------------------------------------------------------------------- */

const protocol = require(path.join(ROOT, 'core/protocol.js'))
const fountain = require(path.join(ROOT, 'core/fountain.js'))
const qr = require(path.join(ROOT, 'core/qr.js'))
const scan = require(path.join(ROOT, 'core/scan.js'))
const codecs = require(path.join(ROOT, 'core/codecs.js'))
const OTP = { protocol, fountain, qr, scan, codecs }

/* -------------------------------------------------------------------------- */
/*                                  断言工具                                   */
/* -------------------------------------------------------------------------- */

let pass = 0
let fail = 0
const failures = []

function assert(cond, message) {
  if (!cond) throw new Error(message)
}
function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || '值不相等') + '：实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expected))
  }
}

const pending = []
function check(name, fn) {
  pending.push({ type: 'check', name, fn })
}
/** 分组标题（按注册顺序打印，避免所有标题堆在开头） */
function group(title) {
  pending.push({ type: 'group', title })
}

async function runAll() {
  for (const item of pending) {
    if (item.type === 'group') {
      console.log('\n=== ' + item.title + ' ===')
      continue
    }
    const t0 = Date.now()
    try {
      const extra = await item.fn()
      console.log(`  ✓ ${item.name}${extra ? ' — ' + extra : ''} (${Date.now() - t0}ms)`)
      pass++
    } catch (err) {
      const detail = (err && err.stack) || String(err)
      console.log(`  ✗ ${item.name} → ${(err && err.message) || err}`)
      failures.push(item.name + '\n' + detail)
      fail++
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                 桩 DOM                                    */
/* -------------------------------------------------------------------------- */

function createNode(tag, attrs) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    className: '',
    hidden: false,
    disabled: false,
    selected: false,
    checked: false,
    type: '',
    src: '',
    alt: '',
    placeholder: '',
    value: '',
    style: {},
    listeners: {},
    parentNode: null,
    _text: '',
    _ctx: null
  }
  const source = attrs || ''
  const valueAttr = /\bvalue="([^"]*)"/.exec(source)
  if (valueAttr) node.value = valueAttr[1]
  const typeAttr = /\btype="([^"]*)"/.exec(source)
  if (typeAttr) node.type = typeAttr[1]

  node.appendChild = function (child) {
    this.children.push(child)
    child.parentNode = this
    // 让 <select> 的 value 跟着 selected 的 option 走（真实浏览器行为）
    if (child.tagName === 'OPTION' && child.selected) this.value = child.value
    if (child.tagName === 'OPTION' && !this.value) this.value = child.value
    return child
  }
  node.addEventListener = function (type, fn) {
    ;(this.listeners[type] = this.listeners[type] || []).push(fn)
  }
  node.setAttribute = function (key, value) {
    this[key] = value
  }
  node.click = function () {
    ;(this.listeners.click || []).forEach((fn) => fn({ target: this }))
  }
  /** 触发某个事件（测试用） */
  node.fire = function (type, event) {
    const handlers = this.listeners[type] || []
    const payload = Object.assign({ target: this, preventDefault() {} }, event || {})
    handlers.forEach((fn) => fn(payload))
  }
  node.getContext = function () {
    if (!this._ctx) {
      const ctx = {
        fillStyle: '',
        fillRect() {
          ctx.fillCalls++
        },
        drawImage() {},
        getImageData() {
          return { data: new Uint8ClampedArray(4), width: 1, height: 1 }
        },
        fillCalls: 0
      }
      this._ctx = ctx
    }
    return this._ctx
  }
  Object.defineProperty(node, 'textContent', {
    get() {
      return this._text + this.children.map((c) => c.textContent).join('')
    },
    set(value) {
      this.children.length = 0
      this._text = value == null ? '' : String(value)
    }
  })
  return node
}

/** 从真实 HTML 里解析 id → 标签，保证测试用的 DOM 和交付的页面一致 */
function parseHtml(html) {
  const map = new Map()
  const re = /<([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)\/?>/g
  let m
  while ((m = re.exec(html))) {
    const attrs = m[2] || ''
    const idMatch = /\bid="([^"]+)"/.exec(attrs)
    if (idMatch) map.set(idMatch[1], { tag: m[1], attrs })
  }
  return map
}

function makeDom(htmlFile) {
  const html = fs.readFileSync(path.join(ROOT, htmlFile), 'utf8')
  const parsed = parseHtml(html)
  const registry = new Map()
  for (const [id, info] of parsed) registry.set(id, createNode(info.tag, info.attrs))
  const document = {
    readyState: 'complete',
    documentElement: { scrollHeight: 640 },
    body: createNode('body', ''),
    createElement: (tag) => createNode(tag, ''),
    getElementById: (id) => registry.get(id) || null,
    addEventListener() {}
  }
  return { html, document, registry, ids: parsed }
}

function findText(node, predicate) {
  const out = []
  const walk = (n) => {
    if (predicate(n)) out.push(n)
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

/* -------------------------------------------------------------------------- */
/*                                 桩沙箱                                    */
/* -------------------------------------------------------------------------- */

function createSandbox(dom, extra) {
  const timers = []
  const intervals = []
  const sandbox = Object.assign(
    {
      console,
      document: dom.document,
      OTP,
      Promise,
      JSON,
      Math,
      Number,
      String,
      Boolean,
      Array,
      Object,
      RegExp,
      Set,
      Map,
      Error,
      Date,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      Uint8ClampedArray,
      Int32Array,
      Float64Array,
      Buffer,
      require,
      process,
      screen: { width: 1920, height: 1080 },
      location: { protocol: 'file:', search: '', pathname: '/standalone.html', origin: 'file://' },
      setTimeout(fn) {
        timers.push(fn)
        return timers.length
      },
      clearTimeout() {},
      setInterval(fn) {
        intervals.push(fn)
        return intervals.length
      },
      clearInterval() {},
      addEventListener() {},
      dispatchEvent() {},
      navigator: {},
      requestAnimationFrame(fn) {
        timers.push(fn)
        return timers.length
      },
      cancelAnimationFrame() {}
    },
    extra || {}
  )
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  return {
    sandbox,
    timers,
    intervals,
    run(rel) {
      const file = path.join(ROOT, rel)
      vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: rel })
    },
    /** 依次跑掉当前挂起的 timer 回调（模拟时间推进） */
    flush(count) {
      for (let i = 0; i < (count || 1); i++) {
        const fn = timers.shift()
        if (!fn) return i
        fn()
      }
      return count || 1
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                  工具                                      */
/* -------------------------------------------------------------------------- */

function makeData(n, seed) {
  const out = new Uint8Array(n)
  let x = (seed || 1234567) >>> 0
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out[i] = (x >>> 16) & 0xff
  }
  return out
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** 从沙箱里的 plan/接收端 DOM 文本里取键值对 */
function kvFromDom(dlNode) {
  const map = {}
  for (let i = 0; i + 1 < dlNode.children.length; i += 2) {
    map[dlNode.children[i].textContent] = dlNode.children[i + 1].textContent
  }
  return map
}

const seqDefaults = codecs.defaultOptions(protocol.MODE_SEQUENTIAL)

/* ======================================================================== */
/*                                 用例                                     */
/* ======================================================================== */

/* ---------------------------- 1. 主面板渲染 ---------------------------- */

group('§6.1 主面板渲染')

check('1. 主面板在无 action 时能渲染（读的是真实 index.html 的 DOM）', () => {
  const dom = makeDom('index.html')
  const bridge = { readFile: () => ({ name: 'x', bytes: new Uint8Array(0) }) }
  const box = createSandbox(dom, { utoolsBridge: bridge })
  box.run('sender.js')
  box.run('index.js')

  const panel = box.sandbox.ASQ.panel
  assert(panel, 'ASQ.panel 没有挂上')
  assert(dom.registry.get('plan').textContent.indexOf('还没有选择要发送的内容') >= 0, '计划区没有渲染空状态')
  assert(dom.registry.get('env-badge').textContent.length > 0, '环境徽标没渲染')
  assert(dom.registry.get('mode-blurb').textContent.length > 10, '模式说明没渲染')

  // 默认必须是方案一的招牌模式与默认切片/帧率
  eq(panel.state.options.mode, protocol.MODE_SEQUENTIAL, '默认模式应当是顺序分片')
  eq(panel.state.options.symbolSize, seqDefaults.symbolSize, '默认切片应当是 400')
  eq(panel.state.options.fps, seqDefaults.fps, '默认帧率应当是 10')
  eq(seqDefaults.symbolSize, 400, 'codecs 里顺序模式默认切片应为 400')
  eq(seqDefaults.fps, 10, 'codecs 里顺序模式默认帧率应为 10')

  // 切片与帧率的可调范围必须覆盖 200–800B / 1–30fps
  const presets = codecs.infoFor(protocol.MODE_SEQUENTIAL).presets
  assert(presets.symbolSize.indexOf(200) >= 0 && presets.symbolSize.indexOf(800) >= 0, '切片范围应含 200 与 800')
  assert(presets.fps.indexOf(1) >= 0 && presets.fps.indexOf(30) >= 0, '帧率范围应含 1 与 30')
  // 方案一自报的参数边界（UI 与文档都引用它）
  const limits = box.sandbox.ASQ.sender.LIMITS
  eq(limits.symbolSize.min, 200, '切片下限应为 200B')
  eq(limits.symbolSize.max, 800, '切片上限应为 800B')
  eq(limits.fps.min, 1, '帧率下限应为 1fps')
  eq(limits.fps.max, 30, '帧率上限应为 30fps')
  assert(
    presets.symbolSize.every((v) => v >= limits.symbolSize.min && v <= limits.symbolSize.max),
    '顺序模式的切片候选超出了 200–800B'
  )
  assert(presets.fps.every((v) => v >= limits.fps.min && v <= limits.fps.max), '顺序模式的帧率候选超出了 1–30fps')
  return '默认 ' + panel.state.options.symbolSize + 'B / ' + panel.state.options.fps + 'fps，范围 200–800B / 1–30fps'
})

/* ------------------- 2. 匹配指令带文件进入 → 描述符正确 ------------------- */

group('§6.2 匹配指令 → 描述符 / 字符串必须走 utf8Encode')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'airscan-qr-test-'))
const samplePath = path.join(tmpRoot, '示例文件.bin')
const sampleBytes = makeData(2500, 42)
fs.writeFileSync(samplePath, Buffer.from(sampleBytes))
const sampleName = '示例文件.bin'

check('2. 匹配指令带文件进入 → 读文件并算出正确描述符（totalBytes / totalSymbols / name）', async () => {
  const dom = makeDom('index.html')
  const bridge = {
    readFile(filePath) {
      const buf = fs.readFileSync(filePath)
      return { name: path.basename(filePath), bytes: new Uint8Array(buf) }
    }
  }
  const box = createSandbox(dom, { utoolsBridge: bridge })
  box.run('sender.js')
  box.run('index.js')
  const panel = box.sandbox.ASQ.panel

  await panel.handleEnter({
    code: 'asq-send-files',
    type: 'file',
    from: 'panel',
    payload: [
      { isFile: true, isDirectory: false, name: sampleName, path: samplePath },
      { isFile: false, isDirectory: true, name: '某个文件夹', path: tmpRoot }
    ]
  })

  eq(panel.state.activeBytes.length, 2500, '读到的字节数不对')
  assert(sameBytes(panel.state.activeBytes, sampleBytes), '读到的内容不对')
  eq(panel.state.activeIndex, 0, '应默认选中第一个文件')

  const plan = panel.state.plan
  eq(plan.totalBytes, 2500, 'totalBytes 不对')
  eq(plan.totalSymbols, Math.ceil(2500 / 400), 'totalSymbols 不对')
  eq(plan.name, sampleName, 'name 不对（中文文件名要保持原样）')
  eq(plan.frameLength, 10 + 400 + 4, 'frameLength 不对')

  // 描述符帧本身也要能解回来
  const desc = protocol.decodeFrame(plan.descriptorFrame)
  assert(desc && desc.type === protocol.TYPE_DESCRIPTOR, '描述符帧解不出来')
  eq(desc.totalBytes, 2500, '描述符里的 totalBytes 不对')
  eq(desc.totalSymbols, 7, '描述符里的 totalSymbols 不对')
  eq(desc.name, sampleName, '描述符里的文件名不对（UTF-8 往返失败？）')
  eq(desc.symbolSize, 400, '描述符里的 symbolSize 不对')

  const shown = kvFromDom(dom.registry.get('plan'))
  eq(shown['分片数'], '7', 'DOM 上的分片数不对')
  eq(shown['QR 版本'], 'v' + qr.versionFor(414, 'L') + ' · ' + qr.moduleCountForVersion(qr.versionFor(414, 'L')) + '×' + qr.moduleCountForVersion(qr.versionFor(414, 'L')), 'DOM 上的 QR 版本不对')
  assert(dom.registry.get('file-list').children.length === 1, '目录应当被过滤掉，只留 1 个文件')
  return '2500B → 7 片 / ' + shown['QR 版本']
})

check('2b. 文本走 utf8Encode（中文/emoji 不被截断，PLUGIN-SPEC §3.2）', () => {
  const dom = makeDom('index.html')
  const box = createSandbox(dom, { utoolsBridge: {} })
  box.run('sender.js')
  box.run('index.js')
  const panel = box.sandbox.ASQ.panel

  const text = '中文测试🎉 with ASCII'
  panel.setText(text, '中文名.txt')
  const expected = protocol.utf8Encode(text)
  eq(panel.state.activeBytes.length, expected.length, '字节数不等于 utf8 编码长度（说明没走 utf8Encode）')
  assert(sameBytes(panel.state.activeBytes, expected), '字节内容不是 UTF-8')
  eq(protocol.utf8Decode(panel.state.activeBytes), text, 'UTF-8 往返失败')

  const plan = panel.state.plan
  eq(plan.name, '中文名.txt', '文件名没有原样保留')
  const desc = protocol.decodeFrame(plan.descriptorFrame)
  eq(desc.name, '中文名.txt', '描述符里的中文文件名往返失败')
  assert(desc.totalBytes > text.length, '中文按 UTF-8 编码后应当比字符数多（' + desc.totalBytes + '）')
  return text.length + ' 字符 → ' + desc.totalBytes + ' 字节'
})

/* ------------------- 3. 三种模式的内存往返（不经像素） ------------------- */

group('§6.3 三种模式内存往返 / 模式名称 / 诚实上报')

check('3. 三种模式各自 createSender → createReceiver 的内存往返都能还原', () => {
  const data = makeData(3000, 7)
  const sessionId = protocol.makeSessionId(data)
  const modes = [protocol.MODE_SEQUENTIAL, protocol.MODE_FOUNTAIN, protocol.MODE_RAPTORQ]
  const notes = []
  for (const mode of modes) {
    const sender = codecs.createSender(mode, { data, name: '内存往返.bin', sessionId, symbolSize: 400 })
    const descriptor = protocol.decodeFrame(protocol.encodeDescriptor(sender.descriptor))
    const receiver = codecs.createReceiver(descriptor)
    const limit = Number.isFinite(sender.totalFrames) ? sender.totalFrames * 5 : 600
    let i = 0
    for (; i < limit && !receiver.isComplete; i++) {
      const coord = sender.frameCoord(i)
      receiver.add(coord.blockIndex, coord.esi, sender.symbol(coord.blockIndex, coord.esi))
    }
    assert(receiver.isComplete, codecs.modeKey(mode) + ' 模式没能收全')
    const out = receiver.assemble()
    assert(out && sameBytes(out, data), codecs.modeKey(mode) + ' 还原的字节不一致')
    notes.push(codecs.modeKey(mode) + ' ' + i + ' 帧')
  }
  return notes.join(' / ')
})

check('3b. 接收端三种模式的名称都能取到（UI 要显示当前模式）', () => {
  const data = makeData(900, 11)
  const labels = []
  for (const mode of [protocol.MODE_SEQUENTIAL, protocol.MODE_FOUNTAIN, protocol.MODE_RAPTORQ]) {
    const sender = codecs.createSender(mode, { data, name: 'x.bin', sessionId: 1, symbolSize: 400 })
    const descriptor = protocol.decodeFrame(protocol.encodeDescriptor(sender.descriptor))
    const engine = receiverEngine()
    const res = engine.ingest(descriptor)
    assert(res.kind === 'descriptor' && res.newSession, '描述符没有被识别为新的传输')
    eq(engine.modeLabel(), codecs.infoFor(mode).label, '模式名称不对')
    labels.push(engine.modeLabel())
  }
  const receiverHtml = fs.readFileSync(path.join(ROOT, 'receiver.html'), 'utf8')
  assert(receiverHtml.indexOf('id="mode"') >= 0, 'receiver.html 缺少显示模式的元素')
  assert(fs.readFileSync(path.join(ROOT, 'standalone.html'), 'utf8').indexOf('id="r-mode"') >= 0, 'standalone.html 缺少显示模式的元素')
  return labels.join(' / ')
})

check('3c. RaptorQ：无 OTI 时按 LT 解码，带 OTI 时如实报「解不了」而不假装', () => {
  const data = makeData(500, 3)
  eq(codecs.raptorqAvailable(), false, 'airscan-qr 里不应该有 RaptorQ WASM 后端')

  // (a) 本插件的 RaptorQ 发送端没有 WASM → 回退 LT，描述符不带 OTI → 接收端用同一套 LT 解码
  const sender = codecs.createSender(protocol.MODE_RAPTORQ, { data, name: 'x.bin', sessionId: 9, symbolSize: 400 })
  const descriptor = protocol.decodeFrame(protocol.encodeDescriptor(sender.descriptor))
  eq(descriptor.extra.length, 0, 'LT 回退的描述符不该带 OTI')
  const engine = receiverEngine()
  engine.ingest(descriptor)
  eq(engine.backendKind(), 'js', 'LT 回退时后端应当是 js')
  assert(engine.backendNote().indexOf('LT') >= 0, 'backendNote 没有说明是 LT 解码：' + engine.backendNote())
  eq(engine.unsupported(), false, 'LT 回退是可解的，不该报 unsupported')

  // (b) 描述符带 12 字节 OTI = 发送端真的用了 WASM RaptorQ → 本端必须如实报错，不许拿 LT 硬解
  const otiDescriptor = protocol.decodeFrame(
    protocol.encodeDescriptor({
      sessionId: 11,
      mode: protocol.MODE_RAPTORQ,
      symbolSize: 400,
      totalSymbols: 2,
      blockCount: 1,
      totalBytes: 800,
      name: 'wasm-rq.bin',
      extra: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    })
  )
  eq(otiDescriptor.extra.length, 12, 'OTI 没有往返回来')
  const rqEngine = receiverEngine()
  rqEngine.ingest(otiDescriptor)
  eq(rqEngine.unsupported(), true, '带 OTI 的 RaptorQ 流必须标记为解不了')
  assert(rqEngine.backendNote().indexOf('WASM') >= 0, 'backendNote 没提到缺 WASM：' + rqEngine.backendNote())
  assert(rqEngine.unsupportedReason().length > 0, '缺少不可解的原因说明')
  const res = rqEngine.ingest({
    type: protocol.TYPE_DATA, sessionId: 11, blockIndex: 0, esi: 0, payload: new Uint8Array(400)
  })
  eq(res.kind, 'unsupported', '数据帧也应当如实回报 unsupported')
  eq(rqEngine.received(), 0, '不许假装收到了数据')
  eq(rqEngine.isComplete(), false, '更不许假装收完了')
  eq(rqEngine.assemble(), null, 'assemble 必须是 null')
  eq(rqEngine.stats().unsupported, 1, 'unsupported 计数不对')

  const fountainSender = codecs.createSender(protocol.MODE_FOUNTAIN, { data, name: 'x.bin', sessionId: 9, symbolSize: 400 })
  const fEngine = receiverEngine()
  fEngine.ingest(protocol.decodeFrame(protocol.encodeDescriptor(fountainSender.descriptor)))
  assert(fEngine.backendNote().indexOf('LT') >= 0, 'LT 模式的 backendNote 不对：' + fEngine.backendNote())
  return 'LT 回退可解 / 真 RaptorQ 如实拒绝'
})

/* ------------------- 4. 经过真实 QR 像素的往返 ------------------- */

group('§6.4 真实 QR 像素往返')

/**
 * 真像素往返：帧 → QR 矩阵 → RGBA → jsQR → 帧 → 解码器
 * @returns {{mode:string, frames:number, version:number, px:number, overhead:number}}
 */
function opticalRoundTrip(mode, symbolSize, data, lossEvery, ecc) {
  const level = ecc || 'L'
  const sessionId = protocol.makeSessionId(data)
  const sender = codecs.createSender(mode, { data, name: '像素往返.bin', sessionId, symbolSize })
  // 固定版本：所有帧（含描述符）共用同一个 version
  const version = qr.versionFor(sender.frameLength, level)

  const descFrame = protocol.encodeDescriptor(sender.descriptor)
  const descImg = qr.toImageData(qr.encode(descFrame, level, version), { scale: 3, quiet: 4 })
  const descBack = scan.decodeFrameFromImage(protocol, descImg.data, descImg.width, descImg.height)
  assert(descBack && descBack.type === protocol.TYPE_DESCRIPTOR, codecs.modeKey(mode) + '：描述符帧没能过像素链路')
  eq(descBack.totalBytes, data.length, '描述符里的长度不对')
  eq(descBack.name, '像素往返.bin', '描述符里的文件名不对')
  eq(descBack.mode, mode, '描述符里的模式不对')

  const receiver = codecs.createReceiver(descBack)
  const sequential = mode === protocol.MODE_SEQUENTIAL
  const limit = sequential ? sender.totalFrames * 5 : sender.totalFrames * 4
  let played = 0
  let decoded = 0

  for (let i = 0; i < limit && !receiver.isComplete; i++) {
    played++
    if (lossEvery && played % lossEvery === 0) continue // 模拟丢帧
    const coord = sender.frameCoord(i)
    const bytes = protocol.encodeDataFrame(
      sender.descriptor.sessionId,
      coord.blockIndex,
      coord.esi,
      sender.symbol(coord.blockIndex, coord.esi)
    )
    eq(bytes.length, sender.frameLength, '数据帧长度与 frameLength 不一致')
    const img = qr.toImageData(qr.encode(bytes, level, version), { scale: 3, quiet: 4 })
    const parsed = scan.decodeFrameFromImage(protocol, img.data, img.width, img.height)
    assert(parsed, codecs.modeKey(mode) + '：第 ' + played + ' 帧没能过像素链路')
    decoded++
    receiver.add(parsed.blockIndex, parsed.esi, parsed.payload)
  }

  assert(receiver.isComplete, codecs.modeKey(mode) + '：过完像素后没能收全')
  const out = receiver.assemble()
  assert(out && sameBytes(out, data), codecs.modeKey(mode) + '：像素链路还原的字节不一致')
  const px = descImg.width
  return { mode: codecs.modeKey(mode), frames: played, decoded: decoded, version: version, px: px, overhead: played / sender.descriptor.totalSymbols }
}

check('4. 三种模式都能过真实 QR 像素往返（describe → jsQR → 还原）', () => {
  const data = makeData(1200, 99)
  const notes = []
  for (const mode of [protocol.MODE_SEQUENTIAL, protocol.MODE_FOUNTAIN, protocol.MODE_RAPTORQ]) {
    const r = opticalRoundTrip(mode, 400, data, 5)
    notes.push(r.mode + ' ' + r.frames + '帧/' + r.px + 'px')
  }
  return notes.join(' / ')
})

check('4b. 800B 大切片（airscan 上限）也能过像素链路', () => {
  const data = makeData(2400, 5)
  const r = opticalRoundTrip(protocol.MODE_SEQUENTIAL, 800, data, 0)
  eq(r.version, qr.versionFor(814, 'L'), '800B 切片的 QR 版本不对')
  return 'v' + r.version + ' / ' + r.px + 'px / 播放 ' + r.frames + ' 帧'
})

check('4c. 全链路：插件自己的发送引擎 → QR 像素 → 插件自己的接收引擎', () => {
  const dom = makeDom('index.html')
  const box = createSandbox(dom, { utoolsBridge: {} })
  box.run('sender.js')
  box.run('receiver.js') // 这里只是要 ASQ.receiver

  const data = makeData(1800, 123)
  const engine = box.sandbox.ASQ.createEngine({
    data,
    name: 'full-stack.bin',
    mode: protocol.MODE_SEQUENTIAL,
    symbolSize: 400,
    fps: 10,
    ecc: 'L',
    repeatDescriptor: 6,
    repairRatio: 0
  })
  const renderer = box.sandbox.ASQ.createRenderer(engine.plan)
  const rx = box.sandbox.ASQ.receiver.createEngine()

  let frames = 0
  let dropped = 0
  for (let i = 0; i < 60 && !rx.isComplete(); i++) {
    const item = engine.next()
    frames++
    if (frames % 4 === 0) {
      dropped++ // 模拟丢帧：顺序模式靠下一轮补上
      continue
    }
    const img = qr.toImageData(renderer.matrixFor(item.bytes, item.key), { scale: 3, quiet: 4 })
    const parsed = scan.decodeFrameFromImage(protocol, img.data, img.width, img.height)
    assert(parsed, '第 ' + frames + ' 帧没过像素链路（' + item.label + '）')
    rx.ingest(parsed)
  }

  assert(rx.isComplete(), '插件自己的收发两端没能跑通（丢帧 ' + dropped + '）')
  assert(sameBytes(rx.assemble(), data), '全链路还原的字节不一致')
  eq(rx.name(), 'full-stack.bin', '接收端拿到的文件名不对')
  eq(rx.modeLabel(), codecs.infoFor(protocol.MODE_SEQUENTIAL).label, '接收端显示的模式名不对')
  eq(rx.totalBytes(), 1800, '接收端拿到的长度不对')
  return '丢 ' + dropped + ' 帧后仍还原 1800B（共播 ' + frames + ' 帧）'
})

/* ------------------- 5. 所有帧（含描述符）QR 模块数一致 ------------------- */

group('§6.5 固定 QR 版本（含描述符帧）')

check('5. 发送端所有帧（含描述符）的 QR 模块数完全一致', async () => {
  const dom = makeDom('index.html')
  const bridge = {
    readFile: () => ({ name: sampleName, bytes: sampleBytes })
  }
  const box = createSandbox(dom, { utoolsBridge: bridge })
  box.run('sender.js')
  box.run('index.js')
  const panel = box.sandbox.ASQ.panel
  await panel.handleEnter({
    code: 'asq-send-files',
    type: 'file',
    payload: [{ isFile: true, isDirectory: false, name: sampleName, path: samplePath }]
  })
  assert(panel.state.activeBytes && panel.state.activeBytes.length === 2500, '没有读到样例文件')

  const engine = box.sandbox.ASQ.createEngine({
    data: panel.state.activeBytes,
    name: sampleName,
    mode: protocol.MODE_SEQUENTIAL,
    symbolSize: 400,
    fps: 10,
    ecc: 'L',
    repeatDescriptor: 20,
    repairRatio: 0
  })
  const plan = engine.plan
  const renderer = box.sandbox.ASQ.createRenderer(plan)
  const expectedModules = qr.moduleCountForVersion(plan.version)
  const sizes = new Set()
  const keys = new Set()
  let descriptors = 0
  let datas = 0

  // 跑满一整轮（含描述符帧），逐个检查
  for (let i = 0; i < plan.itemsPerRound; i++) {
    const item = engine.next()
    const matrix = renderer.matrixFor(item.bytes, item.key)
    keys.add(item.key)
    sizes.add(matrix.moduleCount)
    eq(matrix.moduleCount, expectedModules, '第 ' + i + ' 个播放项的模块数不一致')
    eq(matrix.version, plan.version, '第 ' + i + ' 个播放项的版本不一致')
    if (item.kind === 'descriptor') descriptors++
    else datas++
  }

  eq(sizes.size, 1, '出现了多种模块数：' + Array.from(sizes).join(','))
  eq(keys.size, plan.itemsPerRound, '每个播放项必须有各自唯一的渲染缓存键')
  eq(datas, plan.totalSymbols, '一轮里的数据帧数应当等于分片数')
  eq(descriptors, plan.descriptorsPerRound, '描述符帧数与计划里的不一致（公式：' + plan.descriptorsPerRound + '）')
  eq(plan.itemsPerRound, datas + descriptors, '一轮播放项总数与数据帧+描述符不符')
  return 'v' + plan.version + ' / ' + expectedModules + '×' + expectedModules + ' / ' + datas + ' 数据帧 + ' + descriptors + ' 描述符帧'
})

check('5b. 三种模式的描述符帧与数据帧尺寸一致（固定版本）', () => {
  const data = makeData(2000, 21)
  const notes = []
  for (const mode of [protocol.MODE_SEQUENTIAL, protocol.MODE_FOUNTAIN, protocol.MODE_RAPTORQ]) {
    const sender = codecs.createSender(mode, { data, name: 'fixed.bin', sessionId: 3, symbolSize: 400 })
    const version = qr.versionFor(sender.frameLength, 'L')
    const descMatrix = qr.encode(protocol.encodeDescriptor(sender.descriptor), 'L', version)
    const coord = sender.frameCoord(0)
    const dataFrame = protocol.encodeDataFrame(3, coord.blockIndex, coord.esi, sender.symbol(coord.blockIndex, coord.esi))
    const dataMatrix = qr.encode(dataFrame, 'L', version)
    eq(descMatrix.moduleCount, dataMatrix.moduleCount, codecs.modeKey(mode) + '：描述符与数据帧模块数不一致')
    notes.push(codecs.modeKey(mode) + ' v' + version)
  }
  return notes.join(' / ')
})

/* ------------------- 6. 参数边界 ------------------- */

group('§6.6 参数边界')

check('6. 参数边界：1 字节文件 / 空文件 / 非整除切片 / 超大切片', () => {
  const notes = []

  // (a) 1 字节
  const one = Uint8Array.from([0x5a])
  const oneTrip = memoryRoundTrip(protocol.MODE_SEQUENTIAL, one, 400)
  eq(oneTrip.out.length, 1, '1 字节文件还原后长度不对')
  assert(sameBytes(oneTrip.out, one), '1 字节文件内容不对')
  eq(oneTrip.sender.descriptor.totalSymbols, 1, '1 字节文件应当只占 1 片')
  eq(oneTrip.sender.frameLength, 414, '帧长应当是 400+14')
  notes.push('1B→1片')

  // (b) 空文件（0 字节）
  const empty = new Uint8Array(0)
  const emptyTrip = memoryRoundTrip(protocol.MODE_SEQUENTIAL, empty, 400)
  eq(emptyTrip.out.length, 0, '空文件还原后应当还是 0 字节')
  eq(emptyTrip.sender.descriptor.totalSymbols, 1, '空文件也要有 1 片（补零）')
  notes.push('0B→1片')

  // (c) 非整除切片：1001 / 400 = 2.5 → 3 片，最后一片补零
  const odd = makeData(1001, 4)
  const oddTrip = memoryRoundTrip(protocol.MODE_SEQUENTIAL, odd, 400)
  eq(oddTrip.sender.descriptor.totalSymbols, 3, '1001B/400B 应当是 3 片')
  assert(sameBytes(oddTrip.out, odd), '非整除切片还原不一致')
  const lastSymbol = oddTrip.sender.symbol(0, 2)
  eq(lastSymbol.length, 400, '最后一片必须补零到固定长度')
  // 1001B：第 3 片承载 201 字节真实数据（下标 0..200），201..399 必须是零填充
  eq(lastSymbol[200], odd[1000], '最后一片的最后一个真实字节不对')
  eq(lastSymbol[201], 0, '最后一片的补零起点不对')
  eq(lastSymbol[399], 0, '最后一片末尾必须是零填充')
  notes.push('1001B→3片(末片补零)')

  // (d) 超大切片：800B 是 UI 上限
  const big = makeData(3000, 6)
  const bigTrip = memoryRoundTrip(protocol.MODE_SEQUENTIAL, big, 800)
  eq(bigTrip.sender.frameLength, 814, '800B 切片帧长应为 814')
  assert(sameBytes(bigTrip.out, big), '800B 切片还原不一致')
  notes.push('800B切片')

  // (e) 超出 QR 单帧容量的切片必须抛「Error」而不是静默出错
  const maxFrame = qr.maxFrameBytes('L')
  assert(maxFrame > 0 && maxFrame < 3000, 'QR 单帧上限看起来不对：' + maxFrame)
  let threw = null
  try {
    qr.versionFor(3000, 'L')
  } catch (err) {
    threw = err
  }
  assert(threw, '超容量时应当抛错')
  assert(threw instanceof Error, '超容量抛出的应当是 Error（qrcode-generator 内部溢出抛的是字符串，由 qr.js 兜住了）')
  assert(String(threw.message || threw).length > 0, '错误信息不能为空')
  notes.push('超容量(' + maxFrame + 'B)抛 Error')

  // (f) scanHint 在超大切片 + 小窗口时给出警告
  const tight = codecs.scanHint(800, 'L', qr, 200)
  eq(tight.ok, false, '800B 切片在 200px 码窗里应当判定为不可扫（每模块 ' + tight.pxPerModule.toFixed(2) + 'px）')
  const roomy = codecs.scanHint(200, 'L', qr, 1440)
  eq(roomy.ok, true, '200B 切片在 1440px 码窗里应当判定为可扫（每模块 ' + roomy.pxPerModule.toFixed(2) + 'px）')
  notes.push('scanHint 边界正常')

  return notes.join(' / ')
})

/** 内存往返（不经像素），返回 sender/receiver/out */
function memoryRoundTrip(mode, data, symbolSize) {
  const sessionId = protocol.makeSessionId(data)
  const sender = codecs.createSender(mode, { data, name: 'edge.bin', sessionId, symbolSize })
  const descriptor = protocol.decodeFrame(protocol.encodeDescriptor(sender.descriptor))
  const receiver = codecs.createReceiver(descriptor)
  const limit = Number.isFinite(sender.totalFrames) ? sender.totalFrames * 5 : 400
  for (let i = 0; i < limit && !receiver.isComplete; i++) {
    const coord = sender.frameCoord(i)
    receiver.add(coord.blockIndex, coord.esi, sender.symbol(coord.blockIndex, coord.esi))
  }
  const out = receiver.assemble()
  assert(out, '内存往返没能收全')
  return { sender, receiver, out }
}

/* ------------------- 7. 发送端调度与智能补发 ------------------- */

group('§7 发送端调度 / 智能补发 / 计划自洽（补充，非规范要求）')

/** 连续取 n 个「数据帧」的序号（跳过描述符帧） */
function collectIndices(engine, n) {
  const out = []
  let guard = 0
  while (out.length < n) {
    if (++guard > n * 40 + 200) throw new Error('collectIndices 死循环')
    const item = engine.next()
    if (item.kind === 'data') out.push(item.index)
  }
  return out
}

check('7. 顺序模式一轮的播放序列是 0..N-1，且描述符按间隔插入', () => {
  const dom = makeDom('index.html')
  const box = createSandbox(dom, { utoolsBridge: {} })
  box.run('sender.js')
  const data = makeData(2000, 31) // 2000/400 = 5 片
  const engine = box.sandbox.ASQ.createEngine({
    data,
    name: 'sched.bin',
    mode: protocol.MODE_SEQUENTIAL,
    symbolSize: 400,
    fps: 10,
    ecc: 'L',
    repeatDescriptor: 4,
    repairRatio: 0
  })
  const plan = engine.plan
  const kinds = []
  const indices = []
  for (let i = 0; i < plan.itemsPerRound; i++) {
    const item = engine.next()
    kinds.push(item.kind)
    if (item.kind === 'data') indices.push(item.index)
  }
  eq(plan.totalSymbols, 5, '2000B/400B 应当是 5 片')
  eq(plan.itemsPerRound, 7, '每 4 项插 1 个描述符 → 5 + ceil(5/3) = 7')
  eq(indices.join(','), '0,1,2,3,4', '一轮必须顺序覆盖 0..N-1，第二轮才能从头开始')
  eq(kinds[0], 'descriptor', '第一个播放项必须是描述符帧（方便中途加入的接收端）')
  const descriptorPositions = kinds.map((k, i) => (k === 'descriptor' ? i : -1)).filter((i) => i >= 0)
  eq(descriptorPositions.join(','), '0,4', '描述符插入位置不对')
  eq(plan.descriptorsPerRound, 2, '一轮里的描述符帧数不对')
  // 第二轮依旧从 0 开始（轮播）
  eq(collectIndices(engine, 3).join(','), '0,1,2', '第二轮应当从头开始')
  return '一轮 ' + plan.itemsPerRound + ' 项（5 数据 + 2 描述符）'
})

check('7b. 智能补发：无反馈时按 staleness 加权，有反馈时按真实缺口', () => {
  const dom = makeDom('index.html')
  const box = createSandbox(dom, { utoolsBridge: {} })
  box.run('sender.js')
  const data = makeData(4000, 77) // 4000/400 = 10 片

  function makeEngine(repairRatio, gapProvider) {
    return box.sandbox.ASQ.createEngine({
      data,
      name: 'repair.bin',
      mode: protocol.MODE_SEQUENTIAL,
      symbolSize: 400,
      fps: 10,
      ecc: 'L',
      repeatDescriptor: 1000,
      repairRatio,
      gapProvider
    })
  }

  // (a) ratio=0 → 纯轮播，无补发
  const off = makeEngine(0, null)
  eq(collectIndices(off, 24).join(','), '0,1,2,3,4,5,6,7,8,9,0,1,2,3,4,5,6,7,8,9,0,1,2,3', 'ratio=0 时必须是纯轮播')
  eq(off.stats().repairsSent, 0, 'ratio=0 时不该有补发')
  eq(off.repairMode(), 'off', 'ratio=0 时补发档位应当是 off')
  eq(off.plan.repairPerRound, 0, 'ratio=0 时计划里的补发帧数应当是 0')

  // (b) ratio=0.3 → 每轮后补 3 个，按「最久未播」= 本轮最早播的 0,1,2
  const heur = makeEngine(0.3, null)
  const seq = collectIndices(heur, 13)
  eq(seq.slice(0, 10).join(','), '0,1,2,3,4,5,6,7,8,9', '第一轮还是 0..9')
  eq(seq.slice(10).join(','), '0,1,2', '补发段应当挑最久未播的 0,1,2（统计加权）')
  eq(heur.stats().repairsSent, 3, '补发帧计数不对')
  eq(heur.stats().repairSource, 'heuristic', '无反馈时来源应标为 heuristic')
  eq(heur.repairMode(), 'heuristic', '档位不对')
  eq(heur.plan.repairPerRound, 3, '计划里的补发帧数应为 round(10*0.3)=3')

  // (c) 有真实反馈 → 精确补缺口（这才是 100% 有效的补发）
  const gaps = [7, 8]
  const gap = makeEngine(0.1, () => gaps)
  const gapSeq = collectIndices(gap, 12)
  eq(gapSeq.slice(0, 10).join(','), '0,1,2,3,4,5,6,7,8,9', '第一轮还是 0..9')
  eq(gapSeq.slice(10).join(','), '7,8', '有反馈时应当精确补发缺口 7,8')
  eq(gap.stats().repairSource, 'gap', '有反馈时来源应标为 gap')
  eq(gap.stats().repairsSent, 2, '缺口补发计数不对')
  return 'off→纯轮播 / heuristic→0,1,2 / gap→7,8'
})

check('7c. 计划里的「一轮」耗时与补发帧数自洽（这是接收端中途加入的最坏等待）', () => {
  const dom = makeDom('index.html')
  const box = createSandbox(dom, { utoolsBridge: {} })
  box.run('sender.js')
  const plan = box.sandbox.ASQ.plan({
    name: 'x.bin', byteLength: 4000, mode: protocol.MODE_SEQUENTIAL,
    symbolSize: 400, fps: 10, ecc: 'L', repeatDescriptor: 20, repairRatio: 0.2
  })
  eq(plan.totalSymbols, 10, '分片数不对')
  eq(plan.itemsPerRound, 11, '一轮播放项公式不对（10 + ceil(10/19)）')
  eq(plan.descriptorsPerRound, 1, '一轮描述符帧数不对')
  eq(plan.repairPerRound, 2, '补发帧数不对')
  eq(plan.totalItemsPerRound, 13, '含补发的一轮总数不对')
  assert(Math.abs(plan.roundSeconds - 1.1) < 1e-9, '一轮耗时不对：' + plan.roundSeconds)
  assert(Math.abs(plan.roundSecondsWithRepair - 1.3) < 1e-9, '含补发的一轮耗时不对：' + plan.roundSecondsWithRepair)
  assert(plan.roundSecondsWithRepair > plan.roundSeconds, '补发会拉长轮长——UI 上必须如实体现')
  return '一轮 13 项 / 1.3s（含 2 个补发帧）'
})

check('7d. 喷泉码/RaptorQ 不循环；每帧渲染缓存键唯一（fountain 曾经会全部命中同一帧）', () => {
  const dom = makeDom('index.html')
  const box = createSandbox(dom, { utoolsBridge: {} })
  box.run('sender.js')
  for (const mode of [protocol.MODE_FOUNTAIN, protocol.MODE_RAPTORQ]) {
    const engine = box.sandbox.ASQ.createEngine({
      data: makeData(4000, 8), name: 'f.bin', mode, symbolSize: 1400, fps: 30, ecc: 'L',
      repeatDescriptor: 17, repairRatio: 0
    })
    eq(engine.loops, false, codecs.modeKey(mode) + ' 不该标记为循环')
    eq(engine.total, Infinity, codecs.modeKey(mode) + ' 的 totalFrames 应当是 Infinity')

    const keys = new Set()
    const dataKeys = new Set()
    const payloads = new Set()
    let dataFrames = 0
    let descriptors = 0
    for (let i = 0; i < 40; i++) {
      const item = engine.next()
      keys.add(item.key)
      if (item.kind === 'data') {
        eq(item.bytes.length, 10 + 1400 + 4, codecs.modeKey(mode) + ' 的数据帧长度不对')
        // 发出去的必须是完整帧（带 magic/坐标/CRC），不是裸符号
        const parsed = protocol.decodeFrame(item.bytes)
        assert(parsed && parsed.type === protocol.TYPE_DATA, codecs.modeKey(mode) + '：发出去的必须是可解的完整数据帧')
        eq(parsed.esi, item.coord.esi, codecs.modeKey(mode) + '：帧里的 esi 与坐标不一致')
        eq(parsed.blockIndex, item.coord.blockIndex, codecs.modeKey(mode) + '：帧里的 blockIndex 与坐标不一致')
        dataKeys.add(item.key)
        payloads.add(Buffer.from(item.bytes).toString('base64'))
        dataFrames++
      } else {
        descriptors++
      }
    }
    // 描述符帧内容相同、共用缓存键；每个数据帧必须有各自的键（否则会一直显示同一帧）
    assert(!dataKeys.has('descriptor'), '数据帧的缓存键不该和描述符撞车')
    eq(dataKeys.size, dataFrames, codecs.modeKey(mode) + '：每个数据帧的渲染缓存键都必须唯一')
    eq(keys.size, dataFrames + 1, codecs.modeKey(mode) + '：缓存键总数应为数据帧数 + 1 个描述符键')
    eq(payloads.size, dataFrames, codecs.modeKey(mode) + '：每一帧的内容都必须不同（喷泉码不该重复发同一个符号）')
    assert(descriptors > 0, codecs.modeKey(mode) + '：40 个播放项里应当穿插描述符帧')
  }
  return 'Fountain/RaptorQ 都是无限且不重复的符号流'
})

/* ------------------- 8. 发送端页面控制器（真渲染循环） ------------------- */

group('§8 码窗渲染循环（真跑 createPlayer）')

check('8. 码窗渲染循环：canvas 被真实绘制、HUD 更新、进度回传', () => {
  const dom = makeDom('sender.html')
  const sent = []
  const bridge = {
    getStartPayload: () => ({
      name: '循环测试.bin',
      source: { kind: 'text', text: '循环测试内容' },
      options: { mode: protocol.MODE_SEQUENTIAL, symbolSize: 400, fps: 30, ecc: 'L', repeatDescriptor: 4, repairRatio: 0 }
    }),
    readFile: () => ({ name: 'x', bytes: new Uint8Array(0) }),
    sendToParent: (channel, data) => sent.push({ channel, data }),
    close: () => {}
  }
  const box = createSandbox(dom, { utoolsBridge: bridge })
  box.sandbox.__ASQ_SENDER_PAGE__ = true
  box.run('sender.js')

  const canvas = dom.registry.get('code')
  assert(canvas, 'sender.html 里没有 #code 画布')
  assert(canvas._ctx && canvas._ctx.fillCalls > 0, '画布没有被绘制')

  // 推进若干帧
  const advanced = box.flush(6)
  assert(advanced >= 6, '渲染循环没有继续调度下一帧')
  assert(canvas._ctx.fillCalls > 6, '填充次数不足以说明画出了 QR 模块')
  eq(canvas.width, canvas.height, 'QR 画布必须是正方形（否则模块会被拉变形）')

  eq(dom.registry.get('hud-name').textContent, '循环测试.bin', 'HUD 文件名没更新')
  eq(dom.registry.get('hud-mode').textContent, codecs.infoFor(protocol.MODE_SEQUENTIAL).label, 'HUD 模式名不对')
  assert(dom.registry.get('hud-frame').textContent.length > 0, 'HUD 当前帧没更新')
  assert(dom.registry.get('hud-version').textContent.indexOf('v') === 0, 'HUD 版本没更新')
  assert(dom.registry.get('hud-repair').textContent.indexOf('关闭') >= 0, 'HUD 补发状态不对：' + dom.registry.get('hud-repair').textContent)

  // 进度必须回传给主窗口（发送端只知道「已播放」）
  const progress = sent.filter((s) => s.channel === 'otp:progress')
  assert(progress.length > 0, '没有回传 otp:progress')
  assert(typeof progress[0].data.shown === 'number', '进度里没有 shown')
  return '绘制 ' + canvas._ctx.fillCalls + ' 次填充 / 回传 ' + progress.length + ' 次进度'
})

check('8b. 码窗渲染的是真实可扫的 QR（把画出来的矩阵再解一遍）', () => {
  const dom = makeDom('index.html')
  const box = createSandbox(dom, { utoolsBridge: {} })
  box.run('sender.js')
  const data = makeData(1200, 55)
  const engine = box.sandbox.ASQ.createEngine({
    data, name: 'render.bin', mode: protocol.MODE_SEQUENTIAL, symbolSize: 400, fps: 10, ecc: 'L',
    repeatDescriptor: 1000, repairRatio: 0
  })
  const renderer = box.sandbox.ASQ.createRenderer(engine.plan)
  const receiver = codecs.createReceiver(
    protocol.decodeFrame(protocol.encodeDescriptor(engine.sender.descriptor))
  )
  let frames = 0
  for (let i = 0; i < 20 && !receiver.isComplete; i++) {
    const item = engine.next()
    const matrix = renderer.matrixFor(item.bytes, item.key)
    const img = qr.toImageData(matrix, { scale: 3, quiet: 2 })
    const parsed = scan.decodeFrameFromImage(protocol, img.data, img.width, img.height)
    assert(parsed, '渲染器产出的矩阵解不出来')
    if (parsed.type === protocol.TYPE_DATA) {
      receiver.add(parsed.blockIndex, parsed.esi, parsed.payload)
      frames++
    }
  }
  assert(receiver.isComplete, '用渲染器的矩阵没能收全')
  assert(sameBytes(receiver.assemble(), data), '渲染器链路还原的字节不一致')
  return frames + ' 帧还原 1200B，缓存 ' + renderer.size + ' 个矩阵'
})

/* ------------------- 9. 接收端页面控制器与降级路径 ------------------- */

group('§9 接收端引擎与无摄像头降级路径')

check('9. 无摄像头时接收窗口走降级路径（提示改用截图/图片导入）', () => {
  const dom = makeDom('receiver.html')
  const box = createSandbox(dom, { utoolsBridge: {} })
  box.sandbox.__ASQ_RECEIVER_PAGE__ = true
  // sandbox 里 navigator 没有 mediaDevices → cameraSupported() === false
  box.run('receiver.js')

  const status = dom.registry.get('status').textContent
  assert(/不支持摄像头|不可用/.test(status), '降级提示没有出现：' + status)
  eq(dom.registry.get('fallback').hidden, false, '降级面板应当显示出来')
  assert(dom.registry.get('mode').textContent.indexOf('描述符') >= 0, '还没收到描述符时应显示等待提示')
  assert(dom.registry.get('pick-image') && dom.registry.get('capture-screen') && dom.registry.get('retry-camera'), '降级按钮不全')
  // 没有摄像头时也能通过 scanImageData 吃东西（静态图片路径）
  const scanner = box.sandbox.ASQ.receiver.createScanner({
    canvas: dom.registry.get('work'),
    onFrame() {}
  })
  eq(typeof scanner.scanImageData, 'function', '缺少静态图片识别入口')
  eq(box.sandbox.ASQ.receiver.cameraSupported(), false, '桩环境里不应该报告摄像头可用')
  return '降级面板已显示：' + status.slice(0, 24) + '…'
})

check('9b. 接收引擎能摄入真像素解出的帧并记录会话切换/陈旧帧', () => {
  const engine = receiverEngine()
  const data = makeData(800, 12)
  const sessionId = protocol.makeSessionId(data)
  const sender = codecs.createSender(protocol.MODE_SEQUENTIAL, {
    data, name: 'ingest.bin', sessionId, symbolSize: 400
  })
  const version = qr.versionFor(sender.frameLength, 'L')

  // 描述符
  const descImg = qr.toImageData(
    qr.encode(protocol.encodeDescriptor(sender.descriptor), 'L', version),
    { scale: 3, quiet: 4 }
  )
  const desc = scan.decodeFrameFromImage(protocol, descImg.data, descImg.width, descImg.height)
  const first = engine.ingest(desc)
  assert(first.newSession, '第一帧描述符应当标记为新会话')
  eq(engine.ingest(desc).newSession, undefined, '同一描述符重复出现不应该再重建解码器')
  eq(engine.name(), 'ingest.bin', '文件名不对')
  eq(engine.needed(), 2, '需要 2 片')

  // 一个不属于本会话的数据帧
  eq(engine.ingest({ type: protocol.TYPE_DATA, sessionId: (sessionId + 1) & 0xffff, blockIndex: 0, esi: 0, payload: new Uint8Array(400) }).kind, 'stale-session', '陈旧帧没被识别')

  // 真正的数据帧
  for (let i = 0; i < 2; i++) {
    const coord = sender.frameCoord(i)
    const frame = protocol.decodeFrame(
      protocol.encodeDataFrame(sessionId, coord.blockIndex, coord.esi, sender.symbol(coord.blockIndex, coord.esi))
    )
    engine.ingest(frame)
  }
  eq(engine.isComplete(), true, '两片收齐后应当完成')
  assert(sameBytes(engine.assemble(), data), '还原不一致')
  eq(engine.progress(), 1, '进度应当是 100%')
  eq(engine.ingest({ type: protocol.TYPE_DATA, sessionId, blockIndex: 0, esi: 0, payload: new Uint8Array(400) }).kind, 'duplicate', '重复帧没被识别')
  const stats = engine.stats()
  assert(stats.accepted === 2 && stats.duplicate === 1 && stats.stale === 1, '统计不对：' + JSON.stringify(stats))
  return '会话/陈旧/重复帧都被正确区分'
})

check('9c. 顺序模式缺片时能枚举缺失序号、且不谎报进度', () => {
  const data = makeData(2000, 13)
  const sender = codecs.createSender(protocol.MODE_SEQUENTIAL, {
    data, name: 'gap.bin', sessionId: 5, symbolSize: 400
  })
  const engine = receiverEngine()
  engine.ingest(protocol.decodeFrame(protocol.encodeDescriptor(sender.descriptor)))
  const coords = [0, 2, 4]
  for (const i of coords) {
    const coord = sender.frameCoord(i)
    engine.ingest(
      protocol.decodeFrame(protocol.encodeDataFrame(5, coord.blockIndex, coord.esi, sender.symbol(coord.blockIndex, coord.esi)))
    )
  }
  eq(engine.received(), 3, '已收片数不对')
  eq(engine.needed(), 5, '需要的片数不对')
  eq(engine.isComplete(), false, '缺片时不能报告完成')
  eq(engine.assemble(), null, '缺片时 assemble 必须是 null')
  assert(Math.abs(engine.progress() - 0.6) < 1e-9, '进度应当是 60%')
  eq(engine.missing(10).join(','), '1,3', '缺失序号枚举不对（这正是智能补发要补的东西）')
  return '收到 3/5，缺 1,3'
})

/* ------------------- 10. 交付自检（PLUGIN-SPEC §7） ------------------- */

group('PLUGIN-SPEC §7 交付前自检清单')

/** 只从标签属性里取外部引用，避免把内联 JS 字符串里的 src=" 也算进来 */
function externalRefs(html) {
  const refs = []
  const re = /<(?:script|link|img|source)[^>]*\b(?:src|href)="([^"]+)"/gi
  let m
  while ((m = re.exec(html))) {
    if (/^(https?:|data:|#|\/\/)/.test(m[1])) continue
    refs.push(m[1])
  }
  return refs
}

check('10. 交付自检：文件齐全、没有 CSP meta、没有引用插件目录外的文件', () => {
  const required = [
    'plugin.json', 'logo.png', 'preload.js',
    'index.html', 'index.js', 'index.css',
    'sender.html', 'sender.js', 'sender-preload.js',
    'receiver.html', 'receiver.js', 'receiver-preload.js',
    'standalone.html',
    'core/protocol.js', 'core/fountain.js', 'core/qr.js', 'core/scan.js', 'core/codecs.js',
    'vendor/qrcode-generator.js', 'vendor/jsQR.js',
    'test/plugin.test.js'
  ]
  const missing = required.filter((f) => !fs.existsSync(path.join(ROOT, f)))
  eq(missing.length, 0, '缺少文件：' + missing.join(', '))

  // shared/ 是只读共享核心，插件里的副本必须与它逐字节一致
  const sharedRoot = path.join(ROOT, '..', 'shared')
  const copies = [
    'core/protocol.js', 'core/fountain.js', 'core/qr.js', 'core/scan.js', 'core/codecs.js',
    'vendor/qrcode-generator.js', 'vendor/jsQR.js'
  ]
  for (const rel of copies) {
    const a = fs.readFileSync(path.join(ROOT, rel))
    const b = fs.readFileSync(path.join(sharedRoot, rel))
    assert(a.equals(b), rel + ' 与 shared/ 里的原版不一致（共享核心不许改）')
  }

  // 插件目录内不许有构建残留
  const dirty = ['node_modules', '.git', 'dist']
  for (const d of dirty) {
    assert(!fs.existsSync(path.join(ROOT, d)), '插件目录里不该有 ' + d)
  }

  // vendor/ 必须只有方案一需要的两个库：不许夹带 raptorqr 的 WASM 内核
  // （夹带会让「本插件不含 WASM 核」这句话变成假的）
  const vendorFiles = fs.readdirSync(path.join(ROOT, 'vendor')).sort()
  eq(vendorFiles.join(','), 'jsQR.js,qrcode-generator.js', 'vendor/ 内容不对')
  assert(!fs.existsSync(path.join(ROOT, 'vendor/raptorq.core.wasm')), '方案一不该带 RaptorQ 的 wasm')
  const codecsSrc = fs.readFileSync(path.join(ROOT, 'core/codecs.js'), 'utf8')
  assert(codecsSrc.indexOf('raptorqCore') >= 0, '共享核心应当保留 raptorqCore 的挂载点（只是本插件不注入）')
  // 本插件的任何页面都不许加载 raptorq.core.js（三个页面直接查字节）
  for (const file of ['index.html', 'sender.html', 'receiver.html']) {
    assert(
      fs.readFileSync(path.join(ROOT, file), 'utf8').indexOf('raptorq.core.js') < 0,
      file + ' 不该加载 raptorq.core.js'
    )
  }
  // standalone 里出现该字符串只是 codecs.js 的报错文案，用「外部引用」的方式判定
  for (const ref of externalRefs(fs.readFileSync(path.join(ROOT, 'standalone.html'), 'utf8'))) {
    assert(ref.indexOf('raptorq') < 0, 'standalone.html 不该引用 raptorq.*：' + ref)
  }

  const htmls = ['index.html', 'sender.html', 'receiver.html', 'standalone.html']
  for (const file of htmls) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8')
    assert(
      !/http-equiv=["']Content-Security-Policy["']/i.test(html),
      file + ' 里不该有 CSP meta（本地协议下会白屏）'
    )
    for (const ref of externalRefs(html)) {
      assert(fs.existsSync(path.join(ROOT, ref)), file + ' 引用了不存在的文件：' + ref)
    }
  }

  // plugin.json 合法、code 唯一、main 是相对路径的 .html
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'))
  assert(/\.html$/.test(plugin.main) && !/^([a-zA-Z]+:|\/)/.test(plugin.main), 'main 必须是相对路径的 .html')
  assert(fs.existsSync(path.join(ROOT, plugin.logo)), 'logo 不存在')
  assert(fs.existsSync(path.join(ROOT, plugin.preload)), 'preload 不存在')
  const codes = plugin.features.map((f) => f.code)
  eq(new Set(codes).size, codes.length, 'features[].code 必须唯一')
  assert(codes.every((c) => c.indexOf('asq-') === 0), 'features[].code 应带 asq 前缀：' + codes.join(','))
  assert(plugin.features.some((f) => f.code === 'asq-send-files' && JSON.stringify(f.cmds).indexOf('files') >= 0), '缺少文件匹配指令')
  eq(plugin.pluginSetting.height, 620, 'pluginSetting.height 应为 620')
  return required.length + ' 个文件齐全 / ' + codes.length + ' 个指令'
})

check('10b. standalone.html 是单文件自包含的（内联了核心，且与当前源码同步）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'standalone.html'), 'utf8')
  assert(html.indexOf('<!DOCTYPE html>') === 0, '不是完整 HTML')
  // 不许再有外部引用
  const refs = externalRefs(html)
  eq(refs.length, 0, '单文件版不该引用外部文件：' + refs.join(', '))
  // 内联内容必须和当前源码一致（防止改了 core 忘了重新生成）
  const markers = [
    ['core/protocol.js', 'var MAGIC = 0xa7'],
    ['core/codecs.js', 'MODE_INFO'],
    ['sender.js', 'ASQ.createEngine'],
    ['receiver.js', 'ASQ.receiver'],
    ['vendor/qrcode-generator.js', 'stringToBytes'],
    ['test/standalone-glue.js', 'asq-gap-v1']
  ]
  for (const [file, marker] of markers) {
    assert(html.indexOf(marker) >= 0, 'standalone.html 里没有内联 ' + file + '（是不是忘了 node test/build-standalone.js）')
  }
  // 单文件版必须自己接 DOM，不能启动别的页面的控制器
  assert(!/__ASQ_SENDER_PAGE__\s*=\s*true/.test(html), '单文件版不该启动 sender.html 的页面控制器')
  assert(!/__ASQ_RECEIVER_PAGE__\s*=\s*true/.test(html), '单文件版不该启动 receiver.html 的页面控制器')
  // 所有 <script> 块都必须闭合（源码里若出现 </script 必须被转义）
  const blocks = html.split('<script>').slice(1)
  assert(blocks.length >= 10, '内联的脚本块数量不对：' + blocks.length)
  for (const body of blocks) {
    assert(body.indexOf('</script>') >= 0, '有 script 块没有闭合（内联时 </script 没转义？）')
  }
  // 源码里的核心文件字节必须原样出现（抽查协议魔数与 CRC 表）
  assert(html.indexOf('0xedb88320') >= 0, 'core/protocol.js 的 CRC 表没被原样内联')

  // 最强的一致性检查：现场重新生成一份，必须与磁盘上的逐字节相同
  const generator = require('./build-standalone.js')
  const tmpOut = path.join(os.tmpdir(), 'airscan-standalone-fresh.html')
  generator.build(tmpOut)
  const fresh = fs.readFileSync(tmpOut, 'utf8')
  fs.unlinkSync(tmpOut)
  assert(
    fresh === html,
    'standalone.html 与当前源码不同步（改了 core/sender/receiver/glue 后忘了重新生成）：请运行 node test/build-standalone.js'
  )

  return (Buffer.byteLength(html) / 1024).toFixed(0) + ' KB 自包含 / ' + blocks.length + ' 个脚本块 / 与源码逐字节同步'
})

/* ------------------- 11. 收尾 ------------------- */

function receiverEngine() {
  // 每个用例一个干净的沙箱，避免状态串味
  const dom = makeDom('receiver.html')
  const box = createSandbox(dom, { utoolsBridge: {} })
  box.run('receiver.js')
  return box.sandbox.ASQ.receiver.createEngine()
}

async function main() {
  console.log('airscan-qr 插件测试（桩 DOM + 真实 QR 像素）—— node airscan-qr/test/plugin.test.js\n')
  await runAll()

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch (err) {
    /* 忽略 */
  }

  console.log(
    '\n' + (fail === 0 ? '✅ 全部通过：' + pass + ' 通过 / 0 失败' : '❌ ' + pass + ' 通过 / ' + fail + ' 失败')
  )
  if (failures.length) {
    console.log('\n--- 失败详情 ---\n' + failures.join('\n\n'))
  }
  process.exitCode = fail === 0 ? 0 : 1
}

main()
