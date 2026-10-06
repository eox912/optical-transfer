/**
 * util.ts —— 运行时工具（无 DOM 依赖）
 *
 * 所有模块都挂在 window.DOT 命名空间上（classic script，不用 ESM）。
 * 见 build.mjs 顶部注释：uTools 本地协议下模块脚本有被 CORS 拦掉的风险。
 */
                                                  

                                                    
                                                   
                                                            
                                                            
 (function () {
  'use strict'

  const G      = typeof globalThis !== 'undefined' ? globalThis : {}

  function root()      {
    return G
  }

  /** 取共享核心（vendor + core 五个脚本必须先加载） */
  function core()          {
    const otp = G.OTP
    if (!otp || !otp.protocol || !otp.codecs || !otp.qr) {
      throw new Error('共享核心未加载：请先引入 vendor/*.js 与 core/*.js（codecs.js 最后）')
    }
    return otp           
  }

  function formatBytes(n        )         {
    try {
      return core().protocol.formatBytes(n)
    } catch (err) {
      if (n == null || isNaN(n)) return '—'
      if (n < 1024) return n + ' B'
      const units = ['KB', 'MB', 'GB']
      let value = n / 1024
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index++
      }
      return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[index]
    }
  }

  function formatRate(bytesPerSec        )         {
    if (!isFinite(bytesPerSec) || bytesPerSec <= 0) return '—'
    return formatBytes(bytesPerSec) + '/s'
  }

  function formatDuration(seconds        )         {
    if (seconds == null || !isFinite(seconds) || seconds < 0) return '—'
    const total = Math.round(seconds)
    if (total < 60) return total + ' 秒'
    const minutes = Math.floor(total / 60)
    if (minutes < 60) return minutes + ' 分 ' + (total % 60) + ' 秒'
    return Math.floor(minutes / 60) + ' 时 ' + (minutes % 60) + ' 分'
  }

  function now()         {
    return Date.now()
  }

  G.DOT = G.DOT || {}
  ;(G.DOT       ).util = {
    root,
    core,
    formatBytes,
    formatRate,
    formatDuration,
    now
  }                  
})()
