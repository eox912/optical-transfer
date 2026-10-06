/**
 * receiver.ts —— 摄像头接收窗
 *
 * 链路：getUserMedia → video → 离屏 canvas 缩放 → OTP.scan.decodeFrameFromImage
 *       → 描述符帧建会话 → 数据帧喂给 stream.js（LT 逐块落盘 / 顺序分片缓冲）
 *       → 收齐后流式算 SHA-256 → 校验通过才用原名弹出保存对话框
 *
 * 降级：摄像头不可用（无权限/被占用/无设备）时，改用 utools.screenCapture 框选截图
 *       或导入图片文件识别。
 */
import type { StreamReceiver, Sink } from './types.ts'

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

  function core(): any {
    return U().core()
  }
  function bridge(): any {
    return G.utoolsBridge || null
  }

  const MAX_SCAN_WIDTH = 1080
  const SCAN_INTERVAL_MS = 42
  const RATE_WINDOW_MS = 3000
  const REPORT_INTERVAL_MS = 400

  const state = {
    receiver: null as StreamReceiver | null,
    sessionId: -1,
    name: '',
    totalBytes: 0,
    status: 'idle',
    tempPath: '',
    savedPath: '',
    verifyLabel: '等待校验',
    verifyKind: 'idle',
    modeName: '',
    streaming: false,
    note: '把发送端屏幕上的二维码框进画面即可开始接收。',
    usingCamera: false,
    cameraError: '',
    wasm: '正在加载 vendor/raptorq.core.wasm…'
  }

  const stats = {
    scans: 0,
    hits: 0,
    accepted: 0,
    rankBytes: 0,
    samples: [] as Array<{ t: number; bytes: number }>,
    startedAt: 0,
    lastHitAt: 0,
    duplicate: 0
  }

  let scanTimer: any = null
  let reportTimer: any = null
  let loopRunning = false
  const buttons: any = {}

  /* ------------------------------------------------------------------ */
  /*                              落盘管道                                */
  /* ------------------------------------------------------------------ */

  function makeSink(): Sink {
    const b = bridge()
    return {
      writeAt(offset: number, bytes: Uint8Array): number {
        return b.writeAt(offset, bytes)
      },
      writeAll(bytes: Uint8Array): number {
        return b.writeAll(bytes)
      },
      finish(): any {
        return b.closeSink()
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*                              会话管理                                */
  /* ------------------------------------------------------------------ */

  function startSession(descriptor: any): void {
    const b = bridge()
    closeSinkQuietly()
    if (state.tempPath) b.deleteFile(state.tempPath)

    state.sessionId = descriptor.sessionId
    state.name = descriptor.name || 'receive.bin'
    state.totalBytes = descriptor.totalBytes
    state.savedPath = ''
    state.status = 'receiving'
    state.verifyLabel = '等待校验'
    state.verifyKind = 'idle'
    state.tempPath = b.tempPathFor(state.name, descriptor.sessionId)
    b.openSink(state.tempPath, descriptor.totalBytes)
    state.receiver = DOT.stream.createStreamReceiver(descriptor, makeSink())
    state.streaming = state.receiver.streaming
    state.modeName = core().protocol.modeName(descriptor.mode)

    if (state.receiver.unsupported) {
      state.status = 'unsupported'
      state.note =
        '这条流解不了：' +
        (state.receiver.error || '未知原因') +
        '\n发送端用的是真 RaptorQ（描述符 extra 里带 12 字节 OTI），而本端 WASM 内核不可用。' +
        '共享核心明确要求此时如实报错，不能用 LT 去解（编码方式不同，只会得到垃圾）。'
      D().toast('无法解码这条 RaptorQ 流', 'error')
      renderStats()
      return
    }

    stats.rankBytes = 0
    stats.samples = []
    stats.accepted = 0
    stats.startedAt = U().now()
    stats.lastHitAt = U().now()

    const notes: string[] = []
    notes.push(
      state.streaming
        ? 'LT 流式落盘：每解出一块立刻写到目标文件的对应偏移，内存里只留未解完的块'
        : '缓冲模式（顺序分片 / 真 RaptorQ）：收齐后一次性落盘'
    )
    if (descriptor.mode === core().protocol.MODE_RAPTORQ && !core().codecs.raptorqAvailable()) {
      notes.push('这是 RaptorQ 描述符，但本插件没有 WASM 内核，只能按 LT 解；若发送端是真 RaptorQ，进度会一直不动')
    }
    if (!(descriptor.flags & core().protocol.FLAG_SHA256)) {
      notes.push('发送端没有声明 FLAG_SHA256，收完只能报"未提供摘要"')
    }
    state.note = notes.join('；')

    D().toast(
      '识别到会话：' + state.name + '（' + U().formatBytes(state.totalBytes) + ' · ' + state.modeName + '）',
      'success'
    )
    renderStats()
  }

  function closeSinkQuietly(): void {
    const b = bridge()
    if (!b || typeof b.closeSink !== 'function') return
    try {
      b.closeSink()
    } catch (err) {
      /* fd 可能已经关了 */
    }
  }

  function resetSession(): void {
    const b = bridge()
    closeSinkQuietly()
    if (state.tempPath) b.deleteFile(state.tempPath)
    state.receiver = null
    state.sessionId = -1
    state.tempPath = ''
    state.savedPath = ''
    state.name = ''
    state.totalBytes = 0
    state.status = 'idle'
    state.modeName = ''
    state.streaming = false
    state.verifyLabel = '等待校验'
    state.verifyKind = 'idle'
    state.note = '已重置，等待新的描述符帧。'
    stats.rankBytes = 0
    stats.samples = []
    stats.accepted = 0
    stats.hits = 0
    stats.scans = 0
    stats.duplicate = 0
    startLoop()
    renderStats()
  }

  /* ------------------------------------------------------------------ */
  /*                              收完校验                                */
  /* ------------------------------------------------------------------ */

  function complete(): Promise<void> {
    const b = bridge()
    state.status = 'verifying'
    renderStats()
    stopLoop()

    const receiver = state.receiver
    const leftover = receiver ? receiver.assemble() : null
    if (leftover) b.writeAll(leftover) /* 缓冲路径的字节 */
    closeSinkQuietly()

    return Promise.resolve()
      .then(() => b.sha256File(state.tempPath))
      .then((actual: string) => {
        const expected = receiver ? receiver.digestHex : null
        if (!expected) {
          state.verifyLabel = '发送端未提供摘要'
          state.verifyKind = 'warn'
          state.status = 'done'
          state.note = '内容已收齐，但发送端没有提供 SHA-256 摘要，无法校验完整性。'
        } else {
          try {
            S().assertDigest(actual, expected) /* 不一致会抛错 */
            state.verifyLabel = '校验通过'
            state.verifyKind = 'ok'
            state.status = 'done'
            state.note = 'SHA-256 与发送端摘要一致。'
          } catch (err) {
            const text = err && (err as any).message ? (err as any).message : String(err)
            state.verifyLabel = '校验失败'
            state.verifyKind = 'bad'
            state.status = 'mismatch'
            state.note = text + '\n文件留在临时目录，未保存。'
            b.showNotification('DOT：SHA-256 校验失败，文件未保存')
            D().toast('SHA-256 校验失败，文件未保存', 'error')
          }
        }
        renderStats()
        if (state.status === 'done') saveNow()
      })
      .catch((err: any) => {
        state.status = 'failed'
        state.verifyKind = 'bad'
        state.verifyLabel = '校验出错'
        state.note = '校验过程出错：' + (err && err.message ? err.message : String(err))
        renderStats()
        D().toast(state.note, 'error')
      })
  }

  function saveNow(): void {
    const b = bridge()
    if (!state.tempPath) return
    const target = b.showSaveDialog({
      title: '保存接收到的文件',
      defaultPath: b.getPath('downloads') + '/' + state.name,
      buttonLabel: '保存'
    })
    if (!target) {
      state.note = '已取消保存。文件仍在校验过的临时目录：' + state.tempPath
      renderStats()
      return
    }
    try {
      b.moveFile(state.tempPath, target)
      state.tempPath = ''
      state.savedPath = target
      state.status = 'saved'
      state.note = '已保存：' + target
      b.showNotification('DOT：已保存到 ' + target)
      D().toast('已保存：' + target, 'success')
    } catch (err) {
      state.note = '保存失败：' + (err && (err as any).message ? (err as any).message : String(err))
      D().toast(state.note, 'error')
    }
    renderStats()
  }

  /* ------------------------------------------------------------------ */
  /*                              帧处理循环                              */
  /* ------------------------------------------------------------------ */

  function handleFrame(frame: any): void {
    const P = core().protocol
    stats.hits++
    stats.lastHitAt = U().now()

    if (frame.type === P.TYPE_DESCRIPTOR) {
      if (!state.receiver || frame.sessionId !== state.sessionId) startSession(frame)
      return
    }
    if (!state.receiver || state.status !== 'receiving') return

    const kind = state.receiver.feed(frame)
    if (kind === 'data') {
      stats.accepted++
      stats.rankBytes = state.receiver.rankBytes
      stats.samples.push({ t: U().now(), bytes: stats.rankBytes })
    } else if (kind === 'ignored') {
      stats.duplicate++
    }

    if (state.receiver.isComplete && state.status === 'receiving') {
      complete().catch((err) => console.error('[receiver] complete', err))
    }
  }

  function tick(): void {
    const video = D().byId('video')
    if (!video || !video.videoWidth) return
    const probe = D().byId('probe')
    if (!probe) return
    try {
      const image = core().scan.drawScaled(
        probe,
        video,
        video.videoWidth,
        video.videoHeight,
        MAX_SCAN_WIDTH
      )
      stats.scans++
      const frame = core().scan.decodeFrameFromImage(
        core().protocol,
        image.data,
        image.width,
        image.height
      )
      if (frame) handleFrame(frame)
    } catch (err) {
      console.error('[receiver] 扫描出错：', err)
    }
  }

  function loop(): void {
    if (!loopRunning) return
    if (
      state.status === 'receiving' ||
      state.status === 'idle' ||
      state.status === 'failed' ||
      state.status === 'unsupported'
    ) {
      tick()
    }
    scanTimer = G.setTimeout(loop, SCAN_INTERVAL_MS)
  }

  function startLoop(): void {
    if (loopRunning) return
    loopRunning = true
    loop()
  }

  function stopLoop(): void {
    loopRunning = false
    if (scanTimer) G.clearTimeout(scanTimer)
    scanTimer = null
  }

  /* ------------------------------------------------------------------ */
  /*                              降级通道                                */
  /* ------------------------------------------------------------------ */

  function cameraFailed(message: string): void {
    state.usingCamera = false
    state.cameraError = message
    const empty = D().byId('cam-empty')
    if (empty) {
      empty.hidden = false
      empty.textContent =
        '摄像头不可用：' + message + '\n可用下方「框选截图识别」或「导入图片…」降级接收。'
    }
    D().toast('摄像头不可用：' + message + '（已提供截图/图片降级通道）', 'error')
    startLoop()
    renderStats()
  }

  function decodeStill(dataUrl: string): Promise<void> {
    return new Promise((resolve) => {
      const image = new G.Image()
      image.onload = () => {
        try {
          const probe = D().byId('probe')
          const scaled = core().scan.drawScaled(probe, image, image.width, image.height, MAX_SCAN_WIDTH)
          stats.scans++
          const frame = core().scan.decodeFrameFromImage(
            core().protocol,
            scaled.data,
            scaled.width,
            scaled.height,
            { inversionAttempts: 'attemptBoth' }
          )
          if (frame) handleFrame(frame)
          else D().toast('这张图里没有识别到本协议的二维码帧', 'error')
        } catch (err) {
          console.error('[receiver] 图片识别出错：', err)
          D().toast('图片识别出错：' + String(err), 'error')
        }
        renderStats()
        resolve()
      }
      image.onerror = () => {
        D().toast('图片解码失败', 'error')
        resolve()
      }
      image.src = dataUrl
    })
  }

  function captureStill(): void {
    const b = bridge()
    Promise.resolve()
      .then(() => b.screenCapture())
      .then((dataUrl: string) => decodeStill(dataUrl))
      .catch((err: any) => {
        D().toast('截图识别失败：' + (err && err.message ? err.message : String(err)), 'error')
      })
  }

  function importImage(): void {
    const b = bridge()
    const picked = b.showOpenDialog({
      properties: ['openFile'],
      title: '选择包含光码的图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]
    })
    if (!picked || !picked.length) return
    decodeStill(b.readFileAsDataUrl(picked[0]))
  }

  /* ------------------------------------------------------------------ */
  /*                                渲染                                 */
  /* ------------------------------------------------------------------ */

  function setBadge(node: any, label: string, kind?: string): void {
    if (!node) return
    node.textContent = label
    node.className = 'badge' + (kind ? ' badge--' + kind : '')
  }

  function rate(): number {
    const now = U().now()
    while (stats.samples.length && now - stats.samples[0].t > RATE_WINDOW_MS) stats.samples.shift()
    if (!stats.samples.length) return 0
    const oldest = stats.samples[0]
    const span = (now - oldest.t) / 1000
    if (span <= 0.2) return 0
    return (stats.rankBytes - oldest.bytes) / span
  }

  function renderStats(): void {
    const receiver = state.receiver
    const progress = receiver ? receiver.progress : 0
    const bytesPerSec = rate()
    const now = U().now()

    setBadge(D().byId('mode-badge'), state.modeName || '等待描述符帧')
    setBadge(D().byId('hash-badge'), state.verifyLabel, state.verifyKind)
    const wasmReady = core().codecs.raptorqAvailable()
    setBadge(
      D().byId('engine-badge'),
      wasmReady ? '接收端 WASM 可用' : '接收端无 WASM（RaptorQ 解不了）',
      wasmReady ? 'ok' : 'warn'
    )
    /* 规范第 7.3 节：后端能力必须如实展示，不许假装 */
    state.wasm = wasmStatusText()

    const bar = D().byId('bar')
    if (bar) {
      bar.style.width = (Math.max(0, Math.min(1, progress)) * 100).toFixed(1) + '%'
      bar.className =
        'bar__fill' +
        (state.verifyKind === 'ok' ? ' bar__fill--ok' : state.verifyKind === 'bad' ? ' bar__fill--bad' : '')
    }

    const elapsed = stats.startedAt ? (now - stats.startedAt) / 1000 : 0
    const remaining = receiver ? Math.max(0, state.totalBytes - stats.rankBytes) : 0
    const eta = bytesPerSec > 0 ? remaining / bytesPerSec : Infinity
    const silent = stats.lastHitAt ? (now - stats.lastHitAt) / 1000 : 0

    const statsBox = D().byId('stats')
    if (statsBox) {
      D().clear(statsBox)
      const rows: Array<[string, string]> = [
        ['文件', state.name || '—'],
        ['大小', state.totalBytes ? U().formatBytes(state.totalBytes) : '—'],
        ['模式', state.modeName || '—'],
        ['已收/需要', receiver ? receiver.received + ' / ' + receiver.needed + ' 符号' : '—'],
        ['分块完成', receiver ? receiver.blocksDone + ' / ' + receiver.blockCount : '—'],
        ['已解出字节', receiver ? U().formatBytes(stats.rankBytes) : '—'],
        ['实际吞吐', U().formatRate(bytesPerSec) + (bytesPerSec > 0 ? '（3 秒窗口）' : '')],
        ['剩余估算', bytesPerSec > 0 ? U().formatDuration(eta) : '—'],
        ['识别/命中', stats.scans + ' / ' + stats.hits + ' 次，丢弃重复 ' + stats.duplicate],
        ['已用时', U().formatDuration(elapsed)],
        ['落盘方式', receiver ? (state.streaming ? '逐块随机写（边收边落盘）' : '收齐一次性写') : '—'],
        ['解码后端', receiver && receiver.unsupported ? '不可用' : state.streaming ? 'JS（LT BlockDecoder）' : 'OTP.codecs'],
        ['RaptorQ 内核', state.wasm]
      ]
      statsBox.appendChild(D().kvList(rows))
    }

    const fpsNode = D().byId('cam-fps')
    if (fpsNode) {
      fpsNode.textContent = state.usingCamera
        ? stats.scans + ' 次识别 · 命中 ' + stats.hits
        : state.cameraError
          ? '摄像头不可用 · 降级模式'
          : ''
    }

    if (buttons.reset) buttons.reset.disabled = false
    if (buttons.save) buttons.save.disabled = state.status !== 'done'
    if (buttons.discard) buttons.discard.disabled = !state.tempPath && state.status !== 'mismatch'

    const noteNode = D().byId('note')
    if (noteNode) {
      const extra =
        state.status === 'receiving' && silent > 3 && stats.lastHitAt
          ? '\n已经 ' + silent.toFixed(1) + ' 秒没有识别到新帧了，检查一下摄像头对焦或码窗是否被遮挡。'
          : ''
      noteNode.textContent = state.note + extra
    }
  }

  /* ------------------------------------------------------------------ */
  /*                                启动                                 */
  /* ------------------------------------------------------------------ */

  function buildActions(): void {
    const box = D().byId('actions')
    if (!box) return
    buttons.reset = D().button('丢弃并重新开始', () => resetSession(), 'ghost')
    buttons.still = D().button('框选截图识别', () => captureStill(), 'ghost')
    buttons.import = D().button('导入图片…', () => importImage(), 'ghost')
    buttons.save = D().button('保存到…', () => saveNow(), 'primary')
    buttons.close = D().button(
      '关闭窗口',
      () => {
        const b = bridge()
        closeSinkQuietly()
        if (b && typeof b.close === 'function') b.close()
      },
      'ghost'
    )
    ;[buttons.reset, buttons.still, buttons.import, buttons.save, buttons.close].forEach((node) => {
      box.appendChild(node)
    })
  }

  function startCamera(): void {
    const video = D().byId('video')
    const empty = D().byId('cam-empty')
    if (!G.navigator || !G.navigator.mediaDevices || !G.navigator.mediaDevices.getUserMedia) {
      cameraFailed('当前环境没有 navigator.mediaDevices.getUserMedia')
      return
    }
    Promise.resolve(
      G.navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      })
    )
      .then((stream: any) => {
        if (video) video.srcObject = stream
        const playing = video && typeof video.play === 'function' ? video.play() : null
        return playing && typeof playing.then === 'function' ? playing : null
      })
      .then(() => {
        state.usingCamera = true
        state.cameraError = ''
        if (empty) empty.hidden = true
        startLoop()
        renderStats()
      })
      .catch((err: any) => {
        cameraFailed(err && err.message ? err.message : String(err))
      })
  }

  /**
   * 加载 RaptorQ WASM 内核（只影响"接收端能不能解真 RaptorQ"）。
   * 规范第 3 节坑 4：不能 instantiateStreaming、不能走 CDN；
   * 这里把 fs 读取交给 preload（readBytes），wasm 随插件打包。
   * load() 永不 reject：失败时 isAvailable() 返回 false，前两种模式照常工作。
   */
  /** 规范第 7.3 节：用 OTP.codecs.raptorqStatus() 拿 available / wasmBytes / error */
  function wasmStatusText(): string {
    const c = core().codecs
    const st =
      typeof c.raptorqStatus === 'function'
        ? c.raptorqStatus()
        : { available: c.raptorqAvailable(), wasmBytes: 0, error: '' }
    if (st.available) {
      return (
        'WASM 可用' +
        (st.wasmBytes ? '（' + U().formatBytes(st.wasmBytes) + '）' : '') +
        ' → 能解真 RaptorQ'
      )
    }
    return 'WASM 不可用（' + (st.error || '未加载') + '）→ 带 OTI 的 RaptorQ 流解不了'
  }

  function loadWasmCore(): Promise<void> {
    const rc = G.OTP && G.OTP.raptorqCore
    if (!rc || typeof rc.load !== 'function') {
      state.wasm = '未引入 vendor/raptorq.core.js'
      return Promise.resolve()
    }
    const b = bridge()
    const options: any = {}
    if (b && typeof b.readVendorBytes === 'function') {
      options.readBytes = (url: string) => b.readVendorBytes(url)
    }
    return Promise.resolve(rc.load(options)).then(() => {
      /* load() 永不 reject：失败也是静默降级，这里只负责如实汇报 */
      state.wasm = wasmStatusText()
      renderStats()
    })
  }

  function boot(): void {
    buildActions()
    renderStats()
    startLoop()
    if (typeof G.setInterval === 'function') reportTimer = G.setInterval(renderStats, REPORT_INTERVAL_MS)

    const b = bridge()
    if (b && typeof b.onStart === 'function') b.onStart(() => {})
    loadWasmCore().catch((err) => {
      state.wasm = '加载异常：' + (err && err.message ? err.message : String(err))
    })
    startCamera()
  }

  boot()
  DOT.receiverBooted = true
})()
