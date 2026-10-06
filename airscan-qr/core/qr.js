/**
 * qr.js —— QR 生成与渲染（发送端用）
 *
 * 包了一层 vendor/qrcode-generator.js（MIT, Kazuhiko Arase），做三件事：
 *  1. 把 stringToBytes 覆写成 latin1，让 Byte 模式成为 8-bit clean 的，
 *     这样才能承载任意二进制帧。代价：任何 JS 字符串都必须自己先转字节。
 *  2. 提供"给定字节数，算出最小 QR 版本"的缓存查找（避免每帧重新试错）。
 *  3. 把模块矩阵渲染到 canvas / ImageData。
 *
 * 依赖：vendor/qrcode-generator.js 必须在此之前加载（浏览器用 <script>）。
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.OTP = Object.assign(root.OTP || {}, { qr: factory() })
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict'

  function resolveLib() {
    if (typeof qrcode !== 'undefined' && qrcode) return qrcode
    if (typeof require === 'function') {
      try {
        return require('../vendor/qrcode-generator.js')
      } catch (err) {
        /* 落到下面统一报错 */
      }
    }
    throw new Error('qrcode-generator 未加载：请先引入 vendor/qrcode-generator.js')
  }

  var qrcodeLib = null

  function lib() {
    if (!qrcodeLib) {
      qrcodeLib = resolveLib()
      // 关键：Byte 模式按"每字符一字节"处理，保证二进制不被 UTF-8 改写
      qrcodeLib.stringToBytes = function (s) {
        var out = []
        for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff)
        return out
      }
    }
    return qrcodeLib
  }

  var ECC_LEVELS = ['L', 'M', 'Q', 'H']

  /** QR 版本 → 模块数：version N 是 (21 + 4*(N-1)) × (21 + 4*(N-1)) */
  function moduleCountForVersion(version) {
    return 21 + 4 * (version - 1)
  }

  var versionCache = Object.create(null)

  /**
   * 给定字节数，找能装下的最小版本号。
   * 结果按 (ecc, length) 缓存——同一个会话里帧长固定，所以只会真正计算一次。
   */
  function versionFor(byteLength, ecc) {
    var level = ecc || 'L'
    var key = level + ':' + byteLength
    if (versionCache[key]) return versionCache[key]
    var q = lib()
    var payload = new Array(byteLength + 1).join('A')
    for (var v = 1; v <= 40; v++) {
      try {
        var qr = q(v, level)
        qr.addData(payload, 'Byte')
        qr.make()
        versionCache[key] = v
        return v
      } catch (err) {
        // 容量不够：qrcode-generator 溢出时**抛的是字符串而不是 Error**
        continue
      }
    }
    throw new Error('数据超出 QR 最大容量（' + byteLength + ' 字节 @ ECC ' + level + '）')
  }

  /** 某个纠错等级下单帧能塞的最大字节数（Version 40） */
  function maxFrameBytes(ecc) {
    var level = ecc || 'L'
    var key = 'max:' + level
    if (versionCache[key]) return versionCache[key]
    var q = lib()
    var lo = 1
    var hi = 3000
    var best = 0
    while (lo <= hi) {
      var mid = (lo + hi) >> 1
      try {
        var qr = q(40, level)
        qr.addData(new Array(mid + 1).join('A'), 'Byte')
        qr.make()
        best = mid
        lo = mid + 1
      } catch (err) {
        hi = mid - 1
      }
    }
    versionCache[key] = best
    return best
  }

  /**
   * 编码一帧
   * @param {Uint8Array} bytes
   * @param {string} [ecc] 'L' | 'M' | 'Q' | 'H'
   * @param {number} [version] 指定版本（固定帧长时传，可避免每帧版本抖动）
   * @returns {{version:number, moduleCount:number, isDark:function(number,number):boolean}}
   */
  function encode(bytes, ecc, version) {
    var level = ecc || 'L'
    var q = lib()
    var v = version || versionFor(bytes.length, level)
    var qr = q(v, level)
    qr.addData(String.fromCharCode.apply(null, toPlainArray(bytes)), 'Byte')
    qr.make()
    return {
      version: v,
      moduleCount: qr.getModuleCount(),
      isDark: function (row, col) {
        return qr.isDark(row, col)
      }
    }
  }

  function toPlainArray(bytes) {
    // 分块避免 apply 参数过多
    if (bytes.length <= 0x8000) return bytes
    var out = new Array(bytes.length)
    for (var i = 0; i < bytes.length; i++) out[i] = bytes[i]
    return out
  }

  /**
   * 渲染到 ImageData（测试 / 离屏用）
   * @param {{moduleCount:number,isDark:Function}} qr
   * @param {{scale?:number, quiet?:number, invert?:boolean}} [options]
   */
  function toImageData(qr, options) {
    var opt = options || {}
    var scale = opt.scale || 4
    var quiet = opt.quiet == null ? 4 : opt.quiet
    var n = qr.moduleCount
    var size = (n + quiet * 2) * scale
    var rgba = new Uint8ClampedArray(size * size * 4)
    var dark = opt.invert ? 255 : 0
    var light = opt.invert ? 0 : 255
    for (var i = 0; i < rgba.length; i += 4) {
      rgba[i] = rgba[i + 1] = rgba[i + 2] = light
      rgba[i + 3] = 255
    }
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue
        var x0 = (c + quiet) * scale
        var y0 = (r + quiet) * scale
        for (var dy = 0; dy < scale; dy++) {
          var rowStart = ((y0 + dy) * size + x0) * 4
          for (var dx = 0; dx < scale; dx++) {
            var p = rowStart + dx * 4
            rgba[p] = rgba[p + 1] = rgba[p + 2] = dark
          }
        }
      }
    }
    return { data: rgba, width: size, height: size }
  }

  /**
   * 渲染到 canvas。多码并行时用 drawCode() 往同一个 canvas 的不同区域画。
   * @param {HTMLCanvasElement} canvas
   * @param {{moduleCount:number,isDark:Function}} qr
   * @param {{scale?:number, quiet?:number, dark?:string, light?:string}} [options]
   */
  function drawToCanvas(canvas, qr, options) {
    var opt = options || {}
    var scale = opt.scale || 8
    var quiet = opt.quiet == null ? 2 : opt.quiet
    var n = qr.moduleCount
    var size = (n + quiet * 2) * scale
    canvas.width = size
    canvas.height = size
    var ctx = canvas.getContext('2d', { alpha: false })
    ctx.fillStyle = opt.light || '#ffffff'
    ctx.fillRect(0, 0, size, size)
    ctx.fillStyle = opt.dark || '#000000'
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale)
      }
    }
    return size
  }

  /**
   * 把 QR 画到 canvas 的指定矩形区域里（多码并行布局用）
   * @returns {number} 实际使用的边长
   */
  function drawInto(ctx, qr, x, y, boxSize, options) {
    var opt = options || {}
    var quiet = opt.quiet == null ? 2 : opt.quiet
    var n = qr.moduleCount
    var total = n + quiet * 2
    var scale = Math.max(1, Math.floor(boxSize / total))
    var size = total * scale
    var ox = x + Math.floor((boxSize - size) / 2)
    var oy = y + Math.floor((boxSize - size) / 2)
    ctx.fillStyle = opt.light || '#ffffff'
    ctx.fillRect(ox, oy, size, size)
    ctx.fillStyle = opt.dark || '#000000'
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(ox + (c + quiet) * scale, oy + (r + quiet) * scale, scale, scale)
      }
    }
    return size
  }

  return {
    ECC_LEVELS: ECC_LEVELS,
    moduleCountForVersion: moduleCountForVersion,
    versionFor: versionFor,
    maxFrameBytes: maxFrameBytes,
    encode: encode,
    toImageData: toImageData,
    drawToCanvas: drawToCanvas,
    drawInto: drawInto
  }
})
