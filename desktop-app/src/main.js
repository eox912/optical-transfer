/**
 * main.js —— Electron 主进程
 *
 * 桌面版相对浏览器模式的**真正增量**（也是它值得做成桌面应用的三个理由）：
 *   1. `setAlwaysOnTop(true, 'screen-saver')` + 全屏 → **码窗真的盖住其他应用**。
 *      浏览器模式做不到这一点（只能靠 F11 全屏，仍会被其他窗口遮住）。
 *   2. `powerSaveBlocker.start('prevent-display-sleep')` → **屏幕不会睡眠/变暗**。
 *      这是光学传输的硬需求：息屏或降亮度会直接中断传输。
 *      （对应安卓版的 KeepAwake，但这里不需要任何插件，Electron 自带。）
 *   3. Windows 上还能直接改屏幕亮度（WMI）。
 *
 * 另外还提供系统级能力：原生文件对话框、真正的保存到指定路径、
 * 屏幕捕获（无摄像头时的降级通道）、在文件管理器中定位。
 */
'use strict'

const { app, BrowserWindow, ipcMain, dialog, powerSaveBlocker, desktopCapturer, screen, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const IS_WINDOWS = process.platform === 'win32'
const SMOKE = process.argv.includes('--smoke-test')

/**
 * userData 目录不可写时自动回退。
 *
 * Electron 启动阶段就要在 `userData`（默认是
 * `%APPDATA%\<name>` / `~/Library/Application Support/<name>`）下建 GPU 缓存等，
 * **建不了就直接 SIGTRAP 崩掉整个进程**，而且什么日志都不打——极难定位
 * （本机沙箱里就是这样：`electron .` 必崩，而用默认 app 名 "Electron" 跑却没事，
 * 因为那个目录已存在）。
 *
 * 真实桌面上不会遇到；但沙箱 / CI / 只读 HOME 的场景会遇到，
 * 所以这里探测一次并回退到临时目录，别让整个应用起不来。
 */
function ensureWritableUserData() {
  try {
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    fs.accessSync(dir, fs.constants.W_OK)
  } catch (err) {
    const fallback = path.join(require('os').tmpdir(), 'optical-transfer-desktop')
    try {
      fs.mkdirSync(fallback, { recursive: true })
      app.setPath('userData', fallback)
      console.warn('[userData] 默认目录不可写，已回退到 ' + fallback + '（' + ((err && err.message) || err) + '）')
    } catch (err2) {
      console.error('[userData] 回退也失败：' + ((err2 && err2.message) || err2))
    }
  }
}

ensureWritableUserData()

let mainWindow = null
let sleepBlockerId = null
let savedBrightness = null
/** 冒烟测试期间收集渲染进程的报错 */
const rendererErrors = []

/* ------------------------------------------------------------------ */
/*                              屏幕亮度                               */
/* ------------------------------------------------------------------ */

/**
 * 只有 Windows 能用 WMI 直接调亮度。
 * macOS 没有标准命令行 API（`brightness` 需要额外装 brew 包），
 * 所以如实返回 false，由 UI 显示"亮度控制不可用"。
 */
function windowsBrightness(percent) {
  return new Promise((resolve) => {
    if (!IS_WINDOWS) return resolve(false)
    const ps = `(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,${percent})`
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], (err) => resolve(!err))
  })
}

function windowsGetBrightness() {
  return new Promise((resolve) => {
    if (!IS_WINDOWS) return resolve(null)
    const ps = '(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness'
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], (err, stdout) => {
      if (err) return resolve(null)
      const n = parseInt(String(stdout).trim(), 10)
      resolve(Number.isFinite(n) ? n : null)
    })
  })
}

/* ------------------------------------------------------------------ */
/*                                窗口                                 */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: '光学隔空传输',
    backgroundColor: '#0e1014',
    show: !SMOKE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 里要 require('fs')/require('path') 读 wasm，所以关掉 sandbox
      sandbox: false,
      backgroundThrottling: false
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'index.html'))

  // 收集渲染进程的报错（冒烟测试要断言"没有报错"）
  mainWindow.webContents.on('console-message', function () {
    // Electron 新版是 (event) 且带 event.level；旧版是 (event, level, message)
    const args = Array.prototype.slice.call(arguments)
    const evt = args[0]
    const level = evt && typeof evt === 'object' && 'level' in evt ? evt.level : args[1]
    const message = evt && typeof evt === 'object' && 'message' in evt ? evt.message : args[2]
    if (level === 'error' || level === 3 || level === 2) rendererErrors.push(String(message))
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (SMOKE) mainWindow.webContents.once('did-finish-load', () => runSmokeTest())
}

/* ------------------------------------------------------------------ */
/*                              IPC 接口                              */
/* ------------------------------------------------------------------ */

ipcMain.handle('native:env', () => ({
  native: true,
  platform: process.platform,
  appVersion: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  isPackaged: app.isPackaged,
  // 与安卓 native.js 的 envInfo().plugins 同形，便于 app.js 直接复用
  plugins: {
    KeepAwake: typeof powerSaveBlocker !== 'undefined',
    ScreenBrightness: IS_WINDOWS,
    Filesystem: true,
    Share: true
  },
  capabilities: {
    alwaysOnTop: true,
    screenCapture: true,
    nativeDialogs: true
  }
}))

ipcMain.handle('native:keepAwake', async (event, on) => {
  const result = { keepAwake: false, brightness: false, errors: [] }

  // 1. 屏幕不睡眠（Electron 内置，不需要插件）
  try {
    if (on) {
      if (sleepBlockerId == null) sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep')
      result.keepAwake = powerSaveBlocker.isStarted(sleepBlockerId)
    } else if (sleepBlockerId != null) {
      powerSaveBlocker.stop(sleepBlockerId)
      sleepBlockerId = null
    }
  } catch (err) {
    result.errors.push('powerSaveBlocker: ' + ((err && err.message) || err))
  }

  // 2. 亮度（只有 Windows 能做）
  if (!IS_WINDOWS) {
    result.errors.push('亮度控制仅 Windows 支持（macOS 无标准命令行 API）')
  } else {
    try {
      if (on) {
        if (savedBrightness == null) savedBrightness = await windowsGetBrightness()
        result.brightness = await windowsBrightness(100)
        if (!result.brightness) result.errors.push('WMI 调亮度失败（可能是外接显示器，不走 WMI）')
      } else if (savedBrightness != null) {
        await windowsBrightness(savedBrightness)
        savedBrightness = null
      }
    } catch (err) {
      result.errors.push('Brightness: ' + ((err && err.message) || err))
    }
  }

  return result
})

ipcMain.handle('native:pickFile', async (event, options) => {
  const filters = options && options.image
    ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    : [{ name: '所有文件', extensions: ['*'] }]
  const picked = dialog.showOpenDialogSync(mainWindow, {
    title: '选择要隔空发送的文件',
    properties: ['openFile'],
    filters
  })
  if (!picked || !picked.length) return null
  const filePath = picked[0]
  const bytes = new Uint8Array(fs.readFileSync(filePath))
  return { name: path.basename(filePath), bytes: bytes, size: bytes.length, path: filePath }
})

ipcMain.handle('native:saveFile', async (event, payload) => {
  const name = (payload && payload.name) || 'received.bin'
  const bytes = payload && payload.bytes ? Buffer.from(payload.bytes) : Buffer.alloc(0)
  const target = dialog.showSaveDialogSync(mainWindow, {
    title: '保存接收到的文件',
    defaultPath: path.join(app.getPath('downloads'), name)
  })
  if (!target) return { saved: false, cancelled: true }
  fs.writeFileSync(target, bytes)
  // 桌面的"交付"就是落到用户选定的路径，再提供定位入口
  shell.showItemInFolder(target)
  return { saved: true, uri: target, mode: 'native-path' }
})

ipcMain.handle('native:fullscreen', (event, on) => {
  if (!mainWindow) return false
  try {
    if (on) {
      mainWindow.setFullScreen(true)
      // 'screen-saver' 层级高于普通窗口，能盖住全屏应用
      mainWindow.setAlwaysOnTop(true, 'screen-saver')
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    } else {
      mainWindow.setAlwaysOnTop(false)
      mainWindow.setFullScreen(false)
      mainWindow.setVisibleOnAllWorkspaces(false)
    }
    return true
  } catch (err) {
    return false
  }
})

/** 无摄像头时的降级：抓一张整屏图交给接收端解帧 */
ipcMain.handle('native:captureScreen', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 }
  })
  if (!sources.length) return null
  return sources[0].thumbnail.toDataURL()
})

ipcMain.handle('native:readVendor', (event, relPath) => {
  // 让 raptorq.core.js 走 fs 读 wasm（比 fetch 稳，且打包后路径确定）
  const clean = String(relPath || 'vendor/raptorq.core.wasm').replace(/^\.\//, '')
  const target = path.resolve(__dirname, clean)
  if (!target.startsWith(path.resolve(__dirname))) throw new Error('路径越界：' + relPath)
  return new Uint8Array(fs.readFileSync(target))
})

ipcMain.handle('native:reveal', (event, filePath) => {
  shell.showItemInFolder(String(filePath || ''))
  return true
})

ipcMain.handle('native:displays', () => {
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    primary: d.id === screen.getPrimaryDisplay().id
  }))
})

/* ------------------------------------------------------------------ */
/*                            冒烟测试                                 */
/* ------------------------------------------------------------------ */

/**
 * `electron . --smoke-test`：真的把页面加载起来，然后**在渲染进程里**
 * 检查核心是否就位、WASM 能否加载、并跑一遍真实的"发送→QR像素→接收"往返。
 * 这是唯一能在无头环境里证明"打包出来的 App 真的能跑"的办法。
 */
async function runSmokeTest() {
  const lines = []
  let failed = 0

  const say = (ok, name, extra) => {
    if (!ok) failed++
    lines.push(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  }

  try {
    const info = await mainWindow.webContents.executeJavaScript(`(function () {
      return {
        hasOTP: typeof OTP !== 'undefined',
        modes: typeof OTP !== 'undefined' && OTP.codecs ? OTP.codecs.MODE_INFO.length : 0,
        hasNative: typeof Native !== 'undefined',
        hasApp: Boolean(window.__APP__),
        hasWasmScript: Boolean(OTP && OTP.raptorqCore),
        title: document.title,
        elements: ['code-canvas','video','mode','start','cam-start','save','env-badge']
          .filter(function (id) { return !document.getElementById(id) })
      }
    })()`)

    say(info.hasOTP, 'OTP 核心已加载')
    say(info.modes === 3, '三种模式就位', String(info.modes))
    say(info.hasNative, 'window.Native 已注入')
    say(info.hasApp, 'window.__APP__ 已导出')
    say(info.hasWasmScript, 'raptorq.core.js 已加载')
    say(info.elements.length === 0, '关键 DOM 元素齐全', info.elements.length ? '缺 ' + info.elements.join(',') : '')

    const env = await mainWindow.webContents.executeJavaScript('Native.envInfo()')
    say(env.native === true, '原生环境自报正确', env.platform)
    say(env.plugins.KeepAwake === true, 'powerSaveBlocker 可用（屏幕不睡眠）')

    // 真的把 wasm 加载起来并跑一次真 RaptorQ 往返
    const rt = await mainWindow.webContents.executeJavaScript(`(async function () {
      var ok = await OTP.raptorqCore.load({ readBytes: function (p) { return window.__readVendor(p) } })
      if (!ok || !OTP.raptorqCore.isAvailable()) {
        return { available: false, error: OTP.codecs.raptorqStatus().error }
      }
      OTP.codecs.setRaptorqCore(OTP.raptorqCore)
      var data = new Uint8Array(8000)
      for (var i = 0; i < data.length; i++) data[i] = (i * 13) & 0xff
      var sender = OTP.codecs.createSender(OTP.protocol.MODE_RAPTORQ, {
        data: data, name: 'smoke.bin', sessionId: OTP.protocol.makeSessionId(data), symbolSize: 1400
      })
      var receiver = OTP.codecs.createReceiver(sender.descriptor)
      var n = 0
      while (!receiver.isComplete) {
        var c = sender.frameCoord(n)
        receiver.add(c.blockIndex, c.esi, sender.symbol(c.blockIndex, c.esi))
        n++
        if (n > 100000) return { available: true, ok: false, error: '未收敛' }
      }
      var out = receiver.assemble()
      var same = out && out.length === data.length
      for (var k = 0; ok && same && k < data.length; k++) if (out[k] !== data[k]) same = false
      if (sender.free) sender.free()
      return { available: true, ok: same, backend: sender.backend, symbols: sender.descriptor.totalSymbols }
    })()`)

    say(rt.available, 'WASM 内核加载成功', rt.error || '')
    say(!!rt.ok, '真 RaptorQ 编解码往返一致', rt.available ? rt.symbols + ' 符号 / ' + rt.backend : '')

    // 走一遍真实 QR 像素链路
    const px = await mainWindow.webContents.executeJavaScript(`(function () {
      var data = new Uint8Array(1200)
      for (var i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff
      var sender = OTP.codecs.createSender(OTP.protocol.MODE_SEQUENTIAL, {
        data: data, name: 'px.bin', sessionId: OTP.protocol.makeSessionId(data), symbolSize: 400
      })
      var version = OTP.qr.versionFor(sender.frameLength, 'L')
      var frame = OTP.protocol.encodeDataFrame(sender.descriptor.sessionId, 0, 0, sender.symbol(0, 0))
      var img = OTP.qr.toImageData(OTP.qr.encode(frame, 'L', version), { scale: 3, quiet: 4 })
      var back = OTP.scan.decodeFrameFromImage(OTP.protocol, img.data, img.width, img.height)
      if (!back) return { ok: false }
      var same = back.payload.length === 400
      for (var j = 0; same && j < 400; j++) if (back.payload[j] !== sender.symbol(0, 0)[j]) same = false
      return { ok: same, version: version, px: img.width }
    })()`)
    say(!!px.ok, '帧 → QR 像素 → jsQR 解回 一致', 'v' + px.version + ' / ' + px.px + 'px')

    // 全屏 + 置顶 + 屏幕不睡眠 真的能调用成功
    const fs1 = await mainWindow.webContents.executeJavaScript('Native.enterFullscreen()')
    say(fs1 === true, '进入全屏（并置顶）成功')
    const ka = await mainWindow.webContents.executeJavaScript('Native.keepAwake(true)')
    say(ka.keepAwake === true, '屏幕不睡眠已开启')
    await mainWindow.webContents.executeJavaScript('Native.keepAwake(false); Native.exitFullscreen()')
  } catch (err) {
    say(false, '冒烟测试执行异常', (err && err.message) || String(err))
  }

  console.log('\n=== 桌面版冒烟测试（真实 Electron 进程）===\n')
  for (const l of lines) console.log(l)
  if (rendererErrors.length) {
    console.log('\n渲染进程报错 ' + rendererErrors.length + ' 条：')
    for (const e of rendererErrors.slice(0, 8)) console.log('    ' + e)
    failed++
  } else {
    console.log('\n  ✓ 渲染进程无报错')
  }
  console.log(`\n${failed === 0 ? '✅ 全部通过' : '❌ 有 ' + failed + ' 项失败'}\n`)

  app.exit(failed === 0 ? 0 : 1)
}

/* ------------------------------------------------------------------ */
/*                                启动                                 */
/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (sleepBlockerId != null) {
    try {
      powerSaveBlocker.stop(sleepBlockerId)
    } catch (err) {
      /* 忽略 */
    }
    sleepBlockerId = null
  }
  // 冒烟测试由 runSmokeTest 自己退出
  if (process.platform !== 'darwin' || SMOKE) app.quit()
})
