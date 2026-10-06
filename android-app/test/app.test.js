/**
 * app.test.js —— 安卓 App 的无头验证
 *
 *   node test/app.test.js
 *
 * 真机之外的能验证的都放这里：核心一致性、页面结构、app.js 能否 boot、
 * 三种模式的收发往返、native.js 的降级、以及**安卓配置有没有被改回去**。
 *
 * 明确不覆盖（必须真机）：摄像头能否起、屏幕常亮/亮度是否生效、
 * 真机扫码帧率、APK 安装启动。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const HERE = __dirname
const APP_DIR = path.resolve(HERE, '..')
const WWW = path.join(APP_DIR, 'www')
const SHARED = path.resolve(APP_DIR, '..', 'shared')
const ANDROID = path.join(APP_DIR, 'android')

const CORE_FILES = ['protocol.js', 'fountain.js', 'qr.js', 'scan.js', 'codecs.js']
const VENDOR_FILES = ['qrcode-generator.js', 'jsQR.js', 'raptorq.core.js', 'raptorq.core.wasm']

let pass = 0
let fail = 0
/** 异步用例的 promise（同步 check 会漏掉异步失败 → 假绿，必须单独收） */
const pending = []

function check(name, fn) {
  const t0 = Date.now()
  try {
    const extra = fn()
    if (extra && typeof extra.then === 'function') {
      // 异步用例：失败必须计入 fail，不能变成未处理拒绝而悄悄通过
      pending.push(
        extra
          .then((msg) => {
            console.log(`  ✓ ${name}${msg ? ' — ' + msg : ''} (${Date.now() - t0}ms)`)
            pass++
          })
          .catch((err) => {
            console.log(`  ✗ ${name} → ${(err && err.message) || err}`)
            fail++
          })
      )
      return
    }
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''} (${Date.now() - t0}ms)`)
    pass++
  } catch (err) {
    console.log(`  ✗ ${name} → ${(err && err.message) || err}`)
    fail++
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/* ====================================================================== */
/* 1. www/ 与 shared/ 必须逐字节一致（协议不允许漂移）                      */
/* ====================================================================== */

console.log('\n=== 1. 共享核心一致性 ===')

check('www/core 与 www/vendor 都与 shared/ 逐字节一致', () => {
  for (const f of CORE_FILES) {
    const a = fs.readFileSync(path.join(SHARED, 'core', f))
    const b = fs.readFileSync(path.join(WWW, 'core', f))
    assert(Buffer.compare(a, b) === 0, `core/${f} 不一致`)
  }
  for (const f of VENDOR_FILES) {
    const a = fs.readFileSync(path.join(SHARED, 'vendor', f))
    const b = fs.readFileSync(path.join(WWW, 'vendor', f))
    assert(Buffer.compare(a, b) === 0, `vendor/${f} 不一致`)
  }
  const wasm = fs.statSync(path.join(WWW, 'vendor', 'raptorq.core.wasm'))
  return `${CORE_FILES.length + VENDOR_FILES.length} 个文件一致，wasm ${(wasm.size / 1024).toFixed(0)}KB`
})

/* ====================================================================== */
/* 2. 页面结构：脚本顺序 + id 交叉核对                                     */
/* ====================================================================== */

console.log('\n=== 2. 页面结构 ===')

const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8')
const appJs = fs.readFileSync(path.join(WWW, 'app.js'), 'utf8')

check('脚本加载顺序：vendor → core → native → app', () => {
  const srcs = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1])
  const idx = (needle) => srcs.findIndex((s) => s.indexOf(needle) >= 0)
  // 只检查 .js；wasm 不是 script（另外单独断言它在不在）
  for (const f of VENDOR_FILES.filter((f) => f.endsWith('.js'))) {
    assert(idx('vendor/' + f) >= 0, '缺 vendor/' + f)
  }
  assert(fs.existsSync(path.join(WWW, 'vendor', 'raptorq.core.wasm')), '缺 vendor/raptorq.core.wasm')
  assert(idx('vendor/raptorq.core.js') < idx('core/codecs.js'), 'raptorq.core.js 必须在 codecs 之前')
  for (const f of CORE_FILES) assert(idx('core/' + f) >= 0, '缺 core/' + f)
  assert(idx('core/codecs.js') === Math.max(...CORE_FILES.map((f) => idx('core/' + f))), 'codecs.js 必须是最后一个 core')
  assert(idx('core/codecs.js') < idx('native.js'), 'native.js 要在 core 之后')
  assert(idx('native.js') < idx('app.js'), 'app.js 必须最后')
  return srcs.length + ' 个脚本 + wasm'
})

check('index.html 与 app.js 的 id 交叉核对', () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
  // 注意：app.js 用的是 `$('id')` 辅助函数，不是直接 getElementById。
  // 早期版本这里只匹配 getElementById('字面量')，结果**一个都没匹配到**、
  // 检查形同虚设——所以两种写法都要覆盖，并且断言"确实检查到了足够多的 id"。
  const used = [
    ...appJs.matchAll(/\$\('([^']+)'\)/g),
    ...appJs.matchAll(/getElementById\('([^']+)'\)/g)
  ].map((m) => m[1])
  assert(used.length >= 20, '只匹配到 ' + used.length + ' 个 id，检查可能失效了')
  const missing = used.filter((id) => !htmlIds.has(id))
  assert(missing.length === 0, 'app.js 引用了不存在的元素：' + missing.join(', '))
  return `${used.length} 个 id 全部存在`
})

check('没有 CSP meta（本地/自定义协议下会白屏）', () => {
  assert(!/http-equiv=["']?Content-Security-Policy/i.test(html), '不该有 CSP meta')
})

check('没有引用网络资源', () => {
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1])
  const remote = refs.filter((r) => /^https?:\/\//i.test(r))
  assert(remote.length === 0, '引用了网络资源：' + remote.join(', '))
})

/* ====================================================================== */
/* 3. classic script 全局重名（白屏级）                                    */
/* ====================================================================== */

console.log('\n=== 3. 全局作用域检查 ===')

check('按顺序把所有脚本实例化进同一上下文，无重名', () => {
  const srcs = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1])
  const sandbox = { console: { log() {}, warn() {}, error() {} } }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  const ctx = vm.createContext(sandbox)
  const hits = []
  for (const s of srcs) {
    const p = path.join(WWW, s)
    if (!fs.existsSync(p)) continue
    try {
      vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: s })
    } catch (err) {
      const msg = (err && err.message) || String(err)
      if (/already been declared/i.test(msg)) hits.push(`${s}: ${msg}`)
      // 其它错误（缺 DOM）与本检查无关
    }
  }
  assert(hits.length === 0, hits.join(' / '))
  return srcs.length + ' 个脚本无重名'
})

/* ====================================================================== */
/* 4. app.js 能在桩 DOM 里 boot                                           */
/* ====================================================================== */

console.log('\n=== 4. App 启动 ===')

function makeElement(id) {
  const el = {
    id: id || '',
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    disabled: false,
    min: '0',
    max: '0',
    children: [],
    files: null,
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) {
      this.children.push(c)
      return c
    },
    removeChild() {},
    setAttribute() {},
    getAttribute: () => null,
    getContext: () => ({
      fillRect() {},
      drawImage() {},
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData() {},
      toDataURL: () => 'data:image/png;base64,'
    }),
    play: () => Promise.resolve(),
    click() {},
    focus() {}
  }
  return el
}

let box = null
check('app.js 在桩 DOM 里 boot 不报错，且导出 __APP__', () => {
  const srcs = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1])
  const noop = () => {}
  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Uint8Array,
    Uint8ClampedArray,
    ArrayBuffer,
    Int32Array,
    Float64Array,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Error,
    Date,
    RegExp,
    Map,
    Set,
    TextEncoder,
    TextDecoder,
    performance: { now: () => Date.now() },
    requestAnimationFrame: noop,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    navigator: { platform: 'Linux', userAgent: 'node', mediaDevices: null },
    location: { protocol: 'https:', href: 'https://localhost/' },
    isSecureContext: true,
    screen: { width: 1080, height: 1920 },
    devicePixelRatio: 3,
    addEventListener: noop,
    matchMedia: () => ({ matches: false }),
    crypto: undefined,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
    Blob: function () {},
    Image: function () {},
    CustomEvent: function () {},
    FileReader: function () {}
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  sandbox.document = {
    readyState: 'complete',
    documentElement: makeElement('html'),
    head: makeElement('head'),
    body: makeElement('body'),
    getElementById: (id) => makeElement(id),
    querySelector: () => null,
    createElement: (tag) => makeElement(tag),
    addEventListener: noop,
    exitFullscreen: () => Promise.resolve()
  }
  const ctx = vm.createContext(sandbox)
  for (const s of srcs) {
    const p = path.join(WWW, s)
    if (!fs.existsSync(p)) continue
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: s })
  }
  box = sandbox
  assert(sandbox.__APP__, '没有导出 window.__APP__')
  assert(typeof sandbox.__APP__.boot === 'function', '__APP__.boot 缺失')
  assert(sandbox.OTP && sandbox.OTP.codecs, 'OTP.codecs 没就位')
  const modes = sandbox.OTP.codecs.MODE_INFO.length
  return `boot 成功，OTP 三种模式就位（${modes}）`
})

check('native.js 在没有 Capacitor 时优雅降级', () => {
  const env = box.Native.envInfo()
  assert(env.native === false, '不该报告为原生环境')
  assert(env.plugins.KeepAwake === false, '不该声称有 KeepAwake')
  const r = box.Native.keepAwake(true)
  assert(r && Array.isArray(r.errors) && r.errors.length > 0, '应当给出"没有插件"的说明而不是抛错')
  return '降级正常：' + r.errors.length + ' 条说明'
})

/* ====================================================================== */
/* 5. 用 App 自己那份核心跑收发往返                                        */
/* ====================================================================== */

console.log('\n=== 5. 收发往返（用 www/core 自己那份核心）===')

check('三种模式的内存往返都能还原', () => {
  const protocol = require(path.join(WWW, 'core', 'protocol.js'))
  const codecs = require(path.join(WWW, 'core', 'codecs.js'))
  const notes = []

  for (const info of codecs.MODE_INFO) {
    const data = new Uint8Array(3000)
    let x = 12345
    for (let i = 0; i < data.length; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0
      data[i] = (x >>> 16) & 0xff
    }
    const sessionId = protocol.makeSessionId(data)
    const symbolSize = info.presets.symbolSize[Math.min(2, info.presets.symbolSize.length - 1)]
    const sender = codecs.createSender(info.mode, { data, name: '往返.bin', sessionId, symbolSize })
    const receiver = codecs.createReceiver(sender.descriptor)

    let index = 0
    let shown = 0
    while (!receiver.isComplete) {
      const c = sender.frameCoord(index)
      const sym = sender.symbol(c.blockIndex, c.esi)
      shown++
      if (shown % 5 !== 0) receiver.add(c.blockIndex, c.esi, sym) // 模拟丢 1/5
      index++
      if (index > 200000) throw new Error(info.key + ' 未收敛')
    }
    const out = receiver.assemble()
    assert(out && out.length === data.length, info.key + ' 长度不对')
    for (let i = 0; i < data.length; i++) assert(out[i] === data[i], info.key + ' 第 ' + i + ' 字节不符')
    if (sender.free) sender.free()
    notes.push(`${info.key}(${sender.backend}, ${(shown / sender.descriptor.totalSymbols).toFixed(2)}x)`)
  }
  return notes.join(' ')
})

check('描述符帧能过一遍真实 QR 像素', () => {
  const protocol = require(path.join(WWW, 'core', 'protocol.js'))
  const qr = require(path.join(WWW, 'core', 'qr.js'))
  const scan = require(path.join(WWW, 'core', 'scan.js'))
  const codecs = require(path.join(WWW, 'core', 'codecs.js'))
  const data = new Uint8Array(2000)
  const sender = codecs.createSender(codecs.MODE_INFO[0].mode, {
    data,
    name: '手机端测试.bin',
    sessionId: protocol.makeSessionId(data),
    symbolSize: 400
  })
  const frame = protocol.encodeDescriptor(sender.descriptor)
  const version = qr.versionFor(sender.frameLength, 'L')
  const img = qr.toImageData(qr.encode(frame, 'L', version), { scale: 3, quiet: 4 })
  const back = scan.decodeFrameFromImage(protocol, img.data, img.width, img.height)
  assert(back && back.type === protocol.TYPE_DESCRIPTOR, '描述符没能过像素链路')
  assert(back.name === '手机端测试.bin', '文件名不对：' + back.name)
  return `v${version} / ${img.width}px`
})

check('APK 里那份 RaptorQ WASM 真的能用（真 RFC 6330，不是占位）', () => {
  const protocol = require(path.join(WWW, 'core', 'protocol.js'))
  const codecs = require(path.join(WWW, 'core', 'codecs.js'))
  const raptorq = require(path.join(WWW, 'vendor', 'raptorq.core.js'))
  const bytes = fs.readFileSync(path.join(WWW, 'vendor', 'raptorq.core.wasm'))
  const mod = new WebAssembly.Module(bytes)
  assert(WebAssembly.Module.imports(mod).length === 0, 'wasm 必须零导入项（否则本地协议下实例化会失败）')

  return raptorq.loadFromBytes(bytes).then(function () {
    assert(raptorq.isAvailable(), 'wasm 加载失败：' + raptorq.status().error)
    codecs.setRaptorqCore(raptorq)
    const data = new Uint8Array(20000)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff
    const sender = codecs.createSender(protocol.MODE_RAPTORQ, {
      data,
      name: 'wasm.bin',
      sessionId: protocol.makeSessionId(data),
      symbolSize: 1400
    })
    assert(sender.backend === 'wasm', '应当走 wasm 后端，实际 ' + sender.backend)
    const receiver = codecs.createReceiver(sender.descriptor)
    assert(!receiver.error, '接收端报错：' + receiver.error)
    let i = 0
    while (!receiver.isComplete) {
      const c = sender.frameCoord(i)
      receiver.add(c.blockIndex, c.esi, sender.symbol(c.blockIndex, c.esi))
      i++
      if (i > 50000) throw new Error('未收敛')
    }
    const out = receiver.assemble()
    assert(out && out.length === data.length, '长度不对')
    for (let k = 0; k < data.length; k++) assert(out[k] === data[k], '第 ' + k + ' 字节不符')
    if (sender.free) sender.free()
    codecs.setRaptorqCore(null)
    return `${(bytes.length / 1024).toFixed(0)}KB / ABI v${raptorq.status().abiVersion} / 逐字节一致`
  })
})

/* ====================================================================== */
/* 6. 安卓配置回归（防止 cap sync / 重建把补丁抹掉）                        */
/* ====================================================================== */

console.log('\n=== 6. 安卓工程配置 ===')

check('AndroidManifest 声明了 CAMERA 权限', () => {
  const p = path.join(ANDROID, 'app/src/main/AndroidManifest.xml')
  assert(fs.existsSync(p), '找不到 AndroidManifest.xml')
  const s = fs.readFileSync(p, 'utf8')
  assert(/android\.permission\.CAMERA/.test(s), '缺 CAMERA 权限 —— 摄像头会直接失败')
  assert(/hardware\.camera"[^>]*required="false"/.test(s), 'camera 应标 required=false（发送端不需要摄像头）')
  return 'CAMERA + required=false'
})

check('Gradle 用了国内镜像（官方源只有 26-180 KB/s）', () => {
  const p = path.join(ANDROID, 'build.gradle')
  const s = fs.readFileSync(p, 'utf8')
  assert(s.indexOf('maven.aliyun.com') >= 0, 'build.gradle 里没有阿里云镜像')
  const n = (s.match(/maven\.aliyun\.com/g) || []).length
  assert(n >= 6, '镜像应当同时加进 buildscript 与 allprojects，实际只出现 ' + n + ' 次')
  return n + ' 处镜像'
})

check('Gradle wrapper 用腾讯镜像 + -bin', () => {
  const p = path.join(ANDROID, 'gradle/wrapper/gradle-wrapper.properties')
  const s = fs.readFileSync(p, 'utf8')
  assert(/distributionUrl=.*mirrors\.cloud\.tencent\.com/.test(s), '发行版没有指向腾讯镜像')
  assert(/-bin\.zip/.test(s), '应当用 -bin 而不是 -all（少下约 70MB）')
  const m = /gradle-([0-9.]+)-bin\.zip/.exec(s)
  return 'gradle ' + (m ? m[1] : '?')
})

check('capacitor.config.json 配置正确（https scheme = 安全上下文）', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'capacitor.config.json'), 'utf8'))
  assert(cfg.webDir === 'www', 'webDir 应为 www')
  assert(cfg.appId && cfg.appId.indexOf('.') > 0, 'appId 不规范：' + cfg.appId)
  assert(cfg.server && cfg.server.androidScheme === 'https', 'androidScheme 必须是 https（否则不是安全上下文，摄像头/加密 API 会被拒）')
  return cfg.appId + ' / scheme=' + cfg.server.androidScheme
})

Promise.all(pending).then(() => {
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败（含 ${pending.length} 个异步用例）`)
  console.log('注：摄像头能否起、常亮/亮度是否生效、真机扫码帧率、APK 安装启动 —— 这些必须真机验证。\n')
  process.exitCode = fail ? 1 : 0
})
