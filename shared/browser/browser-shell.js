/**
 * browser-shell.js —— 纯浏览器运行时的"外壳"：补上 uTools 提供的那部分交互
 *
 * 只在**面板页**（index.browser.html）加载，且必须排在页面脚本之后
 * （页面要在启动时先注册好 onPluginEnter，外壳才开始派发事件）。
 *
 * 它做三件事：
 *  1. 右上角一个小浮动条：选文件发送 / 打开接收窗口 / 拖放提示。
 *     —— 关键作用：方案一的面板**没有** showOpenDialog（它的文件来自 uTools 的
 *     "匹配文件"指令），没有这个条就完全没法在浏览器里选文件。
 *  2. 整页拖放：把文件拖到页面任意位置即可发送。
 *  3. 接管提示（toast）与发送进度，让替身层有地方显示状态。
 *
 * 同样整份包在 IIFE 里，不产生顶层词法声明（classic script 全局重名会白屏）。
 */
;(function () {
  'use strict'

  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (!window.utoolsBridge || !window.utoolsBridge.__pickFiles) return
  if (window.__OTP_SHELL_INSTALLED__) return
  window.__OTP_SHELL_INSTALLED__ = true

  var bridge = window.utoolsBridge
  var bar = null
  var toastEl = null
  var toastTimer = null
  var progressEl = null

  function ensureStyle() {
    if (document.getElementById('otp-shell-style')) return
    var style = document.createElement('style')
    style.id = 'otp-shell-style'
    style.textContent = [
      '#otp-shell-bar{position:fixed;top:10px;right:12px;z-index:2147482000;display:flex;gap:8px;align-items:center;',
      'padding:7px 10px;border-radius:10px;background:rgba(20,22,28,.92);color:#e7e9ec;',
      'font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;',
      'box-shadow:0 2px 10px rgba(0,0,0,.35);backdrop-filter:blur(6px)}',
      '#otp-shell-bar button{cursor:pointer;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08);',
      'color:inherit;font:inherit;padding:5px 10px;border-radius:7px}',
      '#otp-shell-bar button:hover{background:rgba(255,255,255,.18)}',
      '#otp-shell-bar .otp-tag{opacity:.72;padding-right:2px}',
      '#otp-shell-toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,10px);z-index:2147482001;',
      'max-width:78vw;padding:9px 15px;border-radius:999px;background:#1f2328;color:#fff;font-size:12px;',
      'opacity:0;transition:opacity .18s ease,transform .18s ease;pointer-events:none;word-break:break-all}',
      '#otp-shell-toast.is-on{opacity:1;transform:translate(-50%,0)}',
      '#otp-shell-toast.is-err{background:#f04438}',
      '#otp-shell-toast.is-ok{background:#12b76a}',
      '#otp-shell-progress{position:fixed;top:52px;right:12px;z-index:2147482000;padding:6px 10px;border-radius:8px;',
      'background:rgba(20,22,28,.92);color:#9fd0ff;font:12px/1.4 ui-monospace,Menlo,monospace;display:none}',
      '#otp-shell-drop{position:fixed;inset:0;z-index:2147482500;display:none;align-items:center;justify-content:center;',
      'background:rgba(10,12,18,.72);color:#fff;font:600 18px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}',
      '#otp-shell-drop.is-on{display:flex}'
    ].join('')
    document.head.appendChild(style)
  }

  function toast(message, kind) {
    ensureStyle()
    if (!toastEl) {
      toastEl = document.createElement('div')
      toastEl.id = 'otp-shell-toast'
      document.body.appendChild(toastEl)
    }
    toastEl.textContent = message
    toastEl.className = 'is-on' + (kind ? ' is-' + kind : '')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      toastEl.className = ''
    }, 2600)
  }

  function setProgress(text) {
    ensureStyle()
    if (!progressEl) {
      progressEl = document.createElement('div')
      progressEl.id = 'otp-shell-progress'
      document.body.appendChild(progressEl)
    }
    if (!text) {
      progressEl.style.display = 'none'
      return
    }
    progressEl.style.display = 'block'
    progressEl.textContent = text
  }

  window.__OTP_SHELL_TOAST__ = toast

  window.__OTP_SHELL_PROGRESS__ = function (channel, data) {
    if (!data || typeof data !== 'object') return
    var parts = []
    if (data.sent != null || data.frame != null) parts.push('帧 ' + (data.sent != null ? data.sent : data.frame))
    if (data.fps != null) parts.push(data.fps.toFixed ? data.fps.toFixed(1) + ' fps' : data.fps + ' fps')
    if (data.progress != null) parts.push(Math.round(data.progress * 100) + '%')
    if (data.symbols != null) parts.push(data.symbols + ' 符号')
    if (parts.length) setProgress(parts.join(' · '))
  }

  function makeButton(label, title, onClick) {
    var b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    if (title) b.title = title
    b.addEventListener('click', onClick)
    return b
  }

  function buildBar() {
    ensureStyle()
    if (bar) return
    bar = document.createElement('div')
    bar.id = 'otp-shell-bar'

    var tag = document.createElement('span')
    tag.className = 'otp-tag'
    tag.textContent = '浏览器模式'
    tag.title = '在纯浏览器里运行（未接入 uTools）。文件走内存，保存走下载。'
    bar.appendChild(tag)

    bar.appendChild(
      makeButton('选择文件发送', '选文件后按本插件的"匹配文件"指令进入', function () {
        bridge.__pickFiles(false)
      })
    )

    if (bridge.__featureCodes && bridge.__featureCodes.receive) {
      bar.appendChild(
        makeButton('打开接收窗口', '在同一页里用 iframe 打开接收端（需要摄像头权限）', function () {
          bridge.openScanWindow({})
        })
      )
    }

    bar.appendChild(
      makeButton('收起', '隐藏这个浮动条（拖放仍然可用）', function () {
        bar.style.display = 'none'
      })
    )

    document.body.appendChild(bar)
  }

  function installDropZone() {
    ensureStyle()
    var mask = document.createElement('div')
    mask.id = 'otp-shell-drop'
    mask.textContent = '松手即发送'
    document.body.appendChild(mask)
    var depth = 0

    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return
      e.preventDefault()
      depth++
      mask.classList.add('is-on')
    })
    window.addEventListener('dragover', function (e) {
      if (e.dataTransfer) e.preventDefault()
    })
    window.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1)
      if (depth === 0) mask.classList.remove('is-on')
    })
    window.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files
      if (!files || !files.length) return
      e.preventDefault()
      depth = 0
      mask.classList.remove('is-on')
      bridge.__sendFiles(files)
    })
  }

  function boot() {
    buildBar()
    installDropZone()
    toast('浏览器模式：拖放文件到页面即可发送，或点右上角「选择文件发送」', 'ok')
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
