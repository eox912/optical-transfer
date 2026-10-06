/**
 * extension.test.js —— 浏览器扩展版的无头验证
 *
 *   node build.mjs && node test/extension.test.js
 *
 * 重点是四类**只在运行时（或 Chrome 加载扩展时）才暴露**的错误：
 *
 *   1. **manifest ↔ 文件系统 ↔ 代码** 三方的交叉契约：
 *      manifest 写了 `default_popup` → `action.onClicked` 永不触发；
 *      manifest 少了 `downloads` 权限 → `chrome.downloads.download` 直接抛；
 *      CSP 少了 `wasm-unsafe-eval` → RaptorQ 的 wasm 被拦（而且是**静默**降级）。
 *   2. **扩展层 ↔ 共用 UI 的 DOM 契约**：PiP 码窗要读主窗口的 `#code-canvas`、
 *      要能点 `#stop`。这两个 id 必须真的存在于 index.html。
 *   3. **降级链真的存在**：PiP → 全屏；另存为 → downloads → 普通下载。
 *      这条用**桩 DOM 真跑一遍**，而不是正则猜它写了没有。
 *   4. 跨文件字节一致性（core/vendor 与 shared、UI 与 android-app/src）。
 *
 * 另外守住桌面版踩过的那个致命坑：keepAwake 的返回值**不能自我解析成 thenable**
 * （会让 V8 直接 SIGTRAP）。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { execFileSync } = require('child_process')

const HERE = __dirname
const APP = path.resolve(HERE, '..')
const DIST = path.join(APP, 'dist')
const SRC = path.join(APP, 'src')
const ROOT = path.resolve(APP, '..')
const SHARED = path.join(ROOT, 'shared')
const ANDROID_SRC = path.join(ROOT, 'android-app', 'src')

const CORE_FILES = ['protocol.js', 'fountain.js', 'qr.js', 'scan.js', 'codecs.js']
const VENDOR_FILES = ['qrcode-generator.js', 'jsQR.js', 'raptorq.core.js', 'raptorq.core.wasm']
const UI_FILES = ['index.html', 'app.css', 'app.js']
const ICON_SIZES = [16, 32, 48, 128]
const REQUIRED_API = ['isNative', 'keepAwake', 'pickFile', 'saveFile', 'enterFullscreen', 'exitFullscreen', 'envInfo']

let pass = 0
let fail = 0
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
/*                            桩 DOM / 沙箱                                */
/* ====================================================================== */

function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    width: 0,
    height: 0,
    style: { cssText: '' },
    attrs: {},
    children: [],
    listeners: {},
    parentNode: null,
    textContent: '',
    clicks: 0,
    type: '',
    setAttribute(k, v) {
      this.attrs[k] = v
    },
    getAttribute(k) {
      return this.attrs[k]
    },
    appendChild(c) {
      c.parentNode = this
      this.children.push(c)
      return c
    },
    removeChild(c) {
      const i = this.children.indexOf(c)
      if (i >= 0) this.children.splice(i, 1)
      c.parentNode = null
      return c
    },
    addEventListener(type, fn) {
      ;(this.listeners[type] = this.listeners[type] || []).push(fn)
    },
    dispatch(type, ev) {
      ;(this.listeners[type] || []).forEach((fn) => fn(ev || {}))
    },
    click() {
      this.clicks++
      this.dispatch('click')
    },
    getContext() {
      const self = this
      this.draws = 0
      return {
        fillStyle: '',
        fillRect() {},
        drawImage() {
          self.draws++
        }
      }
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 10, bottom: 10 }
    }
  }
}

/**
 * 造一个够用的沙箱：把 native.js 真的跑起来，能力全部可控，
 * 于是"降级链到底走没走"这件事可以断言，而不是靠读源码猜。
 */
function makeEnv(opts) {
  opts = opts || {}
  const calls = {
    wake: 0,
    wakeRelease: 0,
    pip: 0,
    pipOptions: null,
    fullscreen: 0,
    downloads: [],
    picker: 0
  }

  const els = { 'code-canvas': makeEl('canvas'), stop: makeEl('button') }
  els['code-canvas'].width = 800
  els['code-canvas'].height = 600

  const doc = {
    title: '',
    visibilityState: 'visible',
    body: makeEl('body'),
    listeners: {},
    documentElement: {
      requestFullscreen() {
        calls.fullscreen++
        return Promise.resolve()
      }
    },
    getElementById: (id) => els[id] || null,
    createElement: (tag) => makeEl(tag),
    addEventListener(type, fn) {
      ;(this.listeners[type] = this.listeners[type] || []).push(fn)
    },
    dispatch(type, ev) {
      ;(this.listeners[type] || []).forEach((fn) => fn(ev || {}))
    },
    exitFullscreen() {
      return Promise.resolve()
    }
  }

  // 沙箱里的定时器必须 unref：native.js 里"保存后延迟 revoke objectURL"用的是
  // 60 秒定时器，不 unref 的话测试跑完还要干等一分钟才退出。
  const sandboxSetTimeout = (fn, ms) => {
    const t = setTimeout(fn, ms)
    if (t && typeof t.unref === 'function') t.unref()
    return t
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise,
    Uint8Array,
    ArrayBuffer,
    Object,
    Array,
    String,
    Boolean,
    Number,
    Error,
    Math,
    JSON,
    Blob,
    setTimeout: sandboxSetTimeout,
    clearTimeout,
    document: doc,
    location: { protocol: 'chrome-extension:' },
    screen: { availWidth: 1440, availHeight: 900 },
    isSecureContext: true,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} }
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox

  const navigator_ = {
    userAgent: 'Mozilla/5.0 Chrome/120.0.0.0',
    mediaDevices: { getUserMedia() {} }
  }
  if (opts.wakeLock !== false) {
    navigator_.wakeLock = {
      request() {
        calls.wake++
        return Promise.resolve({
          released: false,
          addEventListener: (t, fn) => {
            // 记下来，测试里模拟"系统把 wake lock 释放了"
            sandbox.__wakeRelease = fn
          },
          release() {
            calls.wakeRelease++
            return Promise.resolve()
          }
        })
      }
    }
  }
  if (opts.wakeLockFails) {
    navigator_.wakeLock = {
      request() {
        calls.wake++
        return Promise.reject(new Error('屏幕被锁定'))
      }
    }
  }
  sandbox.navigator = navigator_

  if (opts.pip !== false) {
    sandbox.documentPictureInPicture = {
      requestWindow(options) {
        calls.pip++
        calls.pipOptions = options
        const win = {
          closed: false,
          document: null,
          listeners: {},
          rafQueue: [],
          addEventListener(t, fn) {
            ;(this.listeners[t] = this.listeners[t] || []).push(fn)
          },
          dispatch(t, ev) {
            ;(this.listeners[t] || []).forEach((fn) => fn(ev || {}))
          },
          requestAnimationFrame(fn) {
            this.rafQueue.push(fn)
            return this.rafQueue.length
          },
          cancelAnimationFrame() {},
          close() {
            this.closed = true
            this.dispatch('pagehide')
          }
        }
        win.document = {
          title: '',
          body: makeEl('body'),
          createElement: (tag) => makeEl(tag)
        }
        sandbox.__pipWin = win
        return Promise.resolve(win)
      }
    }
  }

  if (opts.chrome !== false) {
    sandbox.chrome = {
      runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', getURL: (p) => 'chrome-extension://x/' + p },
      downloads: {
        download(options) {
          calls.downloads.push(options)
          if (opts.downloadFails) return Promise.reject(new Error(opts.downloadFails))
          return Promise.resolve(42)
        }
      }
    }
  }

  if (opts.savePicker !== false) {
    sandbox.showSaveFilePicker = function (options) {
      calls.picker++
      calls.pickerOptions = options
      if (opts.pickerAborts) {
        const err = new Error('用户取消了')
        err.name = 'AbortError'
        return Promise.reject(err)
      }
      if (opts.pickerFails) return Promise.reject(new Error('权限被拒'))
      return Promise.resolve({
        name: options.suggestedName,
        createWritable: () =>
          Promise.resolve({
            write: () => Promise.resolve(),
            close: () => Promise.resolve()
          })
      })
    }
  }

  vm.createContext(sandbox)
  vm.runInContext(read(path.join(DIST, 'native.js')), sandbox, { filename: 'native.js' })
  return { sandbox, calls, els, doc }
}

function stripComments(src) {
  // 注释里提到的 API 不算"用到了"——否则文档里写一句 `chrome.tabs.query 需要 tabs 权限`
  // 就会把这条测试搞红（本文件第一版就是这么红的）
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 让所有已排队的微任务落地（wakeSentinel 是在 request 的 .then 里赋值的） */
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0))

function pngSize(file) {
  const buf = fs.readFileSync(file)
  assert(buf.slice(1, 4).toString() === 'PNG', path.basename(file) + ' 不是 PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/* ====================================================================== */
console.log('\n=== 1. 共享核心与共用界面（三端一份，不许漂移）===')

check('dist/core 与 dist/vendor 与 shared/ 逐字节一致', () => {
  for (const f of CORE_FILES) {
    assert(
      Buffer.compare(fs.readFileSync(path.join(SHARED, 'core', f)), fs.readFileSync(path.join(DIST, 'core', f))) === 0,
      'core/' + f
    )
  }
  for (const f of VENDOR_FILES) {
    assert(
      Buffer.compare(fs.readFileSync(path.join(SHARED, 'vendor', f)), fs.readFileSync(path.join(DIST, 'vendor', f))) === 0,
      'vendor/' + f
    )
  }
  const wasm = fs.statSync(path.join(DIST, 'vendor', 'raptorq.core.wasm'))
  assert(wasm.size > 200000, 'wasm 体积异常，可能没打进去：' + wasm.size)
  return `${CORE_FILES.length + VENDOR_FILES.length} 个一致，wasm ${(wasm.size / 1024).toFixed(0)}KB`
})

check('界面文件与 android-app/src 逐字节一致（三端真的共用一份 UI）', () => {
  for (const f of UI_FILES) {
    assert(Buffer.compare(fs.readFileSync(path.join(ANDROID_SRC, f)), fs.readFileSync(path.join(DIST, f))) === 0, f)
  }
  return UI_FILES.join(' / ')
})

/* ====================================================================== */
console.log('\n=== 2. manifest 三方契约（Chrome 加载时才报的那类错）===')

const manifest = JSON.parse(read(path.join(DIST, 'manifest.json')))
const backgroundJs = read(path.join(SRC, 'background.js'))
const nativeJs = read(path.join(SRC, 'native.js'))
const html = read(path.join(DIST, 'index.html'))

check('MV3 且 service worker 指向的文件真的存在', () => {
  assert(manifest.manifest_version === 3, '必须是 MV3')
  const sw = manifest.background && manifest.background.service_worker
  assert(sw, '缺 background.service_worker')
  assert(fs.existsSync(path.join(DIST, sw)), 'service worker 文件不存在：' + sw)
  return sw
})

check('没有 action.default_popup（否则 action.onClicked 永不触发）', () => {
  assert(!(manifest.action && manifest.action.default_popup), '有 default_popup 会让 onClicked 失效')
  assert(manifest.action && manifest.action.default_title, '缺 default_title（工具栏悬停提示）')
  return '无 popup，点击图标走 onClicked'
})

check('background.js 打开的页面在包里真实存在', () => {
  // getURL 的参数可能是字面量，也可能是常量（`chrome.runtime.getURL(APP_PAGE)`），
  // 两种情况都要能解析出来，否则这条测试就是空转
  const constants = {}
  for (const m of backgroundJs.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']+)'/g)) constants[m[1]] = m[2]
  const call = backgroundJs.match(/getURL\(\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*\)/)
  assert(call, 'background.js 里找不到 runtime.getURL(...)')
  const page = call[1] || constants[call[2]]
  assert(page, 'getURL 的参数解析不出来：' + call[0])
  assert(fs.existsSync(path.join(DIST, page)), 'getURL 指向的页面不存在：' + page)
  assert(page === 'index.html', '应当打开 index.html，实际 ' + page)
  return page
})

check('图标声明齐全且是声明尺寸的真 PNG（不是拿大图糊弄）', () => {
  const sizes = Object.keys(manifest.icons || {}).map(Number).sort((a, b) => a - b)
  assert(JSON.stringify(sizes) === JSON.stringify(ICON_SIZES), 'icons 应为 ' + ICON_SIZES.join('/') + '，实际 ' + sizes.join('/'))
  for (const s of ICON_SIZES) {
    const p = path.join(DIST, manifest.icons[String(s)])
    assert(fs.existsSync(p), '缺图标 ' + p)
    const dim = pngSize(p)
    assert(dim.width === s && dim.height === s, `icon${s}.png 实际是 ${dim.width}×${dim.height}`)
    assert(manifest.action.default_icon[String(s)] === manifest.icons[String(s)], 'action 图标与扩展图标不一致')
  }
  return ICON_SIZES.map((s) => s + 'px').join(' / ')
})

check('CSP 带 wasm-unsafe-eval（否则 RaptorQ 的 wasm 被静默拦掉）', () => {
  const csp = (manifest.content_security_policy || {}).extension_pages || ''
  assert(/wasm-unsafe-eval/.test(csp), 'CSP 缺 wasm-unsafe-eval：' + (csp || '(空)'))
  assert(/script-src 'self'/.test(csp), 'script-src 应当是 self')
  return csp
})

check('minimum_chrome_version ≥ 116（Document PiP 的下限）', () => {
  const v = String(manifest.minimum_chrome_version || '')
  assert(v, '缺 minimum_chrome_version')
  assert(Number(v.split('.')[0]) >= 116, '低于 116 就没有 documentPictureInPicture：' + v)
  return 'Chrome/Edge ' + v + '+'
})

check('权限最小化：只用 downloads，且代码里没用到没声明的 chrome API', () => {
  // chrome 扩展的经典事故：调了没在 manifest 里声明的 API → 运行时才抛。
  // 所以这里把"代码里出现的 chrome.* 调用"和"manifest 声明的权限"对起来。
  const NEEDS_PERMISSION = { 'downloads.download': 'downloads' }
  const NO_PERMISSION = ['action.onClicked', 'tabs.create', 'runtime.getURL', 'runtime.id']
  const all = stripComments(backgroundJs) + '\n' + stripComments(nativeJs)

  const used = new Set()
  for (const m of all.matchAll(/\bchrome\.([A-Za-z]+)\.([A-Za-z]+)/g)) used.add(m[1] + '.' + m[2])
  // native.js 里用 CHROME 别名调用的也要算上
  for (const m of all.matchAll(/\bCHROME\.([A-Za-z]+)\.([A-Za-z]+)/g)) used.add(m[1] + '.' + m[2])

  assert(used.size > 0, '一个 chrome.* 调用都没扫到，正则可能失效')
  const declared = manifest.permissions || []
  const unknown = [...used].filter((k) => !NEEDS_PERMISSION[k] && !NO_PERMISSION.includes(k))
  assert(unknown.length === 0, '用到未登记的 chrome API（不确定要不要权限）：' + unknown.join(', '))

  for (const [api, perm] of Object.entries(NEEDS_PERMISSION)) {
    if (used.has(api)) assert(declared.includes(perm), `用了 chrome.${api} 但 manifest 没声明 ${perm}`)
  }
  const extra = declared.filter((p) => !Object.values(NEEDS_PERMISSION).includes(p))
  assert(extra.length === 0, '声明了没用到的权限（不要白要权限）：' + extra.join(', '))
  return `用到 ${[...used].join(', ')}；权限恰好 [${declared.join(', ')}]`
})

check('没有往普通网页注入 content script（这个扩展只跑自己的页面）', () => {
  assert(!manifest.content_scripts, '不需要 content_scripts')
  assert(!manifest.host_permissions, '不需要 host_permissions')
  return '无注入 / 无主机权限'
})

/* ====================================================================== */
console.log('\n=== 3. 扩展层 ↔ 共用 UI 的接口与 DOM 契约 ===')

check('native.js 实现了共用 UI 需要的全部方法', () => {
  const { sandbox } = makeEnv()
  const missing = REQUIRED_API.filter((k) => typeof sandbox.Native[k] !== 'function')
  assert(missing.length === 0, '缺方法：' + missing.join(', '))
  assert(sandbox.Native.__extension === true, '应当打上 __extension 标记（与桌面版 __desktop 同样的做法）')
  return REQUIRED_API.join(', ')
})

check('安卓 native.js 的接口 ⊆ 扩展 native.js 的接口', () => {
  const androidNativeJs = read(path.join(ANDROID_SRC, 'native.js'))
  const methodsOf = (src) => {
    const keys = new Set()
    for (const m of src.matchAll(/^\s{4}([A-Za-z_$][\w$]*):\s*(function|keepAwakeThenable)?/gm)) keys.add(m[1])
    return keys
  }
  const android = methodsOf(androidNativeJs)
  const ext = methodsOf(nativeJs)
  for (const k of REQUIRED_API) {
    assert(android.has(k), '安卓版缺 ' + k)
    assert(ext.has(k), '扩展版缺 ' + k + '（共用 UI 会崩）')
  }
  return '必需 7 项两端都有'
})

check('app.js 只通过 window.Native 访问原生能力（无平台专属 API 泄漏）', () => {
  const appJs = read(path.join(ANDROID_SRC, 'app.js'))
  const leaks = ['Capacitor', 'window.desktop', 'chrome.', 'electron'].filter((k) => appJs.indexOf(k) >= 0)
  assert(leaks.length === 0, '共用 UI 里出现了平台专属 API：' + leaks.join(', '))
  return '仅依赖 window.Native'
})

check('PiP 码窗要读的 DOM 契约（#code-canvas / #stop）真的存在于页面', () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
  const needed = [...new Set([...nativeJs.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]))]
  assert(needed.length > 0, 'native.js 里没扫到 getElementById')
  const missing = needed.filter((id) => !htmlIds.has(id))
  assert(missing.length === 0, 'native.js 引用了页面里不存在的 id：' + missing.join(', '))
  assert(needed.includes('code-canvas') && needed.includes('stop'), 'PiP 位拷贝与"关窗即停止"依赖这两个 id')
  return needed.join(', ')
})

/* ====================================================================== */
console.log('\n=== 4. 关键能力真的实现了（桩 DOM 真跑，不靠正则猜）===')

check('屏幕常亮走标准 Screen Wake Lock，并在文档重新可见时补申请', () => {
  const { sandbox, calls, doc } = makeEnv()
  const sync = sandbox.Native.keepAwake(true)
  assert(calls.wake === 1, '应当申请了一次 wake lock')
  return Promise.resolve(sync).then((real) => {
    assert(real.keepAwake === true, '申请成功后 keepAwake 应为 true')
    // 模拟系统释放（文档转 hidden 时浏览器会这么做）
    assert(typeof sandbox.__wakeRelease === 'function', '没有监听 release 事件')
    sandbox.__wakeRelease()
    doc.visibilityState = 'visible'
    doc.dispatch('visibilitychange')
    assert(calls.wake === 2, '文档重新可见后应当补申请一次，实际 ' + calls.wake)
    return flushMicrotasks()
      .then(() => sandbox.Native.keepAwake(false))
      .then((off) => {
        assert(off.keepAwake === false, '关闭后应为 false')
        assert(calls.wakeRelease === 1, '应当 release 了一次，实际 ' + calls.wakeRelease)
        return '申请 → 被释放 → 切回来补申请 → release'
      })
  })
})

check('亮度如实报告不可用，不假装成功', () => {
  const { sandbox } = makeEnv()
  const sync = sandbox.Native.keepAwake(true)
  // app.js 是**同步**读 errors 的，所以同步就得有
  assert(Array.isArray(sync.errors) && sync.errors.length > 0, '同步返回时就该带上"亮度不可用"的说明')
  assert(sync.errors.join(' ').indexOf('亮度') >= 0, 'errors 里应当说明亮度拿不到：' + sync.errors.join(' / '))
  return Promise.resolve(sync).then((real) => {
    assert(real.brightness === false, 'brightness 必须是 false')
    assert(real.errors.join(' ').indexOf('亮度') >= 0, 'await 之后仍应保留说明')
    return 'brightness=false + 明确说明'
  })
})

check('keepAwake 的返回值不会自我解析成 thenable（曾让 Electron 原生崩溃）', () => {
  const { sandbox } = makeEnv()
  const sync = sandbox.Native.keepAwake(true)
  assert(sync && typeof sync.keepAwake === 'boolean', '同步调用者应立刻拿到形状正确的对象')
  return Promise.race([
    Promise.resolve(sync).then((v) => {
      assert(v && typeof v.then !== 'function', 'await 的结果本身还是 thenable → 会自我解析')
      return '同步形状 OK / await 结果为纯对象'
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('await 超时——典型的自我解析死循环')), 1500))
  ])
})

check('没有 Wake Lock API 时如实报错，不静默失败', () => {
  const { sandbox } = makeEnv({ wakeLock: false })
  return Promise.resolve(sandbox.Native.keepAwake(true)).then((real) => {
    assert(real.keepAwake === false, '拿不到就该是 false')
    assert(real.errors.join(' ').indexOf('Wake Lock') >= 0, '应当明确说缺 Wake Lock：' + real.errors.join(' / '))
    return 'errors 里点名缺什么'
  })
})

check('置顶码窗走 Document PiP，且每帧把 #code-canvas 位拷贝过去', () => {
  const { sandbox, calls, els } = makeEnv()
  return sandbox.Native.enterFullscreen().then((ok) => {
    assert(ok === true, 'enterFullscreen 应当成功')
    assert(calls.pip === 1, '应当开了一个 PiP 窗口')
    assert(calls.fullscreen === 0, 'PiP 可用时不该退回普通全屏')
    assert(calls.pipOptions && calls.pipOptions.preferInitialWindowPlacement === true, '应当要求初始居中摆放')
    assert(calls.pipOptions.width > 0 && calls.pipOptions.height > 0, '应当指定尺寸')
    const canvas = els['code-canvas']
    const pipCanvas = sandbox.__pipWin.document.body.children[0]
    assert(pipCanvas.draws > 0, '码窗画布没有被位拷贝（源画布 ' + canvas.width + '×' + canvas.height + '）')
    assert(pipCanvas.attrs.id === 'pip-canvas', '第一个子节点应当是画布')
    assert(pipCanvas.width === canvas.width && pipCanvas.height === canvas.height, '位拷贝应当是 1:1 像素')
    return 'PiP 打开 + 1:1 位拷贝'
  })
})

check('PiP 窗口里的"停止"按钮会去点主窗口的停止', () => {
  const { sandbox, els } = makeEnv()
  return sandbox.Native.enterFullscreen().then(() => {
    const stopBtn = sandbox.__pipWin.document.body.children[2]
    assert(stopBtn.attrs.id === 'pip-stop', '第三个子节点应当是停止按钮')
    assert(els.stop.clicks === 0, '还没点就不该停')
    stopBtn.click()
    assert(els.stop.clicks === 1, '点了码窗的停止，应当触发主窗口的停止')
    return '关窗/点停止都接到主窗口'
  })
})

check('用户直接关掉码窗 = 停止发送；而 exitFullscreen 主动关闭不会误触发停止', () => {
  const { sandbox, els } = makeEnv()
  return sandbox.Native.enterFullscreen()
    .then(() => {
      // 1) 主动退出：先清引用再 close，所以 pagehide 不该被当成"用户关窗"
      return sandbox.Native.exitFullscreen().then((ok) => {
        assert(ok === true, 'exitFullscreen 应当 resolve')
        assert(els.stop.clicks === 0, '主动关闭码窗不该触发停止（否则停止逻辑会重复跑）')
      })
    })
    .then(() => {
      // 2) 用户自己关窗：应当停止
      const { sandbox: s2, els: e2 } = makeEnv()
      return s2.Native.enterFullscreen().then(() => {
        s2.__pipWin.close()
        assert(e2.stop.clicks === 1, '用户关掉码窗应当停止发送，实际 ' + e2.stop.clicks)
      })
    })
    .then(() => '主动关闭不误触 / 用户关窗触发停止')
})

check('拿不到置顶能力时退回 Fullscreen API（降级链不断）', () => {
  const { sandbox, calls } = makeEnv({ pip: false })
  return sandbox.Native.enterFullscreen().then((ok) => {
    assert(calls.pip === 0, '没有 PiP 就不该尝试')
    assert(calls.fullscreen === 1, '应当退回 requestFullscreen')
    assert(ok === true, '降级后仍应报告成功')
    return 'requestFullscreen'
  })
})

check('PiP 抛异常（比如没有用户手势）时也退回全屏，而不是什么都不做', () => {
  const { sandbox, calls } = makeEnv()
  sandbox.documentPictureInPicture.requestWindow = () => Promise.reject(new Error('需要用户手势'))
  return sandbox.Native.enterFullscreen().then((ok) => {
    assert(calls.fullscreen === 1, 'PiP 失败后必须退回全屏')
    assert(ok === true, '降级后仍应报告成功')
    return 'PiP 失败 → 全屏'
  })
})

check('保存文件第一档：showSaveFilePicker 真"另存为"', () => {
  const { sandbox, calls } = makeEnv()
  return sandbox.Native.saveFile('收到.bin', new Uint8Array([1, 2, 3])).then((res) => {
    assert(calls.picker === 1, '应当调了 showSaveFilePicker')
    assert(calls.pickerOptions.suggestedName === '收到.bin', '应当带上原文件名')
    assert(res.saved === true && res.mode === 'file-system-access', '实际 ' + JSON.stringify(res))
    assert(calls.downloads.length === 0, '第一档成功就不该再走下载')
    return 'file-system-access'
  })
})

check('用户在"另存为"里取消 → 如实回报 cancelled，且不再偷偷下载', () => {
  const { sandbox, calls } = makeEnv({ pickerAborts: true })
  return sandbox.Native.saveFile('收到.bin', new Uint8Array([1])).then((res) => {
    assert(res.cancelled === true, 'app.js 靠 cancelled 字段区分"取消"和"失败"')
    assert(calls.downloads.length === 0, '用户取消了就不该换个方式再存一遍')
    return 'cancelled:true'
  })
})

check('第二档：没有 File System Access 时走 chrome.downloads 的另存为', () => {
  const { sandbox, calls } = makeEnv({ savePicker: false })
  return sandbox.Native.saveFile('收到.bin', new Uint8Array([1])).then((res) => {
    assert(calls.downloads.length === 1, '应当调了一次 chrome.downloads.download')
    assert(calls.downloads[0].saveAs === true, '必须带 saveAs:true 才会弹保存对话框')
    assert(calls.downloads[0].filename === '收到.bin', '应当保留原文件名')
    assert(res.saved === true && res.mode === 'chrome-downloads', '实际 ' + JSON.stringify(res))
    return 'chrome-downloads (saveAs)'
  })
})

check('第三档：downloads 失败时退到普通下载，取消则如实回报', () => {
  const cancelEnv = makeEnv({ savePicker: false, downloadFails: 'Download canceled by the user' })
  const fallbackEnv = makeEnv({ savePicker: false, downloadFails: '配额不足' })
  return cancelEnv.sandbox.Native.saveFile('a.bin', new Uint8Array([1]))
    .then((res) => {
      assert(res.cancelled === true, '取消应当回报 cancelled，实际 ' + JSON.stringify(res))
      return fallbackEnv.sandbox.Native.saveFile('b.bin', new Uint8Array([1]))
    })
    .then((res) => {
      assert(res.mode === 'browser-download', '其它失败应当退到普通下载，实际 ' + JSON.stringify(res))
      return '取消 / 失败 两条路都分得清'
    })
})

check('envInfo 如实报告这个平台有什么、没有什么', () => {
  const { sandbox } = makeEnv()
  const env = sandbox.Native.envInfo()
  assert(env.platformLabel === 'Chrome 扩展', 'platformLabel 实际 ' + env.platformLabel)
  assert(env.native === true, '在扩展里 native 应为 true（平台层真的接上了）')
  assert(env.plugins.KeepAwake === true, '有 Wake Lock 就该报 true')
  assert(env.plugins.AlwaysOnTop === true, '有 Document PiP 就该报 true')
  assert(env.plugins.SaveToPath === true, '有 File System Access 就该报 true')
  assert(env.plugins.ScreenBrightness === false, '亮度必须如实报 false，UI 上会显示"缺 ScreenBrightness"')
  assert(env.secureContext === true, '扩展页面是安全上下文')
  assert(env.hasCamera === true, '有 getUserMedia')
  return '齐备 + 如实报缺亮度'
})

check('Edge 上 platformLabel 认得出来', () => {
  const { sandbox } = makeEnv()
  sandbox.navigator.userAgent = 'Mozilla/5.0 Chrome/120 Safari/537.36 Edg/120.0.0.0'
  assert(sandbox.Native.envInfo().platformLabel === 'Edge 扩展', '实际 ' + sandbox.Native.envInfo().platformLabel)
  return 'Edge 扩展'
})

/* ====================================================================== */
console.log('\n=== 5. 页面结构与 MV3 约束 ===')

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
  const used = [...read(path.join(DIST, 'app.js')).matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1])
  assert(used.length >= 20, '只匹配到 ' + used.length + ' 个 id，检查可能失效')
  const missing = used.filter((id) => !htmlIds.has(id))
  assert(missing.length === 0, '引用了不存在的元素：' + missing.join(', '))
  return `${used.length} 个 id 全部存在`
})

check('MV3 硬约束：无内联脚本 / 无内联事件处理器 / 无 eval', () => {
  // MV3 默认 CSP 禁止内联脚本与字符串求值，写错了页面直接白屏
  const inlineScript = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)]
  assert(inlineScript.length === 0, '有内联 <script>，MV3 会拦掉')
  const inlineHandler = [...html.matchAll(/\son[a-z]+\s*=/gi)].map((m) => m[0])
  assert(inlineHandler.length === 0, '有内联事件处理器：' + inlineHandler.join(', '))
  const jsFiles = [
    ...CORE_FILES.map((f) => ['core', f]),
    ...VENDOR_FILES.filter((x) => x.endsWith('.js')).map((f) => ['vendor', f]),
    ['.', 'native.js'],
    ['.', 'app.js'],
    ['.', 'background.js']
  ]
  for (const [dir, f] of jsFiles) {
    const text = read(path.join(DIST, dir, f))
    assert(!/\beval\s*\(/.test(text), f + ' 里有 eval()，MV3 会拦')
    assert(!/\bnew\s+Function\s*\(/.test(text), f + ' 里有 new Function()，MV3 会拦')
  }
  return '无内联 / 无 eval'
})

check('无 CSP meta、无网络资源（扩展必须完全离线可用）', () => {
  assert(!/http-equiv=["']?Content-Security-Policy/i.test(html), '不该有 CSP meta')
  const remote = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1]).filter((r) => /^(https?:)?\/\//i.test(r))
  assert(remote.length === 0, '引用了网络资源：' + remote.join(', '))
  const netUse = ['background.js', 'native.js'].filter((f) => /\bfetch\s*\(/.test(read(path.join(DIST, f))))
  assert(netUse.length === 0, '扩展层不该发网络请求：' + netUse.join(', '))
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
    const p = path.join(DIST, s)
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
console.log('\n=== 6. 构建 ===')

check('build.mjs 幂等（重复组装结果一致）', () => {
  const hash = () => {
    const out = []
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f)
        if (fs.statSync(fp).isDirectory()) walk(fp)
        else out.push(path.relative(DIST, fp) + ':' + fs.statSync(fp).size)
      }
    }
    walk(DIST)
    return out.sort().join('|')
  }
  const before = hash()
  execFileSync(process.execPath, [path.join(APP, 'build.mjs')], { stdio: 'ignore' })
  assert(before === hash(), '重复组装产生了不同结果')
  return '两次一致'
})

check('.gitignore 排除了 dist/（生成物不进版本库）', () => {
  const ignore = read(path.join(APP, '.gitignore'))
  assert(ignore.indexOf('dist/') >= 0, '.gitignore 里应排除 dist/')
  return 'dist/ 已排除'
})

/* ====================================================================== */
Promise.all(pending).then(() => {
  console.log(
    `\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败（含 ${pending.length} 个异步用例）`
  )
  console.log('注：真实的 Chrome 加载与摄像头扫码必须在浏览器里跑一遍——沙箱里没有 Chrome 也没有摄像头。\n')
  process.exitCode = fail ? 1 : 0
})
