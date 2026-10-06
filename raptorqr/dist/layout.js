/**
 * layout.ts —— 多码并行布局（raptorqr 的招牌：1 / 2 / 4 码同屏）
 *
 * 这是纯几何计算，不碰 DOM、不碰 QR 库，所以能被测试直接断言：
 *  - 2 码横排、4 码田字格，每个码位是一个互不重叠的正方形区域；
 *  - 顶部留出 HUD 带（只占一条，不压在任何码上）；
 *  - 收端按同一套几何把画面切成 N 个区域分别识别（见 receiver.ts）。
 *
 * 关键约定：HUD 高度用**比例**（HUD_RATIO）而不是固定像素。
 * 发送端窗口和接收端摄像头画面的分辨率通常不同，只有比例一致时，
 * 接收端用同一比例算出来的分区才能正好套住发送端画出来的码。
 */
;(function (root) {
  'use strict'
  var RQ = (root.RQ = root.RQ || {})

  /** 顶部 HUD 占窗口高度的比例。收发两端共用，保证分区可对齐 */
  var HUD_RATIO = 0.065
  /** 每个单元格四周留白的比例（码位不会顶到单元格边缘） */
  var PADDING_RATIO = 0.06
  /** 收端扩展分区的默认比例，用来吃掉两端分辨率的细微不一致 */
  var DEFAULT_EXPAND = 0.08

  /** 把任意输入规范成 1 / 2 / 4 */
  function normalizeMultiQr(value) {
    var v = Number(value)
    return v === 2 || v === 4 ? v : 1
  }

  /** 给定画面高度，算出 HUD 带的像素高度 */
  function hudFor(height) {
    return Math.round(Math.max(1, height) * HUD_RATIO)
  }

  /**
   * 算出 N 个码位的区域
   * @param {number} multiQr 1 / 2 / 4
   * @param {number} width 画布宽（设备像素）
   * @param {number} height 画布高（设备像素）
   * @param {{hudHeight?:number, padding?:number}} [options]
   * @returns {RQLayout}
   */
  function compute(multiQr, width, height, options) {
    var opts = options || {}
    var mq = normalizeMultiQr(multiQr)
    var w = Math.max(1, Math.round(width))
    var h = Math.max(1, Math.round(height))

    var hud = opts.hudHeight == null ? hudFor(h) : Math.max(0, Math.round(opts.hudHeight))
    // HUD 不能把可用高度吃光，至少给码留 8px
    hud = Math.min(hud, Math.max(0, h - 8))

    // 2 码横排（2 列 1 行）、4 码田字格（2 列 2 行）、1 码整幅
    var cols = mq === 1 ? 1 : 2
    var rows = mq <= 2 ? 1 : 2

    var availH = Math.max(1, h - hud)
    var cellW = w / cols
    var cellH = availH / rows
    var pad = opts.padding == null ? PADDING_RATIO : opts.padding
    var boxSize = Math.max(8, Math.floor(Math.min(cellW, cellH) * (1 - pad)))

    var boxes = []
    for (var i = 0; i < mq; i++) {
      var col = i % cols
      var row = Math.floor(i / cols)
      boxes.push({
        index: i,
        col: col,
        row: row,
        x: Math.floor(col * cellW + (cellW - boxSize) / 2),
        y: Math.floor(hud + row * cellH + (cellH - boxSize) / 2),
        size: boxSize
      })
    }

    return {
      multiQr: mq,
      width: w,
      height: h,
      hudHeight: hud,
      cols: cols,
      rows: rows,
      boxSize: boxSize,
      boxes: boxes
    }
  }

  /** 两个码位是否重叠（严格相交；只擦边不算） */
  function overlaps(a, b) {
    return a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size
  }

  /** 布局里是否有任意两个码位重叠 */
  function hasOverlap(layout) {
    var boxes = layout.boxes
    for (var i = 0; i < boxes.length; i++) {
      for (var j = i + 1; j < boxes.length; j++) {
        if (overlaps(boxes[i], boxes[j])) return true
      }
    }
    return false
  }

  /**
   * 由码位区域算出实际绘制出来的正方形（drawInto 会在 box 里居中）
   * @param {RQCodeBox} box
   * @param {number} drawnSize drawInto 返回的实际边长
   */
  function drawnRect(box, drawnSize) {
    var offset = Math.floor((box.size - drawnSize) / 2)
    return { x: box.x + offset, y: box.y + offset, size: drawnSize }
  }

  /**
   * 把码位区域转成"识别分区"（可外扩），收端按这些矩形分别喂给 jsQR
   * @param {RQLayout} layout
   * @param {number} [expand] 外扩比例，默认 0.08
   */
  function regionRects(layout, expand) {
    var e = expand == null ? DEFAULT_EXPAND : expand
    var out = []
    for (var i = 0; i < layout.boxes.length; i++) {
      var box = layout.boxes[i]
      var grow = Math.round(box.size * e)
      var x = Math.max(0, box.x - grow)
      var y = Math.max(0, box.y - grow)
      var right = Math.min(layout.width, box.x + box.size + grow)
      var bottom = Math.min(layout.height, box.y + box.size + grow)
      out.push({
        index: box.index,
        x: x,
        y: y,
        width: Math.max(1, right - x),
        height: Math.max(1, bottom - y)
      })
    }
    return out
  }

  /**
   * 收端的候选分区方案，按"最可能命中"排序：
   *  - 指定码数时：先试与发送端完全同几何的那一套（HUD_RATIO），再试无 HUD、大 HUD 的变体；
   *  - 自动模式（multiQr 传 0）：先按 4 码找，再按 2 码找；
   *  - 最后永远加一套"整幅当单码"兜底。
   */
  function candidateLayouts(width, height, multiQr) {
    var h = Math.max(1, Math.round(height))
    var list = []
    var mq = Number(multiQr)
    if (mq === 1 || mq === 2 || mq === 4) {
      list.push(compute(mq, width, h, { hudHeight: hudFor(h) }))
      list.push(compute(mq, width, h, { hudHeight: 0 }))
      list.push(compute(mq, width, h, { hudHeight: Math.round(h * 0.12) }))
    } else {
      list.push(compute(4, width, h, { hudHeight: hudFor(h) }))
      list.push(compute(4, width, h, { hudHeight: 0 }))
      list.push(compute(2, width, h, { hudHeight: hudFor(h) }))
      list.push(compute(2, width, h, { hudHeight: 0 }))
    }
    list.push(compute(1, width, h, { hudHeight: 0 }))
    return list
  }

  RQ.layout = {
    HUD_RATIO: HUD_RATIO,
    PADDING_RATIO: PADDING_RATIO,
    DEFAULT_EXPAND: DEFAULT_EXPAND,
    normalizeMultiQr: normalizeMultiQr,
    hudFor: hudFor,
    compute: compute,
    overlaps: overlaps,
    hasOverlap: hasOverlap,
    drawnRect: drawnRect,
    regionRects: regionRects,
    candidateLayouts: candidateLayouts
  }
})(typeof self !== 'undefined' ? self : globalThis)
