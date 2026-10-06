#!/usr/bin/env node
/**
 * decimen-optical-transfer / build.mjs
 *
 * 【零依赖构建】只用 Node 内置能力，不引入 esbuild / vite / typescript，
 * 不需要 npm install。Node ≥ 22.13 的 module.stripTypeScriptTypes 负责剥类型。
 *
 * 流程：
 *   1. 清空 dist/
 *   2. src/**\/*.ts  → 改写 import 说明符 .ts→.js → stripTypeScriptTypes → dist/**\/*.js
 *   3. src/ 下的其它静态资源（html / css / js / png / json）原样 copy 到 dist/
 *   4. ../shared/core/*.js 与 ../shared/vendor/*.js 原样 copy 到 dist/core/ 与 dist/vendor/
 *   5. logo.png 取自 ../demo-utools-plugin/logo.png（缺失时回退 src/logo.png）
 *   6. 构建期自检（规范第 7 节）：JSON 合法性、feature code 唯一、引用文件存在、
 *      没有 CSP meta、没有残留的运行时 import/export、没有 .map / node_modules / .git
 *
 * 注意（规范第 3 节坑 5）：产物必须是 classic script（非 ESM）。
 * uTools 以本地协议加载页面，模块脚本在 opaque origin 下有被 CORS 拦掉的风险，
 * 所以本插件所有源码一律不写运行时 import/export，只用 import type（会被完全擦除）。
 * 构建末尾会强制校验这一点，一旦残留就直接失败。
 */
import { stripTypeScriptTypes } from 'node:module'
import fs from 'node:fs'
import nodeCrypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* Node 会对 stripTypeScriptTypes 打 ExperimentalWarning，构建日志里不需要 */
const originalEmitWarning = process.emitWarning.bind(process)
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || ''
  if (text.includes('stripTypeScriptTypes')) return
  return originalEmitWarning(warning, ...rest)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, 'src')
const DIST = path.join(HERE, 'dist')
const SHARED_CORE = path.join(HERE, '..', 'shared', 'core')
const SHARED_VENDOR = path.join(HERE, '..', 'shared', 'vendor')
const DEMO_LOGO = path.join(HERE, '..', 'demo-utools-plugin', 'logo.png')
const FALLBACK_LOGO = path.join(SRC, 'logo.png')

/** 只匹配相对路径的 import 说明符，顺带把 .ts 改成 .js */
const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g
/** 运行时 import/export：classic script 里出现就是致命错误 */
const RUNTIME_MODULE_RE = /^[ \t]*(?:import\s|export\s|export\{|import\{)/m

const report = { ts: [], empty: [], copied: [], bytes: 0 }

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

function walk(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, base))
    else out.push(path.relative(base, full))
  }
  return out.sort()
}

function writeFileDeep(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  report.bytes += Buffer.byteLength(content)
}

function buildTypeScript(rel) {
  const source = fs.readFileSync(path.join(SRC, rel), 'utf8')
  // 先改说明符，再剥类型：这样 import type 的 .ts 也已经变成 .js（虽然随后会被整行擦除）
  const rewritten = source.replace(SPECIFIER_RE, (m, head, quote, spec) => `${head}${quote}${spec}.js${quote}`)
  let stripped
  try {
    stripped = stripTypeScriptTypes(rewritten, { mode: 'strip' })
  } catch (err) {
    throw new Error(
      `剥类型失败：src/${rel}\n  ${err && err.message ? err.message : String(err)}\n` +
        '  提示：strip 模式不支持 enum / namespace / 构造函数参数属性，请改写。'
    )
  }
  if (RUNTIME_MODULE_RE.test(stripped)) {
    throw new Error(
      `src/${rel} 里残留了运行时 import/export。\n` +
        '  产物必须是 classic script（非 ESM），值级别的跨文件引用请走 window.DOT 命名空间，' +
        '类型引用请用 `import type`（会被完全擦除）。'
    )
  }
  const outRel = rel.replace(/\.ts$/, '.js')
  /* 纯类型文件剥完只剩注释与空白，不必产出（也没有任何页面引用它） */
  const meaningful = stripped
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .trim()
  if (!meaningful) {
    report.empty.push(outRel)
    return
  }
  writeFileDeep(path.join(DIST, outRel), stripped)
  report.ts.push(outRel)
}

/** 把 sourceFullPath 复制到 dist/<relTarget>（relTarget 用 / 分隔的相对路径） */
function copyFileTo(relTarget, sourceFullPath) {
  const target = path.join(DIST, relTarget)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(sourceFullPath, target)
  report.bytes += fs.statSync(target).size
  report.copied.push(relTarget)
}

/* ------------------------------------------------------------------ */
/*                                 构建                                */
/* ------------------------------------------------------------------ */

rmrf(DIST)
fs.mkdirSync(DIST, { recursive: true })

for (const rel of walk(SRC)) {
  if (rel.endsWith('.ts')) buildTypeScript(rel)
  else copyFileTo(rel, path.join(SRC, rel))
}

/* core/ 与 vendor/ 原样从 ../shared 复制，绝不修改。
   vendor 现在有 4 个文件：qrcode-generator.js / jsQR.js 给所有页面用，
   raptorq.core.js + raptorq.core.wasm 只被接收窗加载（发送端不加载 WASM）。 */
for (const rel of walk(SHARED_CORE)) copyFileTo(path.join('core', rel), path.join(SHARED_CORE, rel))
for (const rel of walk(SHARED_VENDOR)) copyFileTo(path.join('vendor', rel), path.join(SHARED_VENDOR, rel))

const logoSource = fs.existsSync(DEMO_LOGO) ? DEMO_LOGO : FALLBACK_LOGO
if (!fs.existsSync(logoSource)) throw new Error('找不到 logo.png：' + logoSource)
fs.copyFileSync(logoSource, path.join(DIST, 'logo.png'))
report.bytes += fs.statSync(path.join(DIST, 'logo.png')).size
report.copied.push('logo.png')

/* ------------------------------------------------------------------ */
/*                              构建期自检                              */
/* ------------------------------------------------------------------ */

const problems = []

function checkPluginJson() {
  const file = path.join(DIST, 'plugin.json')
  if (!fs.existsSync(file)) return problems.push('dist/plugin.json 不存在')
  let pj
  try {
    pj = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return problems.push('plugin.json 不是合法 JSON：' + err.message)
  }
  for (const key of ['main', 'logo']) {
    if (!pj[key]) problems.push(`plugin.json 缺少必填字段 ${key}`)
    else if (!fs.existsSync(path.join(DIST, pj[key]))) problems.push(`plugin.json 的 ${key} 指向的文件不存在：${pj[key]}`)
  }
  if (pj.preload && !fs.existsSync(path.join(DIST, pj.preload))) {
    problems.push('plugin.json 的 preload 指向的文件不存在：' + pj.preload)
  }
  const features = Array.isArray(pj.features) ? pj.features : []
  if (!features.length) problems.push('plugin.json 的 features 为空')
  const codes = features.map((f) => f.code)
  if (new Set(codes).size !== codes.length) problems.push('plugin.json 的 features[].code 有重复')
  for (const f of features) {
    if (!f.code) problems.push('存在没有 code 的 feature')
    if (!Array.isArray(f.cmds) || !f.cmds.length) problems.push(`feature ${f.code} 没有 cmds`)
  }
}

function checkHtml() {
  for (const rel of walk(DIST)) {
    if (!rel.endsWith('.html')) continue
    const html = fs.readFileSync(path.join(DIST, rel), 'utf8')
    if (/http-equiv\s*=\s*["']?Content-Security-Policy/i.test(html)) {
      problems.push(`${rel} 里有 CSP meta（规范第 3 节坑 1：会白屏）`)
    }
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = m[1]
      if (/^(https?:|data:|#|mailto:)/.test(ref)) continue
      if (ref.startsWith('..')) {
        problems.push(`${rel} 引用了插件目录之外的文件：${ref}`)
        continue
      }
      if (!fs.existsSync(path.join(DIST, ref))) problems.push(`${rel} 引用的文件不存在：${ref}`)
    }
  }
}

function checkClean() {
  for (const rel of walk(DIST)) {
    if (rel.endsWith('.map')) problems.push('产物里不该有 sourcemap：' + rel)
    if (rel.startsWith('node_modules') || rel.startsWith('.git')) problems.push('产物里不该有：' + rel)
  }
  // 被 import 的脚本必须真的存在（例如 core/codecs.js 依赖 protocol.js / fountain.js）
  const entryFiles = walk(DIST).filter((r) => r.endsWith('.js'))
  for (const rel of entryFiles) {
    const code = fs.readFileSync(path.join(DIST, rel), 'utf8')
    for (const m of code.matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g)) {
      const resolved = path.join(path.dirname(path.join(DIST, rel)), m[2])
      if (!fs.existsSync(resolved) && !fs.existsSync(resolved + '.js')) {
        problems.push(`${rel} require 的模块不存在：${m[2]}`)
      }
    }
  }
}

checkPluginJson()
checkHtml()
checkClean()

/* ------------------------------------------------------------------ */
/*                                 汇总                                */
/* ------------------------------------------------------------------ */

const distFiles = walk(DIST)
console.log('decimen-optical-transfer · 零依赖构建（module.stripTypeScriptTypes）')
console.log('  TS  →  ' + report.ts.length + ' 个：' + report.ts.join(', '))
if (report.empty.length) console.log('  纯类型文件（未产出）：' + report.empty.join(', '))
console.log('  静态资源：' + report.copied.length + ' 个')
/* 共享核心指纹：三个插件必须打同一份 core/vendor，父 agent 可据此核对协议互通 */
const fingerprints = walk(path.join(DIST, 'core')).map(
  (rel) =>
    rel +
    '=' +
    nodeCrypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(DIST, 'core', rel)))
      .digest('hex')
      .slice(0, 8)
)
console.log('  共享核心指纹：' + fingerprints.join(' '))
console.log('  dist 共 ' + distFiles.length + ' 个文件，' + (report.bytes / 1024).toFixed(1) + ' KB')

if (problems.length) {
  console.error('\n构建自检失败：')
  for (const p of problems) console.error('  ✗ ' + p)
  process.exit(1)
}
console.log('  自检：plugin.json / 引用文件 / 无 CSP meta / 无残留 import 全部通过')
