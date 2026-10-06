/**
 * preload.js —— Electron 预加载脚本
 *
 * contextIsolation 开着，所以渲染进程只能看到这里显式暴露的东西。
 * 只暴露能力，不暴露 `require`。
 *
 * `platform` / `versions` 是**同步**挂在 window.desktop 上的常量：
 * 渲染进程的 envInfo() 需要在页面启动时就同步拿到平台名（用来显示环境徽标）。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  env: () => ipcRenderer.invoke('native:env'),
  keepAwake: (on) => ipcRenderer.invoke('native:keepAwake', !!on),
  pickFile: (options) => ipcRenderer.invoke('native:pickFile', options || {}),
  saveFile: (name, bytes) => ipcRenderer.invoke('native:saveFile', { name: name, bytes: bytes }),
  fullscreen: (on) => ipcRenderer.invoke('native:fullscreen', !!on),
  captureScreen: () => ipcRenderer.invoke('native:captureScreen'),
  readVendor: (relPath) => ipcRenderer.invoke('native:readVendor', relPath),
  reveal: (filePath) => ipcRenderer.invoke('native:reveal', filePath),
  displays: () => ipcRenderer.invoke('native:displays')
})
