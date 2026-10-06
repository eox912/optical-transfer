/**
 * raptorq.core.js —— RaptorQ (RFC 6330) WASM 内核的 JS 胶水
 *
 * 对应的 wasm 是 core-rs/ 里的 Rust crate 编译产物（cdylib，
 * 目标 wasm32-unknown-unknown，**不依赖 wasm-bindgen**，所以零导入项）。
 *
 * 三条必须遵守的工程约束（都是本地协议 + uTools 打包带来的）：
 *  1. **不要用 `WebAssembly.instantiateStreaming`**：本地协议返回的 MIME
 *     多半不是 `application/wasm`，会被拒绝。先拿 ArrayBuffer 再 instantiate。
 *  2. **不要从网络加载 wasm**：uTools 发布时禁止请求网络资源，必须随插件打包。
 *  3. **加载失败必须静默降级**：`isAvailable()` 返回 false，由 codecs.js 回退到
 *     LT 喷泉码。绝不把异常抛到 UI 上，也不能假装 WASM 可用。
 *
 * ABI（见 core-rs/src/lib.rs）：
 *   raptorq_abi_version() -> u32
 *   alloc(size)/dealloc(ptr,size)
 *   encoder_create(data_ptr,data_len,mtu) -> id
 *   encoder_oti(id,out12) / encoder_symbol_size(id) / encoder_source_blocks(id)
 *   encoder_block_source_symbols(id,block) / encoder_symbol(id,block,esi,out) -> len
 *   decoder_create(oti_ptr) -> id / decoder_add(id,block,esi,ptr,len) -> 1完成 0已收 2..出错
 *   decoder_result_ptr(id) / decoder_result_len(id)
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.OTP = Object.assign(root.OTP || {}, { raptorqCore: factory() })
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict'

  var ABI_VERSION = 1
  var DEFAULT_URL = 'vendor/raptorq.core.wasm'

  var instance = null
  var loadPromise = null
  var lastError = ''
  var wasmBytes = 0

  function view() {
    return new Uint8Array(instance.memory.buffer)
  }

  /**
   * 把 preload 桥 / readBytes 的返回值统一成 Uint8Array。
   *
   * 这里必须宽容：插件各自的 preload 是各写各的，可能返回 Uint8Array、
   * Node Buffer、也可能是 ArrayBuffer（后者只有 byteLength 没有 length）。
   * 早期版本只检查 `bytes.length`，于是 preload 返回 ArrayBuffer 时会被误判成
   * "返回空"，浏览器里 wasm 永远起不来——这个坑真实发生过，所以在边界处吞掉。
   */
  function toBytes(value) {
    if (!value) return null
    if (value instanceof Uint8Array) return value.length ? value : null
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
      return value.byteLength ? new Uint8Array(value) : null
    }
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
      return value.byteLength
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : null
    }
    // 退化情形：类数组（有 length 且能索引）
    if (typeof value.length === 'number' && value.length > 0) {
      try {
        return Uint8Array.from(value)
      } catch (err) {
        return null
      }
    }
    return null
  }

  function readBytesFrom(url, options) {
    var opt = options || {}
    // 优先级：显式注入 > preload 桥 > fetch > XHR
    //
    // 为什么不能只靠 fetch：如果 uTools 用 file:// 加载页面，Chromium 会
    // 直接拒绝 `fetch()` 该 scheme（"URL scheme must be http or https"），
    // 所以 preload 里用 fs.readFileSync 读字节是最可靠的路子。
    if (typeof opt.readBytes === 'function') {
      return Promise.resolve(opt.readBytes(url)).then(function (value) {
        var bytes = toBytes(value)
        if (!bytes) throw new Error('readBytes 没有返回可用字节')
        return bytes
      })
    }

    var bridge = defaultBridge()
    if (bridge && typeof bridge.readBinary === 'function') {
      return Promise.resolve(bridge.readBinary(url)).then(function (value) {
        var bytes = toBytes(value)
        if (!bytes) throw new Error('preload readBinary 没有返回可用字节')
        return bytes
      })
    }

    if (typeof fetch === 'function') {
      return fetch(url)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.arrayBuffer()
        })
        .then(function (buf) {
          return new Uint8Array(buf)
        })
    }

    if (typeof XMLHttpRequest === 'function') {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest()
        xhr.open('GET', url, true)
        xhr.responseType = 'arraybuffer'
        xhr.onload = function () {
          if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
            resolve(new Uint8Array(xhr.response))
          } else {
            reject(new Error('XHR ' + xhr.status))
          }
        }
        xhr.onerror = function () {
          reject(new Error('XHR 网络错误'))
        }
        xhr.send()
      })
    }

    return Promise.reject(new Error('没有可用的读取方式（fetch / XHR / preload 桥都不可用）'))
  }

  function defaultBridge() {
    if (typeof window !== 'undefined' && window && window.utoolsBridge) return window.utoolsBridge
    return null
  }

  function instantiate(bytes) {
    if (!bytes || bytes.length < 8) throw new Error('wasm 数据为空')
    return WebAssembly.instantiate(bytes, {}).then(function (result) {
      var ex = result.instance.exports
      if (typeof ex.raptorq_abi_version !== 'function') {
        throw new Error('不是 raptorqr-core 的产物（缺少 raptorq_abi_version）')
      }
      var version = ex.raptorq_abi_version()
      if (version !== ABI_VERSION) {
        throw new Error('ABI 版本不匹配：wasm=' + version + ' js=' + ABI_VERSION)
      }
      instance = ex
      wasmBytes = bytes.length
      return ex
    })
  }

  /**
   * 加载并实例化 wasm。**永不 reject**，失败时返回 null 并把原因记在 lastError。
   *
   * 注意：**失败不会被缓存**。这一点很关键——"脚本解析时自动加载"可能先失败
   * （比如 file:// 下 fetch 取不到），如果把这个失败缓存住，页面之后带着可用的
   * readBytes 再调 load() 就会拿到同一个失败结果，wasm 永远加载不上。
   *
   * @param {{url?:string, readBytes?:Function, bytes?:Uint8Array}} [options]
   */
  function load(options) {
    if (instance) return Promise.resolve(instance)
    if (loadPromise) return loadPromise
    var opt = options || {}
    loadPromise = Promise.resolve()
      .then(function () {
        if (opt.bytes) return instantiate(opt.bytes)
        return readBytesFrom(opt.url || DEFAULT_URL, opt).then(instantiate)
      })
      .then(function (result) {
        if (!result) loadPromise = null // 失败不缓存，允许之后带 readBytes 再试
        return result
      })
      .catch(function (err) {
        lastError = (err && err.message) || String(err)
        instance = null
        loadPromise = null
        return null
      })
    return loadPromise
  }

  /** 测试与 preload 场景：直接喂字节 */
  function loadFromBytes(bytes) {
    return load({ bytes: bytes })
  }

  function isAvailable() {
    return Boolean(instance)
  }

  function status() {
    return {
      available: Boolean(instance),
      abiVersion: ABI_VERSION,
      wasmBytes: wasmBytes,
      error: lastError
    }
  }

  /* ------------------------------------------------------------------ */
  /*                                编码器                               */
  /* ------------------------------------------------------------------ */

  /**
   * @param {Uint8Array} data
   * @param {number} mtu 期望的符号大小（RaptorQ 会按对齐要求微调，
   *                     真实值以返回的 symbolSize 为准）
   */
  function createEncoder(data, mtu) {
    if (!instance) return null
    var ex = instance
    var dataPtr = ex.alloc(data.length)
    view().set(data, dataPtr)
    var id = ex.encoder_create(dataPtr, data.length, mtu)
    if (!id) {
      ex.dealloc(dataPtr, data.length)
      return null
    }
    var symbolSize = ex.encoder_symbol_size(id)
    var blockCount = ex.encoder_source_blocks(id)
    var perBlock = []
    var total = 0
    for (var b = 0; b < blockCount; b++) {
      var k = ex.encoder_block_source_symbols(id, b)
      perBlock.push(k)
      total += k
    }
    var otiPtr = ex.alloc(12)
    ex.encoder_oti(id, otiPtr)
    var oti = view().slice(otiPtr, otiPtr + 12)
    ex.dealloc(otiPtr, 12)

    var outLen = symbolSize + 64
    var outPtr = ex.alloc(outLen)

    return {
      id: id,
      oti: oti,
      symbolSize: symbolSize,
      sourceBlocks: blockCount,
      blockSourceSymbols: perBlock,
      totalSourceSymbols: total,
      /** @returns {Uint8Array|null} */
      symbol: function (block, esi) {
        var len = ex.encoder_symbol(id, block, esi, outPtr)
        if (!len) return null
        return view().slice(outPtr, outPtr + len)
      },
      free: function () {
        try {
          ex.encoder_free(id)
          ex.dealloc(outPtr, outLen)
          ex.dealloc(dataPtr, data.length)
        } catch (err) {
          /* 忽略释放期异常 */
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*                                解码器                               */
  /* ------------------------------------------------------------------ */

  /**
   * @param {Uint8Array} oti 发送端通过描述符帧 extra 带过来的 12 字节 OTI
   */
  function createDecoder(oti) {
    if (!instance || !oti || oti.length !== 12) return null
    var ex = instance
    var otiPtr = ex.alloc(12)
    view().set(oti, otiPtr)
    var id = ex.decoder_create(otiPtr)
    ex.dealloc(otiPtr, 12)
    if (!id) return null

    var scratchPtr = 0
    var scratchLen = 0
    var accepted = 0
    var rejected = 0
    var result = null

    function ensureScratch(len) {
      if (len <= scratchLen) return
      if (scratchPtr) ex.dealloc(scratchPtr, scratchLen)
      scratchLen = len
      scratchPtr = ex.alloc(scratchLen)
    }

    return {
      id: id,
      get isComplete() {
        return result != null
      },
      get received() {
        return accepted
      },
      get rejected() {
        return rejected
      },
      /**
       * @returns {boolean} 是否被接受（含"这一帧让它完成了"）
       */
      add: function (block, esi, payload) {
        if (result) return false
        ensureScratch(payload.length)
        view().set(payload, scratchPtr)
        var code = ex.decoder_add(id, block, esi, scratchPtr, payload.length)
        if (code === 1) {
          var ptr = ex.decoder_result_ptr(id)
          var len = ex.decoder_result_len(id)
          result = view().slice(ptr, ptr + len)
          accepted++
          return true
        }
        if (code === 0) {
          accepted++
          return true
        }
        // 3=符号长度不符 4=块号越界 5=esi 越界：这是坏帧，丢掉即可
        rejected++
        return false
      },
      result: function () {
        return result
      },
      free: function () {
        try {
          ex.decoder_free(id)
          if (scratchPtr) ex.dealloc(scratchPtr, scratchLen)
        } catch (err) {
          /* 忽略 */
        }
      }
    }
  }

  return {
    ABI_VERSION: ABI_VERSION,
    DEFAULT_URL: DEFAULT_URL,
    load: load,
    loadFromBytes: loadFromBytes,
    isAvailable: isAvailable,
    status: status,
    createEncoder: createEncoder,
    createDecoder: createDecoder
  }
})

/* --------------------------------------------------------------------------
 * 在浏览器/插件页面里被 <script> 引入时，尝试后台预加载。
 *
 * 但**只在有可靠读取途径时才自动加载**：
 *   - preload 桥提供了 readBinary（fs.readFileSync，最可靠），或
 *   - 页面本身是 http(s)（fetch 可用）。
 * 否则（典型情形：file:// 且桥里没有 readBinary）就留着不动，让页面自己
 * 显式 `await load({ readBytes })`。这样不会把注定失败的尝试写成状态。
 * 想严格控制时序的页面仍然可以自己 await。
 * ------------------------------------------------------------------------ */
;(function autoLoadInBrowser() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  var core = window.OTP && window.OTP.raptorqCore
  if (!core || typeof core.load !== 'function') return
  var bridge = window.utoolsBridge
  var hasBridgeReader = Boolean(bridge && typeof bridge.readBinary === 'function')
  var httpPage =
    typeof location !== 'undefined' && location && /^https?:$/.test(location.protocol || '')
  if (!hasBridgeReader && !httpPage) return
  try {
    core.load()
  } catch (err) {
    /* 加载失败已经由 load() 内部消化，这里只是双保险 */
  }
})()
