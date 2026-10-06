#!/usr/bin/env node
/**
 * build.mjs —— raptorqr 的零依赖构建
 *
 *   node build.mjs
 *
 * 做四件事，全部只用 Node 内置能力（不装任何 npm 包）：
 *   1. src/**.ts  → 用 node:module 的 stripTypeScriptTypes 剥掉类型 → dist/**.js
 *      （只剥类型，不做代码转换：所以源码里不能用 enum / namespace /
 *        构造函数参数属性这类"需要代码生成"的语法）
 *   2. src/ 下的静态资源（html / css / js / json / png）原样拷进 dist/
 *   3. core/ 与 vendor/（从 shared/ 原样复制的共享核心）拷进 dist/
 *   4. 构建期自检：CSP、引用文件是否存在、plugin.json 是否合法
 *
 * dist/ 就是最终交给 uTools 的插件目录。
 */
import { stripTypeScriptTypes } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// stripTypeScriptTypes 在 Node 22/24 上会打 ExperimentalWarning，构建日志里没必要出现
const originalEmitWarning = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || ''
  if (text.indexOf('stripTypeScriptTypes') >= 0) return
  return originalEmitWarning.call(process, warning, ...rest)
}

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(ROOT, 'src')
const DIST = path.join(ROOT, 'dist')
/** 共享核心：本地留一份给测试用，同时必须随插件一起发布 */
const SHARED_DIRS = ['core', 'vendor']

const problems = []
const copied = []
const compiled = []

/* -------------------------------------------------------------------------- */
/*                                  工具                                       */
/* -------------------------------------------------------------------------- */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function rimraf(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
}

function listFiles(dir, base) {
  const root = base || dir
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, root))
    else out.push(path.relative(root, full))
  }
  return out
}

/** 把 `from './x.ts'` 之类的说明符改成 .js（当前源码没用到 import，留作保险） */
function rewriteTsSpecifiers(code) {
  return code
    .replace(/(\bfrom\s*['"])([^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(\bimport\s*\(\s*['"])([^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(\bimport\s+['"])([^'"]+)\.ts(['"])/g, '$1$2.js$3')
}

function compileTs(source) {
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' })
  return rewriteTsSpecifiers(stripped)
}

/* -------------------------------------------------------------------------- */
/*                                1. 清空 dist                                 */
/* -------------------------------------------------------------------------- */

rimraf(DIST)
ensureDir(DIST)

/* -------------------------------------------------------------------------- */
/*                              2. 编译 / 拷贝 src                             */
/* -------------------------------------------------------------------------- */

for (const rel of listFiles(SRC)) {
  const from = path.join(SRC, rel)
  const ext = path.extname(rel)

  if (ext === '.ts') {
    // .d.ts 只放类型声明，不产出文件
    if (rel.endsWith('.d.ts')) continue
    const to = path.join(DIST, rel.slice(0, -3) + '.js')
    ensureDir(path.dirname(to))
    fs.writeFileSync(to, compileTs(fs.readFileSync(from, 'utf8')))
    compiled.push(path.relative(ROOT, to))
    continue
  }

  const to = path.join(DIST, rel)
  ensureDir(path.dirname(to))
  fs.copyFileSync(from, to)
  copied.push(path.relative(ROOT, to))
}

/* -------------------------------------------------------------------------- */
/*                          3. 拷贝共享核心 core/ vendor/                       */
/* -------------------------------------------------------------------------- */

for (const dir of SHARED_DIRS) {
  const from = path.join(ROOT, dir)
  if (!fs.existsSync(from)) {
    problems.push(`缺少共享核心目录 ${dir}/（应从 ../shared/ 原样复制）`)
    continue
  }
  for (const rel of listFiles(from)) {
    const to = path.join(DIST, dir, rel)
    ensureDir(path.dirname(to))
    fs.copyFileSync(path.join(from, rel), to)
    copied.push(path.relative(ROOT, to))
  }
}

/* -------------------------------------------------------------------------- */
/*                                 4. 自检                                     */
/* -------------------------------------------------------------------------- */

const htmlFiles = listFiles(DIST).filter((f) => f.endsWith('.html'))

for (const rel of htmlFiles) {
  const html = fs.readFileSync(path.join(DIST, rel), 'utf8')

  // 坑 #1：uTools 以本地协议加载页面，origin 是 opaque 的，CSP 会把脚本拦掉
  if (/content-security-policy/i.test(html)) {
    problems.push(`${rel} 里有 CSP meta —— uTools 本地协议下会白屏，必须删掉`)
  }

  // 清单第 1 条：html 里引用的文件必须存在
  const refs = []
  const re = /(?:src|href)\s*=\s*"([^"]+)"/g
  let m
  while ((m = re.exec(html))) {
    const target = m[1]
    if (/^(https?:|data:|#|mailto:)/i.test(target)) continue
    refs.push(target)
  }
  for (const ref of refs) {
    const resolved = path.join(DIST, ref)
    if (!fs.existsSync(resolved)) problems.push(`${rel} 引用了不存在的文件：${ref}`)
  }
}

const pluginJsonPath = path.join(DIST, 'plugin.json')
if (!fs.existsSync(pluginJsonPath)) {
  problems.push('dist/plugin.json 不存在')
} else {
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'))
  } catch (err) {
    problems.push('plugin.json 不是合法 JSON：' + err.message)
  }
  if (parsed) {
    for (const field of ['main', 'logo']) {
      if (!parsed[field]) problems.push(`plugin.json 缺少必填字段 ${field}`)
      else if (!fs.existsSync(path.join(DIST, parsed[field]))) {
        problems.push(`plugin.json 的 ${field}=${parsed[field]} 在 dist 里不存在`)
      }
    }
    if (parsed.main && !parsed.main.endsWith('.html')) problems.push('plugin.json 的 main 必须是 .html')
    if (parsed.preload && !fs.existsSync(path.join(DIST, parsed.preload))) {
      problems.push(`plugin.json 的 preload=${parsed.preload} 不存在`)
    }
    const features = parsed.features || []
    if (!features.length) problems.push('plugin.json 至少要有一个 feature')
    const codes = features.map((f) => f.code)
    if (new Set(codes).size !== codes.length) problems.push('plugin.json 的 features[].code 有重复：' + codes.join(','))
    for (const f of features) {
      if (!f.code) problems.push('存在没有 code 的 feature')
      if (!Array.isArray(f.cmds) || !f.cmds.length) problems.push(`feature ${f.code} 的 cmds 为空`)
    }
  }
}

// 坑 #8：发布目录里不能有源码管理目录 / sourcemap / node_modules
for (const rel of listFiles(DIST)) {
  if (rel.endsWith('.js.map') || rel.endsWith('.css.map')) problems.push(`dist 里有 sourcemap：${rel}`)
  if (rel.split(path.sep).includes('node_modules')) problems.push(`dist 里有 node_modules：${rel}`)
}

/* -------------------------------------------------------------------------- */
/*                                  报告                                       */
/* -------------------------------------------------------------------------- */

console.log(`raptorqr 构建完成 → dist/`)
console.log(`  编译 TS   : ${compiled.length} 个（${compiled.map((p) => path.basename(p)).join(', ')}）`)
console.log(`  拷贝资源  : ${copied.length} 个`)

if (problems.length) {
  console.error('\n构建自检未通过：')
  for (const p of problems) console.error('  ✗ ' + p)
  process.exit(1)
}
console.log('  自检      : 通过（无 CSP / 引用完整 / plugin.json 合法 / 无 sourcemap）')
