/**
 * scan.js —— QR 识别与解帧（接收端用）
 *
 * 包了一层 vendor/jsQR.js（Apache-2.0, cozmo），统一处理三件事：
 *  1. 用 binaryData 取回**逐字节精确**的载荷（不能只用 result.data 字符串，
 *     二进制帧经过 UTF-8 解码会被破坏）。
 *  2. 把"识别 + 解帧 + CRC 校验"串成一步，顺带把非本协议的二维码丢掉。
 *  3. 提供灰度/降采样等预处理开关，低端摄像头上能明显提速。
 *
 * 依赖：vendor/jsQR.js 必须在此之前加载。
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.OTP = Object.assign(root.OTP || {}, { scan: factory() })
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict'

  function resolveLib() {
    if (typeof jsQR !== 'undefined' && jsQR) return jsQR
    if (typeof require === 'function') {
      try {
        return require('../vendor/jsQR.js')
      } catch (err) {
        /* 落到下面统一报错 */
      }
    }
    throw new Error('jsQR 未加载：请先引入 vendor/jsQR.js')
  }

  var jsqrLib = null

  function lib() {
    if (!jsqrLib) jsqrLib = resolveLib()
    return jsqrLib
  }

  /**
   * 从 RGBA 像素里识别一个二维码，返回原始字节
   * @param {Uint8ClampedArray|Uint8Array} rgba
   * @param {number} width
   * @param {number} height
   * @param {{inversionAttempts?: 'dontInvert'|'onlyInvert'|'attemptBoth'}} [options]
   * @returns {{bytes: Uint8Array, location: object}|null}
   */
  function decodeBytes(rgba, width, height, options) {
    var opt = options || {}
    var result = lib()(rgba, width, height, {
      inversionAttempts: opt.inversionAttempts || 'dontInvert'
    })
    if (!result) return null
    var binary = result.binaryData
    if (!binary || !binary.length) {
      // 理论上 Byte 模式一定会有 binaryData；兜底用 latin1 从 data 里还原
      var s = result.data || ''
      binary = new Array(s.length)
      for (var i = 0; i < s.length; i++) binary[i] = s.charCodeAt(i) & 0xff
    }
    return { bytes: Uint8Array.from(binary), location: result.location }
  }

  /**
   * 识别 + 解帧一步到位
   * @param {object} protocol OTP.protocol
   * @returns {object|null} 解出的帧，或 null
   */
  function decodeFrameFromImage(protocol, rgba, width, height, options) {
    var found = decodeBytes(rgba, width, height, options)
    if (!found) return null
    var frame = protocol.decodeFrame(found.bytes)
    if (!frame) return null
    frame.location = found.location
    return frame
  }

  /**
   * 把 ImageData/ImageBitmap 画到离屏 canvas 上再取像素（方便做缩放预处理）
   * @param {HTMLCanvasElement} canvas 复用的离屏 canvas
   */
  function drawScaled(canvas, source, srcWidth, srcHeight, maxWidth) {
    var ratio = maxWidth && srcWidth > maxWidth ? maxWidth / srcWidth : 1
    var w = Math.max(1, Math.round(srcWidth * ratio))
    var h = Math.max(1, Math.round(srcHeight * ratio))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    var ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
    ctx.drawImage(source, 0, 0, srcWidth, srcHeight, 0, 0, w, h)
    return ctx.getImageData(0, 0, w, h)
  }

  /**
   * 估算摄像头画面里的二维码边长是否符合"能扫"的下限。
   * 经验值：模块数 × 2 像素以下基本扫不动（Nyquist 边上还要留余量）。
   */
  function scanFeasibility(moduleCount, pixelSize, quiet) {
    var modules = moduleCount + (quiet == null ? 4 : quiet) * 2
    var pxPerModule = pixelSize / modules
    return { pxPerModule: pxPerModule, ok: pxPerModule >= 2.5 }
  }

  return {
    decodeBytes: decodeBytes,
    decodeFrameFromImage: decodeFrameFromImage,
    drawScaled: drawScaled,
    scanFeasibility: scanFeasibility
  }
})
