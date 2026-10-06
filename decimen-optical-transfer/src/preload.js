/**
 * preload.js —— 主窗口预加载脚本（CommonJS，Electron preload 环境）
 *
 * 职责：
 *   1. 接管 utools.onPluginEnter，转交给页面（页面脚本可能晚于事件就绪）
 *   2. 开/关两个子窗口：sender.html（全屏码窗）、receiver.html（摄像头接收窗）
 *   3. 提供 Node 能力：读文件、stat、SHA-256、路径、保存对话框
 *
 * 注意：createBrowserWindow 的 url 与 webPreferences.preload 都必须是**相对路径**。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { ipcRenderer } = require('electron')

const api = typeof utools !== 'undefined' ? utools : null

let codeWindow = null
let scanWindow = null
let lastAction = null
const enterListeners = new Set()

if (api && typeof api.onPluginEnter === 'function') {
  api.onPluginEnter((action) => {
    lastAction = action
    enterListeners.forEach((fn) => {
      try {
        fn(action)
      } catch (err) {
        console.error('[preload] onPluginEnter 回调异常：', err)
      }
    })
  })
}

if (api && typeof api.onPluginOut === 'function') {
  api.onPluginOut(() => {
    /* 主窗口退出不强制关闭子窗口：接收往往还在进行中，由用户自己关 */
  })
}

/* ------------------------------------------------------------------ */
/*                               子窗口                                */
/* ------------------------------------------------------------------ */

function destroy(win) {
  if (!win) return
  try {
    if (!win.isDestroyed()) win.close()
  } catch (err) {
    console.error('[preload] 关闭窗口失败：', err)
  }
}

/**
 * 打开全屏码窗：手工按显示器 bounds 铺满，比 fullscreen 在各平台更可控
 * @param {object} payload 发送参数（文件路径 / 模式 / 切片 / 帧率 / 摘要 …）
 */
function openSenderWindow(payload) {
  destroy(codeWindow)
  if (!api || typeof api.createBrowserWindow !== 'function') return null
  let bounds = { x: 0, y: 0, width: 1280, height: 800 }
  try {
    bounds = api.getPrimaryDisplay().bounds
  } catch (err) {
    console.error('[preload] getPrimaryDisplay 失败：', err)
  }
  const win = api.createBrowserWindow(
    'sender.html',
    {
      show: false,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      autoHideMenuBar: true,
      backgroundColor: '#08080c',
      closeable: true,
      webPreferences: { preload: 'sender-preload.js' }
    },
    () => {
      try {
        win.setAlwaysOnTop(true, 'screen-saver')
      } catch (err) {
        /* 部分平台不支持 level 参数，忽略 */
      }
      win.show()
      /* 主窗口 → 子窗口：只能用 webContents.send */
      win.webContents.send('otp:start', payload)
    }
  )
  codeWindow = win
  return win
}

/** 接收窗口：普通可缩放窗口，方便摆在摄像头旁边看进度 */
function openScanWindow(payload) {
  destroy(scanWindow)
  if (!api || typeof api.createBrowserWindow !== 'function') return null
  const win = api.createBrowserWindow(
    'receiver.html',
    {
      show: false,
      width: 720,
      height: 820,
      minWidth: 480,
      minHeight: 560,
      title: '光码接收（DOT）',
      backgroundColor: '#0f1115',
      closeable: true,
      webPreferences: { preload: 'receiver-preload.js' }
    },
    () => {
      win.show()
      win.webContents.send('otp:start', payload || {})
    }
  )
  scanWindow = win
  return win
}

/* 子窗口 → 主窗口：utools.sendToParent，这里用 ipcRenderer.on 接 */
ipcRenderer.on('otp:close-sender', () => destroy(codeWindow))
ipcRenderer.on('otp:close-receiver', () => destroy(scanWindow))

function forward(channel, payload) {
  try {
    window.dispatchEvent(new CustomEvent(channel, { detail: payload }))
  } catch (err) {
    /* 页面还没加载时忽略 */
  }
}
ipcRenderer.on('otp:progress', (event, payload) => forward('otp:progress', payload))
ipcRenderer.on('otp:sender-closed', (event, payload) => forward('otp:sender-closed', payload))

/* ------------------------------------------------------------------ */
/*                              Node 能力                              */
/* ------------------------------------------------------------------ */

function readFile(filePath) {
  const buf = fs.readFileSync(filePath)
  const bytes = new Uint8Array(buf.length)
  bytes.set(buf)
  return { name: path.basename(filePath), bytes }
}

function statFile(filePath) {
  const stat = fs.statSync(filePath)
  return {
    path: filePath,
    name: path.basename(filePath),
    bytes: stat.size,
    isDirectory: stat.isDirectory(),
    mtime: stat.mtime.toISOString()
  }
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/** 字节数组摘要（WebCrypto 不可用时的回退） */
function sha256Bytes(bytes) {
  return sha256Hex(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

/** 文件摘要：流式读，内存占用与文件大小无关（接收端校验用） */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function getPath(name) {
  try {
    if (api && typeof api.getPath === 'function') return api.getPath(name)
  } catch (err) {
    /* 落到 os 回退 */
  }
  const fallback = {
    home: () => os.homedir(),
    desktop: () => path.join(os.homedir(), 'Desktop'),
    downloads: () => path.join(os.homedir(), 'Downloads'),
    temp: () => os.tmpdir()
  }[name]
  return fallback ? fallback() : os.homedir()
}

window.utoolsBridge = {
  services: {
    getPath,
    readFile,
    statFile,
    sha256Bytes,
    sha256File,
    platform: process.platform,
    versions: { node: process.versions.node, electron: process.versions.electron || '' }
  },
  readFile,
  statFile,
  sha256Bytes,
  sha256File,
  getPath,
  showSaveDialog(options) {
    if (api && typeof api.showSaveDialog === 'function') return api.showSaveDialog(options)
    return undefined
  },
  showOpenDialog(options) {
    if (api && typeof api.showOpenDialog === 'function') return api.showOpenDialog(options)
    return undefined
  },
  openSenderWindow,
  openScanWindow,
  getLastEnterAction: () => lastAction,
  onPluginEnter(fn) {
    enterListeners.add(fn)
    return () => enterListeners.delete(fn)
  },
  onSenderProgress(fn) {
    const handler = (event) => fn(event.detail)
    window.addEventListener('otp:progress', handler)
    return () => window.removeEventListener('otp:progress', handler)
  },
  isDev() {
    return Boolean(api && api.isDev && api.isDev())
  }
}
