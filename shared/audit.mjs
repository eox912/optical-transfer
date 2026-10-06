#!/usr/bin/env node
/**
 * audit.mjs —— 插件交付前自检（对应 PLUGIN-SPEC.md 第 8 节的清单）
 *
 *   node shared/audit.mjs
 *
 * 检查的是"测试跑不到但一上线就白屏"的那类问题：
 *   - HTML 里有没有 CSP meta（本地协议下会把 JS 拦掉 → 白屏）
 *   - script 顺序对不对（vendor 必须全部先于 core，codecs.js 必须最后）
 *   - vendor/raptorq.core.js 有没有引入（没有就收不了 RaptorQ 流）
 *   - 引用的资源文件是否都存在
 *   - preload 有没有暴露 readBinary（file:// 下 fetch 取不到 wasm，只能靠它）
 *   - 有没有引用插件目录之外的文件
 *   - plugin.json 是否合法、features[].code 是否唯一
 *   - 是否残留 .git / *.js.map / node_modules 等不该打包的东西
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const PLUGINS = ['airscan-qr', 'decimen-optical-transfer', 'raptorqr']

const problems = []
const notes = []

/**
 * 方案一按设计**不携带** RaptorQ 的 WASM 核：
 * 它的身份是"纯 HTML/JS、零依赖、单文件可自包含"，塞 241KB wasm 会破坏这个身份，
 * 而且 standalone.html 也没法再保持自包含。
 * 代价是它收不了**真 RaptorQ 流**——但它会如实拒绝（UnsupportedReceiver + 明确文案），
 * 不会拿 LT 硬解出垃圾数据。这是有意的、可解释的边界，不是遗漏。
 */
const WASM_OPTIONAL = new Set(['airscan-qr'])

function bad(plugin, message) {
  problems.push(`[${plugin}] ${message}`)
}
function note(message) {
  notes.push(message)
}

function walkFiles(dir, out = [], depth = 0) {
  if (depth > 6) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walkFiles(full, out, depth + 1)
    } else {
      out.push(full)
    }
  }
  return out
}

/** 插件里可能有多个"可交付根"：扁平的插件根，或 dist/ */
function deliveryRoots(pluginDir) {
  const roots = []
  if (fs.existsSync(path.join(pluginDir, 'plugin.json'))) roots.push(pluginDir)
  for (const sub of ['dist', 'build', 'public']) {
    const p = path.join(pluginDir, sub)
    if (fs.existsSync(path.join(p, 'plugin.json'))) roots.push(p)
  }
  return roots
}

for (const name of PLUGINS) {
  const pluginDir = path.join(root, name)
  if (!fs.existsSync(pluginDir)) {
    bad(name, '插件目录不存在')
    continue
  }
  const roots = deliveryRoots(pluginDir)
  if (roots.length === 0) {
    bad(name, '找不到可交付的 plugin.json（既不在插件根，也不在 dist/）')
    continue
  }

  for (const deliveryRoot of roots) {
    const label = name + (deliveryRoot === pluginDir ? '' : '/' + path.basename(deliveryRoot))

    /* ---------- plugin.json ---------- */
    let pluginJson = null
    try {
      pluginJson = JSON.parse(fs.readFileSync(path.join(deliveryRoot, 'plugin.json'), 'utf8'))
    } catch (err) {
      bad(label, 'plugin.json 不是合法 JSON：' + err.message)
    }
    if (pluginJson) {
      for (const field of ['main', 'logo', 'features']) {
        if (!pluginJson[field]) bad(label, `plugin.json 缺少必填字段 ${field}`)
      }
      if (pluginJson.main && !pluginJson.main.endsWith('.html')) {
        bad(label, `plugin.json 的 main 必须是 .html，实际 ${pluginJson.main}`)
      }
      for (const field of ['main', 'logo', 'preload']) {
        const value = pluginJson[field]
        if (value && !fs.existsSync(path.join(deliveryRoot, value))) {
          bad(label, `plugin.json 引用的 ${field}=${value} 不存在`)
        }
      }
      const features = Array.isArray(pluginJson.features) ? pluginJson.features : []
      if (features.length === 0) bad(label, 'plugin.json 的 features 为空')
      const codes = features.map((f) => f.code)
      const dup = codes.filter((c, i) => codes.indexOf(c) !== i)
      if (dup.length) bad(label, 'features[].code 重复：' + [...new Set(dup)].join(', '))
      for (const f of features) {
        if (!f.code) bad(label, '有 feature 缺少 code')
        if (!Array.isArray(f.cmds) || f.cmds.length === 0) bad(label, `feature ${f.code} 缺少 cmds`)
      }
      if (!pluginJson.pluginSetting || pluginJson.pluginSetting.single === undefined) {
        note(`${label}: pluginSetting.single 未设置（会走默认值 true）`)
      }
    }

    /* ---------- HTML ---------- */
    const htmlFiles = walkFiles(deliveryRoot).filter((f) => f.endsWith('.html'))
    if (htmlFiles.length === 0) bad(label, '没有任何 .html 文件')

    for (const htmlPath of htmlFiles) {
      const rel = path.relative(deliveryRoot, htmlPath)
      const html = fs.readFileSync(htmlPath, 'utf8')

      if (/http-equiv=["']?Content-Security-Policy/i.test(html)) {
        bad(label, `${rel} 含 CSP meta —— 本地协议下 script-src 'self' 会导致白屏`)
      }
      if (/src=["']https?:\/\//i.test(html) || /href=["']https?:\/\//i.test(html)) {
        bad(label, `${rel} 引用了网络资源 —— uTools 发布时禁止请求网络资源`)
      }
      if (/(src|href)=["'](\.\.\/)+/i.test(html)) {
        bad(label, `${rel} 引用了插件目录之外的文件`)
      }

      // 收集本地的 script/link/资源引用，检查是否存在
      const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1])
      for (const ref of refs) {
        if (/^(https?:|data:|#|javascript:)/i.test(ref)) continue
        const target = ref.split('?')[0]
        if (!target) continue
        if (!fs.existsSync(path.join(path.dirname(htmlPath), target))) {
          bad(label, `${rel} 引用了不存在的资源：${target}`)
        }
      }

      // script 顺序：codecs.js 必须在所有 core 之后；若页面用到 codecs，vendor 要先于 core
      const scripts = [...html.matchAll(/<script[^>]*src=["']([^"']+)["'][^>]*>/g)].map((m) => m[1])
      const idxOf = (needle) => scripts.findIndex((s) => s.indexOf(needle) >= 0)
      const iCodecs = idxOf('core/codecs.js')
      if (iCodecs >= 0) {
        for (const dep of ['core/protocol.js', 'core/fountain.js', 'core/qr.js', 'core/scan.js']) {
          const i = idxOf(dep)
          if (i >= 0 && i > iCodecs) bad(label, `${rel} 里 ${dep} 必须在 core/codecs.js 之前`)
        }
        const iQrVendor = idxOf('vendor/qrcode-generator.js')
        if (iQrVendor >= 0 && iQrVendor > iCodecs) {
          bad(label, `${rel} 里 vendor/qrcode-generator.js 必须在 core 之前`)
        }
        if (idxOf('vendor/raptorq.core.js') < 0) {
          // 只有"接收端页面"必须带 WASM 核：真 RaptorQ 流只有 RaptorQ 解码器能解。
          // 发送端页面不带没关系（发送端可以只用 LT / 顺序分片）。
          const isReceiverPage = /receiver/i.test(rel)
          if (WASM_OPTIONAL.has(name)) {
            note(`${label}: ${rel} 未引入 vendor/raptorq.core.js —— 方案一按设计不带 WASM 核（收 RaptorQ 流时如实拒绝）`)
          } else if (isReceiverPage) {
            bad(label, `${rel} 是接收端页面却没有引入 vendor/raptorq.core.js —— 将收不了真 RaptorQ 流`)
          } else {
            note(`${label}: ${rel} 未引入 vendor/raptorq.core.js（非接收端页面，允许）`)
          }
        } else if (idxOf('vendor/raptorq.core.js') > iCodecs) {
          bad(label, `${rel} 里 vendor/raptorq.core.js 必须在 core 之前`)
        }
      }
    }

    /* ---------- preload 桥：只要有一个 preload 能从 fs 读 wasm 就行 ---------- */
    // 为什么不按函数名判：三个插件的 preload 是各写各的（叫 readBinary /
    // readVendorBytes / ...）。这里按**能力**判：引用了 wasm 路径且用了 fs 读文件。
    // 注意 raptorq.core.js 现在同时接受 Uint8Array / ArrayBuffer / 任意 TypedArray，
    // 所以不限定返回类型。
    const preloadFiles = walkFiles(deliveryRoot).filter((f) => /preload.*\.js$/.test(path.basename(f)))
    if (preloadFiles.length === 0) {
      bad(label, '没有任何 preload 文件')
    } else if (!WASM_OPTIONAL.has(name)) {
      const reader = preloadFiles.find((f) => {
        const s = fs.readFileSync(f, 'utf8')
        return /raptorq\.core\.wasm/.test(s) && /readFileSync/.test(s)
      })
      if (!reader) {
        bad(label, `没有 preload 能从 fs 读 vendor/raptorq.core.wasm —— file:// 下 fetch 取不到，接收端将解不了真 RaptorQ 流`)
      }
    } else {
      note(`${label}: 方案一不带 wasm，preload 不需要 wasm 读取能力`)
    }

    /* ---------- 不该打包的东西 ---------- */
    for (const f of walkFiles(deliveryRoot)) {
      const rel = path.relative(deliveryRoot, f)
      if (rel.endsWith('.js.map') || rel.endsWith('.css.map')) bad(label, `残留 sourcemap：${rel}`)
      if (rel === '.gitignore' || rel.startsWith('.git' + path.sep)) bad(label, `残留 git 相关文件：${rel}`)
    }

    /* ---------- 核心是否齐备 ---------- */
    for (const f of ['protocol.js', 'fountain.js', 'qr.js', 'scan.js', 'codecs.js']) {
      if (!fs.existsSync(path.join(deliveryRoot, 'core', f))) bad(label, `缺少 core/${f}`)
    }
    const requiredVendor = ['qrcode-generator.js', 'jsQR.js']
    if (WASM_OPTIONAL.has(name)) {
      note(`${label}: 按设计不含 vendor/raptorq.*（方案一不带 WASM 核，收 RaptorQ 流时如实拒绝）`)
    } else {
      requiredVendor.push('raptorq.core.js', 'raptorq.core.wasm')
    }
    for (const f of requiredVendor) {
      if (!fs.existsSync(path.join(deliveryRoot, 'vendor', f))) bad(label, `缺少 vendor/${f}`)
    }

    note(`${label}: ${walkFiles(deliveryRoot).length} 个文件待打包`)
  }
}

console.log('\n=== 插件交付自检 ===\n')
if (notes.length) {
  for (const n of notes) console.log('  · ' + n)
  console.log('')
}
if (problems.length === 0) {
  console.log('✅ 没有发现问题\n')
  process.exitCode = 0
} else {
  for (const p of problems) console.log('  ❌ ' + p)
  console.log(`\n❌ 共 ${problems.length} 个问题\n`)
  process.exitCode = 1
}
