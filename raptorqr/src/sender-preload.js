/**
 * sender-preload.js —— 全屏码窗的预加载脚本
 *
 * 码窗是被主窗口用 createBrowserWindow 拉起来的，数据只能靠 IPC 送进来。
 * 页面脚本可能比 'otp:start' 事件晚就绪，所以这里既转发事件、也缓存一份供补取。
 */
const { ipcRenderer } = require('electron')

/**
 * 把 IPC 传过来的字节规范化成 Uint8Array。
 * 正常情况下结构化克隆直接给 Uint8Array；但不同 Electron/序列化路径下
 * 也可能是 Buffer、普通数组或 {type:'Buffer',data:[...]}，这里统一兜住。
 */
function toBytes(value) {
  if (!value) return null
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return Uint8Array.from(value)
  if (value.type === 'Buffer' && Array.isArray(value.data)) return Uint8Array.from(value.data)
  if (typeof value.length === 'number') return Uint8Array.from(value)
  return null
}

function normalize(payload) {
  if (!payload) return null
  const out = {}
  for (const key in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) out[key] = payload[key]
  }
  out.bytes = toBytes(payload.bytes)
  return out
}

let lastPayload = null

ipcRenderer.on('otp:start', (event, payload) => {
  lastPayload = normalize(payload)
  try {
    window.dispatchEvent(new CustomEvent('otp:start', { detail: lastPayload }))
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
    const fs = require('fs')
    const path = require('path')
    const target = path.isAbsolute(url) ? url : path.join(__dirname, url)
    if (!fs.existsSync(target)) return null
    return new Uint8Array(fs.readFileSync(target))
  } catch (err) {
    return null
  }
}

window.utoolsBridge = {
  getStartPayload: () => lastPayload,
  close: () => {
    try {
      utools.sendToParent('otp:close-sender')
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
  readBinary,
  readVendorWasm: () => readBinary('vendor/raptorq.core.wasm'),
  isDev: () => {
    try {
      return Boolean(utools && utools.isDev && utools.isDev())
    } catch (err) {
      return false
    }
  },
  platform: process.platform
}
