/**
 * index.ts —— 主控制面板
 *
 * 职责：选文件 → 算描述符/摘要（招牌特性：SHA-256 完整性校验、保留文件名）
 *      → 参数与模式切换 → 开全屏码窗；以及打开接收窗口。
 *
 * 这里**不**保留编码器：buildPlan() 只算出描述符与统计量，
 * 真正逐帧编码发生在码窗（sender.js）里，避免 64MB 文件被复制成两份常驻。
 */
import type { SendPlan, DotState } from './types.ts'

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

  function protocol(): any {
    return U().core().protocol
  }
  function codecs(): any {
    return U().core().codecs
  }
  function bridge(): any {
    return G.utoolsBridge || null
  }

  /* ------------------------------------------------------------------ */
  /*                                 状态                                */
  /* ------------------------------------------------------------------ */

  const state: DotState = {
    plan: null,
    pending: null,
    mode: 1 /* protocol.MODE_FOUNTAIN */,
    symbolSize: 1400,
    fps: 30,
    ecc: 'L',
    repeatDescriptor: 17,
    filePath: '',
    fileInfo: null,
    digestHex: '',
    lastAction: null,
    senderOpen: false,
    progress: null,
    errors: []
  }

  DOT.state = state

  function modeInfo(): any {
    return codecs().infoFor(state.mode)
  }

  /* ------------------------------------------------------------------ */
  /*                                渲染                                 */
  /* ------------------------------------------------------------------ */

  function card(title: string): any {
    const root = D().el('section', 'card')
    const head = D().el('header', 'card__head')
    head.appendChild(D().el('h2', 'card__title', title))
    const body = D().el('div', 'card__body')
    root.appendChild(head)
    root.appendChild(body)
    return { root: root, body: body }
  }

  function modeSelector(): any {
    const row = D().el('div', 'modes')
    const P = protocol()
    const options = [
      { mode: P.MODE_SEQUENTIAL, key: 'sequential', hint: '400B / 10fps' },
      { mode: P.MODE_FOUNTAIN, key: 'fountain', hint: '1400B / 30fps' },
      { mode: P.MODE_RAPTORQ, key: 'raptorq', hint: '需要 WASM，本插件未内置' }
    ]
    options.forEach((option) => {
      const info = codecs().infoFor(option.mode)
      const usable = option.mode !== P.MODE_RAPTORQ || codecs().raptorqAvailable()
      const node = D().el(
        'button',
        'mode' + (state.mode === option.mode ? ' mode--on' : '') + (usable ? '' : ' mode--off'),
        info.label
      )
      node.type = 'button'
      node.disabled = !usable
      node.title = usable ? info.blurb : option.hint
      D().on(node, 'click', () => {
        if (!usable) {
          D().toast('RaptorQ 需要 WASM 内核，本插件没有内置，发送端已禁用', 'error')
          return
        }
        applyMode(option.mode)
      })
      const wrap = D().el('div', 'mode-wrap')
      wrap.appendChild(node)
      wrap.appendChild(D().el('span', 'mode__hint', option.hint))
      row.appendChild(wrap)
    })
    return row
  }

  function applyMode(mode: number): void {
    state.mode = mode
    const defaults = codecs().defaultOptions(mode)
    state.symbolSize = defaults.symbolSize
    state.fps = defaults.fps
    state.ecc = defaults.ecc
    state.repeatDescriptor = defaults.repeatDescriptor
    DOT.state = state
    if (state.filePath) {
      state.pending = prepareSend(state.filePath)
    } else {
      render()
    }
  }

  function paramRow(): any {
    const info = modeInfo()
    const row = D().el('div', 'params')

    const sizeSelect = D().el('select', 'select')
    info.presets.symbolSize.forEach((size: number) => {
      const option = D().el('option', null, size + ' B')
      option.value = String(size)
      if (size === state.symbolSize) option.selected = true
      sizeSelect.appendChild(option)
    })
    D().on(sizeSelect, 'change', () => {
      state.symbolSize = Number(sizeSelect.value)
      if (state.filePath) state.pending = prepareSend(state.filePath)
      else render()
    })

    const fpsSelect = D().el('select', 'select')
    info.presets.fps.forEach((fps: number) => {
      const option = D().el('option', null, fps + ' fps')
      option.value = String(fps)
      if (fps === state.fps) option.selected = true
      fpsSelect.appendChild(option)
    })
    D().on(fpsSelect, 'change', () => {
      state.fps = Number(fpsSelect.value)
      if (state.filePath) state.pending = prepareSend(state.filePath)
      else render()
    })

    ;[
      ['切片大小', sizeSelect],
      ['帧率', fpsSelect]
    ].forEach((item) => {
      const field = D().el('label', 'field')
      field.appendChild(D().el('span', 'field__label', item[0] as string))
      field.appendChild(item[1] as any)
      row.appendChild(field)
    })
    return row
  }

  function sendCard(): any {
    const view = card('发送')
    const info = state.fileInfo

    if (!info) {
      view.body.appendChild(
        D().el(
          'p',
          'hint',
          '选择一个文件（或在文件管理器里选中文件后唤出超级面板 →「隔空发送（DOT）」），屏幕会开始播放动态二维码。'
        )
      )
      const row = D().actions()
      row.appendChild(
        D().button('选择文件…', () => {
          const picked = bridge() && bridge().showOpenDialog
            ? bridge().showOpenDialog({ properties: ['openFile'], title: '选择要隔空发送的文件' })
            : null
          if (picked && picked.length) state.pending = prepareSend(picked[0])
        }, 'primary')
      )
      view.body.appendChild(row)
    } else {
      view.body.appendChild(
        D().kvList([
          ['文件', info.name],
          ['大小', U().formatBytes(info.bytes)],
          ['路径', info.path]
        ])
      )
    }

    view.body.appendChild(modeSelector())
    view.body.appendChild(paramRow())

    if (state.plan) {
      const plan = state.plan
      view.body.appendChild(
        D().kvList([
          ['模式', plan.modeLabel + '（' + plan.modeKey + '）'],
          ['编码内核', plan.backend === 'wasm' ? 'WASM' : 'JS（本插件不含 WASM）'],
          ['单帧', plan.symbolSize + ' B 载荷 / ' + plan.frameLength + ' B 帧'],
          ['QR', 'Version ' + plan.version + '（' + plan.moduleCount + '×' + plan.moduleCount + ' 模块，ECC ' + plan.ecc + '）'],
          ['符号数', String(plan.totalSymbols) + ' 个源符号，' + plan.blockCount + ' 块 × ' + plan.symbolsPerBlock],
          ['会话 ID', '0x' + plan.sessionId.toString(16).padStart(4, '0')],
          ['SHA-256', plan.digestHex],
          ['摘要算法', plan.digestBackend],
          ['理论速率', U().formatRate(plan.estimate.usefulRate) + '（含每 ' + plan.repeatDescriptor + ' 帧插描述符+摘要的开销）'],
          ['预计时长', plan.loops ? '一轮 ' + U().formatDuration(plan.estimate.seconds) + '，循环播放' : U().formatDuration(plan.estimate.seconds) + '（LT 的 ε 按 15% 估）']
        ])
      )
      const row = D().actions()
      row.appendChild(D().button('开始隔空发送', () => startSend(), 'primary'))
      row.appendChild(
        D().button('重新选择文件', () => {
          state.plan = null
          state.fileInfo = null
          state.filePath = ''
          render()
        }, 'ghost')
      )
      view.body.appendChild(row)
    } else if (info) {
      view.body.appendChild(D().el('p', 'hint', '正在计算描述符与 SHA-256…'))
    }

    if (!codecs().raptorqAvailable()) {
      view.body.appendChild(
        D().el('p', 'hint', '如实说明：本插件的**发送端**不加载 WASM 内核，编码内核是纯 JS 的 LT 喷泉码，所以 RaptorQ 发送已禁用，不假装可用。（接收端会加载 vendor/raptorq.core.wasm，因此仍能解别人发来的真 RaptorQ 流。）')
      )
    }
    return view
  }

  function receiveCard(): any {
    const view = card('接收')
    view.body.appendChild(
      D().el('p', 'hint', '打开接收窗口后用摄像头对着发送端屏幕即可。接收端支持全部三种模式（顺序分片 / LT 喷泉码 / RaptorQ），并会显示当前收到的是哪种。')
    )
    const row = D().actions()
    row.appendChild(D().button('打开摄像头接收窗口', () => openReceiver(), 'primary'))
    view.body.appendChild(row)
    view.body.appendChild(
      D().el('p', 'hint', '摄像头被占用或没有权限时，接收窗口里可以用「框选截图识别」或「导入图片识别」降级。')
    )
    return view
  }

  function statusCard(): any {
    const view = card('本次发送')
    if (!state.senderOpen && !state.progress) {
      view.body.appendChild(D().el('p', 'hint', '还没有开始发送。'))
      return view
    }
    const p = state.progress || {}
    view.body.appendChild(
      D().kvList([
        ['码窗', state.senderOpen ? '已打开（全屏置顶，Esc 关闭）' : '已关闭'],
        ['已播放帧', p.frames == null ? '—' : String(p.frames)],
        ['实际帧率', typeof p.fps === 'number' ? p.fps.toFixed(1) + ' fps' : '—'],
        ['已播放', p.elapsed == null ? '—' : U().formatDuration(p.elapsed)],
        ['数据帧 / 控制帧', (p.dataFrames == null ? '—' : p.dataFrames) + ' / ' + (p.controlFrames == null ? '—' : p.controlFrames)]
      ])
    )
    return view
  }

  function notesCard(): any {
    const view = card('限制与实现说明')
    view.body.appendChild(
      D().kvList([
        ['文件上限', U().formatBytes(S().MAX_BYTES) + '（超出会直接拒绝并提示）'],
        ['帧格式', 'magic + type + sessionId + block + esi + payload + CRC32，全部走 QR Byte 模式（8-bit clean）'],
        ['摘要通道', '描述符 flags 置 FLAG_SHA256，32 字节 SHA-256 原始摘要放在描述符的可选附加区 extra（文件名之后、CRC 之前）'],
        ['为什么放 extra', '既不占用文件名字段（文件名与扩展名原样保留），又让接收端一收到描述符就知道期望摘要；另外两个插件的接收端不读 extra，互不破坏'],
        ['OTI 与摘要的区分', 'extra 长度为 12 时在共享核心里是 RaptorQ 的 OTI；本插件按长度区分，绝不会把 OTI 误当摘要'],
        ['WASM 边界', '发送端不加载 WASM（本插件招牌是纯 JS 的 LT 喷泉码，RaptorQ 发送已禁用）；接收端会加载 vendor/raptorq.core.wasm，所以能解全部三种模式（含真 RaptorQ），加载失败则如实降级'],
        ['接收端落盘', 'LT 模式按块解码，一块凑满秩就立刻写到目标文件的对应偏移并释放该块；顺序分片是单块结构，只能收齐再写']
      ])
    )
    return view
  }

  function render(): void {
    const panel = D().byId('panel')
    if (!panel) return
    D().clear(panel)
    panel.appendChild(sendCard().root)
    panel.appendChild(receiveCard().root)
    panel.appendChild(statusCard().root)
    panel.appendChild(notesCard().root)
    D().setText(D().byId('hero-sub'), '招牌模式 LT 喷泉码 · SHA-256 校验 · 保留文件名 · 最大 64MB')
    D().setText(
      D().byId('engine-badge'),
      codecs().raptorqAvailable() ? 'WASM 内核' : 'JS 内核（无 WASM）'
    )
  }

  /* ------------------------------------------------------------------ */
  /*                                行为                                 */
  /* ------------------------------------------------------------------ */

  function prepareSend(filePath: string): Promise<any> {
    const task = Promise.resolve()
      .then(() => {
        const b = bridge()
        if (!b) throw new Error('不在 uTools 环境里：没有 utoolsBridge')
        const info = b.statFile(filePath)
        if (info.isDirectory) throw new Error('这是文件夹，不是文件：' + info.name)
        S().assertSendableSize(info.bytes)
        const file = b.readFile(filePath)
        state.filePath = filePath
        state.fileInfo = { path: filePath, name: file.name, bytes: file.bytes }
        return S().buildPlan({
          filePath: filePath,
          name: file.name,
          bytes: file.bytes,
          mode: state.mode,
          symbolSize: state.symbolSize,
          fps: state.fps,
          ecc: state.ecc,
          repeatDescriptor: state.repeatDescriptor
        })
      })
      .then((plan: SendPlan) => {
        state.plan = plan
        state.digestHex = plan.digestHex
        DOT.state = state
        render()
        return plan
      })
      .catch((err: any) => {
        const text = err && err.message ? err.message : String(err)
        state.errors.push(text)
        state.plan = null
        DOT.state = state
        render()
        D().toast(text, 'error')
        return null
      })
    state.pending = task
    return task
  }

  function startSend(): void {
    const b = bridge()
    if (!b || !state.plan) return
    const payload = {
      filePath: state.plan.filePath,
      name: state.plan.name,
      sessionId: state.plan.sessionId,
      totalBytes: state.plan.totalBytes,
      mode: state.plan.mode,
      symbolSize: state.plan.symbolSize,
      fps: state.plan.fps,
      ecc: state.plan.ecc,
      repeatDescriptor: state.plan.repeatDescriptor,
      digestHex: state.plan.digestHex,
      version: state.plan.version
    }
    if (typeof b.openSenderWindow !== 'function') {
      D().toast('当前环境没有 createBrowserWindow，无法打开码窗', 'error')
      return
    }
    b.openSenderWindow(payload)
    state.senderOpen = true
    state.progress = null
    render()
  }

  function openReceiver(): void {
    const b = bridge()
    if (!b || typeof b.openScanWindow !== 'function') {
      D().toast('当前环境没有 createBrowserWindow，无法打开接收窗口', 'error')
      return
    }
    b.openScanWindow({})
  }

  function handleEnter(action: any): void {
    state.lastAction = action
    const code = (action && action.code) || 'dot-send'
    const type = (action && action.type) || 'text'
    const P = protocol()

    if (code === 'dot-receive') {
      render()
      openReceiver()
      return
    }

    if (code === 'dot-send-files' && (type === 'files' || type === 'file')) {
      const list = Array.isArray(action.payload) ? action.payload : [action.payload]
      const first = list[0]
      const filePath = typeof first === 'string' ? first : first && first.path
      if (!filePath) {
        D().toast('没有拿到文件路径', 'error')
        render()
        return
      }
      if (list.length > 1) {
        D().toast('协议是单文件流，已取第 1 个：' + (first.name || filePath) + '（共 ' + list.length + ' 个）', 'error')
      }
      state.mode = state.mode == null ? P.MODE_FOUNTAIN : state.mode
      render()
      state.pending = prepareSend(filePath)
      return
    }

    render()
  }

  /* ------------------------------------------------------------------ */
  /*                                启动                                 */
  /* ------------------------------------------------------------------ */

  function boot(): void {
    const b = bridge()
    if (b && typeof b.onPluginEnter === 'function') b.onPluginEnter(handleEnter)
    if (b && typeof b.onSenderProgress === 'function') {
      b.onSenderProgress((payload: any) => {
        state.progress = payload
        if (payload && payload.closed) state.senderOpen = false
        render()
      })
    }
    D().on(typeof window !== 'undefined' ? window : G, 'otp:sender-closed', () => {
      state.senderOpen = false
      render()
    })

    const last = b && typeof b.getLastEnterAction === 'function' ? b.getLastEnterAction() : null
    if (last) handleEnter(last)
    else render()
  }

  boot()
  DOT.booted = true
})()
