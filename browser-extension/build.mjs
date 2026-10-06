#!/usr/bin/env node
/**
 * build.mjs —— 组装 browser-extension/dist/（"加载已解压的扩展程序"就选这个目录）
 *
 *   node build.mjs
 *
 * 四个来源：
 *   1. **界面**（index.html / app.css / app.js）来自 `../android-app/src/` ——
 *      与安卓版、桌面版**逐字节同一份**，一个字都不改。
 *   2. **扩展层**（native.js / background.js）来自本目录 `src/`，
 *      再加上根目录的 `manifest.json`。
 *   3. **核心**（core/ + vendor/）来自 `../shared/` —— 与三个 uTools 插件、
 *      安卓 App、桌面版是**逐字节同一份**，协议绝不允许漂移。
 *   4. **图标**来自 `../airscan-qr/logo.png`（256×256，与 uTools 插件同一张），
 *      有 `sips`（macOS）就真缩放成 16/32/48/128，没有就退回复制原图。
 *
 * dist/ 是生成物（.gitignore 里已排除），改源码后重跑本脚本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const sharedDir = path.join(root, 'shared')
const androidSrc = path.join(root, 'android-app', 'src')
const logoPng = path.join(root, 'airscan-qr', 'logo.png')
const srcDir = path.join(here, 'src')
const distDir = path.join(here, 'dist')

const UI_FILES = ['index.html', 'app.css', 'app.js']
const EXT_FILES = ['native.js', 'background.js']
const CORE_FILES = ['protocol.js', 'fountain.js', 'qr.js', 'scan.js', 'codecs.js']
const VENDOR_FILES = ['qrcode-generator.js', 'jsQR.js', 'raptorq.core.js', 'raptorq.core.wasm']
const ICON_SIZES = [16, 32, 48, 128]
const MANIFEST = 'manifest.json'

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  return fs.statSync(to).size
}

fs.rmSync(distDir, { recursive: true, force: true })

let count = 0
let bytes = 0
const add = (from, to) => {
  bytes += copy(from, to)
  count++
}

// 1. 共用界面
for (const f of UI_FILES) add(path.join(androidSrc, f), path.join(distDir, f))
// 2. 扩展层
for (const f of EXT_FILES) add(path.join(srcDir, f), path.join(distDir, f))
add(path.join(here, MANIFEST), path.join(distDir, MANIFEST))
// 3. 共享核心
for (const f of CORE_FILES) add(path.join(sharedDir, 'core', f), path.join(distDir, 'core', f))
for (const f of VENDOR_FILES) add(path.join(sharedDir, 'vendor', f), path.join(distDir, 'vendor', f))

// 4. 图标
let resized = 0
for (const size of ICON_SIZES) {
  const out = path.join(distDir, 'icons', `icon${size}.png`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  let ok = false
  try {
    execFileSync('sips', ['-Z', String(size), logoPng, '--out', out], { stdio: 'ignore' })
    ok = fs.existsSync(out) && fs.statSync(out).size > 0
  } catch (err) {
    ok = false
  }
  if (!ok) fs.copyFileSync(logoPng, out) // 退路：直接给 256px 原图，浏览器会自己缩
  else resized++
  count++
  bytes += fs.statSync(out).size
}

// ---- 自检 ----
console.log('\n=== 组装 browser-extension/dist/ ===')
let bad = 0
const bad_ = (msg) => {
  console.error('  ✗ ' + msg)
  bad++
}

const same = (a, b, label) => {
  if (Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) !== 0) bad_(label + ' 不一致')
}
for (const f of CORE_FILES) same(path.join(sharedDir, 'core', f), path.join(distDir, 'core', f), 'core/' + f)
for (const f of VENDOR_FILES) same(path.join(sharedDir, 'vendor', f), path.join(distDir, 'vendor', f), 'vendor/' + f)
for (const f of UI_FILES) same(path.join(androidSrc, f), path.join(distDir, f), 'ui/' + f)

// manifest ↔ 文件系统一致性：manifest 里写错路径，Chrome 加载时会直接报错
let manifest = null
try {
  manifest = JSON.parse(fs.readFileSync(path.join(distDir, MANIFEST), 'utf8'))
} catch (err) {
  bad_('manifest.json 解析失败：' + ((err && err.message) || err))
}

if (manifest) {
  const refs = []
  if (manifest.background && manifest.background.service_worker) refs.push(manifest.background.service_worker)
  for (const size of Object.keys(manifest.icons || {})) refs.push(manifest.icons[size])
  const action = manifest.action || {}
  for (const size of Object.keys(action.default_icon || {})) refs.push(action.default_icon[size])
  for (const rel of refs) {
    if (!fs.existsSync(path.join(distDir, rel))) bad_('manifest 引用了不存在的文件：' + rel)
  }
  if (action.default_popup) {
    // 这条是隐藏契约：写了 default_popup，background.js 里的 action.onClicked 就永不触发
    bad_('manifest 里有 action.default_popup，background.js 的 action.onClicked 将永远不会触发')
  }
  if (manifest.manifest_version !== 3) bad_('manifest_version 必须是 3')
  const wasm = fs.existsSync(path.join(distDir, 'vendor', 'raptorq.core.wasm'))
  if (!wasm) bad_('缺 vendor/raptorq.core.wasm')
  const csp = (manifest.content_security_policy || {}).extension_pages || ''
  if (csp.indexOf('wasm-unsafe-eval') < 0) bad_('CSP 里缺 wasm-unsafe-eval，RaptorQ 的 wasm 会被拦')
}

console.log(`  文件数   : ${count}`)
console.log(`  总体积   : ${(bytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`  界面     : ${UI_FILES.length} 个（与 android-app/src 逐字节一致，三端共用一份 UI）`)
console.log(`  扩展层   : ${EXT_FILES.length} 个 + manifest.json`)
console.log(`  共享核心 : core ${CORE_FILES.length} + vendor ${VENDOR_FILES.length}（与 shared/ 逐字节一致）`)
console.log(`  图标     : ${ICON_SIZES.join('/')}（${resized > 0 ? resized + ' 个由 sips 缩放' : '本机无 sips，用 256px 原图代填'}）`)
console.log(`  自检     : ${bad === 0 ? '通过' : bad + ' 个问题'}`)
console.log('\n下一步：')
console.log('  Chrome/Edge → chrome://extensions → 打开"开发者模式" → "加载已解压的扩展程序" → 选 dist/')
console.log('  也可以打包成 .crx/.zip 分发：chrome://extensions → "打包扩展程序"\n')

if (bad) process.exitCode = 1
