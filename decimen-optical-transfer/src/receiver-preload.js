/**
 * receiver-preload.js —— 摄像头接收窗的预加载脚本
 *
 * 【边收边落盘】的关键在这里：
 *   openSink 预先把目标文件按 totalBytes 长度开好，之后每解出一块就用
 *   writeAt(offset, bytes) 随机写进去，所以内存里永远只有"正在解的那一块"，
 *   不会把整个文件堆在内存里。文件句柄一直开着，收完 closeSink。
 *
 * SHA-256 校验也在这里做：createReadStream + createHash 流式摘要，
 * 64MB 文件也只占 1MB 缓冲区（WebCrypto 的 digest 是一次性的，会要一整块内存）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { ipcRenderer } = require('electron')

const api = typeof utools !== 'undefined' ? utools : null

let lastPayload = null
const startListeners = new Set()
let sinkFd = null
let sinkPath = null

ipcRenderer.on('otp:start', (event, payload) => {
  lastPayload = payload || {}
  startListeners.forEach((fn) => {
    try {
      fn(lastPayload)
    } catch (err) {
      console.error('[receiver-preload] onStart 回调异常：', err)
    }
  })
  try {
    window.dispatchEvent(new CustomEvent('otp:start', { detail: lastPayload }))
  } catch (err) {
    /* 忽略 */
  }
})

function getPath(name) {
  try {
    if (api && typeof api.getPath === 'function') return api.getPath(name)
  } catch (err) {
    /* 落到 os 回退 */
  }
  return name === 'temp' ? os.tmpdir() : os.homedir()
}

/** 接收临时文件路径：落在 temp 目录，校验通过后才搬到用户选的位置 */
function tempPathFor(name, sessionId) {
  const safe = String(name || 'receive.bin')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 120)
  const dir = path.join(getPath('temp'), 'dot-receive')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 's' + (sessionId >>> 0).toString(16) + '-' + safe)
}

function closeSink() {
  if (sinkFd == null) return null
  try {
    fs.closeSync(sinkFd)
  } catch (err) {
    console.error('[receiver-preload] close 失败：', err)
  }
  const done = sinkPath
  sinkFd = null
  sinkPath = null
  return done
}

/** 打开落盘目标：立刻按总长度建好文件，后续随机位置写 */
function openSink(filePath, totalBytes) {
  closeSink()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const fd = fs.openSync(filePath, 'w+')
  if (totalBytes > 0) fs.ftruncateSync(fd, totalBytes)
  sinkFd = fd
  sinkPath = filePath
  return filePath
}

function writeAt(offset, bytes) {
  if (sinkFd == null) throw new Error('落盘目标未打开')
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let written = 0
  while (written < buffer.length) {
    written += fs.writeSync(sinkFd, buffer, written, buffer.length - written, offset + written)
  }
  return written
}

/** 一次性写入（顺序分片等"攒齐再写"的路径用） */
function writeAll(bytes) {
  if (sinkFd == null) throw new Error('落盘目标未打开')
  fs.ftruncateSync(sinkFd, 0)
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let written = 0
  while (written < buffer.length) {
    written += fs.writeSync(sinkFd, buffer, written, buffer.length - written, written)
  }
  return written
}

/** 流式 SHA-256：内存占用与文件大小无关 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 校验通过后把临时文件搬到用户选的位置（同卷 rename，跨卷退化为 copy+unlink） */
function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  } catch (err) {
    fs.copyFileSync(from, to)
    fs.unlinkSync(from)
  }
  return to
}

function deleteFile(filePath) {
  try {
    fs.unlinkSync(filePath)
  } catch (err) {
    /* 文件可能已经不在了 */
  }
}

/**
 * 读插件目录内的二进制文件（RaptorQ 的 wasm）。
 * 规范第 3 节坑 4：本地协议下 MIME 多半不是 application/wasm，
 * 不能用 WebAssembly.instantiateStreaming，也不能走 CDN；
 * 正确做法就是在 preload 里 fs.readFileSync 成字节再交给 WebAssembly.instantiate。
 */
function readVendorBytes(relPath) {
  const clean = String(relPath || 'vendor/raptorq.core.wasm').replace(/^\.\//, '')
  const target = path.resolve(__dirname, clean)
  if (target.indexOf(path.resolve(__dirname)) !== 0) throw new Error('路径越界：' + relPath)
  const buf = fs.readFileSync(target)
  const out = new Uint8Array(buf.length)
  out.set(buf)
  return out
}

function readFileAsDataUrl(filePath) {
  const buf = fs.readFileSync(filePath)
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase()
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[ext] || 'image/png'
  return 'data:' + mime + ';base64,' + buf.toString('base64')
}

window.utoolsBridge = {
  getStartPayload: () => lastPayload,
  onStart(fn) {
    startListeners.add(fn)
    return () => startListeners.delete(fn)
  },
  getPath,
  tempPathFor,
  openSink,
  writeAt,
  writeAll,
  closeSink,
  sha256File,
  moveFile,
  deleteFile,
  readFileAsDataUrl,
  readVendorBytes,
  showSaveDialog(options) {
    if (api && typeof api.showSaveDialog === 'function') return api.showSaveDialog(options)
    return undefined
  },
  showOpenDialog(options) {
    if (api && typeof api.showOpenDialog === 'function') return api.showOpenDialog(options)
    return undefined
  },
  showNotification(body) {
    try {
      api.showNotification(body)
    } catch (err) {
      /* 忽略 */
    }
  },
  /** utools.screenCapture 的回调式 API 包成 Promise（摄像头不可用时的降级通道） */
  screenCapture() {
    return new Promise((resolve, reject) => {
      if (!api || typeof api.screenCapture !== 'function') {
        reject(new Error('当前 uTools 版本不支持 screenCapture'))
        return
      }
      try {
        api.screenCapture((image) => resolve(image))
      } catch (err) {
        reject(err)
      }
    })
  },
  close() {
    try {
      api.sendToParent('otp:close-receiver')
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
  }
}
