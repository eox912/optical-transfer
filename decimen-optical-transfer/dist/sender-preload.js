/**
 * sender-preload.js —— 全屏码窗的预加载脚本
 *
 * 码窗需要自己读文件（避免把 64MB 通过 IPC 传一遍），所以这里直接给 fs。
 * otp:start 可能在页面脚本就绪之前就到达，因此既缓存一份也给页面派发事件。
 */
const fs = require('fs')
const path = require('path')
const { ipcRenderer } = require('electron')

const api = typeof utools !== 'undefined' ? utools : null

let lastPayload = null
const startListeners = new Set()

ipcRenderer.on('otp:start', (event, payload) => {
  lastPayload = payload
  startListeners.forEach((fn) => {
    try {
      fn(payload)
    } catch (err) {
      console.error('[sender-preload] onStart 回调异常：', err)
    }
  })
  try {
    window.dispatchEvent(new CustomEvent('otp:start', { detail: payload }))
  } catch (err) {
    /* 忽略 */
  }
})

function readFile(filePath) {
  const buf = fs.readFileSync(filePath)
  const bytes = new Uint8Array(buf.length)
  bytes.set(buf)
  return { name: path.basename(filePath), bytes }
}

window.utoolsBridge = {
  /** 页面补取：脚本就绪前已经收到的 payload */
  getStartPayload: () => lastPayload,
  onStart(fn) {
    startListeners.add(fn)
    return () => startListeners.delete(fn)
  },
  readFile,
  statFile(filePath) {
    const stat = fs.statSync(filePath)
    return { path: filePath, name: path.basename(filePath), bytes: stat.size }
  },
  close() {
    try {
      api.sendToParent('otp:close-sender')
    } catch (err) {
      window.close()
    }
  },
  sendToParent(channel, data) {
    try {
      api.sendToParent(channel, data)
    } catch (err) {
      /* 忽略 */
    }
  },
  isDev() {
    return Boolean(api && api.isDev && api.isDev())
  },
  getWindowType() {
    try {
      return api.getWindowType()
    } catch (err) {
      return 'browser'
    }
  }
}
