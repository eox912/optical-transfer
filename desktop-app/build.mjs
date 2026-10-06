#!/usr/bin/env node
/**
 * build.mjs —— 组装 desktop-app/www/
 *
 *   node build.mjs
 *
 * 三个来源：
 *   1. **界面**（index.html / app.css / app.js）来自 `../android-app/src/` ——
 *      这三个文件是平台无关的，只依赖 `window.Native.*`，所以安卓与桌面**共用同一份 UI**。
 *   2. **原生层**（main.js / preload.js / native.js）来自本目录的 `src/`。
 *   3. **核心**（core/ + vendor/）来自 `../shared/` —— 与三个 uTools 插件、
 *      安卓 App 是**逐字节同一份**，协议绝不允许漂移。
 *
 * www/ 是生成物（electron-builder 的 files 只打包 www/），改源码后重跑本脚本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const sharedDir = path.join(root, 'shared')
const androidSrc = path.join(root, 'android-app', 'src')
const srcDir = path.join(here, 'src')
const wwwDir = path.join(here, 'www')

const UI_FILES = ['index.html', 'app.css', 'app.js']
const NATIVE_FILES = ['main.js', 'preload.js', 'native.js']
const CORE_FILES = ['protocol.js', 'fountain.js', 'qr.js', 'scan.js', 'codecs.js']
const VENDOR_FILES = ['qrcode-generator.js', 'jsQR.js', 'raptorq.core.js', 'raptorq.core.wasm']

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  return fs.statSync(to).size
}

function require_(cond, msg) {
  if (!cond) {
    console.error('  ✗ ' + msg)
    process.exitCode = 1
  }
  return cond
}

fs.rmSync(wwwDir, { recursive: true, force: true })

let count = 0
let bytes = 0
const add = (from, to) => {
  bytes += copy(from, to)
  count++
}

// 1. 共用界面
for (const f of UI_FILES) add(path.join(androidSrc, f), path.join(wwwDir, f))
// 2. 原生层
for (const f of NATIVE_FILES) add(path.join(srcDir, f), path.join(wwwDir, f))
// 3. 共享核心
for (const f of CORE_FILES) add(path.join(sharedDir, 'core', f), path.join(wwwDir, 'core', f))
for (const f of VENDOR_FILES) add(path.join(sharedDir, 'vendor', f), path.join(wwwDir, 'vendor', f))

// ---- 自检 ----
let bad = 0
const same = (a, b, label) => {
  if (Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) !== 0) {
    console.error('  ✗ ' + label + ' 不一致')
    bad++
  }
}
for (const f of CORE_FILES) same(path.join(sharedDir, 'core', f), path.join(wwwDir, 'core', f), 'core/' + f)
for (const f of VENDOR_FILES) same(path.join(sharedDir, 'vendor', f), path.join(wwwDir, 'vendor', f), 'vendor/' + f)
for (const f of UI_FILES) same(path.join(androidSrc, f), path.join(wwwDir, f), 'ui/' + f)

console.log('\n=== 组装 desktop-app/www/ ===')
console.log(`  文件数   : ${count}`)
console.log(`  总体积   : ${(bytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`  界面     : ${UI_FILES.length} 个（与 android-app/src 逐字节一致，两端共用一份 UI）`)
console.log(`  原生层   : ${NATIVE_FILES.length} 个（Electron 版）`)
console.log(`  共享核心 : core ${CORE_FILES.length} + vendor ${VENDOR_FILES.length}（与 shared/ 逐字节一致）`)
console.log(`  自检     : ${bad === 0 ? '通过' : bad + ' 个文件不一致'}`)
console.log('\n下一步：')
console.log('  npm start                 # 本地跑起来')
console.log('  npm run smoke             # 真 Electron 进程的冒烟测试')
console.log('  npm run dist:win          # 打 Windows 安装包（NSIS + 免安装版）\n')

if (bad) process.exitCode = 1
