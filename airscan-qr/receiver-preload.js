/**
 * receiver-preload.js —— 摄像头接收窗的预加载脚本
 *
 * 除了收 otp:start 和回传/关闭，还负责两件降级路径需要的能力：
 *   · writeFile / showSaveDialog —— 收完后落盘
 *   · captureScreen()            —— 无摄像头时用 uTools 的框选截图识别
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
  getStartPayload: () => lastPayload,
  writeFile(filePath, bytes) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, Buffer.from(bytes))
    return filePath
  },
  showSaveDialog(options) {
    try {
      return utools.showSaveDialog(options)
    } catch (err) {
      return undefined
    }
  },
  /** uTools 框选截图 → Promise<dataURL>；这是没有摄像头时的主降级路径 */
  captureScreen() {
    return new Promise((resolve, reject) => {
      try {
        utools.screenCapture((image) => resolve(image))
      } catch (err) {
        reject(err)
      }
    })
  },
  sendToParent(channel, data) {
    try {
      utools.sendToParent(channel, data)
    } catch (err) {
      /* 忽略 */
    }
  },
  close() {
    try {
      utools.sendToParent('otp:close-receiver')
    } catch (err) {
      window.close()
    }
  }
}
