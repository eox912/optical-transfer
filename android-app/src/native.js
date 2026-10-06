/**
 * native.js —— 安卓原生能力封装（Capacitor 插件 + WebView 能力）
 *
 * 这一层只做 App 真正需要、而浏览器给不了的事：
 *   1. **屏幕常亮 + 满亮度**（发送端的关键：息屏或自动降亮度会直接中断光学传输）
 *   2. **保存文件**（写进 Documents 并调起系统分享，让用户自己决定放哪）
 *   3. 全屏（沉浸式）
 *
 * 摄像头不走这里：`getUserMedia` 在安卓 WebView 里可用（需要宿主授予 CAMERA 权限，
 * 见 android/app/src/main/AndroidManifest.xml 与 MainActivity）。
 *
 * 所有原生调用都做了**可用性降级**：在浏览器里打开时不会报错，只是能力变弱。
 * 这样同一份代码既能跑在 App 里，也能用 `python3 -m http.server` 在电脑上调试。
 */
;(function () {
  'use strict'

  var plugged = null

  function cap() {
    return window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins : null
  }

  function isNative() {
    return Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  }

  function plugin(name) {
    var p = cap()
    return p && p[name] ? p[name] : null
  }

  /* ------------------------------------------------------------------ */
  /*                        屏幕常亮 + 亮度                              */
  /* ------------------------------------------------------------------ */

  var savedBrightness = null

  /**
   * 进入"发送态"：屏幕常亮 + 亮度拉满。
   * 为什么必须做：手机默认 30 秒息屏、自动亮度还会随环境变暗，
   * 而光学传输要求屏幕**持续以稳定高亮度**显示二维码。
   */
  function keepAwake(on) {
    var result = { keepAwake: false, brightness: false, errors: [] }

    var ka = plugin('KeepAwake')
    if (ka && typeof ka.keepAwake === 'function') {
      try {
        var p = on ? ka.keepAwake() : ka.allowSleep()
        if (p && p.catch) {
          p.then(function () {
            result.keepAwake = true
          }).catch(function (err) {
            result.errors.push('KeepAwake: ' + ((err && err.message) || err))
          })
        } else {
          result.keepAwake = true
        }
      } catch (err) {
        result.errors.push('KeepAwake: ' + ((err && err.message) || err))
      }
    } else {
      result.errors.push('当前环境没有 KeepAwake 插件（浏览器里正常）')
    }

    var sb = plugin('ScreenBrightness')
    if (sb) {
      try {
        if (on) {
          if (savedBrightness == null && typeof sb.getBrightness === 'function') {
            var g = sb.getBrightness()
            if (g && g.then) {
              g.then(function (r) {
                savedBrightness = r && typeof r.brightness === 'number' ? r.brightness : null
              }).catch(function () {})
            }
          }
          var s = sb.setBrightness({ brightness: 1 })
          if (s && s.then) {
            s.then(function () {
              result.brightness = true
            }).catch(function (err) {
              result.errors.push('Brightness: ' + ((err && err.message) || err))
            })
          } else {
            result.brightness = true
          }
        } else if (savedBrightness != null && typeof sb.setBrightness === 'function') {
          sb.setBrightness({ brightness: savedBrightness })
        }
      } catch (err) {
        result.errors.push('Brightness: ' + ((err && err.message) || err))
      }
    } else {
      result.errors.push('当前环境没有 ScreenBrightness 插件（浏览器里正常）')
    }

    return result
  }

  /* ------------------------------------------------------------------ */
  /*                              文件选择                               */
  /* ------------------------------------------------------------------ */

  /** 用 <input type=file>；安卓 WebView 会直接调起系统文件选择器，不需要任何插件 */
  function pickFile(accept) {
    return new Promise(function (resolve) {
      var input = document.createElement('input')
      input.type = 'file'
      if (accept) input.accept = accept
      input.style.cssText = 'position:fixed;left:-9999px;top:0'
      document.body.appendChild(input)
      input.addEventListener('change', function () {
        var f = input.files && input.files[0]
        document.body.removeChild(input)
        if (!f) return resolve(null)
        var reader = f.arrayBuffer
          ? f.arrayBuffer().then(function (b) {
              return new Uint8Array(b)
            })
          : new Promise(function (res) {
              var fr = new FileReader()
              fr.onload = function () {
                res(new Uint8Array(fr.result))
              }
              fr.readAsArrayBuffer(f)
            })
        reader.then(function (bytes) {
          resolve({ name: f.name, bytes: bytes, size: bytes.length })
        })
      })
      input.click()
    })
  }

  /* ------------------------------------------------------------------ */
  /*                              保存文件                               */
  /* ------------------------------------------------------------------ */

  function toBase64(bytes) {
    var CHUNK = 0x8000
    var out = ''
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
    }
    return btoa(out)
  }

  /**
   * 保存接收到的文件。
   *
   * 策略：先写进 App 的 Documents 目录（不需要任何存储权限），
   * 再调起系统"分享/保存到"面板让用户自己决定最终位置。
   * 这比直接写公共 Downloads 稳（Android 10+ 的分区存储限制多）。
   */
  function saveFile(name, bytes) {
    var fsPlugin = plugin('Filesystem')
    var share = plugin('Share')

    if (!fsPlugin || typeof fsPlugin.writeFile !== 'function') {
      // 浏览器降级：直接触发下载
      var blob = new Blob([bytes])
      var url = URL.createObjectURL(blob)
      var a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      setTimeout(function () {
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }, 4000)
      return Promise.resolve({ saved: false, uri: name, mode: 'browser-download' })
    }

    return fsPlugin
      .writeFile({
        path: name,
        data: toBase64(bytes),
        directory: 'DOCUMENTS',
        recursive: true
      })
      .then(function (res) {
        var uri = res && res.uri ? res.uri : name
        if (share && typeof share.share === 'function') {
          return share
            .share({ title: name, url: uri, dialogTitle: '保存或分享 ' + name })
            .then(function () {
              return { saved: true, uri: uri, mode: 'documents+share' }
            })
            .catch(function () {
              // 用户取消了分享，但文件已经写进 Documents 了
              return { saved: true, uri: uri, mode: 'documents' }
            })
        }
        return { saved: true, uri: uri, mode: 'documents' }
      })
  }

  /* ------------------------------------------------------------------ */
  /*                                全屏                                 */
  /* ------------------------------------------------------------------ */

  function enterFullscreen() {
    var el = document.documentElement
    var fn = el.requestFullscreen || el.webkitRequestFullscreen
    if (!fn) return Promise.resolve(false)
    try {
      var p = fn.call(el)
      return p && p.then ? p.then(function () {
        return true
      }).catch(function () {
        return false
      }) : Promise.resolve(true)
    } catch (err) {
      return Promise.resolve(false)
    }
  }

  function exitFullscreen() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen
    if (!fn) return Promise.resolve(false)
    try {
      var p = fn.call(document)
      return p && p.then ? p.then(function () {
        return true
      }).catch(function () {
        return false
      }) : Promise.resolve(true)
    } catch (err) {
      return Promise.resolve(false)
    }
  }

  /* ------------------------------------------------------------------ */
  /*                              自检信息                               */
  /* ------------------------------------------------------------------ */

  function envInfo() {
    var p = cap() || {}
    return {
      native: isNative(),
      platform: (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'web',
      plugins: {
        KeepAwake: Boolean(p.KeepAwake),
        ScreenBrightness: Boolean(p.ScreenBrightness),
        Filesystem: Boolean(p.Filesystem),
        Share: Boolean(p.Share)
      },
      secureContext: Boolean(window.isSecureContext),
      hasCamera: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    }
  }

  window.Native = {
    isNative: isNative,
    keepAwake: keepAwake,
    pickFile: pickFile,
    saveFile: saveFile,
    enterFullscreen: enterFullscreen,
    exitFullscreen: exitFullscreen,
    envInfo: envInfo
  }
})()
