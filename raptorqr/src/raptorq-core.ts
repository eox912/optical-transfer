/**
 * raptorq-core.ts —— WASM 内核的**加载与状态**封装
 *
 * ⚠ 名字容易混：
 *   - 本文件（连字符）`raptorq-core.js` = 加载器/状态上报，插件自己的薄壳；
 *   - `vendor/raptorq.core.js`（点号）= Rust→WASM 内核的 JS 胶水，真正的实现。
 *
 * 分工：
 *   vendor 那个文件是 UMD，被 <script> 引入时会**自己**把 `OTP.raptorqCore`
 *   挂上，并在后台开始加载 wasm（见其文件末尾的 autoLoadInBrowser）。
 *   所以本加载器**不接管** `OTP.raptorqCore`，只负责三件事：
 *     1. 兜底：万一 vendor 那道 <script> 没生效（文件缺失 / 求值出错），
 *        再动态注入一次，失败或超时都**静默**记录原因，绝不抛到 UI；
 *     2. 接住内核自己的 load() promise，知道"到底就绪没有、为什么没就绪"；
 *     3. 通过 onChange() 通知 UI 重新渲染（wasm 是异步就绪的）。
 *
 * 诚实性由共享核心保证：`OTP.codecs.raptorqAvailable()` / `raptorqStatus()`
 * 直接读 `OTP.raptorqCore`，缺失时返回 false，codecs 自动回退 LT 喷泉码。
 * 本文件从不伪造可用性。
 */
;(function (root) {
  'use strict'

  var VENDOR_URL = 'vendor/raptorq.core.js'
  /** 兜底注入的超时：到点还没 onload/onerror 就认定不可用 */
  var SCRIPT_TIMEOUT_MS = 5000

  var OTP = (root.OTP = root.OTP || {})

  /** idle | loading | loaded | unavailable */
  var state = 'idle'
  var lastError = ''
  var listeners = []
  var injectedOnce = false

  /** 取当前挂在 OTP 上的内核（只读，不接管） */
  function core() {
    var candidate = OTP.raptorqCore
    if (candidate && typeof candidate.isAvailable === 'function') return candidate
    return null
  }

  function isAvailable() {
    var candidate = core()
    if (!candidate) return false
    try {
      return Boolean(candidate.isAvailable())
    } catch (err) {
      return false
    }
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](status())
      } catch (err) {
        /* 监听器自己出错不影响加载 */
      }
    }
  }

  /**
   * 如实的状态报告（UI 直接用它）
   * @returns {{available:boolean, state:string, error:string, abiVersion:number|undefined, wasmBytes:number|undefined, vendorLoaded:boolean}}
   */
  function status() {
    var candidate = core()
    var inner = null
    if (candidate && typeof candidate.status === 'function') {
      try {
        inner = candidate.status()
      } catch (err) {
        inner = null
      }
    }
    var available = isAvailable()
    return {
      available: available,
      state: available ? 'loaded' : state === 'idle' && !candidate ? 'unavailable' : state,
      error: (inner && inner.error) || lastError || '',
      abiVersion: inner ? inner.abiVersion : undefined,
      wasmBytes: inner ? inner.wasmBytes : undefined,
      vendorLoaded: Boolean(candidate)
    }
  }

  function setUnavailable(reason) {
    state = 'unavailable'
    lastError = reason || lastError || 'WASM 内核不可用'
    notify()
  }

  function defaultCreateScript(url) {
    var el = root.document.createElement('script')
    el.src = url
    el.async = true
    return el
  }

  function mountPoint() {
    var doc = root.document
    if (!doc) return null
    return doc.head || (doc.getElementsByTagName && doc.getElementsByTagName('head')[0]) || null
  }

  /** 兜底注入 vendor/raptorq.core.js。全程不抛异常。 */
  function inject(options) {
    var opts = options || {}
    injectedOnce = true

    if (typeof root.WebAssembly === 'undefined') {
      setUnavailable('当前运行时不支持 WebAssembly')
      return
    }
    var mount = mountPoint()
    if (!mount || typeof root.document.createElement !== 'function') {
      setUnavailable('没有可用的 document，无法注入 vendor 脚本')
      return
    }

    var el
    try {
      el = (opts.createScript || defaultCreateScript)(VENDOR_URL)
    } catch (err) {
      setUnavailable('无法创建 script 标签：' + String((err && err.message) || err))
      return
    }
    if (!el) {
      setUnavailable('createScript 没有返回 script 元素')
      return
    }

    state = 'loading'
    notify()

    var settled = false
    var timer = setTimeout(function () {
      if (settled) return
      settled = true
      setUnavailable('加载 ' + VENDOR_URL + ' 超时')
    }, SCRIPT_TIMEOUT_MS)

    el.onload = function () {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!core()) {
        setUnavailable(VENDOR_URL + ' 已加载但没有暴露 OTP.raptorqCore')
        return
      }
      // 内核挂上了，接着等它把 wasm 实例化完
      ensure()
    }
    el.onerror = function () {
      if (settled) return
      settled = true
      clearTimeout(timer)
      setUnavailable('未找到 ' + VENDOR_URL + '（WASM 核心未随插件打包）')
    }

    try {
      mount.appendChild(el)
    } catch (err) {
      settled = true
      clearTimeout(timer)
      setUnavailable('挂载 script 失败：' + String((err && err.message) || err))
    }
  }

  /**
   * 确保内核在加载中/已就绪。永不抛异常。
   * @param {{createScript?:Function, loadOptions?:object}} [options] createScript 供测试注入
   * @returns {boolean} 此刻是否已经真的可用
   */
  function ensure(options) {
    var opts = options || {}
    var candidate = core()

    if (!candidate) {
      // vendor 那道 script 没生效 → 再注入一次作为兜底
      if (!injectedOnce) inject(opts)
      return false
    }

    if (isAvailable()) {
      state = 'loaded'
      return true
    }

    state = 'loading'
    try {
      var pending = typeof candidate.load === 'function' ? candidate.load(opts.loadOptions || {}) : null
      if (pending && typeof pending.then === 'function') {
        pending.then(
          function () {
            if (isAvailable()) {
              state = 'loaded'
              lastError = ''
            } else {
              var inner = candidate.status ? candidate.status() : null
              setUnavailable((inner && inner.error) || 'wasm 实例化失败')
              return
            }
            notify()
          },
          function (err) {
            setUnavailable(String((err && err.message) || err))
          }
        )
      } else {
        state = isAvailable() ? 'loaded' : 'unavailable'
      }
    } catch (err) {
      setUnavailable(String((err && err.message) || err))
    }
    return isAvailable()
  }

  OTP.raptorqLoader = {
    VENDOR_URL: VENDOR_URL,
    ensure: ensure,
    status: status,
    isAvailable: isAvailable,
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {}
      listeners.push(fn)
      return function () {
        var i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    }
  }

  // 页面里立刻接住内核的加载过程；vendor 缺失时静默降级
  ensure()
})(typeof self !== 'undefined' ? self : globalThis)
