#!/usr/bin/env node
/**
 * build.mjs —— 把 App 源码 + 共享核心组装进 www/（Capacitor 的 web 资产目录）
 *
 *   node build.mjs
 *
 * 为什么要有这一步：`core/` 与 `vendor/` 是**三个 uTools 插件和这个 App 共用的同一份**，
 * 必须从 `../shared/` 拷过来，而不是各自维护一份副本——否则协议一漂移，
 * 手机和电脑之间就互不兼容了。
 *
 * www/ 是生成物，不要手改；改源码后重跑本脚本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const sharedDir = path.resolve(here, '..', 'shared')
const srcDir = path.join(here, 'src')
const wwwDir = path.join(here, 'www')

const CORE_FILES = ['protocol.js', 'fountain.js', 'qr.js', 'scan.js', 'codecs.js']
const VENDOR_FILES = ['qrcode-generator.js', 'jsQR.js', 'raptorq.core.js', 'raptorq.core.wasm']

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  return fs.statSync(to).size
}

function listFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) listFiles(full, out)
    else out.push(full)
  }
  return out
}

fs.rmSync(wwwDir, { recursive: true, force: true })

let count = 0
let bytes = 0

// 1. App 源码
for (const f of listFiles(srcDir)) {
  const rel = path.relative(srcDir, f)
  bytes += copyFile(f, path.join(wwwDir, rel))
  count++
}

// 2. 共享核心（与三个 uTools 插件逐字节同一份）
for (const f of CORE_FILES) {
  bytes += copyFile(path.join(sharedDir, 'core', f), path.join(wwwDir, 'core', f))
  count++
}
for (const f of VENDOR_FILES) {
  bytes += copyFile(path.join(sharedDir, 'vendor', f), path.join(wwwDir, 'vendor', f))
  count++
}

// 3. 自检：核心必须与 shared 逐字节一致（防止有人手改了 www/）
let mismatched = 0
for (const [dir, files] of [
  ['core', CORE_FILES],
  ['vendor', VENDOR_FILES]
]) {
  for (const f of files) {
    const a = fs.readFileSync(path.join(sharedDir, dir, f))
    const b = fs.readFileSync(path.join(wwwDir, dir, f))
    if (Buffer.compare(a, b) !== 0) {
      console.error(`  ✗ ${dir}/${f} 与 shared/ 不一致`)
      mismatched++
    }
  }
}

console.log(`\n=== 组装 www/ ===`)
console.log(`  文件数   : ${count}`)
console.log(`  总体积   : ${(bytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`  共享核心 : core ${CORE_FILES.length} 个 + vendor ${VENDOR_FILES.length} 个（与 shared/ 逐字节一致）`)
console.log(`  自检     : ${mismatched === 0 ? '通过' : mismatched + ' 个文件不一致'}`)
console.log(`\n下一步： npx cap sync android && cd android && ./gradlew assembleDebug\n`)

if (mismatched) process.exit(1)
