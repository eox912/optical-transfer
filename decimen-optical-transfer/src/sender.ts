/**
 * sender.ts —— 全屏码窗
 *
 * 逐帧把 session.js 产出的帧编码成 QR 并贴到 canvas 上。
 *
 * 两个性能上的关键点：
 *  1. **固定 QR 版本**：所有帧（描述符/摘要/数据）都用同一个 version 渲染，像素尺寸一致，
 *     摄像头不会因为码大小跳变而反复重对焦；canvas 尺寸也只需设一次。
 *  2. **预渲染队列**：qrcode-generator 编一个 Version 27 的码要花几毫秒，
 *     直接在显示定时器里做会让帧率抖动。这里用一个后台队列提前编好几帧，
 *     显示循环只做 putImageData，实际帧率由 HUD 如实显示。
 */
import type { FrameStep, SenderHandle } from './types.ts'

/* classic script 之间共享同一个全局词法作用域（同一个 <script> 作用域链），
   所以每个模块都用 IIFE 把自己的名字关起来，只通过 globalThis.DOT 对外暴露。
   这与 shared/core/*.js 的写法一致；不这样做，两个文件里的 top-level const 会直接
   抛 'Identifier has already been declared'，插件在浏览器里会整体白屏。 */
;(function () {
  'use strict'

  const G: any = typeof globalThis !== 'undefined' ? globalThis : {}
  const DOT: any = (G.DOT = G.DOT || {})
  const D = () => DOT.dom
  const S = () => DOT.session
  const U = () => DOT.util

  function bridge(): any {
    return G.utoolsBridge || null
  }

  const QUEUE_MAX = 8
  const QUIET = 4

  let handle: SenderHandle | null = null
  let canvas: any = null
  let ctx: any = null
  let scale = 1
  let descriptorImage: any = null
  let queue: Array<{ step: FrameStep; image: any }> = []
  let displayTimer: any = null
  let statsTimer: any = null
  let running = false
  let played = 0
  let dataFrames = 0
  let controlFrames = 0
  let stalls = 0
  let startedAt = 0
  let lastKind = '—'
  let warnings: string[] = []

  function renderFrame(bytes: Uint8Array): any {
    const qr = U().core().qr
    const encoded = qr.encode(bytes, handle.ecc, handle.version)
    const image = qr.toImageData(encoded, { scale: scale, quiet: QUIET })
    return new G.ImageData(image.data, image.width, image.height)
  }

  function computeScale(moduleCount: number): number {
    const modules = moduleCount + QUIET * 2
    const side = Math.min(G.innerWidth || 1280, G.innerHeight || 800) * 0.84
    return Math.max(1, Math.floor(side / modules))
  }

  function rebuildCache(): void {
    scale = computeScale(handle.moduleCount)
    descriptorImage = renderFrame(handle.descriptorFrame)
    canvas.width = descriptorImage.width
    canvas.height = descriptorImage.height
    queue = []
  }

  /** 后台预渲染：一次最多补到 QUEUE_MAX，然后让出事件循环 */
  function pump(): void {
    if (!running) return
    try {
      while (queue.length < QUEUE_MAX) {
        const step = handle.next()
        const image = step.kind === 'descriptor' ? descriptorImage : renderFrame(step.bytes)
        if (!image) continue
        queue.push({ step: step, image: image })
      }
    } catch (err) {
      /* qrcode-generator 容量溢出抛的是字符串，不是 Error，必须 String(e) */
      fail('编码失败：' + (err && (err as any).message ? (err as any).message : String(err)))
      return
    }
    G.setTimeout(pump, 0)
  }

  function tick(): void {
    if (!running) return
    if (!queue.length) {
      stalls++
      return
    }
    const item = queue.shift() as { step: FrameStep; image: any }
    ctx.putImageData(item.image, 0, 0)
    played++
    lastKind = item.step.kind
    if (item.step.kind === 'data') dataFrames++
    else controlFrames++
  }

  function report(): void {
    if (!handle) return
    const elapsed = (U().now() - startedAt) / 1000
    const actualFps = elapsed > 0 ? played / elapsed : 0
    const hud = D().byId('hud')
    if (!hud) return
    D().clear(hud)
    hud.appendChild(D().el('h3', 'hud__title', handle.name))
    hud.appendChild(
      D().kvList([
        ['大小', U().formatBytes(handle.totalBytes)],
        ['模式', U().core().protocol.modeName(handle.mode) + (handle.loops ? '（循环）' : '（无限）')],
        ['单帧', handle.symbolSize + ' B / ' + handle.frameLength + ' B'],
        ['QR', 'V' + handle.version + ' · ' + handle.moduleCount + '²'],
        ['帧率', '目标 ' + handle.fps + ' fps · 实际 ' + actualFps.toFixed(1) + ' fps'],
        ['已播放', played + ' 帧（数据 ' + dataFrames + ' / 控制 ' + controlFrames + '）'],
        ['已用时', U().formatDuration(elapsed)],
        ['理论速率', U().formatRate(handle.estimate.usefulRate)],
        ['SHA-256', handle.digestHex ? handle.digestHex.slice(0, 16) + '…' : '未提供'],
        ['当前帧', lastKind]
      ])
    )
    if (stalls > 0) hud.appendChild(D().el('p', 'hint', '编码跟不上：已空转 ' + stalls + ' 次，实际帧率低于目标。'))
    if (warnings.length) {
      warnings.forEach((text) => hud.appendChild(D().el('p', 'hint', text)))
    }
    hud.appendChild(D().el('p', 'hint', '把接收端摄像头对准这块屏幕；按 Esc 关闭码窗。'))

    const b = bridge()
    if (b && typeof b.sendToParent === 'function') {
      b.sendToParent('otp:progress', {
        frames: played,
        fps: actualFps,
        elapsed: elapsed,
        dataFrames: dataFrames,
        controlFrames: controlFrames,
        stalls: stalls
      })
    }
  }

  function fail(message: string): void {
    running = false
    stopTimers()
    const hud = D().byId('hud')
    if (hud) {
      D().clear(hud)
      hud.appendChild(D().el('h3', 'hud__title', '发送失败'))
      hud.appendChild(D().el('p', 'hint', message))
    }
    D().toast(message, 'error')
  }

  function stopTimers(): void {
    if (displayTimer) G.clearInterval(displayTimer)
    if (statsTimer) G.clearInterval(statsTimer)
    displayTimer = null
    statsTimer = null
  }

  function close(): void {
    running = false
    stopTimers()
    const b = bridge()
    if (b && typeof b.close === 'function') b.close()
    else G.close()
  }

  function start(payload: any): void {
    const b = bridge()
    if (!b) {
      fail('不在 uTools 环境里：没有 utoolsBridge')
      return
    }
    let file: any
    try {
      file = b.readFile(payload.filePath)
    } catch (err) {
      fail('读取文件失败：' + (err && (err as any).message ? (err as any).message : String(err)))
      return
    }

    warnings = []
    if (file.bytes.length !== payload.totalBytes) {
      warnings.push(
        '警告：文件大小已变化（面板记录 ' + payload.totalBytes + ' B，实际 ' + file.bytes.length + ' B）'
      )
    }

    try {
      handle = S().createSenderHandle({
        bytes: file.bytes,
        name: payload.name || file.name,
        mode: payload.mode,
        symbolSize: payload.symbolSize,
        fps: payload.fps,
        ecc: payload.ecc,
        repeatDescriptor: payload.repeatDescriptor,
        sessionId: payload.sessionId,
        digestHex: payload.digestHex
      })
    } catch (err) {
      fail('建立发送会话失败：' + (err && (err as any).message ? (err as any).message : String(err)))
      return
    }

    if (payload.sessionId != null && handle.sessionId !== payload.sessionId) {
      warnings.push('警告：重算出的会话 ID 与面板不一致，接收端可能对不上。')
    }
    if (payload.version != null && handle.version !== payload.version) {
      warnings.push('警告：重算出的 QR 版本与面板不一致（' + handle.version + ' vs ' + payload.version + '）。')
    }
    if (handle.modeNote) warnings.push(handle.modeNote)

    canvas = D().byId('qr')
    ctx = canvas.getContext('2d', { alpha: false })
    startedAt = U().now()
    played = 0
    dataFrames = 0
    controlFrames = 0
    stalls = 0
    running = true
    rebuildCache()
    report()
    pump()
    displayTimer = G.setInterval(tick, Math.max(1, Math.round(1000 / handle.fps)))
    statsTimer = G.setInterval(report, 500)
  }

  function boot(): void {
    const b = bridge()
    const closeButton = D().byId('close')
    if (closeButton) D().on(closeButton, 'click', close)
    D().on(G.document, 'keydown', (event: any) => {
      if (event && event.key === 'Escape') close()
    })
    D().on(G, 'resize', () => {
      if (running && handle) {
        rebuildCache()
        D().toast('窗口尺寸变化，已按新尺寸重绘二维码')
      }
    })
    D().on(G, 'beforeunload', () => {
      running = false
      stopTimers()
    })

    const last = b && typeof b.getStartPayload === 'function' ? b.getStartPayload() : null
    if (last) {
      start(last)
    } else if (b && typeof b.onStart === 'function') {
      b.onStart((payload: any) => start(payload))
    } else {
      fail('没有收到发送参数（otp:start）')
    }
  }

  boot()
  DOT.senderBooted = true
})()
