/**
 * multiscan.ts —— 多码并行识别（收端）与会话状态机
 *
 * jsQR 一次只认一个码，所以"同屏 4 个码"只能靠**画面分区**：
 *   整幅先试一次（单码的便宜路径）→ 再按候选布局把画面切成 2 / 4 块分别识别。
 * 候选布局来自 RQ.layout.candidateLayouts()，第一套与发送端同几何，
 * 后面的变体用来兜住两端分辨率/窗口尺寸不一致的情况。
 *
 * 诚实说明（UI 上也会写）：
 *   - 这是"分区多次识别"，不是 jsQR 原生多码；
 *   - 分区数越多，单帧识别的 CPU 越贵，所以带粘性策略：某个布局命中过就先用它，
 *     连续多次不中再放宽回去找；
 *   - 极端情况下（码很小 / 分区切偏）仍可能只认出一个码，此时进度会明显变慢，
 *     UI 会提示用户可以切"接收分区"手动指认。
 *
 * 本文件是纯函数 + 状态机，不碰 DOM，可以直接在 Node 里跑测试。
 */
;(function (root) {
  'use strict'
  var RQ = (root.RQ = root.RQ || {})

  /**
   * 从 ImageData 里抠出一个矩形（越界自动裁剪），返回新的 ImageData 形状对象
   */
  function extractRegion(imageData, rect) {
    var x0 = Math.max(0, Math.min(imageData.width - 1, Math.round(rect.x)))
    var y0 = Math.max(0, Math.min(imageData.height - 1, Math.round(rect.y)))
    var width = Math.max(1, Math.min(Math.round(rect.width), imageData.width - x0))
    var height = Math.max(1, Math.min(Math.round(rect.height), imageData.height - y0))
    var out = new Uint8ClampedArray(width * height * 4)
    var rowBytes = width * 4
    for (var row = 0; row < height; row++) {
      var start = ((y0 + row) * imageData.width + x0) * 4
      var slice = imageData.data.subarray(start, start + rowBytes)
      out.set(slice, row * rowBytes)
    }
    return { data: out, width: width, height: height }
  }

  /** 在一个布局的每个码位区域里各识别一次 */
  function scanLayout(protocol, imageData, layout, options) {
    var opts = options || {}
    var rects = RQ.layout.regionRects(layout, opts.expand)
    var out = []
    for (var i = 0; i < rects.length; i++) {
      var region = extractRegion(imageData, rects[i])
      var frame = root.OTP.scan.decodeFrameFromImage(
        protocol,
        region.data,
        region.width,
        region.height,
        opts.scanOptions
      )
      if (frame) {
        frame.slot = rects[i].index
        frame.region = rects[i]
        out.push(frame)
      }
    }
    return out
  }

  function frameKey(frame) {
    return frame.sessionId + ':' + frame.blockIndex + ':' + frame.esi
  }

  /**
   * 按候选布局依次识别，返回去重后的帧
   * @param {object} protocol OTP.protocol
   * @param {{data:Uint8ClampedArray,width:number,height:number}} imageData
   * @param {{multiQr?:number, expand?:number, layouts?:Array<any>, scanOptions?:any,
   *          tryWhole?:boolean}} [options] multiQr 传 0/undefined = 自动
   */
  function scanRegions(protocol, imageData, options) {
    var opts = options || {}
    var layouts = opts.layouts || RQ.layout.candidateLayouts(imageData.width, imageData.height, opts.multiQr)
    var seen = {}
    var frames = []
    var layoutIndex = -1

    function absorb(list) {
      for (var i = 0; i < list.length; i++) {
        var key = frameKey(list[i])
        if (seen[key]) continue
        seen[key] = true
        frames.push(list[i])
      }
    }

    // 便宜路径：整幅当单码试一次（不复制像素）
    if (opts.tryWhole !== false) {
      var whole = root.OTP.scan.decodeFrameFromImage(protocol, imageData.data, imageData.width, imageData.height, opts.scanOptions)
      if (whole) {
        whole.slot = 0
        absorb([whole])
        if (opts.multiQr === 1) return { frames: frames, layoutIndex: -1, layoutsTried: 0 }
      }
    }

    for (var i = 0; i < layouts.length; i++) {
      var hit = scanLayout(protocol, imageData, layouts[i], opts)
      if (hit.length) {
        if (layoutIndex < 0) layoutIndex = i
        absorb(hit)
      }
    }
    return { frames: frames, layoutIndex: layoutIndex, layoutsTried: layouts.length }
  }

  /**
   * 带粘性的扫描器：稳态下只反复用命中的那套分区，避免每帧都把所有布局试一遍
   * @param {{multiQr?:number, expand?:number, scanOptions?:any, missLimit?:number}} [options]
   */
  function createScanner(protocol, options) {
    var opts = options || {}
    var preferred = -1
    var misses = 0
    var missLimit = opts.missLimit == null ? 30 : opts.missLimit

    return {
      scan: function (imageData) {
        var layouts = RQ.layout.candidateLayouts(imageData.width, imageData.height, opts.multiQr)
        var order = []
        var idx = []
        var i
        if (preferred >= 0 && preferred < layouts.length) {
          order.push(layouts[preferred])
          idx.push(preferred)
        }
        for (i = 0; i < layouts.length; i++) {
          if (i === preferred) continue
          order.push(layouts[i])
          idx.push(i)
        }

        var seen = {}
        var frames = []
        var hitLayout = -1

        // 便宜路径：整幅先试一次（单码时一帧就够，不必再分区）
        if (opts.tryWhole !== false) {
          var whole = root.OTP.scan.decodeFrameFromImage(
            protocol,
            imageData.data,
            imageData.width,
            imageData.height,
            opts.scanOptions
          )
          if (whole) {
            whole.slot = 0
            seen[frameKey(whole)] = true
            frames.push(whole)
            if (opts.multiQr === 1) return { frames: frames, preferred: preferred }
          }
        }

        for (var k = 0; k < order.length; k++) {
          var hit = scanLayout(protocol, imageData, order[k], opts)
          if (!hit.length) continue
          if (hitLayout < 0) hitLayout = idx[k]
          for (var j = 0; j < hit.length; j++) {
            var key = frameKey(hit[j])
            if (seen[key]) continue
            seen[key] = true
            frames.push(hit[j])
          }
          // 首选布局（上一帧命中的那套）已经有收获，就不必再扫其它布局
          if (idx[k] === preferred) break
        }

        if (hitLayout >= 0) {
          preferred = hitLayout
          misses = 0
        } else {
          misses += 1
          if (misses > missLimit) {
            preferred = -1
            misses = 0
          }
        }
        return { frames: frames, preferred: preferred }
      },
      preferredLayout: function () {
        return preferred
      },
      reset: function () {
        preferred = -1
        misses = 0
      }
    }
  }

  /**
   * 接收会话：描述符 → 解码器 → 收符号 → 组装
   * sessionId 一变就整体重置（上一轮传输的残留帧会被判为 stale 丢掉）
   */
  function createSession(protocol, options) {
    var opts = options || {}
    var descriptor = null
    var receiver = null
    var assembled = null
    var decoderError = ''
    var stats = { descriptors: 0, frames: 0, accepted: 0, duplicate: 0, stale: 0, resets: 0 }

    function reset() {
      descriptor = null
      receiver = null
      assembled = null
      decoderError = ''
      stats.frames = 0
      stats.accepted = 0
      stats.duplicate = 0
      stats.stale = 0
    }

    return {
      /**
       * 摄入一帧
       * @returns {'descriptor'|'descriptor-dup'|'accepted'|'duplicate'|'stale'|'no-descriptor'|'ignored'}
       */
      ingest: function (frame) {
        if (!frame || frame.type == null) return 'ignored'

        if (frame.type === protocol.TYPE_DESCRIPTOR) {
          stats.descriptors += 1
          var same =
            descriptor &&
            descriptor.sessionId === frame.sessionId &&
            descriptor.totalBytes === frame.totalBytes &&
            descriptor.totalSymbols === frame.totalSymbols
          if (same) {
            // 之前因为缺内核解不了？内核可能刚好就绪了：重试一次建解码器。
            // （描述符每十几帧就重播一次，所以晚到的内核能自愈，不用重新开始整轮传输。）
            if (decoderError) {
              var retry = root.OTP.codecs.createReceiver(frame)
              if (retry && !retry.error) {
                receiver = retry
                decoderError = ''
                stats.resets += 1
                return 'descriptor'
              }
            }
            return 'descriptor-dup'
          }
          // 新的一轮传输（或首次拿到描述符）
          var hadOne = Boolean(descriptor)
          reset()
          descriptor = frame
          receiver = root.OTP.codecs.createReceiver(frame)
          // 带 OTI 的 RaptorQ 流在缺内核时会被如实拒绝：记下来给 UI 显示，
          // 而不是让它假装在收、进度永远 0。
          decoderError = receiver && receiver.error ? String(receiver.error) : ''
          if (hadOne) stats.resets += 1
          return 'descriptor'
        }

        if (frame.type !== protocol.TYPE_DATA) return 'ignored'
        if (!receiver) return 'no-descriptor'
        if (decoderError) return 'unsupported'
        if (frame.sessionId !== descriptor.sessionId) {
          stats.stale += 1
          return 'stale'
        }
        stats.frames += 1
        if (receiver.add(frame.blockIndex, frame.esi, frame.payload)) {
          stats.accepted += 1
          return 'accepted'
        }
        stats.duplicate += 1
        return 'duplicate'
      },
      descriptor: function () {
        return descriptor
      },
      receiver: function () {
        return receiver
      },
      progress: function () {
        return receiver ? receiver.progress : 0
      },
      received: function () {
        return receiver ? receiver.received : 0
      },
      needed: function () {
        return receiver ? receiver.needed : 0
      },
      isComplete: function () {
        return Boolean(receiver && receiver.isComplete)
      },
      assemble: function () {
        if (assembled) return assembled
        if (!receiver || !receiver.isComplete) return null
        assembled = receiver.assemble()
        return assembled
      },
      /** 接收端要显示的"当前收到的是哪种模式" */
      modeName: function () {
        return descriptor ? protocol.modeName(descriptor.mode) : ''
      },
      mode: function () {
        return descriptor ? descriptor.mode : -1
      },
      /** 解码器后端：'js'（LT/顺序）| 'wasm'（RaptorQ）| 'unavailable'（缺内核，收不了） */
      decoderBackend: function () {
        if (!receiver) return ''
        return receiver.backend || 'js'
      },
      /** 非空表示这条流本端解不了，UI 必须原样显示 */
      decoderError: function () {
        return decoderError
      },
      /** 描述符是否带 12 字节 OTI（= 对端用的是 WASM RaptorQ） */
      hasOti: function () {
        return Boolean(descriptor && descriptor.extra && descriptor.extra.length === 12)
      },
      stats: function () {
        return stats
      },
      reset: reset
    }
  }

  RQ.multiscan = {
    extractRegion: extractRegion,
    scanLayout: scanLayout,
    scanRegions: scanRegions,
    createScanner: createScanner,
    createSession: createSession,
    frameKey: frameKey
  }
})(typeof self !== 'undefined' ? self : globalThis)
