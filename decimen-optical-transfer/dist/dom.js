/**
 * dom.ts —— DOM 小工具（无框架）
 *
 * 全部在函数内部访问 document，模块加载时不碰 DOM，
 * 这样 Node 桩 DOM 测试可以先装好环境再跑脚本。
 */
                                        

                                                    
                                                   
                                                            
                                                            
 (function () {
  'use strict'

  const G      = typeof globalThis !== 'undefined' ? globalThis : {}

  function root()      {
    return typeof window !== 'undefined' ? window : G
  }

  function doc()      {
    return G.document
  }

  function el(tag        , className         , text         )      {
    const node = doc().createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = String(text)
    return node
  }

  function clear(node     )       {
    if (!node) return
    node.textContent = ''
  }

  function setText(node     , text        )       {
    if (node) node.textContent = text == null ? '' : String(text)
  }

  function on(target     , type        , fn                      )       {
    if (target && typeof target.addEventListener === 'function') target.addEventListener(type, fn)
  }

  function byId(id        )      {
    return doc().getElementById(id)
  }

  function button(label        , onClick            , variant         )      {
    const node = el('button', 'btn' + (variant ? ' btn--' + variant : ''), label)
    node.type = 'button'
    on(node, 'click', onClick)
    return node
  }

  function actions()      {
    return el('div', 'actions')
  }

  function kvList(rows                         )      {
    const list = el('dl', 'kv')
    rows.forEach((row) => {
      list.appendChild(el('dt', 'kv__k', row[0]))
      list.appendChild(el('dd', 'kv__v', row[1] == null || row[1] === '' ? '—' : String(row[1])))
    })
    return list
  }

  let toastTimer      = null

  function toast(message        , kind         )       {
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
  function guard   (errors                 , label        , fn         )                {
    try {
      return fn()
    } catch (err) {
      const text = err && (err       ).message ? (err       ).message : String(err)
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
  }                 
})()
