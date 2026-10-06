/**
 * preload.js —— 主窗口（控制面板）的预加载脚本
 *
 * 只做三件事：
 *   1. 提供 Node 文件能力（读文件、写文件、选路径、看磁盘信息）；
 *   2. 开两个子窗口：全屏码窗 sender.html / 接收窗 receiver.html；
 *   3. 把 onPluginEnter 转给页面（页面脚本可能比事件晚就绪，所以缓存一份）。
 *
 * 窗口通信规矩（uTools 文档）：
 *   主窗口 → 子窗口：只能 win.webContents.send
 *   子窗口 → 主窗口：只能 utools.sendToParent，这里用 ipcRenderer.on 接
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ipcRenderer } = require('electron')

const api = typeof utools !== 'undefined' ? utools : null

let codeWindow = null
let scanWindow = null

/* -------------------------------------------------------------------------- */
/*                                 小工具                                      */
/* -------------------------------------------------------------------------- */

function isAlive(win) {
  if (!win) return false
  try {
    return typeof win.isDestroyed === 'function' ? !win.isDestroyed() : true
  } catch (err) {
    return false
  }
}

function closeWindow(win) {
  if (!isAlive(win)) return
  try {
    win.close()
  } catch (err) {
    /* 已经关了 */
  }
}

/** 插件根目录：preload 就在插件根下，__dirname 即根目录 */
function rootDir() {
  try {
    return __dirname
  } catch (err) {
    return '.'
  }
}

/**
 * 把插件目录下的二进制文件读成 ArrayBuffer。
 *
 * 这是 vendor/raptorq.core.js 官方约定的桥：它按
 *   opts.readBytes → window.utoolsBridge.readBinary → fetch → XHR
 * 的顺序找读取方式。本地协议下 fetch 很可能被 Chromium 拒绝
 * （"URL scheme must be http or https"），所以走 fs 最稳，
 * 也正好满足"不要用 instantiateStreaming / 不要走网络"的要求。
 *
 * 返回值必须是 **Uint8Array**：胶水层会检查 `bytes.length`
 * （ArrayBuffer 只有 byteLength，会被判成空）。WebAssembly.instantiate
 * 接受任何 BufferSource，所以 TypedArray 直接就够用。
 */
function readBinary(url) {
  try {
    const target = path.isAbsolute(url) ? url : path.join(rootDir(), url)
    if (!fs.existsSync(target)) return null
    return new Uint8Array(fs.readFileSync(target))
  } catch (err) {
    return null
  }
}

/** 兼容旧调用点：直接取 vendor 里的 wasm */
function readVendorWasm() {
  return readBinary(path.join('vendor', 'raptorq.core.wasm'))
}

/** 显示器列表（全屏码窗要铺满哪块屏） */
function displays() {
  try {
    const primary = api.getPrimaryDisplay()
    const all = api.getAllDisplays() || [primary]
    return all.map((d, i) => ({
      id: d.id,
      index: i,
      primary: primary ? d.id === primary.id : i === 0,
      label: d.label || '显示器 ' + (i + 1),
      bounds: d.bounds,
      scaleFactor: d.scaleFactor || 1
    }))
  } catch (err) {
    return []
  }
}

function pickDisplay(displayId) {
  const list = displays()
  if (!list.length) return null
  for (let i = 0; i < list.length; i++) if (list[i].id === displayId) return list[i]
  for (let j = 0; j < list.length; j++) if (list[j].primary) return list[j]
  return list[0]
}

/* -------------------------------------------------------------------------- */
/*                                  子窗口                                     */
/* -------------------------------------------------------------------------- */

/**
 * 开全屏码窗。用显示器的 bounds 手工铺满，比 fullscreen 在各平台更可控。
 * @param {{name:string, bytes:Uint8Array, mode:number, symbolSize:number, fps:number,
 *          ecc:string, multiQr:number, redundancy:number, displayId?:number}} payload
 */
function openSenderWindow(payload) {
  if (!api || typeof api.createBrowserWindow !== 'function') {
    return { ok: false, error: '当前环境没有 utools.createBrowserWindow' }
  }
  const display = pickDisplay(payload && payload.displayId)
  const b = display ? display.bounds : { x: 0, y: 0, width: 1280, height: 800 }

  closeWindow(codeWindow)

  try {
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
          /* 某些平台不支持 screen-saver 层级 */
        }
        try {
          win.show()
        } catch (err) {
          /* ignore */
        }
        try {
          win.webContents.send('otp:start', payload)
        } catch (err) {
          /* ignore */
        }
      }
    )
    codeWindow = win
    return { ok: true, bounds: b }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/** 开接收窗（普通可缩放窗口） */
function openScanWindow(payload) {
  if (!api || typeof api.createBrowserWindow !== 'function') {
    return { ok: false, error: '当前环境没有 utools.createBrowserWindow' }
  }
  if (isAlive(scanWindow)) {
    try {
      scanWindow.show()
      scanWindow.focus()
    } catch (err) {
      /* ignore */
    }
    return { ok: true, reused: true }
  }
  try {
    const win = api.createBrowserWindow(
      'receiver.html',
      {
        show: false,
        width: 940,
        height: 720,
        minWidth: 640,
        minHeight: 520,
        title: 'RaptorQR · 接收',
        backgroundColor: '#0b0b0f',
        closeable: true,
        webPreferences: { preload: 'receiver-preload.js' }
      },
      () => {
        try {
          win.show()
        } catch (err) {
          /* ignore */
        }
        try {
          if (payload) win.webContents.send('otp:receive-options', payload)
        } catch (err) {
          /* ignore */
        }
      }
    )
    scanWindow = win
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/* 子窗口 → 主窗口 */
ipcRenderer.on('otp:close-sender', () => {
  closeWindow(codeWindow)
})
ipcRenderer.on('otp:close-receiver', () => {
  closeWindow(scanWindow)
})
ipcRenderer.on('otp:progress', (event, payload) => {
  try {
    window.dispatchEvent(new CustomEvent('rq:sender-progress', { detail: payload }))
  } catch (err) {
    /* ignore */
  }
})
ipcRenderer.on('otp:saved', (event, payload) => {
  try {
    window.dispatchEvent(new CustomEvent('rq:receiver-saved', { detail: payload }))
  } catch (err) {
    /* ignore */
  }
})

/* -------------------------------------------------------------------------- */
/*                              事件转交 / 桥接                                 */
/* -------------------------------------------------------------------------- */

let lastEnterAction = null
const enterListeners = new Set()

if (api && typeof api.onPluginEnter === 'function') {
  api.onPluginEnter((action) => {
    lastEnterAction = action
    enterListeners.forEach((fn) => {
      try {
        fn(action)
      } catch (err) {
        console.error('[preload] onPluginEnter 回调异常：', err)
      }
    })
  })
}

window.utoolsBridge = {
  /* ---- 事件 ---- */
  getLastEnterAction: () => lastEnterAction,
  onPluginEnter: (fn) => {
    enterListeners.add(fn)
    return () => enterListeners.delete(fn)
  },

  /* ---- 文件 ---- */
  readFile(filePath) {
    const buf = fs.readFileSync(filePath)
    return { name: path.basename(filePath), bytes: new Uint8Array(buf) }
  },
  statPath(filePath) {
    try {
      const st = fs.statSync(filePath)
      return { exists: true, size: st.size, isDirectory: st.isDirectory(), mtime: st.mtime.toISOString() }
    } catch (err) {
      return { exists: false, size: null, isDirectory: false, mtime: '' }
    }
  },
  getPath(name) {
    try {
      return api.getPath(name)
    } catch (err) {
      return os.homedir()
    }
  },
  /**
   * 写文件。showSaveDialog 在不同平台上可能返回"文件路径"也可能返回"目录"，
   * 所以这里见到目录就自动拼上文件名，避免直接往目录上写。
   */
  writeFile(target, bytes, suggestedName) {
    let dest = target
    if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
      dest = path.join(dest, suggestedName || 'received.bin')
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, Buffer.from(bytes))
    return dest
  },
  showSaveDialog(options) {
    try {
      return api.showSaveDialog(options)
    } catch (err) {
      return undefined
    }
  },

  /* ---- 窗口 ---- */
  openSenderWindow,
  openScanWindow,
  closeSenderWindow() {
    closeWindow(codeWindow)
  },
  displays,
  readBinary,
  readVendorWasm,

  /* ---- 环境 ---- */
  isDev() {
    return Boolean(api && api.isDev && api.isDev())
  },
  platform: process.platform,
  versions: { node: process.versions.node, electron: process.versions.electron || '' }
}
