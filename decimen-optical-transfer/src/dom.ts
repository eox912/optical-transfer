/**
 * dom.ts —— DOM 小工具（无框架）
 *
 * 全部在函数内部访问 document，模块加载时不碰 DOM，
 * 这样 Node 桩 DOM 测试可以先装好环境再跑脚本。
 */
import type { DomApi } from './types.ts'

/* classic script 之间共享同一个全局词法作用域（同一个 <script> 作用域链），
   所以每个模块都用 IIFE 把自己的名字关起来，只通过 globalThis.DOT 对外暴露。
   这与 shared/core/*.js 的写法一致；不这样做，两个文件里的 top-level const 会直接
   抛 'Identifier has already been declared'，插件在浏览器里会整体白屏。 */
;(function () {
  'use strict'

  const G: any = typeof globalThis !== 'undefined' ? globalThis : {}

  function root(): any {
    return typeof window !== 'undefined' ? window : G
  }

  function doc(): any {
    return G.document
  }

  function el(tag: string, className?: string, text?: string): any {
    const node = doc().createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = String(text)
    return node
  }

  function clear(node: any): void {
    if (!node) return
    node.textContent = ''
  }

  function setText(node: any, text: string): void {
    if (node) node.textContent = text == null ? '' : String(text)
  }

  function on(target: any, type: string, fn: (event: any) => void): void {
    if (target && typeof target.addEventListener === 'function') target.addEventListener(type, fn)
  }

  function byId(id: string): any {
    return doc().getElementById(id)
  }

  function button(label: string, onClick: () => void, variant?: string): any {
    const node = el('button', 'btn' + (variant ? ' btn--' + variant : ''), label)
    node.type = 'button'
    on(node, 'click', onClick)
    return node
  }

  function actions(): any {
    return el('div', 'actions')
  }

  function kvList(rows: Array<[string, string]>): any {
    const list = el('dl', 'kv')
    rows.forEach((row) => {
      list.appendChild(el('dt', 'kv__k', row[0]))
      list.appendChild(el('dd', 'kv__v', row[1] == null || row[1] === '' ? '—' : String(row[1])))
    })
    return list
  }

  let toastTimer: any = null

  function toast(message: string, kind?: string): void {
    const node = byId('toast')
    if (!node) return
    node.textContent = message
    node.className = 'toast is-visible' + (kind ? ' toast--' + kind : '')
    if (toastTimer && typeof G.clearTimeout === 'function') G.clearTimeout(toastTimer)
    if (typeof G.setTimeout === 'function') {
      toastTimer = G.setTimeout(() => {
        node.className = 'toast'
      }, 2600)
    }
  }

  /** 统一的异常兜底：出错时弹 toast、记进 state.errors，并返回 undefined */
  function guard<T>(errors: string[] | null, label: string, fn: () => T): T | undefined {
    try {
      return fn()
    } catch (err) {
      const text = err && (err as any).message ? (err as any).message : String(err)
      console.error('[' + label + ']', err)
      if (errors) errors.push(label + ': ' + text)
      toast(text, 'error')
      return undefined
    }
  }

  G.DOT = G.DOT || {}
  G.DOT.dom = {
    el,
    clear,
    button,
    kvList,
    actions,
    toast,
    setText,
    on,
    byId,
    root,
    guard
  } satisfies DomApi
})()
