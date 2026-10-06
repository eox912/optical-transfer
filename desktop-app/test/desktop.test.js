/**
 * desktop.test.js —— 桌面版的无头验证
 *
 *   node test/desktop.test.js
 *
 * 重点是三类**跨文件契约**，它们的错误否则只在运行时才暴露：
 *   1. main.js 注册的 IPC 通道  ↔  preload.js invoke 的通道
 *   2. preload.js 暴露的键      ↔  native.js 里实际用到的键
 *   3. 安卓 native.js 的接口    ⊆  桌面 native.js 的接口（两端共用一份 UI，不能漂移）
 *
 * 另外还校验：核心与 shared 逐字节一致、UI 与 android-app/src 逐字节一致、
 * 页面结构与全局作用域、以及 electron-builder 的打包配置。
 *
 * **真正的"能跑起来"由 `npm run smoke` 验证**（真 Electron 进程 + 真 wasm + 真往返）。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { execFileSync } = require('child_process')

const HERE = __dirname
const APP = path.resolve(HERE, '..')
const WWW = path.join(APP, 'www')
const SRC = path.join(APP, 'src')
const ROOT = path.resolve(APP, '..')
const SHARED = path.join(ROOT, 'shared')
const ANDROID_SRC = path.join(ROOT, 'android-app', 'src')

const CORE_FILES = ['protocol.js', 'fountain.js', 'qr.js', 'scan.js', 'codecs.js']
const VENDOR_FILES = ['qrcode-generator.js', 'jsQR.js', 'raptorq.core.js', 'raptorq.core.wasm']
const UI_FILES = ['index.html', 'app.css', 'app.js']

let pass = 0
let fail = 0
/** 异步用例（同步 check 会漏掉异步失败 → 假绿） */
const pending = []

function check(name, fn) {
  try {
    const extra = fn()
    if (extra && typeof extra.then === 'function') {
      pending.push(
        extra.then(
          (msg) => {
            console.log(`  ✓ ${name}${msg ? ' — ' + msg : ''}`)
            pass++
          },
          (err) => {
            console.log(`  ✗ ${name} → ${(err && err.message) || err}`)
            fail++
          }
        )
      )
      return
    }
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`)
    pass++
  } catch (err) {
    console.log(`  ✗ ${name} → ${(err && err.message) || err}`)
    fail++
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function read(p) {
  return fs.readFileSync(p, 'utf8')
}

/* ====================================================================== */
console.log('\n=== 1. 共享核心与共用界面 ===')

check('www/core 与 www/vendor 与 shared/ 逐字节一致', () => {
  for (const f of CORE_FILES) {
    assert(Buffer.compare(fs.readFileSync(path.join(SHARED, 'core', f)), fs.readFileSync(path.join(WWW, 'core', f))) === 0, 'core/' + f)
  }
  for (const f of VENDOR_FILES) {
    assert(Buffer.compare(fs.readFileSync(path.join(SHARED, 'vendor', f)), fs.readFileSync(path.join(WWW, 'vendor', f))) === 0, 'vendor/' + f)
  }
  const wasm = fs.statSync(path.join(WWW, 'vendor', 'raptorq.core.wasm'))
  return `${CORE_FILES.length + VENDOR_FILES.length} 个一致，wasm ${(wasm.size / 1024).toFixed(0)}KB`
})

check('界面文件与 android-app/src 逐字节一致（两端真的共用一份 UI）', () => {
  for (const f of UI_FILES) {
    const a = fs.readFileSync(path.join(ANDROID_SRC, f))
    const b = fs.readFileSync(path.join(WWW, f))
    assert(Buffer.compare(a, b) === 0, f + ' 与 android-app/src 不一致')
  }
  return UI_FILES.join(' / ')
})

/* ====================================================================== */
console.log('\n=== 2. 跨文件契约（运行时才会暴露的那类错误）===')

const mainJs = read(path.join(SRC, 'main.js'))
const preloadJs = read(path.join(SRC, 'preload.js'))
const desktopNativeJs = read(path.join(SRC, 'native.js'))
const androidNativeJs = read(path.join(ANDROID_SRC, 'native.js'))

check('main.js 注册的 IPC 通道 ↔ preload.js invoke 的通道 完全对应', () => {
  const handled = [...mainJs.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]).sort()
  const invoked = [...preloadJs.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]).sort()
  assert(handled.length > 0, 'main.js 里没找到 ipcMain.handle')
  assert(invoked.length > 0, 'preload.js 里没找到 ipcRenderer.invoke')
  const missing = invoked.filter((c) => !handled.includes(c))
  const unused = handled.filter((c) => !invoked.includes(c))
  assert(missing.length === 0, 'preload 调用了 main 没注册的通道：' + missing.join(', '))
  assert(unused.length === 0, 'main 注册了没人用的通道：' + unused.join(', '))
  return `${handled.length} 个通道一一对应`
})

check('preload 暴露的键 ↔ native.js 实际用到的键 完全覆盖', () => {
  // preload: contextBridge.exposeInMainWorld('desktop', { key: ... })
  const block = preloadJs.slice(preloadJs.indexOf('exposeInMainWorld'))
  const exposed = [...block.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1])
  assert(exposed.length > 0, '解析不出 preload 暴露的键')
  const used = [...new Set([...desktopNativeJs.matchAll(/\bd\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))]
  const missing = used.filter((k) => !exposed.includes(k))
  assert(missing.length === 0, 'native.js 用了 preload 没暴露的键：' + missing.join(', '))
  return `${exposed.length} 个暴露 / ${used.length} 个被用到`
})

check('安卓 native.js 的接口 ⊆ 桌面 native.js 的接口（共用 UI 的前提）', () => {
  // 从两份 native.js 里扒出挂到 window.Native 上的方法名
  const methodsOf = (src) => {
    const keys = new Set()
    for (const m of src.matchAll(/^\s{4}([A-Za-z_$][\w$]*):\s*(function|keepAwakeThenable)?/gm)) keys.add(m[1])
    return keys
  }
  const android = methodsOf(androidNativeJs)
  const desktop = methodsOf(desktopNativeJs)
  // 只关心真正的方法型 API
  const REQUIRED = ['isNative', 'keepAwake', 'pickFile', 'saveFile', 'enterFullscreen', 'exitFullscreen', 'envInfo']
  for (const k of REQUIRED) {
    assert(android.has(k), '安卓 native.js 缺少 ' + k + '（共用 UI 会崩）')
    assert(desktop.has(k), '桌面 native.js 缺少 ' + k + '（共用 UI 会崩）')
  }
  const desktopOnly = [...desktop].filter((k) => !android.has(k))
  return `必需 ${REQUIRED.length} 项两端都有；桌面额外：${desktopOnly.join(', ') || '无'}`
})

check('app.js 只通过 window.Native 访问原生能力（没有平台专属 API 泄漏）', () => {
  const appJs = read(path.join(ANDROID_SRC, 'app.js'))
  const leaks = ['Capacitor', 'capacitor', 'window.desktop', 'electron'].filter((k) => appJs.indexOf(k) >= 0)
  assert(leaks.length === 0, '共用 UI 里出现了平台专属 API：' + leaks.join(', '))
  return '仅依赖 window.Native'
})

/* ====================================================================== */
console.log('\n=== 3. 页面结构 ===')

const html = read(path.join(WWW, 'index.html'))
const appJs = read(path.join(WWW, 'app.js'))

check('脚本加载顺序：vendor → core → native → app', () => {
  const srcs = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1])
  const idx = (n) => srcs.findIndex((s) => s.indexOf(n) >= 0)
  for (const f of VENDOR_FILES.filter((f) => f.endsWith('.js'))) assert(idx('vendor/' + f) >= 0, '缺 ' + f)
  assert(idx('vendor/raptorq.core.js') < idx('core/codecs.js'), 'raptorq.core.js 必须在 codecs 前')
  assert(idx('core/codecs.js') === Math.max(...CORE_FILES.map((f) => idx('core/' + f))), 'codecs.js 必须最后')
  assert(idx('native.js') > idx('core/codecs.js'), 'native.js 要在 core 之后')
  assert(idx('app.js') > idx('native.js'), 'app.js 必须最后')
  return srcs.length + ' 个脚本'
})

check('index.html 与 app.js 的 id 交叉核对', () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
  const used = [...appJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1])
  assert(used.length >= 20, '只匹配到 ' + used.length + ' 个 id，检查可能失效')
  const missing = used.filter((id) => !htmlIds.has(id))
  assert(missing.length === 0, '引用了不存在的元素：' + missing.join(', '))
  return `${used.length} 个 id 全部存在`
})

check('无 CSP meta、无网络资源', () => {
  assert(!/http-equiv=["']?Content-Security-Policy/i.test(html), '不该有 CSP meta')
  const remote = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1]).filter((r) => /^https?:/i.test(r))
  assert(remote.length === 0, '引用了网络资源：' + remote.join(', '))
  return '干净'
})

check('classic script 全局作用域无重名（白屏级）', () => {
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
      vm.runInContext(read(p), ctx, { filename: s })
    } catch (err) {
      const msg = (err && err.message) || String(err)
      if (/already been declared/i.test(msg)) hits.push(s + ': ' + msg)
    }
  }
  assert(hits.length === 0, hits.join(' / '))
  return srcs.length + ' 个脚本'
})

/* ====================================================================== */
console.log('\n=== 4. 桌面版该有的原生能力（这是它存在的理由）===')

check('屏幕不睡眠：用了 powerSaveBlocker.prevent-display-sleep', () => {
  assert(/powerSaveBlocker\.start\(\s*'prevent-display-sleep'/.test(mainJs), 'main.js 没有开 prevent-display-sleep')
  assert(/powerSaveBlocker\.stop/.test(mainJs), 'main.js 没有对应的 stop（退出时会一直挂着）')
  return 'start + stop 都在'
})

check('真置顶全屏：setAlwaysOnTop(screen-saver) + setFullScreen', () => {
  assert(/setAlwaysOnTop\(true,\s*'screen-saver'/.test(mainJs), '没用 screen-saver 层级（普通置顶盖不住全屏应用）')
  assert(/setFullScreen\(true\)/.test(mainJs), '没有全屏')
  assert(/setAlwaysOnTop\(false\)/.test(mainJs), '退出时没恢复置顶')
  return '置顶层级 screen-saver'
})

check('安全配置：contextIsolation 开、nodeIntegration 关', () => {
  assert(/contextIsolation:\s*true/.test(mainJs), 'contextIsolation 必须开')
  assert(/nodeIntegration:\s*false/.test(mainJs), 'nodeIntegration 必须关')
  assert(/contextBridge\.exposeInMainWorld/.test(preloadJs), 'preload 应当用 contextBridge 暴露能力')
  assert(!/nodeIntegration:\s*true/.test(mainJs), '不允许开 nodeIntegration')
  return 'contextIsolation=true / nodeIntegration=false'
})

check('README 里承诺的能力真的实现了：原生对话框 / 屏幕捕获 / 定位文件', () => {
  assert(/showSaveDialogSync/.test(mainJs), '缺原生保存对话框')
  assert(/showOpenDialogSync/.test(mainJs), '缺原生打开对话框')
  assert(/desktopCapturer\.getSources/.test(mainJs), '缺屏幕捕获（无摄像头时的降级通道）')
  assert(/shell\.showItemInFolder/.test(mainJs), '缺"在文件管理器中定位"')
  return '4 项齐全'
})

check('Windows 亮度控制走 WMI，且 macOS 如实报告不可用', () => {
  assert(/WmiSetBrightness/.test(mainJs), '缺 WMI 调亮度')
  assert(/WmiMonitorBrightness/.test(mainJs), '缺读当前亮度（退出时要恢复）')
  assert(/IS_WINDOWS/.test(mainJs), '没有按平台分支')
  assert(/亮度控制仅 Windows 支持/.test(mainJs), 'macOS 下应当如实说明不可用，而不是假装成功')
  return 'WMI + 平台分支 + 如实说明'
})

check('userData 不可写时自动回退（否则受限环境启动即 SIGTRAP）', () => {
  // 本机沙箱里真实踩到：Electron 启动阶段要写
  // ~/Library/Application Support/<app>，写不了就**直接 SIGTRAP 崩掉且无任何日志**。
  assert(/ensureWritableUserData/.test(mainJs), '缺少 userData 可写性探测')
  assert(/app\.setPath\(\s*'userData'/.test(mainJs), '没有回退到其它 userData 目录')
  assert(/accessSync\(dir,\s*fs\.constants\.W_OK\)/.test(mainJs), '应当真的判断可写性，而不是只看 mkdir 有没有抛')
  return '探测 + 回退'
})

check('keepAwake 的返回值不会自我解析成 thenable（曾让 Electron 原生崩溃）', () => {
  // 本项目最隐蔽的一个 bug：为了让 app.js 能同步拿返回值，native.js 返回
  // "带 then 的乐观对象"，而内部 promise 又解析回这同一个对象
  // → 自我解析的 thenable 无限递归 → V8 直接 SIGTRAP，栈里只有 node 内部符号。
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    Promise,
    Uint8Array,
    ArrayBuffer,
    Object,
    Array,
    String,
    Boolean,
    Number,
    Error,
    navigator: { mediaDevices: null },
    setTimeout,
    clearTimeout
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  sandbox.window.desktop = {
    platform: 'win32',
    versions: { electron: 'x', chrome: 'x', node: 'x' },
    keepAwake: () => Promise.resolve({ keepAwake: true, brightness: true, errors: [] }),
    pickFile: () => Promise.resolve(null),
    saveFile: () => Promise.resolve({ saved: true, uri: 'x' }),
    fullscreen: () => Promise.resolve(true),
    captureScreen: () => Promise.resolve(null),
    readVendor: () => new Uint8Array(1),
    reveal: () => Promise.resolve(true),
    displays: () => Promise.resolve([])
  }
  vm.createContext(sandbox)
  vm.runInContext(desktopNativeJs, sandbox, { filename: 'native.js' })

  const sync = sandbox.Native.keepAwake(true)
  assert(sync && typeof sync.keepAwake === 'boolean', '同步调用者应立刻拿到形状正确的对象')

  return Promise.race([
    Promise.resolve(sync).then((v) => {
      assert(v && typeof v.then !== 'function', 'await 的结果本身还是 thenable → 会自我解析')
      assert(v.keepAwake === true, 'await 后应拿到真实值，实际 ' + JSON.stringify(v))
      return '同步形状 OK / await 结果为纯对象'
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('await 超时——典型的自我解析死循环')), 1500)
    )
  ])
})

/* ====================================================================== */
console.log('\n=== 5. 打包配置 ===')

check('electron-builder 配置可用于出 Windows 包', () => {
  const pkg = JSON.parse(read(path.join(APP, 'package.json')))
  assert(pkg.main === 'www/main.js', 'main 应指向 www/main.js，实际 ' + pkg.main)
  assert(pkg.build, 'package.json 里缺 build 配置')
  assert((pkg.build.files || []).some((f) => f.indexOf('www') >= 0), 'files 必须包含 www/')
  const winTargets = (pkg.build.win && pkg.build.win.target ? pkg.build.win.target : []).map((t) =>
    typeof t === 'string' ? t : t.target
  )
  assert(winTargets.indexOf('nsis') >= 0, '缺 nsis 安装包目标')
  assert(winTargets.indexOf('portable') >= 0, '缺免安装版目标')
  assert(pkg.scripts['dist:win'], '缺 dist:win 脚本')
  return 'nsis + portable / x64'
})

check('build.mjs 幂等', () => {
  const hash = () => {
    const out = []
    for (const dir of ['core', 'vendor', '.']) {
      const p = path.join(WWW, dir)
      if (!fs.existsSync(p)) continue
      for (const f of fs.readdirSync(p)) {
        const fp = path.join(p, f)
        if (fs.statSync(fp).isFile()) out.push(path.relative(WWW, fp) + ':' + fs.statSync(fp).size)
      }
    }
    return out.sort().join('|')
  }
  const before = hash()
  execFileSync(process.execPath, [path.join(APP, 'build.mjs')], { stdio: 'ignore' })
  assert(before === hash(), '重复组装产生了不同结果')
  return '两次一致'
})

// 汇总必须等所有异步用例落地后再打印/定退出码：
// 否则异步用例的结果会在汇总之后才出现，计数与 exitCode 都会漏掉它
// （verify.sh 靠退出码判定，漏掉就是"假绿"）。
Promise.all(pending).then(() => {
  console.log(
    `\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败（含 ${pending.length} 个异步用例）`
  )
  console.log('注：真实的 Electron 启动 + wasm + 收发往返由 `npm run smoke` 验证（本机已实测通过）。\n')
  process.exitCode = fail ? 1 : 0
})
