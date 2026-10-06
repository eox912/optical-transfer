/**
 * util.ts —— 运行时工具（无 DOM 依赖）
 *
 * 所有模块都挂在 window.DOT 命名空间上（classic script，不用 ESM）。
 * 见 build.mjs 顶部注释：uTools 本地协议下模块脚本有被 CORS 拦掉的风险。
 */
import type { CoreRef, UtilApi } from './types.ts'

/* classic script 之间共享同一个全局词法作用域（同一个 <script> 作用域链），
   所以每个模块都用 IIFE 把自己的名字关起来，只通过 globalThis.DOT 对外暴露。
   这与 shared/core/*.js 的写法一致；不这样做，两个文件里的 top-level const 会直接
   抛 'Identifier has already been declared'，插件在浏览器里会整体白屏。 */
;(function () {
  'use strict'

  const G: any = typeof globalThis !== 'undefined' ? globalThis : {}

  function root(): any {
    return G
  }

  /** 取共享核心（vendor + core 五个脚本必须先加载） */
  function core(): CoreRef {
    const otp = G.OTP
    if (!otp || !otp.protocol || !otp.codecs || !otp.qr) {
      throw new Error('共享核心未加载：请先引入 vendor/*.js 与 core/*.js（codecs.js 最后）')
    }
    return otp as CoreRef
  }

  function formatBytes(n: number): string {
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

  function formatRate(bytesPerSec: number): string {
    if (!isFinite(bytesPerSec) || bytesPerSec <= 0) return '—'
    return formatBytes(bytesPerSec) + '/s'
  }

  function formatDuration(seconds: number): string {
    if (seconds == null || !isFinite(seconds) || seconds < 0) return '—'
    const total = Math.round(seconds)
    if (total < 60) return total + ' 秒'
    const minutes = Math.floor(total / 60)
    if (minutes < 60) return minutes + ' 分 ' + (total % 60) + ' 秒'
    return Math.floor(minutes / 60) + ' 时 ' + (minutes % 60) + ' 分'
  }

  function now(): number {
    return Date.now()
  }

  G.DOT = G.DOT || {}
  ;(G.DOT as any).util = {
    root,
    core,
    formatBytes,
    formatRate,
    formatDuration,
    now
  } satisfies UtilApi
})()
