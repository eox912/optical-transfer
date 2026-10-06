#!/usr/bin/env node
/**
 * integrate.mjs —— 把 RaptorQ WASM 能力接进三个插件（幂等，可重复跑）
 *
 *   node shared/sync-core.mjs    # 先把 core/ 与 vendor/ 同步过去
 *   node shared/integrate.mjs    # 再补 HTML 脚本顺序与 preload 桥
 *
 * 做两件事：
 *  1. 在每个用到 core/codecs.js 的 HTML 里，把
 *     <script src="vendor/raptorq.core.js"></script> 插到第一个 core/ 脚本之前。
 *  2. 在每个 preload.js 末尾注入 readBinary：把相对路径按 __dirname（插件根目录）
 *     解析后用 fs 读字节。
 *
 * 为什么第 2 条是必须的：如果 uTools 以 file:// 加载页面，Chromium 会拒绝
 * `fetch()` 这个 scheme，wasm 就取不到；preload 里的 fs.readFileSync 是唯一稳的路子。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const PLUGINS = ['airscan-qr', 'decimen-optical-transfer', 'raptorqr']

/**
 * 方案一按设计不带 WASM 核（保持"纯 HTML/JS 零依赖 + 单文件自包含"的身份），
 * 代价是收不了真 RaptorQ 流——但它会如实拒绝。所以这里完全跳过它。
 */
const WASM_OPTIONAL_PLUGINS = new Set(['airscan-qr'])

/**
 * 只给**接收端页面**补 `vendor/raptorq.core.js`：
 * 真 RaptorQ 流只有 RaptorQ 解码器能解，所以接收端必须有；而发送端页面
 * 可以只用 LT / 顺序分片（方案二就是有意这么设计的，不要替它改主意）。
 */
function needsRaptorScript(relPath) {
  return /receiver/i.test(path.basename(relPath))
}

const READ_BINARY_SNIPPET = `
/* -------------------------------------------------------------------------- */
/* 由 shared/integrate.mjs 注入：把 wasm 读取能力挂到 preload 桥上              */
/*                                                                            */
/* 为什么需要它：uTools 若以 file:// 加载页面，Chromium 会拒绝 fetch 该 scheme， */
/* 所以 vendor/raptorq.core.wasm 必须由 preload 用 fs 读成字节再交给页面。       */
/* 相对路径按 __dirname（插件根目录）解析，因为 preload 的工作目录不保证是插件根。 */
/* -------------------------------------------------------------------------- */
;(function attachReadBinary() {
  var fs = require('fs')
  var path = require('path')
  var bridge = typeof window !== 'undefined' ? window.utoolsBridge : null
  if (!bridge || typeof bridge.readBinary === 'function') return
  bridge.readBinary = function (relativePath) {
    var target = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(__dirname, relativePath)
    return new Uint8Array(fs.readFileSync(target))
  }
})()
`

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'test') continue
      walk(full, out, depth + 1)
    } else if (e.isFile()) {
      out.push(full)
    }
  }
  return out
}

const changes = []

for (const name of PLUGINS) {
  const pluginDir = path.join(root, name)
  if (!fs.existsSync(pluginDir)) continue
  if (WASM_OPTIONAL_PLUGINS.has(name)) continue
  const files = walk(pluginDir)

  /* ---------- 1. HTML：给接收端页面插入 raptorq.core.js ---------- */
  for (const file of files.filter((f) => f.endsWith('.html'))) {
    if (!needsRaptorScript(file)) continue
    let html = fs.readFileSync(file, 'utf8')
    if (html.indexOf('core/codecs.js') < 0) continue
    if (html.indexOf('vendor/raptorq.core.js') >= 0) continue

    // 找到第一个 <script src="...core/..."> 那一行，照着它的缩进插在前面
    const lines = html.split('\n')
    const at = lines.findIndex((l) => /<script[^>]+src=["'][^"']*core\//.test(l))
    if (at < 0) {
      changes.push(`跳过 ${path.relative(root, file)}：找不到 core/ 脚本行`)
      continue
    }
    const indent = (lines[at].match(/^\s*/) || [''])[0]
    lines.splice(at, 0, `${indent}<script src="vendor/raptorq.core.js"></script>`)
    fs.writeFileSync(file, lines.join('\n'))
    changes.push(`HTML 插入 raptorq.core.js：${path.relative(root, file)}`)
  }

  /* ---------- 2. preload：注入 readBinary（任意一个 preload 有就行）---------- */
  const preloads = files.filter((f) => /preload.*\.js$/.test(path.basename(f)))
  const alreadyHas = preloads.some((f) => fs.readFileSync(f, 'utf8').indexOf('readBinary') >= 0)
  if (!alreadyHas) {
    const main = preloads.find((f) => fs.readFileSync(f, 'utf8').indexOf('utoolsBridge') >= 0)
    if (main) {
      const src = fs.readFileSync(main, 'utf8')
      fs.writeFileSync(main, src.replace(/\s*$/, '\n') + READ_BINARY_SNIPPET)
      changes.push(`preload 注入 readBinary：${path.relative(root, main)}`)
    } else {
      changes.push(`注意 ${name}：没有找到可注入的 preload（需要手工补 readBinary）`)
    }
  }
}

if (changes.length === 0) {
  console.log('无需改动：RaptorQ 能力已经接好了')
} else {
  for (const c of changes) console.log('  · ' + c)
  console.log(`\n共 ${changes.length} 处改动`)
}
