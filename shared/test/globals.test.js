/**
 * globals.test.js —— classic script 的全局词法重名检查（白屏级风险）
 *
 *   node shared/test/globals.test.js
 *
 * 为什么需要这个：uTools 插件的页面用的是 classic script（不是 ES module），
 * 所有 `<script>` 共享**同一个全局词法作用域**。于是
 *
 *     a.js:  const G = ...
 *     b.js:  const G = ...
 *
 * 会让第二个脚本在**实例化阶段**就抛
 *     SyntaxError: Identifier 'G' has already been declared
 * 整个页面的 JS 从此不执行 —— 直接白屏，而单文件语法检查（node --check）
 * 完全看不出来，因为每个文件单独看都是合法的。
 *
 * 这个 bug 在本项目里真实发生过：方案二最初在 8 个 TS 模块里各写了 top-level
 * `const G` / `const DOT`，是它的测试把页面脚本跑进同一个沙箱才抓到的。
 * 方案一（无构建、扁平文件最多）风险最高，所以这里对**每个插件的每个页面**
 * 都做一遍。
 *
 * 关键技巧：顶层 let/const/class 重名属于**早期错误**，在任何代码执行之前
 * 就会抛出，所以这里只需要一个最小桩环境，不必真的能把页面跑起来——
 * 因缺少 DOM 而抛的其它错误可以安全忽略。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..', '..')
// 安卓 App 的 www/ 也是同一类页面（classic script 共享全局作用域），一并纳入检查
const PLUGINS = ['airscan-qr', 'decimen-optical-transfer', 'raptorqr', path.join('android-app', 'www')]

let pass = 0
let fail = 0

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
    } else if (e.isFile() && e.name.endsWith('.html')) {
      out.push(full)
    }
  }
  return out
}

/** 按出现顺序取出页面里的 classic script（外部 + 内联），跳过 module 与远程 */
function collectScripts(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8')
  const dir = path.dirname(htmlPath)
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi
  const out = []
  let m
  while ((m = re.exec(html))) {
    const attrs = m[1] || ''
    const body = m[2] || ''
    if (/type\s*=\s*["']?module/i.test(attrs)) continue // module 有独立作用域
    const srcMatch = /src\s*=\s*["']([^"']+)["']/i.exec(attrs)
    if (srcMatch) {
      const ref = srcMatch[1]
      if (/^(https?:|data:|javascript:)/i.test(ref)) continue
      const target = path.join(dir, ref.split('?')[0])
      if (!fs.existsSync(target)) {
        out.push({ kind: 'external', label: ref, source: null })
        continue
      }
      out.push({ kind: 'external', label: ref, source: fs.readFileSync(target, 'utf8') })
    } else if (body.trim()) {
      out.push({ kind: 'inline', label: '<inline>', source: body })
    }
  }
  return out
}

/** 在同一个上下文里依次实例化所有脚本，专门捕捉"重名"这一类早期错误 */
function findRedeclaration(scripts) {
  const sandbox = { console: { log() {}, warn() {}, error() {} } }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  sandbox.document = undefined
  sandbox.navigator = undefined
  const ctx = vm.createContext(sandbox)

  const hits = []
  for (const s of scripts) {
    if (!s.source) continue
    try {
      vm.runInContext(s.source, ctx, { filename: s.label })
    } catch (err) {
      const msg = (err && err.message) || String(err)
      if (/already been declared/i.test(msg)) {
        hits.push(`${s.label}: ${msg}`)
      }
      // 其它错误（document 未定义等）与本检查无关，忽略
    }
  }
  return hits
}

console.log('\n=== classic script 全局词法重名检查（白屏级）===\n')

for (const name of PLUGINS) {
  const pluginDir = path.join(ROOT, name)
  if (!fs.existsSync(pluginDir)) {
    console.log(`  ✗ ${name} 目录不存在`)
    fail++
    continue
  }
  const htmls = walk(pluginDir)
  if (htmls.length === 0) {
    console.log(`  ✗ ${name} 没有 html`)
    fail++
    continue
  }
  for (const htmlPath of htmls) {
    const rel = path.relative(ROOT, htmlPath)
    const scripts = collectScripts(htmlPath)
    const hits = findRedeclaration(scripts)
    const externals = scripts.filter((s) => s.kind === 'external').length
    const inlines = scripts.filter((s) => s.kind === 'inline').length
    if (hits.length === 0) {
      console.log(`  ✓ ${rel}  (${externals} 外部 + ${inlines} 内联脚本，无重名)`)
      pass++
    } else {
      console.log(`  ✗ ${rel}  (${externals} 外部 + ${inlines} 内联脚本)`)
      for (const h of hits) console.log(`      ${h}`)
      fail++
    }
  }
}

console.log(
  `\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败` +
    `\n（重名会让整个页面白屏，且 node --check 查不出来，必须在这里拦住）\n`
)
process.exitCode = fail ? 1 : 0
