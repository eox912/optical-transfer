/**
 * browser.test.js —— 纯浏览器替身层的验收测试
 *
 *   node shared/browser/browser.test.js
 *
 * 替身层最怕的错误是"某个 API 没实现"——页面在浏览器里跑到一半炸掉，
 * 而且没有 uTools、没有摄像头，很难在无头环境里端到端发现。
 * 所以这里用两招建立可信度：
 *
 *  1. **把替身真的加载进桩 DOM**，然后内省 window.utools / window.utoolsBridge
 *     的实际键，而不是用正则去猜替身实现了什么。
 *  2. **静态交叉校验**：扫出三个插件页面脚本里所有 `bridge.X` / `utools.X` 调用，
 *     逐个断言替身里有对应实现。缺一个就红。
 *
 * 另外校验生成的 *.browser.html：替身脚本必须在页面脚本之前、外壳必须在最后，
 * 且除了这两行插入之外与源页面逐字节一致（防止生成器悄悄改坏页面）。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..', '..')
const PLUGINS = ['airscan-qr', 'decimen-optical-transfer', 'raptorqr']
const SHIM = path.join(__dirname, 'utools-shim.js')

let pass = 0
let fail = 0

function check(name, fn) {
  try {
    const extra = fn()
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`)
    pass++
  } catch (err) {
    console.log(`  ✗ ${name} → ${(err && err.message) || err}`)
    fail++
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

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
      if (['vendor', 'core', 'test', 'node_modules', '.git'].indexOf(e.name) >= 0) continue
      walk(full, out, depth + 1)
    } else if (e.isFile()) {
      out.push(full)
    }
  }
  return out
}

function deliveryRoots(pluginDir) {
  const roots = []
  if (fs.existsSync(path.join(pluginDir, 'plugin.json'))) roots.push(pluginDir)
  for (const sub of ['dist', 'build']) {
    if (fs.existsSync(path.join(pluginDir, sub, 'plugin.json'))) roots.push(path.join(pluginDir, sub))
  }
  return roots
}

/* ------------------------------------------------------------------ */
/* 把替身加载进桩 DOM，拿到它真正挂上去的键                              */
/* ------------------------------------------------------------------ */

function loadShim() {
  const source = fs.readFileSync(SHIM, 'utf8')
  const noop = () => {}
  const fakeEl = {
    style: {},
    classList: { add: noop, remove: noop },
    setAttribute: noop,
    addEventListener: noop,
    appendChild: noop,
    removeChild: noop
  }
  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout,
    clearTimeout,
    Promise,
    Uint8Array,
    ArrayBuffer,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Error,
    Date,
    RegExp,
    CustomEvent: function () {},
    navigator: { platform: 'Linux', userAgent: 'node' },
    location: { protocol: 'http:', href: 'http://localhost:8000/' },
    screen: { width: 1280, height: 800, availWidth: 1280, availHeight: 800 },
    devicePixelRatio: 1,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    matchMedia: () => ({ matches: false })
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  sandbox.document = {
    readyState: 'complete',
    head: { appendChild: noop },
    body: { appendChild: noop, removeChild: noop },
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => fakeEl,
    addEventListener: noop
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'utools-shim.js' })
  return sandbox
}

/* ------------------------------------------------------------------ */
/* 扫出页面脚本实际调用的 API                                            */
/* ------------------------------------------------------------------ */

function collectCalls(deliveryRoot) {
  const bridgeNames = new Set()
  const utoolsNames = new Set()
  const files = walk(deliveryRoot).filter((f) => {
    const b = path.basename(f)
    if (!f.endsWith('.js')) return false
    if (/preload/i.test(b)) return false
    if (b === 'utools-shim.js' || b === 'browser-shell.js') return false
    if (b === 'jsQR.js' || b === 'qrcode-generator.js' || b === 'raptorq.core.js') return false
    return true
  })
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(?:bridge|utoolsBridge)\.([A-Za-z_$][\w$]*)/g)) bridgeNames.add(m[1])
    for (const m of src.matchAll(/(?:utools|api)\.([A-Za-z_$][\w$]*)/g)) utoolsNames.add(m[1])
  }
  return { bridgeNames, utoolsNames, files }
}

console.log('\n=== 1. 替身能被加载进桩 DOM 并挂上 API ===')

let shimBox = null
check('utools-shim.js 在桩 DOM 里执行成功', () => {
  shimBox = loadShim()
  assert(shimBox.window && shimBox.window.utools, '没有挂上 window.utools')
  assert(shimBox.window.utoolsBridge, '没有挂上 window.utoolsBridge')
  return `utools ${Object.keys(shimBox.utools).length} 个键 / utoolsBridge ${Object.keys(shimBox.utoolsBridge).length} 个键`
})

check('替身不会覆盖 uTools 里的真实现（已存在就退出）', () => {
  const source = fs.readFileSync(SHIM, 'utf8')
  assert(/__OTP_SHIM_INSTALLED__/.test(source), '缺少"已安装"哨兵，重复加载会覆盖真实现')
  const box = loadShim()
  const before = box.utools
  // 再跑一次：应当原样返回，不抛错也不替换
  vm.runInContext(source, box, { filename: 'utools-shim.js' })
  assert(box.utools === before, '第二次加载把 window.utools 换掉了')
})

console.log('\n=== 2. 静态交叉校验：页面调用到的每个 API 都要有实现 ===')

for (const name of PLUGINS) {
  const pluginDir = path.join(ROOT, name)
  if (!fs.existsSync(pluginDir)) {
    console.log(`  ✗ ${name} 目录不存在`)
    fail++
    continue
  }
  for (const root of deliveryRoots(pluginDir)) {
    const label = path.relative(ROOT, root) || name
    check(`${label}：bridge.* 与 utools.* 全部有实现`, () => {
      const { bridgeNames, utoolsNames, files } = collectCalls(root)
      const missingBridge = [...bridgeNames].filter((n) => typeof shimBox.utoolsBridge[n] !== 'function')
      const missingUtools = [...utoolsNames].filter((n) => typeof shimBox.utools[n] !== 'function')
      assert(
        missingBridge.length === 0,
        '替身缺 utoolsBridge.' + missingBridge.join(' / utoolsBridge.')
      )
      assert(missingUtools.length === 0, '替身缺 utools.' + missingUtools.join(' / utools.'))
      return `${files.length} 个页面脚本 → bridge ${bridgeNames.size} 个、utools ${utoolsNames.size} 个调用点全覆盖`
    })
  }
}

console.log('\n=== 3. 生成的 *.browser.html 是否正确 ===')

for (const name of PLUGINS) {
  const pluginDir = path.join(ROOT, name)
  if (!fs.existsSync(pluginDir)) continue
  for (const root of deliveryRoots(pluginDir)) {
    const label = path.relative(ROOT, root) || name
    const sources = walk(root).filter((f) => f.endsWith('.html') && !f.endsWith('.browser.html'))

    for (const src of sources) {
      const base = path.basename(src)
      const html = fs.readFileSync(src, 'utf8')
      const hasExternal = /<script[^>]*\ssrc=/i.test(html)
      const outPath = path.join(path.dirname(src), base.replace(/\.html?$/i, '') + '.browser.html')

      if (!hasExternal) {
        check(`${label}/${base} 自包含 → 不该生成替身版本`, () => {
          assert(!fs.existsSync(outPath), '自包含单文件不该有 .browser.html 副本')
        })
        continue
      }

      check(`${label}/${base.replace(/\.html$/, '.browser.html')} 结构与同步性`, () => {
        assert(fs.existsSync(outPath), '没有生成：' + path.relative(ROOT, outPath))
        const out = fs.readFileSync(outPath, 'utf8')

        // 替身必须在任何 core/ 与页面脚本之前
        const iShim = out.indexOf('utools-shim.js')
        assert(iShim >= 0, '没有引入 utools-shim.js')
        const iCore = out.search(/<script[^>]+src=["'][^"']*core\//)
        if (iCore >= 0) assert(iShim < iCore, 'utools-shim.js 必须在 core/ 脚本之前')

        // 外壳只能出现在 main 页，且必须是最后一个脚本
        const mainPage = (() => {
          try {
            return JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')).main || 'index.html'
          } catch (err) {
            return 'index.html'
          }
        })()
        const isMain = base === mainPage
        const iShell = out.indexOf('browser-shell.js')
        if (isMain) {
          assert(iShell >= 0, 'main 页没有引入 browser-shell.js')
          const srcs = [...out.matchAll(/<script[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1])
          assert(
            srcs[srcs.length - 1].indexOf('browser-shell.js') >= 0,
            'browser-shell.js 必须是最后一个脚本（要等页面注册完 onPluginEnter）'
          )
        } else {
          assert(iShell < 0, '非 main 页不该引入 browser-shell.js')
        }

        // 除插入的那一两行之外，必须与源页面完全一致
        const strip = (s) =>
          s
            .split('\n')
            .filter((l) => l.indexOf('utools-shim.js') < 0 && l.indexOf('browser-shell.js') < 0)
            .join('\n')
        assert(strip(out) === strip(html), '除了插入脚本那两行，内容应与源页面一致（生成器改坏了页面？）')

        return `${out.length} 字节`
      })
    }
  }
}

console.log('\n=== 4. 替身脚本与外壳必须被拷进每个插件 ===')

for (const name of PLUGINS) {
  const pluginDir = path.join(ROOT, name)
  if (!fs.existsSync(pluginDir)) continue
  for (const root of deliveryRoots(pluginDir)) {
    const label = path.relative(ROOT, root) || name
    check(`${label} 含替身与外壳`, () => {
      for (const asset of ['utools-shim.js', 'browser-shell.js']) {
        const p = path.join(root, asset)
        assert(fs.existsSync(p), '缺少 ' + asset)
        const a = fs.readFileSync(path.join(__dirname, asset))
        const b = fs.readFileSync(p)
        assert(Buffer.compare(a, b) === 0, asset + ' 与 shared/browser 下的不一致')
      }
      return '2 个文件一致'
    })
  }
}

console.log('\n=== 5. 生成器是幂等的 ===')

check('重复生成不改变结果', () => {
  const { execFileSync } = require('child_process')
  const hash = () => {
    const out = []
    for (const name of PLUGINS) {
      const pluginDir = path.join(ROOT, name)
      if (!fs.existsSync(pluginDir)) continue
      for (const root of deliveryRoots(pluginDir)) {
        for (const f of walk(root).filter((f) => f.endsWith('.browser.html'))) {
          out.push(f + ':' + fs.statSync(f).size)
        }
      }
    }
    return out.sort().join('|')
  }
  const before = hash()
  execFileSync(process.execPath, [path.join(__dirname, 'make-browser-entries.mjs')], { stdio: 'ignore' })
  const after = hash()
  assert(before === after, '重复生成产生了不同结果')
  return '两次生成一致'
})

console.log('\n=== 6. 替身里的同步 SHA-256 必须与标准实现一致 ===')

check('已知答案测试（与 Node crypto 逐字节对照）', () => {
  const nodeCrypto = require('crypto')
  // 覆盖填充边界：55/56 是单块与双块的分界，63/64/65 是块边界
  const lengths = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 65536]
  for (const n of lengths) {
    const bytes = Buffer.alloc(n)
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff
    const expect = nodeCrypto.createHash('sha256').update(bytes).digest('hex')
    const got = shimBox.utoolsBridge.sha256Bytes(new Uint8Array(bytes))
    assert(got === expect, `长度 ${n} 不一致：${got} != ${expect}`)
  }
  return `${lengths.length} 个长度全部一致（含 55/56/64 等填充边界）`
})

check('ArrayBuffer / TypedArray 入参都能接受', () => {
  const nodeCrypto = require('crypto')
  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  const expect = nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex')
  assert(shimBox.utoolsBridge.sha256Bytes(bytes) === expect, 'Uint8Array 入参不对')
  assert(shimBox.utoolsBridge.sha256Bytes(bytes.buffer) === expect, 'ArrayBuffer 入参不对')
  const view = new Uint8Array(bytes.buffer, 1, 3)
  const expectView = nodeCrypto.createHash('sha256').update(Buffer.from([2, 3, 4])).digest('hex')
  assert(shimBox.utoolsBridge.sha256Bytes(view) === expectView, '带偏移的视图入参不对')
  return '3 种入参形态都对'
})

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`)
process.exitCode = fail ? 1 : 0
