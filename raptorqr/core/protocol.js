/**
 * protocol.js —— 三个方案共用的光学传输帧协议 v1
 *
 * 数据通路：文件字节 → 分块 → 编码符号 → 帧 → QR Byte 模式 → 屏幕
 *                                                              ↓
 *           文件字节 ← 组块 ← 解码还原 ← 解帧 ← jsQR ← 摄像头
 *
 * 所有帧都是纯二进制，用 QR 的 Byte 模式承载（8-bit clean）。
 * 注意：qrcode-generator 的 stringToBytes 被覆写成 latin1，
 * 所以任何字符串都必须先自己转成字节，绝不能直接把 JS 字符串塞进 addData()。
 *
 * 帧格式（大端）：
 *
 *   描述符帧 type=0                                   数据帧 type=1
 *   ┌────┬────┬──────┬──────┬───────┬───────────┐    ┌────┬────┬──────┬──────┬─────┬─────────┐
 *   │magic│type│sessId│ mode │ flags │ symbolSize│    │magic│type│sessId│block │ esi │ payload │
 *   └────┴────┴──────┴──────┴───────┴───────────┘    └────┴────┴──────┴──────┴─────┴─────────┘
 *   总符号数 / 块数 / 总字节 / 文件名 / CRC32            尾部同样带 CRC32
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.OTP = Object.assign(root.OTP || {}, { protocol: factory() })
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict'

  var MAGIC = 0xa7
  var TYPE_DESCRIPTOR = 0
  var TYPE_DATA = 1

  // 编码模式：描述符里告诉接收端该用哪种解码器
  var MODE_SEQUENTIAL = 0 // 顺序分片 + 轮播（无喷泉码）
  var MODE_FOUNTAIN = 1 // LT 喷泉码
  var MODE_RAPTORQ = 2 // RaptorQ (RFC 6330)

  var FLAG_SHA256 = 1
  var FLAG_COMPRESSED = 2

  /** QR Version 40 / ECC L / Byte 模式的硬上限 */
  var MAX_FRAME_BYTES = 2953
  /** 数据帧固定头部长度（不含 payload 与 CRC） */
  var DATA_HEADER_BYTES = 10
  /**
   * 描述符帧固定头部长度（不含文件名与 CRC）
   *   magic(1) type(1) sessionId(2) mode(1) flags(1) symbolSize(2)
   *   totalSymbols(4) blockCount(2) totalBytes(4) nameLen(1)
   * totalSymbols 用 u32 而不是 u16：按 400B 切片时 u16 只能表示 26MB，
   * 撑不起"最大 64MB"这类目标。
   */
  var DESCRIPTOR_HEADER_BYTES = 19

  /* ------------------------------------------------------------------ */
  /*                                 CRC32                               */
  /* ------------------------------------------------------------------ */

  var CRC_TABLE = (function () {
    var table = new Int32Array(256)
    for (var n = 0; n < 256; n++) {
      var c = n
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
    return table
  })()

  function crc32(bytes, start, end) {
    var s = start == null ? 0 : start
    var e = end == null ? bytes.length : end
    var c = -1
    for (var i = s; i < e; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }

  /* ------------------------------------------------------------------ */
  /*                          字节 / 字符串工具                          */
  /* ------------------------------------------------------------------ */

  function utf8Encode(str) {
    return new TextEncoder().encode(str)
  }

  function utf8Decode(bytes) {
    return new TextDecoder().decode(bytes)
  }

  /** 字节数组 → latin1 字符串（每个字节一个字符，供 QR Byte 模式使用） */
  function bytesToLatin1(bytes) {
    var out = ''
    var CHUNK = 0x8000
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
    }
    return out
  }

  /** latin1 字符串 → 字节数组 */
  function latin1ToBytes(str) {
    var out = new Uint8Array(str.length)
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff
    return out
  }

  /** FNV-1a 32 位，用来派生会话 ID */
  function fnv1a(bytes, seed) {
    var h = (seed == null ? 0x811c9dc5 : seed) >>> 0
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i]
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h >>> 0
  }

  /** 由文件内容派生 16 位会话 ID（接收端用来丢弃上一次传输的残留帧） */
  function makeSessionId(bytes) {
    var id = fnv1a(bytes, 0x811c9dc5) ^ fnv1a(bytes, 0x9e3779b9)
    return id & 0xffff
  }

  /* ------------------------------------------------------------------ */
  /*                          分块（source block）规划                    */
  /* ------------------------------------------------------------------ */

  /**
   * 把 totalBytes 切成若干等长的源块，每块的符号数不超过 maxBlockSymbols。
   * 分块的好处：解码规模可控（内存 / 时间），且可以边收边解码。
   */
  function planBlocks(totalBytes, symbolSize, maxBlockSymbols) {
    var maxSymbols = maxBlockSymbols || 1024
    var totalSymbols = Math.ceil(totalBytes / symbolSize) || 1
    var blockCount = Math.max(1, Math.ceil(totalSymbols / maxSymbols))
    var symbolsPerBlock = Math.ceil(totalSymbols / blockCount)
    blockCount = Math.ceil(totalSymbols / symbolsPerBlock)
    return {
      totalBytes: totalBytes,
      symbolSize: symbolSize,
      totalSymbols: totalSymbols,
      blockCount: blockCount,
      symbolsPerBlock: symbolsPerBlock,
      maxBlockSymbols: maxSymbols
    }
  }

  /** 第 blockIndex 块的符号数（最后一块可能少一些） */
  function symbolsInBlock(plan, blockIndex) {
    var start = blockIndex * plan.symbolsPerBlock
    return Math.max(0, Math.min(plan.symbolsPerBlock, plan.totalSymbols - start))
  }

  /** 取第 index 个源符号（不足则补零），返回 Uint8Array */
  function readSymbol(data, index, symbolSize) {
    var out = new Uint8Array(symbolSize)
    var start = index * symbolSize
    if (start >= data.length) return out
    out.set(data.subarray(start, Math.min(start + symbolSize, data.length)))
    return out
  }

  /* ------------------------------------------------------------------ */
  /*                                帧编码                               */
  /* ------------------------------------------------------------------ */

  function writeU16(view, offset, value) {
    view[offset] = (value >>> 8) & 0xff
    view[offset + 1] = value & 0xff
  }

  function readU16(bytes, offset) {
    return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0
  }

  function writeU32(view, offset, value) {
    view[offset] = (value >>> 24) & 0xff
    view[offset + 1] = (value >>> 16) & 0xff
    view[offset + 2] = (value >>> 8) & 0xff
    view[offset + 3] = value & 0xff
  }

  function readU32(bytes, offset) {
    return (
      ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
      0
    )
  }

  /**
   * 描述符帧：接收端靠它知道"在传什么、多大、怎么解"
   *
   * `extra` 是可选的尾部附加区（放在文件名之后、CRC 之前）。RaptorQ 模式用它携带
   * 12 字节的 OTI；不带 extra 的帧完全兼容，解析出来是空数组。
   *
   * @param {{sessionId:number, mode:number, symbolSize:number, totalSymbols:number,
   *          blockCount:number, totalBytes:number, name:string, flags?:number,
   *          extra?:Uint8Array}} descriptor
   */
  function encodeDescriptor(descriptor) {
    var name = utf8Encode(descriptor.name || '')
    if (name.length > 255) name = name.subarray(0, 255)
    var extra = descriptor.extra && descriptor.extra.length ? descriptor.extra : null
    var size = DESCRIPTOR_HEADER_BYTES + name.length + (extra ? extra.length : 0) + 4
    var out = new Uint8Array(size)
    out[0] = MAGIC
    out[1] = TYPE_DESCRIPTOR
    writeU16(out, 2, descriptor.sessionId)
    out[4] = descriptor.mode & 0xff
    out[5] = descriptor.flags || 0
    writeU16(out, 6, descriptor.symbolSize)
    writeU32(out, 8, descriptor.totalSymbols)
    writeU16(out, 12, descriptor.blockCount)
    writeU32(out, 14, descriptor.totalBytes)
    out[18] = name.length
    out.set(name, 19)
    if (extra) out.set(extra, 19 + name.length)
    writeU32(out, size - 4, crc32(out, 0, size - 4))
    return out
  }

  /** 数据帧：blockIndex + esi 定位编码符号 */
  function encodeDataFrame(sessionId, blockIndex, esi, payload) {
    var size = DATA_HEADER_BYTES + payload.length + 4
    var out = new Uint8Array(size)
    out[0] = MAGIC
    out[1] = TYPE_DATA
    writeU16(out, 2, sessionId)
    writeU16(out, 4, blockIndex)
    writeU32(out, 6, esi)
    out.set(payload, DATA_HEADER_BYTES)
    writeU32(out, size - 4, crc32(out, 0, size - 4))
    return out
  }

  /**
   * 解帧。CRC 不过 / magic 不符 / 长度不足一律返回 null（当作噪声丢弃）。
   * @returns {null | {type:number, sessionId:number, ...}}
   */
  function decodeFrame(bytes) {
    if (!bytes || bytes.length < DESCRIPTOR_HEADER_BYTES + 4) return null
    if (bytes[0] !== MAGIC) return null
    var expected = readU32(bytes, bytes.length - 4)
    if (crc32(bytes, 0, bytes.length - 4) !== expected) return null

    var type = bytes[1]
    var sessionId = readU16(bytes, 2)

    if (type === TYPE_DESCRIPTOR) {
      var nameLen = bytes[18]
      if (bytes.length < DESCRIPTOR_HEADER_BYTES + nameLen + 4) return null
      var extraStart = 19 + nameLen
      var extraEnd = bytes.length - 4
      return {
        type: TYPE_DESCRIPTOR,
        sessionId: sessionId,
        mode: bytes[4],
        flags: bytes[5],
        symbolSize: readU16(bytes, 6),
        totalSymbols: readU32(bytes, 8),
        blockCount: readU16(bytes, 12),
        totalBytes: readU32(bytes, 14),
        name: utf8Decode(bytes.subarray(19, 19 + nameLen)),
        // 可选附加区：RaptorQ 用它携带 12 字节 OTI；没有就是空数组
        extra: extraEnd > extraStart ? bytes.subarray(extraStart, extraEnd) : new Uint8Array(0)
      }
    }

    if (type === TYPE_DATA) {
      return {
        type: TYPE_DATA,
        sessionId: sessionId,
        blockIndex: readU16(bytes, 4),
        esi: readU32(bytes, 6),
        payload: bytes.subarray(DATA_HEADER_BYTES, bytes.length - 4)
      }
    }

    return null
  }

  /* ------------------------------------------------------------------ */
  /*                              人肉可读                                */
  /* ------------------------------------------------------------------ */

  function formatBytes(n) {
    if (n == null || isNaN(n)) return '—'
    if (n < 1024) return n + ' B'
    var units = ['KB', 'MB', 'GB']
    var v = n / 1024
    var i = 0
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024
      i++
    }
    return v.toFixed(v >= 10 ? 0 : 1) + ' ' + units[i]
  }

  function modeName(mode) {
    return mode === MODE_FOUNTAIN ? 'LT 喷泉码' : mode === MODE_RAPTORQ ? 'RaptorQ' : '顺序分片'
  }

  return {
    MAGIC: MAGIC,
    TYPE_DESCRIPTOR: TYPE_DESCRIPTOR,
    TYPE_DATA: TYPE_DATA,
    MODE_SEQUENTIAL: MODE_SEQUENTIAL,
    MODE_FOUNTAIN: MODE_FOUNTAIN,
    MODE_RAPTORQ: MODE_RAPTORQ,
    FLAG_SHA256: FLAG_SHA256,
    FLAG_COMPRESSED: FLAG_COMPRESSED,
    MAX_FRAME_BYTES: MAX_FRAME_BYTES,
    DATA_HEADER_BYTES: DATA_HEADER_BYTES,
    DESCRIPTOR_HEADER_BYTES: DESCRIPTOR_HEADER_BYTES,
    crc32: crc32,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    bytesToLatin1: bytesToLatin1,
    latin1ToBytes: latin1ToBytes,
    fnv1a: fnv1a,
    makeSessionId: makeSessionId,
    planBlocks: planBlocks,
    symbolsInBlock: symbolsInBlock,
    readSymbol: readSymbol,
    encodeDescriptor: encodeDescriptor,
    encodeDataFrame: encodeDataFrame,
    decodeFrame: decodeFrame,
    formatBytes: formatBytes,
    modeName: modeName
  }
})
