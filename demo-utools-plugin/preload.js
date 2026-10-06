/**
 * preload.js —— uTools 预加载脚本
 *
 * 该脚本在窗口加载前执行，运行在独立环境中，可以直接使用：
 *   - Node.js 原生能力（fs / path / os ...）
 *   - Electron 渲染进程 API
 *   - utools 全部 API
 *
 * 注意：preload 里不要写页面 UI 逻辑。这里只做两件事：
 *   1. 接管 onPluginEnter / onPluginOut 事件，转交给页面（避免页面脚本还没加载好就错过事件）
 *   2. 把需要 Node 能力的方法挂到 window.utoolsBridge.services，供 index.js 调用
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const api = typeof utools !== 'undefined' ? utools : null

/* -------------------------------------------------------------------------- */
/*                                 路径处理                                    */
/* -------------------------------------------------------------------------- */

const PATH_FALLBACK = {
  home: () => os.homedir(),
  desktop: () => path.join(os.homedir(), 'Desktop'),
  documents: () => path.join(os.homedir(), 'Documents'),
  downloads: () => path.join(os.homedir(), 'Downloads'),
  pictures: () => path.join(os.homedir(), 'Pictures'),
  music: () => path.join(os.homedir(), 'Music'),
  videos: () => path.join(os.homedir(), 'Videos'),
  temp: () => os.tmpdir()
}

/**
 * 获取系统特殊目录，utools 不可用时回退到 Node 的默认位置
 * @param {string} name home | desktop | documents | downloads | pictures | temp ...
 */
function getPath(name) {
  try {
    if (api && typeof api.getPath === 'function') {
      const value = api.getPath(name)
      if (value) return value
    }
  } catch (err) {
    console.error('[preload] utools.getPath 调用失败：', err)
  }
  const fallback = PATH_FALLBACK[name]
  return fallback ? fallback() : os.homedir()
}

/* -------------------------------------------------------------------------- */
/*                                 文件工具                                    */
/* -------------------------------------------------------------------------- */

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/avif': 'avif'
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatTime(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  )
}

/** 若目标文件已存在，自动追加 -1、-2 ... 后缀 */
function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base}-${i}${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`)
}

/**
 * 读取路径的详细信息，失败时也不会抛错（文件可能已被移动或删除）
 * @param {string|{path:string,name?:string,isDirectory?:boolean}} target
 */
function describe(target) {
  const filePath = typeof target === 'string' ? target : String((target && target.path) || '')
  const info = {
    path: filePath,
    name: (target && target.name) || path.basename(filePath) || filePath,
    isDirectory: Boolean(target && (target.isDirectory || target.isFile === false)),
    exists: false,
    size: null,
    mtime: '',
    ext: path.extname(filePath).replace(/^\./, '').toLowerCase(),
    icon: ''
  }

  try {
    const stat = fs.statSync(filePath)
    info.exists = true
    info.isDirectory = stat.isDirectory()
    info.size = info.isDirectory ? null : stat.size
    info.mtime = formatTime(stat.mtime)
  } catch (err) {
    // 忽略：路径不存在或无权限
  }

  try {
    if (api && typeof api.getFileIcon === 'function') {
      info.icon = api.getFileIcon(info.isDirectory ? 'folder' : filePath)
    }
  } catch (err) {
    // 忽略：拿不到系统图标时页面会回退到插件 logo
  }

  return info
}

/**
 * 读取文件夹内容
 * @param {string} dirPath 文件夹绝对路径
 * @param {number} limit 最多返回多少项（默认 200）
 */
function readDir(dirPath, limit = 200) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
  const list = entries
    .slice(0, limit)
    .map((entry) =>
      describe({
        path: path.join(dirPath, entry.name),
        name: entry.name,
        isDirectory: entry.isDirectory()
      })
    )
  return { total: entries.length, list, truncated: entries.length > limit }
}

/**
 * 把 dataURL（图片匹配指令拿到的 payload 就是它）保存为本地文件
 * @param {string} dataUrl 形如 data:image/png;base64,xxxx
 * @param {string} [dir] 目标目录，默认「图片」目录
 * @param {string} [baseName] 文件名（不含扩展名）
 * @returns {string} 实际写入的绝对路径
 */
function saveDataUrlToFile(dataUrl, dir, baseName) {
  const matched = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''))
  if (!matched) throw new Error('无法解析图片数据（不是合法的 dataURL）')

  const mime = matched[1] || 'image/png'
  const isBase64 = Boolean(matched[2])
  const payload = matched[3] || ''
  const buffer = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8')

  const ext = MIME_EXT[mime.toLowerCase()] || 'png'
  const targetDir = dir || getPath('pictures')
  fs.mkdirSync(targetDir, { recursive: true })

  const filePath = uniquePath(path.join(targetDir, `${baseName || 'utools-image'}.${ext}`))
  fs.writeFileSync(filePath, buffer)
  return filePath
}

/* -------------------------------------------------------------------------- */
/*                          进入 / 退出事件的一点封装                           */
/* -------------------------------------------------------------------------- */

let lastEnterAction = null
const enterListeners = new Set()
const outListeners = new Set()

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

if (api && typeof api.onPluginOut === 'function') {
  api.onPluginOut((isKill) => {
    outListeners.forEach((fn) => {
      try {
        fn(isKill)
      } catch (err) {
        console.error('[preload] onPluginOut 回调异常：', err)
      }
    })
  })
}

window.utoolsBridge = {
  services: {
    getPath,
    describe,
    readDir,
    saveDataUrlToFile,
    uniquePath,
    platform: process.platform,
    versions: { node: process.versions.node, electron: process.versions.electron || '' }
  },
  /** 页面加载前若已经进入过插件，用它可以补一次渲染 */
  getLastEnterAction: () => lastEnterAction,
  /** 页面就绪后注册进入回调 */
  onPluginEnter: (fn) => {
    enterListeners.add(fn)
    return () => enterListeners.delete(fn)
  },
  onPluginOut: (fn) => {
    outListeners.add(fn)
    return () => outListeners.delete(fn)
  }
}
