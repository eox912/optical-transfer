#!/usr/bin/env node
/**
 * make-browser-entries.mjs —— 为每个插件生成"纯浏览器可跑"的页面副本
 *
 *   node shared/browser/make-browser-entries.mjs
 *
 * 对每个插件里**引用了外部脚本**的 .html，生成一个同名副本
 *   index.html  → index.browser.html
 *   sender.html → sender.browser.html
 *   receiver.html → receiver.browser.html
 * 插入顺序：
 *   1. <script src="utools-shim.js">  放在第一个 core/ 脚本**之前**
 *      （替身要赶在页面脚本之前把 window.utools / window.utoolsBridge 装上）
 *   2. <script src="browser-shell.js"> 只加到 plugin.json 的 main 页，且放在**最后**
 *      （页面要先注册好 onPluginEnter，外壳才开始派发事件）
 *
 * 自包含的单文件（比如 airscan-qr 的 standalone.html：一个 <script src> 都没有）
 * 会被跳过——它本来就是浏览器直接打开就能用的，不需要替身。
 *
 * 页面源码一个字都不改，`*.browser.html` 是生成物；改了源码重跑本脚本即可。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PLUGINS = ['airscan-qr', 'decimen-optical-transfer', 'raptorqr']
const ASSETS = ['utools-shim.js', 'browser-shell.js']

function walk(dir, out = [], depth = 0) {
  if (depth > 5) return out
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
    } else if (e.isFile() && e.name.endsWith('.html') && !e.name.endsWith('.browser.html')) {
      out.push(full)
    }
  }
  return out
}

/** 找到插件里可交付的 plugin.json（插件根或 dist/）*/
function deliveryRoots(pluginDir) {
  const roots = []
  if (fs.existsSync(path.join(pluginDir, 'plugin.json'))) roots.push(pluginDir)
  for (const sub of ['dist', 'build', 'public']) {
    if (fs.existsSync(path.join(pluginDir, sub, 'plugin.json'))) roots.push(path.join(pluginDir, sub))
  }
  return roots
}

const written = []
const skipped = []

for (const name of PLUGINS) {
  const pluginDir = path.join(root, name)
  if (!fs.existsSync(pluginDir)) continue

  for (const deliveryRoot of deliveryRoots(pluginDir)) {
    const label = path.relative(root, deliveryRoot) || name

    // 1. 把替身与外壳拷进插件目录（uTools 打包时它们也会跟着走，体积很小）
    for (const asset of ASSETS) {
      const src = path.join(here, asset)
      const dst = path.join(deliveryRoot, asset)
      if (!fs.existsSync(src)) throw new Error('缺少 ' + src)
      fs.copyFileSync(src, dst)
    }

    let mainPage = 'index.html'
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(deliveryRoot, 'plugin.json'), 'utf8'))
      if (pj.main) mainPage = pj.main
    } catch (err) {
      /* 用默认值 */
    }

    for (const htmlPath of walk(deliveryRoot)) {
      const base = path.basename(htmlPath)
      const html = fs.readFileSync(htmlPath, 'utf8')
      const scriptSrcs = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1])

      if (scriptSrcs.length === 0) {
        skipped.push(`${label}/${base}（自包含单文件，无需替身）`)
        continue
      }
      if (scriptSrcs.some((s) => s.indexOf('utools-shim.js') >= 0)) {
        skipped.push(`${label}/${base}（已经是替身版本）`)
        continue
      }

      const lines = html.split('\n')

      // 2. 替身插到第一个 core/ 脚本之前；没有 core/ 就插到第一个 script 之前
      let at = lines.findIndex((l) => /<script[^>]+src=["'][^"']*core\//.test(l))
      if (at < 0) at = lines.findIndex((l) => /<script[^>]+src=/.test(l))
      if (at < 0) {
        skipped.push(`${label}/${base}（找不到可插入的位置）`)
        continue
      }
      const indent = (lines[at].match(/^\s*/) || [''])[0]
      lines.splice(at, 0, `${indent}<script src="utools-shim.js"></script>`)

      // 3. main 页额外挂外壳，且必须排在页面脚本之后
      if (base === mainPage) {
        let last = -1
        for (let i = lines.length - 1; i >= 0; i--) {
          if (/<script[^>]+src=/.test(lines[i])) {
            last = i
            break
          }
        }
        const lastIndent = last >= 0 ? (lines[last].match(/^\s*/) || [''])[0] : indent
        lines.splice(last + 1, 0, `${lastIndent}<script src="browser-shell.js"></script>`)
      }

      const outName = base.replace(/\.html?$/i, '') + '.browser.html'
      const outPath = path.join(path.dirname(htmlPath), outName)
      fs.writeFileSync(outPath, lines.join('\n'))
      written.push(`${label}/${outName}`)
    }
  }
}

console.log('\n=== 生成纯浏览器入口 ===\n')
for (const w of written) console.log('  ✓ ' + w)
for (const s of skipped) console.log('  · 跳过 ' + s)
console.log(`\n共生成 ${written.length} 个浏览器入口\n`)
console.log('用法：')
console.log('  cd ' + root)
console.log('  python3 -m http.server 8000')
console.log('  # 然后浏览器打开 http://localhost:8000/<插件>/index.browser.html')
console.log('  # （方案二/三在 dist/ 下：http://localhost:8000/raptorqr/dist/index.browser.html）\n')
