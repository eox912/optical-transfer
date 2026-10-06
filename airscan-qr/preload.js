/**
 * preload.js —— airscan-qr 主窗口预加载脚本
 *
 * 职责（照 PLUGIN-SPEC 第 2 节）：
 *   1. 开两个子窗口：全屏码窗（sender.html）与摄像头接收窗（receiver.html）
 *   2. 给主界面提供文件读写 / 保存对话框 / 路径等 Node 能力
 *   3. 把子窗口回传的进度事件转发给主界面
 *
 * 注意：createBrowserWindow 的 url 与 webPreferences.preload 都是**相对路径**；
 * 子窗口要能自己关闭必须传 closeable: true。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { ipcRenderer } = require('electron')

const api = typeof utools !== 'undefined' ? utools : null

let codeWindow = null
let scanWindow = null
/** 最近一次的进度事件，供页面加载完成后补取 */
let lastProgress = null

/* -------------------------------------------------------------------------- */
/*                                  窗口管理                                   */
/* -------------------------------------------------------------------------- */

function destroy(win) {
  if (!win) return
  try {
    if (!win.isDestroyed()) win.close()
  } catch (err) {
    console.error('[preload] 关闭窗口失败：', err)
  }
}

/**
 * 打开全屏动态码窗。
 * 用显示器的 bounds 手工铺满，比 fullscreen 在各平台更可控。
 * @param {{name:string, source:{kind:'file'|'text', path?:string, text?:string}, options:object}} payload
 */
function openSenderWindow(payload) {
  destroy(codeWindow)
  const display = api.getPrimaryDisplay()
  const b = display.bounds
  const win = api.createBrowserWindow(
    'sender.html',
    {
      show: false,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      autoHideMenuBar: true,
      backgroundColor: '#0b0b0f',
      closeable: true,
      webPreferences: { preload: 'sender-preload.js' }
    },
    () => {
      try {
        win.setAlwaysOnTop(true, 'screen-saver')
      } catch (err) {
        /* 某些平台不支持该 level，忽略 */
      }
      win.show()
      // 主窗口 → 子窗口：只能用 webContents.send
      win.webContents.send('otp:start', payload)
    }
  )
  codeWindow = win
  return true
}

/**
 * 打开摄像头接收窗（普通可缩放窗口）。
 * @param {{mode:'camera'|'image'}} [payload]
 */
function openScanWindow(payload) {
  destroy(scanWindow)
  const win = api.createBrowserWindow(
    'receiver.html',
    {
      show: false,
      width: 880,
      height: 900,
      minWidth: 420,
      minHeight: 560,
      title: 'AirScan 扫码接收',
      backgroundColor: '#12141a',
      autoHideMenuBar: true,
      alwaysOnTop: true,
      closeable: true,
      webPreferences: { preload: 'receiver-preload.js' }
    },
    () => {
      win.show()
      win.webContents.send('otp:start', payload || {})
    }
  )
  scanWindow = win
  return true
}

ipcRenderer.on('otp:close-sender', () => destroy(codeWindow))
ipcRenderer.on('otp:close-receiver', () => destroy(scanWindow))
ipcRenderer.on('otp:progress', (event, payload) => {
  lastProgress = payload
  if (typeof window !== 'undefined' && window.dispatchEvent) {
    window.dispatchEvent(new CustomEvent('otp:progress', { detail: payload }))
  }
})

/* -------------------------------------------------------------------------- */
/*                                 文件能力                                    */
/* -------------------------------------------------------------------------- */

function readFile(filePath) {
  const buf = fs.readFileSync(filePath)
  return { name: path.basename(filePath), bytes: new Uint8Array(buf) }
}

function getPath(name) {
  try {
    if (api && api.getPath) {
      const value = api.getPath(name)
      if (value) return value
    }
  } catch (err) {
    /* 落到下面的兜底 */
  }
  return name === 'downloads' ? path.join(os.homedir(), 'Downloads') : os.homedir()
}

function writeFile(target, bytes) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.from(bytes))
  return target
}

window.utoolsBridge = {
  readFile,
  writeFile,
  getPath,
  showSaveDialog(options) {
    try {
      return api.showSaveDialog(options)
    } catch (err) {
      return undefined
    }
  },
  openSenderWindow,
  openScanWindow,
  getLastProgress: () => lastProgress,
  isDev() {
    return Boolean(api && api.isDev && api.isDev())
  },
  platform: process.platform,
  versions: { node: process.versions.node }
}
