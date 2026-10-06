/**
 * sender-preload.js —— 全屏码窗的预加载脚本
 *
 * 该窗口只需要三件事：
 *   1. 收主窗口发来的 otp:start（可能早于页面脚本就绪，所以缓存一份 + 派发事件）
 *   2. 读文件（文件内容不经 IPC 传输，避免大文件走结构化克隆）
 *   3. 关闭自己 / 回传进度
 */
const fs = require('fs')
const path = require('path')
const { ipcRenderer } = require('electron')

let lastPayload = null

ipcRenderer.on('otp:start', (event, payload) => {
  lastPayload = payload
  if (typeof window !== 'undefined' && window.dispatchEvent) {
    window.dispatchEvent(new CustomEvent('otp:start', { detail: payload }))
  }
})

window.utoolsBridge = {
  /** 页面脚本可能在 otp:start 之后才就绪，用这个补取 */
  getStartPayload: () => lastPayload,
  readFile(filePath) {
    const buf = fs.readFileSync(filePath)
    return { name: path.basename(filePath), bytes: new Uint8Array(buf) }
  },
  writeFile(target, bytes) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.from(bytes))
    return target
  },
  showSaveDialog(options) {
    try {
      return utools.showSaveDialog(options)
    } catch (err) {
      return undefined
    }
  },
  sendToParent(channel, data) {
    try {
      utools.sendToParent(channel, data)
    } catch (err) {
      /* 独立调试时没有父窗口，忽略 */
    }
  },
  close() {
    try {
      utools.sendToParent('otp:close-sender')
    } catch (err) {
      window.close()
    }
  }
}
