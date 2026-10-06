/**
 * receiver-preload.js —— 接收窗的预加载脚本
 *
 * 接收窗需要落盘能力（收到文件后写出去），也需要 vendor wasm 的字节通道。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ipcRenderer } = require('electron')

const api = typeof utools !== 'undefined' ? utools : null

let lastOptions = null

ipcRenderer.on('otp:receive-options', (event, payload) => {
  lastOptions = payload || null
  try {
    window.dispatchEvent(new CustomEvent('otp:receive-options', { detail: lastOptions }))
  } catch (err) {
    /* 页面还没挂监听也不影响缓存 */
  }
})

/**
 * vendor/raptorq.core.js 约定的二进制读取桥（本地协议下比 fetch 可靠）。
 * 必须返回 Uint8Array：胶水层检查的是 bytes.length（ArrayBuffer 只有 byteLength）。
 */
function readBinary(url) {
  try {
    const target = path.isAbsolute(url) ? url : path.join(__dirname, url)
    if (!fs.existsSync(target)) return null
    return new Uint8Array(fs.readFileSync(target))
  } catch (err) {
    return null
  }
}

window.utoolsBridge = {
  getReceiveOptions: () => lastOptions,
  close: () => {
    try {
      utools.sendToParent('otp:close-receiver')
    } catch (err) {
      try {
        window.close()
      } catch (err2) {
        /* ignore */
      }
    }
  },
  sendToParent: (channel, data) => {
    try {
      utools.sendToParent(channel, data)
    } catch (err) {
      /* ignore */
    }
  },
  /** 同主窗口：见到目录就补文件名，兼容 showSaveDialog 返回目录的实现 */
  writeFile(target, bytes, suggestedName) {
    let dest = target
    if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
      dest = path.join(dest, suggestedName || 'received.bin')
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, Buffer.from(bytes))
    return dest
  },
  getPath(name) {
    try {
      return api.getPath(name)
    } catch (err) {
      return os.homedir()
    }
  },
  showSaveDialog(options) {
    try {
      return api.showSaveDialog(options)
    } catch (err) {
      return undefined
    }
  },
  /** 无摄像头时的降级：uTools 自带的框选截图 */
  screenCapture(callback) {
    try {
      if (api && typeof api.screenCapture === 'function') {
        api.screenCapture(callback)
        return true
      }
    } catch (err) {
      /* ignore */
    }
    return false
  },
  /** 无摄像头时的降级：手动挑一张图（截图文件）来识别 */
  showOpenDialog(options) {
    try {
      return api.showOpenDialog(options)
    } catch (err) {
      return undefined
    }
  },
  readImageAsDataUrl(filePath) {
    const buf = fs.readFileSync(filePath)
    const ext = path.extname(filePath).replace(/^\./, '').toLowerCase()
    const mime = ext === 'jpg' ? 'jpeg' : ext || 'png'
    return 'data:image/' + mime + ';base64,' + buf.toString('base64')
  },
  readBinary,
  readVendorWasm: () => readBinary('vendor/raptorq.core.wasm'),
  isDev: () => {
    try {
      return Boolean(api && api.isDev && api.isDev())
    } catch (err) {
      return false
    }
  },
  platform: process.platform
}
