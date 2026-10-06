/**
 * fountain.js —— LT 喷泉码（Luby Transform）
 *
 * 为什么要喷泉码：光学信道是单向的，接收端没法"请求重发第 7 帧"。
 * 喷泉码让发送端可以无限产生**从不重复**的编码符号，接收端只要凑够
 * 任意 K×(1+ε) 个不同符号就能还原，丢帧、乱序、中途加入都天然容错。
 *
 * 实现要点：
 *  - 度分布用标准 Robust Soliton，发送端和接收端用**同一个确定性 PRNG**
 *    （种子 = sessionId + blockIndex + esi）各自算出相同的一组邻居，所以
 *    帧里只需要带 esi，不需要带邻居列表。
 *  - 前 K 个 esi 直接就是源符号（系统化），零丢包时开销为 0。
 *  - 解码用增量 GF(2) 行化简（RREF）：每收到一帧就约化一次，凑满秩 K 时
 *    每个变量对应的行只剩一个 1，直接取出即可。K 被分块限制在 1024 以内，
 *    所以这个 O(K²) 的稠密做法完全够快。
 */
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.OTP = Object.assign(root.OTP || {}, { fountain: factory() })
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict'

  /* ------------------------------------------------------------------ */
  /*                          确定性随机 / 度分布                          */
  /* ------------------------------------------------------------------ */

  /** mulberry32：小而快的确定性 PRNG，同种子必得同序列 */
  function mulberry32(seed) {
    var a = seed >>> 0
    return function () {
      a = (a + 0x6d2b79f5) >>> 0
      var t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /** 把 (sessionId, blockIndex, esi) 混成一个 PRNG 种子 */
  function hashSeed(sessionId, blockIndex, esi) {
    var h = 0x811c9dc5
    h = Math.imul(h ^ (sessionId & 0xffff), 0x01000193) >>> 0
    h = Math.imul(h ^ (blockIndex & 0xffff), 0x01000193) >>> 0
    h = Math.imul(h ^ (esi >>> 0), 0x01000193) >>> 0
    h ^= h >>> 15
    return h >>> 0
  }

  var cdfCache = Object.create(null)

  /**
   * Robust Soliton 分布的累积分布函数（CDF[1..K]）
   * @param {number} K 源符号个数
   * @param {number} [c] 常数，默认 0.1
   * @param {number} [delta] 失败概率上界，默认 0.5
   */
  function robustSolitonCdf(K, c, delta) {
    var cc = c == null ? 0.1 : c
    var dd = delta == null ? 0.5 : delta
    var key = K + ':' + cc + ':' + dd
    if (cdfCache[key]) return cdfCache[key]

    var ideal = new Float64Array(K + 1)
    ideal[1] = 1 / K
    for (var d = 2; d <= K; d++) ideal[d] = 1 / (d * (d - 1))

    // R = c * ln(K/delta) * sqrt(K)
    var R = cc * Math.log(K / dd) * Math.sqrt(K)
    var spike = Math.max(1, Math.floor(K / R))
    var tau = new Float64Array(K + 1)
    for (var i = 1; i <= K; i++) {
      if (i < spike) tau[i] = R / (i * K)
      else if (i === spike) tau[i] = (R * Math.log(R / dd)) / K
    }

    var Z = 0
    for (var j = 1; j <= K; j++) Z += ideal[j] + tau[j]

    var cdf = new Float64Array(K + 1)
    var acc = 0
    for (var m = 1; m <= K; m++) {
      acc += (ideal[m] + tau[m]) / Z
      cdf[m] = acc
    }
    cdf[K] = 1
    cdfCache[key] = cdf
    return cdf
  }

  /** 按 CDF 反采样出一个度（二分查找） */
  function sampleDegree(cdf, K, rand) {
    var u = rand()
    var lo = 1
    var hi = K
    while (lo < hi) {
      var mid = (lo + hi) >> 1
      if (cdf[mid] < u) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** 用同一个 PRNG 选出 d 个**互不相同**的源符号下标 */
  function pickNeighbors(K, d, rand) {
    var degree = Math.min(d, K)
    if (degree >= K) {
      var all = new Int32Array(K)
      for (var a = 0; a < K; a++) all[a] = a
      return all
    }
    // 大度数走"部分洗牌"：拒绝采样在 d 接近 K 时是 O(K ln K)，这里只需 O(K)
    if (degree > K >> 2) {
      var pool = new Int32Array(K)
      for (var p = 0; p < K; p++) pool[p] = p
      for (var i = 0; i < degree; i++) {
        var j = i + Math.floor(rand() * (K - i))
        if (j >= K) j = K - 1
        var tmp = pool[i]
        pool[i] = pool[j]
        pool[j] = tmp
      }
      return pool.slice(0, degree)
    }
    var out = new Int32Array(degree)
    var used = Object.create(null)
    var filled = 0
    while (filled < degree) {
      var idx = Math.floor(rand() * K)
      if (idx >= K) idx = K - 1
      if (used[idx]) continue
      used[idx] = 1
      out[filled++] = idx
    }
    return out
  }

  /**
   * 修复符号的度数策略。
   *
   * 纯 LT（robust soliton）在"只差最后几个符号"时效率很差：此时缺失变量只剩 m 个，
   * 而 soliton 采出来的度数普遍很小，一个度为 d 的修复符号能覆盖到缺失变量的概率
   * 只有约 m·d/K。实测 1/3 丢包下 64 个符号要播 125 帧（≈1.95×）。
   *
   * 因为本解码器用的是稠密 GF(2) 消元（不是 peeling），把修复符号做稠密反而更划算：
   * 每来一帧几乎必定提升秩，代价是编码端每符号多花 O(K) 次异或。实测见
   * shared/test/repair-strategy.bench.js。
   */
  var REPAIR_DENSE_RATIO = 0.5
  var repairStrategy = 'dense'

  function setRepairStrategy(name) {
    repairStrategy = name
  }

  function repairDegree(K, rand) {
    if (repairStrategy === 'soliton') return sampleDegree(robustSolitonCdf(K), K, rand)
    var dense = Math.max(2, Math.round(K * REPAIR_DENSE_RATIO))
    if (repairStrategy === 'dense') return dense
    // hybrid：先按 soliton 发一轮，之后转稠密
    return Math.max(dense, sampleDegree(robustSolitonCdf(K), K, rand))
  }

  /** 由 esi 推出这一帧覆盖哪些源符号：前 K 个是系统化符号，之后走修复符号策略 */
  function neighborsFor(esi, K, sessionId, blockIndex) {
    if (esi < K) {
      var single = new Int32Array(1)
      single[0] = esi
      return single
    }
    var rand = mulberry32(hashSeed(sessionId, blockIndex, esi))
    return pickNeighbors(K, repairDegree(K, rand), rand)
  }

  /* ------------------------------------------------------------------ */
  /*                              字节运算                                */
  /* ------------------------------------------------------------------ */

  function aligned(view) {
    return view.byteOffset % 4 === 0
  }

  /** dst ^= src（等长） */
  function xorInto(dst, src) {
    var n = dst.length
    if (n === src.length && (n & 3) === 0 && aligned(dst) && aligned(src)) {
      var d32 = new Uint32Array(dst.buffer, dst.byteOffset, n >> 2)
      var s32 = new Uint32Array(src.buffer, src.byteOffset, n >> 2)
      for (var i = 0; i < d32.length; i++) d32[i] ^= s32[i]
      return dst
    }
    for (var j = 0; j < n; j++) dst[j] ^= src[j]
    return dst
  }

  /* ------------------------------------------------------------------ */
  /*                                编码器                                */
  /* ------------------------------------------------------------------ */

  /**
   * @param {Uint8Array} blockData 这一块的原始字节（长度必须是 k*symbolSize，尾部已补零）
   * @param {number} k 源符号数
   * @param {number} symbolSize
   * @param {number} sessionId
   * @param {number} blockIndex
   */
  function BlockEncoder(blockData, k, symbolSize, sessionId, blockIndex) {
    return {
      k: k,
      symbolSize: symbolSize,
      /** 取第 esi 个编码符号（esi 可以无限增长） */
      symbol: function (esi) {
        var out = new Uint8Array(symbolSize)
        var idx = neighborsFor(esi, k, sessionId, blockIndex)
        for (var i = 0; i < idx.length; i++) {
          var start = idx[i] * symbolSize
          for (var b = 0; b < symbolSize; b++) out[b] ^= blockData[start + b]
        }
        return out
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*                                解码器                                */
  /* ------------------------------------------------------------------ */

  /**
   * 增量 GF(2) 行化简解码器：每收一帧就把它约化进已有的行阶梯矩阵，
   * 凑满秩 k 时每个变量对应的行只剩一个 1，解就出来了。
   */
  function BlockDecoder(k, symbolSize, sessionId, blockIndex) {
    var nbytes = (k + 7) >> 3
    var rows = [] // { bits: Uint8Array(nbytes), data: Uint8Array(symbolSize) }
    var pivotRow = new Int32Array(k).fill(-1)
    var rank = 0
    var solution = null

    function getBit(bits, p) {
      return (bits[p >> 3] >> (p & 7)) & 1
    }

    function setBit(bits, p) {
      bits[p >> 3] |= 1 << (p & 7)
    }

    function lowestSetBit(bits) {
      for (var w = 0; w < nbytes; w++) {
        var word = bits[w]
        if (word) {
          var b = 31 - Math.clz32(word & -word)
          var p = (w << 3) + b
          return p < k ? p : -1
        }
      }
      return -1
    }

    function makeRow(esi, payload) {
      var bits = new Uint8Array(nbytes)
      var idx = neighborsFor(esi, k, sessionId, blockIndex)
      for (var i = 0; i < idx.length; i++) setBit(bits, idx[i])
      return { bits: bits, data: new Uint8Array(payload) }
    }

    return {
      k: k,
      get rank() {
        return rank
      },
      get progress() {
        return k === 0 ? 1 : rank / k
      },
      get isComplete() {
        return solution != null
      },
      /**
       * 摄入一个编码符号
       * @returns {boolean} 是否提升了秩（false = 重复帧 / 线性相关，可以直接丢）
       */
      add: function (esi, payload) {
        if (solution || payload.length !== symbolSize) return false
        var row = makeRow(esi, payload)

        // 正向消元：把所有主元列上的 1 消掉
        for (var p = 0; p < k; p++) {
          if (getBit(row.bits, p) && pivotRow[p] >= 0) {
            xorInto(row.bits, rows[pivotRow[p]].bits)
            xorInto(row.data, rows[pivotRow[p]].data)
          }
        }

        var pivot = lowestSetBit(row.bits)
        if (pivot < 0) return false // 线性相关（或全零行），丢弃

        // 反向消元：把新主元从已有行里消掉，始终保持 RREF
        for (var r = 0; r < rows.length; r++) {
          if (getBit(rows[r].bits, pivot)) {
            xorInto(rows[r].bits, row.bits)
            xorInto(rows[r].data, row.data)
          }
        }

        pivotRow[pivot] = rows.length
        rows.push(row)
        rank++

        if (rank === k) {
          var out = new Uint8Array(k * symbolSize)
          for (var v = 0; v < k; v++) out.set(rows[pivotRow[v]].data, v * symbolSize)
          solution = out
        }
        return true
      },
      /** @returns {Uint8Array|null} k*symbolSize 的原始块数据 */
      result: function () {
        return solution
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*                        面向整个文件的高层封装                         */
  /* ------------------------------------------------------------------ */

  /**
   * 发送端：把整个文件包装成"按 (blockIndex, esi) 取符号"的喷泉
   * @param {Uint8Array} data
   * @param {object} plan protocol.planBlocks() 的产物
   * @param {number} sessionId
   */
  function FountainEncoder(data, plan, sessionId) {
    var encoders = []
    for (var b = 0; b < plan.blockCount; b++) {
      var k = Math.max(1, Math.min(plan.symbolsPerBlock, plan.totalSymbols - b * plan.symbolsPerBlock))
      var padded = new Uint8Array(k * plan.symbolSize)
      var start = b * plan.symbolsPerBlock * plan.symbolSize
      var end = Math.min(start + padded.length, data.length)
      if (start < data.length) padded.set(data.subarray(start, end))
      encoders.push(BlockEncoder(padded, k, plan.symbolSize, sessionId, b))
    }
    return {
      plan: plan,
      sessionId: sessionId,
      blockCount: plan.blockCount,
      symbolsInBlock: function (blockIndex) {
        return encoders[blockIndex] ? encoders[blockIndex].k : 0
      },
      /** esi 无限增长即可，发送端可以一直播下去 */
      symbol: function (blockIndex, esi) {
        var enc = encoders[blockIndex]
        if (!enc) return null
        return enc.symbol(esi)
      }
    }
  }

  /**
   * 接收端：按块解码，全部凑齐后拼出文件
   * @param {object} descriptor protocol.decodeFrame() 解出的描述符
   */
  function FountainDecoder(descriptor) {
    var plan = {
      totalBytes: descriptor.totalBytes,
      symbolSize: descriptor.symbolSize,
      totalSymbols: descriptor.totalSymbols,
      blockCount: descriptor.blockCount,
      symbolsPerBlock: Math.ceil(descriptor.totalSymbols / descriptor.blockCount)
    }
    var decoders = []
    for (var b = 0; b < plan.blockCount; b++) {
      var k = Math.max(1, Math.min(plan.symbolsPerBlock, plan.totalSymbols - b * plan.symbolsPerBlock))
      decoders.push(BlockDecoder(k, plan.symbolSize, descriptor.sessionId, b))
    }

    return {
      plan: plan,
      symbolSize: plan.symbolSize,
      add: function (blockIndex, esi, payload) {
        var dec = decoders[blockIndex]
        if (!dec || dec.isComplete) return false
        return dec.add(esi, payload)
      },
      blockProgress: function (blockIndex) {
        var dec = decoders[blockIndex]
        return dec ? dec.progress : 0
      },
      /** 所有块都解出来的比例 */
      get progress() {
        var sum = 0
        for (var i = 0; i < decoders.length; i++) sum += decoders[i].progress
        return decoders.length ? sum / decoders.length : 1
      },
      get isComplete() {
        for (var i = 0; i < decoders.length; i++) if (!decoders[i].isComplete) return false
        return true
      },
      /** @returns {Uint8Array|null} */
      assemble: function () {
        if (!this.isComplete) return null
        var out = new Uint8Array(plan.totalBytes)
        var offset = 0
        for (var i = 0; i < decoders.length; i++) {
          var block = decoders[i].result()
          var take = Math.min(block.length, plan.totalBytes - offset)
          out.set(block.subarray(0, take), offset)
          offset += take
        }
        return out
      }
    }
  }

  return {
    mulberry32: mulberry32,
    hashSeed: hashSeed,
    robustSolitonCdf: robustSolitonCdf,
    sampleDegree: sampleDegree,
    pickNeighbors: pickNeighbors,
    neighborsFor: neighborsFor,
    setRepairStrategy: setRepairStrategy,
    xorInto: xorInto,
    BlockEncoder: BlockEncoder,
    BlockDecoder: BlockDecoder,
    FountainEncoder: FountainEncoder,
    FountainDecoder: FountainDecoder
  }
})
