/**
 * index.js —— 插件页面逻辑
 *
 * 页面里可以直接使用 uTools 注入的 `utools` API；
 * 需要 Node 能力（读写文件、读取目录）时，走 preload.js 暴露的
 * `window.utoolsBridge.services`。
 *
 * 所有界面都从 handleEnter() 分发：根据 action.code / action.type
 * 决定渲染哪一个视图，新增功能时照着往下加即可。
 */
;(function () {
  'use strict'

  const api = typeof utools !== 'undefined' ? utools : null
  const bridge = window.utoolsBridge || null
  const services = (bridge && bridge.services) || {}

  const panel = document.getElementById('panel')
  const heroSub = document.getElementById('hero-sub')
  const envBadge = document.getElementById('env-badge')
  const toastEl = document.getElementById('toast')

  let toastTimer = null
  /** 最近一次文件匹配的结果，用于从「读取文件夹」返回 */
  let lastMatchedFiles = []
  /** 防止同一次进入被渲染两次 */
  let handledAction = null

  /* ====================================================================== */
  /*                              通用小工具                                 */
  /* ====================================================================== */

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = String(text)
    return node
  }

  function button(label, onClick, variant) {
    const btn = el('button', 'btn' + (variant ? ' btn--' + variant : ''), label)
    btn.type = 'button'
    btn.addEventListener('click', onClick)
    return btn
  }

  function actionRow() {
    const row = el('div', 'actions')
    for (let i = 0; i < arguments.length; i += 1) row.appendChild(arguments[i])
    return row
  }

  function toast(message, kind) {
    if (!toastEl) return
    toastEl.textContent = message
    toastEl.className = 'toast is-visible' + (kind ? ' toast--' + kind : '')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastEl.className = 'toast'
    }, 2400)
  }

  /** 统一的异常兜底：出错时弹 toast 并返回 undefined */
  function run(label, fn) {
    try {
      return fn()
    } catch (err) {
      console.error('[' + label + ']', err)
      toast((err && err.message) || String(err), 'error')
      return undefined
    }
  }

  function copyText(text) {
    run('copyText', () => {
      if (api && api.copyText) api.copyText(text)
    })
  }

  function showNotification(body) {
    run('showNotification', () => {
      if (api && api.showNotification) api.showNotification(body)
    })
  }

  /** utools.dbStorage 读写封装（文档见 https://www.u-tools.cn/docs/developer/utools-api/db.html） */
  function dbGet(key, fallback) {
    try {
      if (api && api.dbStorage) {
        const value = api.dbStorage.getItem(key)
        return value == null ? fallback : value
      }
    } catch (err) {
      console.error('[dbStorage.getItem]', err)
    }
    return fallback
  }

  function dbSet(key, value) {
    try {
      if (api && api.dbStorage) api.dbStorage.setItem(key, value)
    } catch (err) {
      console.error('[dbStorage.setItem]', err)
    }
  }

  function platformName() {
    if (!api) return '浏览器预览'
    if (api.isMacOS && api.isMacOS()) return 'macOS'
    if (api.isWindows && api.isWindows()) return 'Windows'
    if (api.isLinux && api.isLinux()) return 'Linux'
    return '未知平台'
  }

  function isDev() {
    return Boolean(api && api.isDev && api.isDev())
  }

  function describeFrom(from) {
    return (
      {
        main: '主搜索框',
        panel: '超级面板',
        hotkey: '快捷键',
        reirect: '重定向'
      }[from] || from || '未知'
    )
  }

  function basename(filePath) {
    return String(filePath).split(/[\\/]/).pop() || String(filePath)
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || Number.isNaN(bytes)) return '—'
    if (bytes < 1024) return bytes + ' B'
    const units = ['KB', 'MB', 'GB']
    let value = bytes / 1024
    let index = 0
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024
      index += 1
    }
    return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[index]
  }

  function timestamp() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    )
  }

  function mimeOf(dataUrl) {
    const matched = /^data:([^;,]*)/.exec(String(dataUrl || ''))
    return (matched && matched[1]) || '未知'
  }

  function dataUrlBytes(dataUrl) {
    const matched = /^data:[^,]*,([\s\S]*)$/.exec(String(dataUrl || ''))
    if (!matched) return 0
    return Math.floor((matched[1].length * 3) / 4)
  }

  /** 让插件窗口高度跟随内容（最大 720） */
  function fitHeight() {
    if (!api || typeof api.setExpendHeight !== 'function') return
    const height = Math.min(720, Math.max(320, document.documentElement.scrollHeight + 8))
    run('setExpendHeight', () => api.setExpendHeight(height))
  }

  /* ====================================================================== */
  /*                               布局组件                                  */
  /* ====================================================================== */

  function card(title) {
    const root = el('section', 'card')
    const head = el('header', 'card__head')
    head.appendChild(el('h2', 'card__title', title))
    const body = el('div', 'card__body')
    root.appendChild(head)
    root.appendChild(body)
    return { root: root, body: body }
  }

  function kvList(rows) {
    const list = el('dl', 'kv')
    rows.forEach((row) => {
      list.appendChild(el('dt', 'kv__key', row[0]))
      list.appendChild(el('dd', 'kv__value', row[1] == null || row[1] === '' ? '—' : row[1]))
    })
    return list
  }

  function setPanel() {
    panel.textContent = ''
    const cards = el('div', 'cards')
    for (let i = 0; i < arguments.length; i += 1) cards.appendChild(arguments[i])
    panel.appendChild(cards)
  }

  /* ====================================================================== */
  /*                                 视图                                   */
  /* ====================================================================== */

  /** 1. 主界面：功能指令「uTools 示例」 */
  function renderHome(action) {
    heroSub.textContent = '主界面 · 运行环境与指令用法'

    const env = card('运行环境')
    env.body.appendChild(
      kvList([
        ['uTools 版本', api && api.getAppVersion ? api.getAppVersion() : '未检测到 uTools'],
        ['应用名称', api && api.getAppName ? api.getAppName() : '—'],
        ['操作系统', platformName()],
        ['调试环境', isDev() ? '是（已接入开发者工具）' : '否'],
        ['Node 版本', services.versions ? services.versions.node : '—'],
        ['当前指令', (action && action.code) || 'demo-home'],
        ['触发方式', describeFrom(action && action.from)]
      ])
    )

    const usage = card('本地数据（utools.dbStorage 演示）')
    usage.body.appendChild(
      kvList([
        ['累计进入次数', dbGet('demo-enter-count', 0)],
        ['上次进入时间', dbGet('demo-last-enter-at', '—')]
      ])
    )
    usage.body.appendChild(
      actionRow(
        button(
          '复制记录 JSON',
          () => {
            const snapshot = {
              count: dbGet('demo-enter-count', 0),
              lastEnterAt: dbGet('demo-last-enter-at', '')
            }
            copyText(JSON.stringify(snapshot, null, 2))
            toast('已复制到剪贴板')
          },
          'ghost'
        ),
        button(
          '清空记录',
          () => {
            dbSet('demo-enter-count', 0)
            dbSet('demo-last-enter-at', '')
            toast('已清空', 'success')
            renderHome(action)
          },
          'ghost'
        )
      )
    )

    const guide = card('指令速查')
    const list = el('ul', 'guide')
    ;[
      ['功能指令', '在 uTools 搜索框输入「uTools 示例」或「示例插件」回车，打开本界面。'],
      ['图片匹配', '截图或复制图片后唤出超级面板，选择「图片另存为文件」。'],
      ['文件匹配', '在文件管理器选中文件 / 文件夹后唤出超级面板，选择「查看文件信息」。'],
      ['文件夹匹配', '只选中一个文件夹时，可用「读取文件夹内容」浏览里面的文件。']
    ].forEach((item) => {
      const li = el('li', 'guide__item')
      li.appendChild(el('span', 'guide__tag', item[0]))
      li.appendChild(el('span', 'guide__desc', item[1]))
      list.appendChild(li)
    })
    guide.body.appendChild(list)

    const next = card('接下来改哪里')
    next.body.appendChild(
      kvList([
        ['plugin.json', 'features[].code 是功能编码，features[].cmds 是搜索关键词 / 匹配规则。'],
        ['index.js', 'handleEnter() 按 code / type 分发视图，新增功能从这里加分支。'],
        ['preload.js', '需要 Node 能力时在这里写方法，通过 utoolsBridge.services 暴露给页面。'],
        ['logo.png', '插件图标（256×256），替换成自己的图标即可。']
      ])
    )

    setPanel(env.root, usage.root, guide.root, next.root)
    fitHeight()
  }

  /** 2. 图片匹配：预览 + 另存为文件 */
  function renderImage(dataUrl) {
    heroSub.textContent = '图片匹配指令 · 预览并另存为文件'

    const view = card('匹配到的图片')
    const preview = el('img', 'preview')
    preview.src = dataUrl
    preview.alt = '匹配到的图片'
    view.body.appendChild(preview)
    view.body.appendChild(
      kvList([
        ['数据格式', mimeOf(dataUrl)],
        ['数据体积', formatBytes(dataUrlBytes(dataUrl))],
        ['默认保存目录', services.getPath ? services.getPath('pictures') : '—']
      ])
    )

    const savedSlot = el('div', 'saved')
    view.body.appendChild(
      actionRow(
        button('另存为文件', () => saveImage(dataUrl, savedSlot), 'primary'),
        button(
          '复制 Base64',
          () => {
            copyText(dataUrl)
            toast('已复制 Base64 数据')
          },
          'ghost'
        )
      )
    )
    view.body.appendChild(savedSlot)

    const tip = card('说明')
    tip.body.appendChild(
      el('p', 'hint', '图片匹配指令的 payload 就是 dataURL，preload.js 里的 saveDataUrlToFile() 会把它解码后写入图片目录，重名时自动加序号。')
    )

    setPanel(view.root, tip.root)
    fitHeight()
  }

  function saveImage(dataUrl, slot) {
    const dir = services.getPath ? services.getPath('pictures') : undefined
    const filePath = run('saveDataUrlToFile', () =>
      services.saveDataUrlToFile(dataUrl, dir, 'utools-image-' + timestamp())
    )
    if (!filePath) return

    toast('已保存：' + filePath, 'success')
    showNotification('图片已保存到 ' + filePath)

    if (slot) {
      slot.textContent = ''
      slot.appendChild(el('p', 'saved__path', filePath))
      slot.appendChild(
        actionRow(
          button('打开文件', () => run('shellOpenPath', () => api.shellOpenPath(filePath))),
          button(
            '在文件夹中显示',
            () => run('shellShowItemInFolder', () => api.shellShowItemInFolder(filePath)),
            'ghost'
          )
        )
      )
    }
    fitHeight()
  }

  /** 3. 文件匹配：信息 / 复制路径 / 打开 / 读取文件夹 */
  function renderFiles(payload) {
    const raw = Array.isArray(payload) ? payload : payload ? [payload] : []
    lastMatchedFiles = raw

    if (!raw.length) {
      heroSub.textContent = '文件匹配指令 · 没有拿到文件数据'
      const empty = card('没有拿到文件数据')
      empty.body.appendChild(el('p', 'hint', '请重新在文件管理器选中文件（夹）后再试一次。'))
      setPanel(empty.root)
      fitHeight()
      return
    }

    heroSub.textContent = '文件匹配指令 · 共 ' + raw.length + ' 项'

    const view = card('匹配到 ' + raw.length + ' 个文件 / 文件夹')
    const list = el('ul', 'file-list')
    raw.forEach((item) => list.appendChild(fileRow(normalize(item))))
    view.body.appendChild(list)

    setPanel(view.root)
    fitHeight()
  }

  function normalize(item) {
    const info = run('describe', () => services.describe(item))
    if (info) return info
    const filePath = typeof item === 'string' ? item : String((item && item.path) || '')
    return { path: filePath, name: basename(filePath), isDirectory: false, exists: false, size: null, mtime: '', ext: '' }
  }

  function fileRow(item) {
    const li = el('li', 'file-row')

    const icon = el('img', 'file-row__icon')
    icon.src = item.icon || 'logo.png'
    icon.alt = ''

    const meta = el('div', 'file-row__meta')
    meta.appendChild(el('div', 'file-row__name', item.name || basename(item.path)))
    meta.appendChild(el('div', 'file-row__path', item.path))

    const chips = [item.isDirectory ? '文件夹' : item.ext ? item.ext.toUpperCase() + ' 文件' : '文件']
    if (typeof item.size === 'number') chips.push(formatBytes(item.size))
    if (item.mtime) chips.push('修改于 ' + item.mtime)
    if (item.exists === false) chips.push('路径已不存在')
    meta.appendChild(el('div', 'file-row__sub', chips.join(' · ')))

    const actions = el('div', 'file-row__actions')
    actions.appendChild(
      button(
        '复制路径',
        () => {
          copyText(item.path)
          toast('已复制路径')
        },
        'ghost'
      )
    )
    actions.appendChild(
      button('打开', () => run('shellOpenPath', () => api.shellOpenPath(item.path)), 'ghost')
    )
    actions.appendChild(
      button(
        '定位',
        () => run('shellShowItemInFolder', () => api.shellShowItemInFolder(item.path)),
        'ghost'
      )
    )
    if (item.isDirectory) {
      actions.appendChild(button('读取', () => renderDirectory(item.path), 'ghost'))
    }

    li.appendChild(icon)
    li.appendChild(meta)
    li.appendChild(actions)
    return li
  }

  /** 4. 读取文件夹（Node fs.readdirSync 演示） */
  function renderDirectory(dirPath) {
    const result = run('readDir', () => services.readDir(dirPath))
    if (!result) return

    heroSub.textContent = '读取文件夹 · ' + dirPath

    const back = actionRow(
      button('← 返回文件列表', () => renderFiles(lastMatchedFiles), 'ghost'),
      button('复制文件夹路径', () => {
        copyText(dirPath)
        toast('已复制路径')
      }, 'ghost')
    )

    const view = card(
      '文件夹内容（显示 ' + result.list.length + ' / 共 ' + result.total + ' 项）'
    )
    view.body.appendChild(back)

    const list = el('ul', 'file-list')
    if (result.list.length === 0) {
      list.appendChild(el('li', 'file-row file-row--empty', '空文件夹'))
    } else {
      result.list.forEach((child) => list.appendChild(fileRow(child)))
    }
    view.body.appendChild(list)

    setPanel(view.root)
    fitHeight()
  }

  /** 5. 其它匹配（文本 / 正则 / 窗口）：给出占位视图 */
  function renderFallback(action) {
    heroSub.textContent = '未处理的指令 · ' + ((action && action.code) || '未知')

    const view = card('这个指令还没有写界面')
    view.body.appendChild(
      kvList([
        ['code', (action && action.code) || '—'],
        ['type', (action && action.type) || '—'],
        ['from', describeFrom(action && action.from)],
        [
          'payload',
          action && typeof action.payload === 'string'
            ? action.payload
            : JSON.stringify(action && action.payload)
        ]
      ])
    )
    view.body.appendChild(el('p', 'hint', '在 index.js 的 handleEnter() 里为这个 code 增加分支即可。'))

    setPanel(view.root)
    fitHeight()
  }

  /* ====================================================================== */
  /*                              事件分发                                   */
  /* ====================================================================== */

  function handleEnter(action) {
    // preload 的 getLastEnterAction() 与回调可能拿到同一个对象，去重
    if (action && action === handledAction) return
    handledAction = action

    const code = (action && action.code) || 'demo-home'
    const type = (action && action.type) || 'text'

    // 统计进入次数，顺便演示 utools.dbStorage
    if (code === 'demo-home') {
      dbSet('demo-enter-count', (Number(dbGet('demo-enter-count', 0)) || 0) + 1)
      dbSet('demo-last-enter-at', new Date().toLocaleString())
    }

    if (type === 'img' && typeof action.payload === 'string') return renderImage(action.payload)
    if (type === 'file' || type === 'files') return renderFiles(action.payload)
    if (type === 'text' || type === 'regex' || type === 'over') return renderHome(action)
    return renderFallback(action)
  }

  function boot() {
    if (envBadge) envBadge.textContent = isDev() ? 'DEV' : api ? 'PROD' : 'WEB'

    // 先注册回调，再补一次「页面加载前已触发」的进入事件
    if (bridge && typeof bridge.onPluginEnter === 'function') bridge.onPluginEnter(handleEnter)

    const lastAction = bridge && bridge.getLastEnterAction ? bridge.getLastEnterAction() : null
    if (lastAction) handleEnter(lastAction)
    else renderHome(null)
  }

  boot()
})()
