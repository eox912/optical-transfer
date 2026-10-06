#!/usr/bin/env node
/**
 * sync-core.mjs —— 把 shared/ 里的共享核心同步到每个插件目录
 *
 * 三个插件必须携带**完全一致**的 core/ 与 vendor/，这是它们能互相收发
 * （raptorqr 发、airscan-qr 收）的前提。手抄迟早会漂移，所以用脚本推。
 *
 *   node shared/sync-core.mjs          # 同步
 *   node shared/sync-core.mjs --check   # 只检查是否一致，不一致就退出码 1
 *
 * 不写死插件目录结构（有的扁平、有的是 src → dist），而是扫描整个工作区里
 * 所有已存在的 core/protocol.js，就地更新它们旁边的文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const checkOnly = process.argv.includes('--check')

const CORE_FILES = ['protocol.js', 'fountain.js', 'qr.js', 'scan.js', 'codecs.js']
const VENDOR_FILES = ['qrcode-generator.js', 'jsQR.js', 'raptorq.core.js', 'raptorq.core.wasm']

/**
 * 方案一按设计**不携带** RaptorQ 的 WASM 核：它的身份是"纯 HTML/JS、零依赖、
 * 单文件可自包含"，塞 241KB wasm 会破坏这个身份。代价是收不了真 RaptorQ 流，
 * 但它会如实拒绝而不是硬解出垃圾。所以这里不要把 wasm 推给它。
 */
const WASM_OPTIONAL_PLUGINS = new Set(['airscan-qr'])

function walk(dir, visit, depth = 0) {
  if (depth > 4) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    visit(full)
    walk(full, visit, depth + 1)
  }
}

/** 找出所有作为插件落点的目录对：{ coreDir, vendorDir } */
function findTargets() {
  const targets = []
  walk(root, (dir) => {
    if (path.basename(dir) !== 'core') return
    // shared/core 是源头本身，不是落点
    if (path.resolve(dir) === path.resolve(here, 'core')) return
    const protocolPath = path.join(dir, 'protocol.js')
    if (!fs.existsSync(protocolPath)) return
    targets.push({ coreDir: dir, vendorDir: path.join(path.dirname(dir), 'vendor') })
  })
  return targets
}

const STATUSES = { same: '一致', updated: '已更新', missing: '缺失', created: '新建' }

function syncOne(target, srcDir, files, label) {
  const out = []
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true })
  }
  for (const name of files) {
    const src = path.join(srcDir, name)
    const dst = path.join(target, name)
    if (!fs.existsSync(src)) {
      out.push({ name, label, status: STATUSES.missing })
      continue
    }
    const srcBuf = fs.readFileSync(src)
    const exists = fs.existsSync(dst)
    const same = exists && Buffer.compare(srcBuf, fs.readFileSync(dst)) === 0
    if (same) {
      out.push({ name, label, status: STATUSES.same })
      continue
    }
    if (checkOnly) {
      out.push({ name, label, status: exists ? STATUSES.updated : STATUSES.created })
      continue
    }
    fs.copyFileSync(src, dst)
    if (name.endsWith('.js')) fs.chmodSync(dst, 0o644)
    out.push({ name, label, status: exists ? STATUSES.updated : STATUSES.created })
  }
  return out
}

const targets = findTargets()
if (targets.length === 0) {
  console.log('没有找到任何插件里的 core/ 目录——插件还没建好？')
  process.exit(checkOnly ? 1 : 0)
}

console.log(`${checkOnly ? '检查' : '同步'}共享核心 → ${targets.length} 个落点\n`)

let drifted = 0
for (const target of targets) {
  const relative = path.relative(root, target.coreDir)
  const plugin = relative.split(path.sep)[0]
  const vendorFiles = WASM_OPTIONAL_PLUGINS.has(plugin)
    ? VENDOR_FILES.filter((f) => f.indexOf('raptorq.') !== 0)
    : VENDOR_FILES
  const results = [
    ...syncOne(target.coreDir, path.join(here, 'core'), CORE_FILES, 'core'),
    ...syncOne(target.vendorDir, path.join(here, 'vendor'), vendorFiles, 'vendor')
  ]
  const bad = results.filter((r) => r.status === STATUSES.updated || r.status === STATUSES.created || r.status === STATUSES.missing)
  drifted += bad.length
  const mark = bad.length === 0 ? '✓' : checkOnly ? '✗' : '→'
  console.log(`${mark} ${plugin}/${relative.split(path.sep).slice(1).join('/') || '.'}  (${results.length} 个文件)`)
  for (const r of bad) {
    console.log(`      ${r.label}/${r.name}  ${r.status}`)
  }
}

console.log('')
if (checkOnly) {
  if (drifted) {
    console.log(`❌ 有 ${drifted} 个文件与 shared/ 不一致——三个插件必须携带同一份核心`)
    process.exit(1)
  }
  console.log('✅ 所有插件的 core/ 与 vendor/ 都与 shared/ 一致')
} else {
  console.log(drifted ? `已同步 ${drifted} 个文件` : '全部已是最新，无需改动')
}
