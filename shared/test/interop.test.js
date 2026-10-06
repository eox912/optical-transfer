/**
 * interop.test.js —— 跨插件互通验收测试
 *
 *   node shared/test/interop.test.js
 *
 * 这个测试**不看 shared/，而是直接加载三个插件各自的 core/ 与 vendor/**，
 * 然后交叉配对：
 *
 *   raptorqr 发送端  →  airscan-qr 接收端
 *   airscan-qr 发送端 →  decimen 接收端
 *   decimen 发送端   →  raptorqr 接收端
 *
 * 帧要真的走一遍 QR 编码 → 像素 → 另一端用**自己的**解码器解帧 → CRC → 解码器。
 * 三个插件必须携带完全一致的 core/，所以这个测试同时也是"共享核心防漂移"的
 * 最终把关：谁偷偷改了协议，这里就会红。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const PLUGINS = ['airscan-qr', 'decimen-optical-transfer', 'raptorqr']

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

function makeData(n, seed) {
  const out = new Uint8Array(n)
  let x = (seed || 13572468) >>> 0
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out[i] = (x >>> 16) & 0xff
  }
  return out
}

function firstExisting(candidates) {
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

/** 加载某个插件自己的核心（不是 shared/），保证测的是真正交付出去的那一份 */
function loadPlugin(name) {
  const base = path.join(ROOT, name)
  const coreDir = firstExisting([
    path.join(base, 'core'),
    path.join(base, 'dist', 'core'),
    path.join(base, 'src', 'core')
  ])
  const vendorDir = firstExisting([
    path.join(base, 'vendor'),
    path.join(base, 'dist', 'vendor'),
    path.join(base, 'src', 'vendor')
  ])
  if (!coreDir || !vendorDir) {
    throw new Error(`${name} 找不到 core/ 或 vendor/（coreDir=${coreDir} vendorDir=${vendorDir}）`)
  }
  return {
    name,
    coreDir,
    vendorDir,
    protocol: require(path.join(coreDir, 'protocol.js')),
    qr: require(path.join(coreDir, 'qr.js')),
    scan: require(path.join(coreDir, 'scan.js')),
    codecs: require(path.join(coreDir, 'codecs.js')),
    // 方案一按设计不带 WASM 核，所以这里是可选的
    raptorq: (() => {
      const p = path.join(vendorDir, 'raptorq.core.js')
      return fs.existsSync(p) ? require(p) : null
    })()
  }
}

/** 让插件具备 RaptorQ 能力（它自己 vendor 目录里的 wasm） */
async function prime(p) {
  const wasmPath = path.join(p.vendorDir, 'raptorq.core.wasm')
  if (!fs.existsSync(wasmPath)) throw new Error(`${p.name} 缺少 vendor/raptorq.core.wasm`)
  const inst = await p.raptorq.load({ bytes: fs.readFileSync(wasmPath) })
  if (!inst) throw new Error(`${p.name} 的 wasm 加载失败：${p.raptorq.status().error}`)
  p.codecs.setRaptorqCore(p.raptorq)
  return p
}

/**
 * 跨插件往返：S 发送 → R 接收，中间走真实 QR 像素
 * 注意两端各自用自己的 protocol/qr/scan/codecs，没有任何共享对象
 */
function crossRoundTrip(S, R, mode, dataLen, symbolSize, lossEvery) {
  const data = makeData(dataLen)
  const sessionId = S.protocol.makeSessionId(data)
  const sender = S.codecs.createSender(mode, {
    data,
    name: 'interop-互通测试.bin',
    sessionId,
    symbolSize
  })
  const ecc = 'L'
  const version = S.qr.versionFor(sender.frameLength, ecc)

  // 描述符帧：S 编码 → 像素 → R 用**自己的**协议解析
  const descFrame = S.protocol.encodeDescriptor(sender.descriptor)
  const descImg = S.qr.toImageData(S.qr.encode(descFrame, ecc, version), { scale: 3, quiet: 4 })
  const descBack = R.scan.decodeFrameFromImage(R.protocol, descImg.data, descImg.width, descImg.height)
  assert(descBack, `${S.name}→${R.name}：描述符帧没能被接收端解析（协议不一致？）`)
  assert(descBack.totalBytes === dataLen, 'bytes 不一致')
  assert(descBack.name === 'interop-互通测试.bin', '文件名没能跨插件传递：' + descBack.name)
  assert(descBack.mode === mode, '模式不一致')

  const receiver = R.codecs.createReceiver(descBack)
  assert(!receiver.error, `接收端报错：${receiver.error}`)

  let index = 0
  let shown = 0
  while (!receiver.isComplete) {
    const c = sender.frameCoord(index)
    const sym = sender.symbol(c.blockIndex, c.esi)
    assert(sym, '发送端拿不到符号')
    const frame = S.protocol.encodeDataFrame(sessionId, c.blockIndex, c.esi, sym)
    const img = S.qr.toImageData(S.qr.encode(frame, ecc, version), { scale: 3, quiet: 4 })
    shown++
    if (!(lossEvery && shown % lossEvery === 0)) {
      const parsed = R.scan.decodeFrameFromImage(R.protocol, img.data, img.width, img.height)
      assert(parsed, `${S.name}→${R.name}：第 ${shown} 帧没能被接收端解析`)
      assert(parsed.sessionId === sessionId, 'sessionId 不一致')
      receiver.add(parsed.blockIndex, parsed.esi, parsed.payload)
    }
    index++
    if (index > 40000) throw new Error('未收敛')
  }
  const out = receiver.assemble()
  assert(out, 'assemble 返回空')
  assert(out.length === dataLen, `长度不符 ${out.length} != ${dataLen}`)
  for (let i = 0; i < dataLen; i++) assert(out[i] === data[i], `第 ${i} 字节不符`)

  const backend = S.codecs.modeKey(mode) === 'raptorq' ? sender.backend : '—'
  if (sender.free) sender.free()
  return { shown, K: sender.descriptor.totalSymbols, backend }
}

;(async function main() {
  console.log('\n=== 0. 加载三个插件自己的核心 ===')
  const loaded = {}
  for (const name of PLUGINS) {
    try {
      loaded[name] = loadPlugin(name)
      const c = loaded[name]
      console.log(`  ✓ ${name}  core=${path.relative(ROOT, c.coreDir)}  vendor=${path.relative(ROOT, c.vendorDir)}`)
      pass++
    } catch (err) {
      console.log(`  ✗ ${name} → ${err.message}`)
      fail++
    }
  }
  if (fail) {
    console.log('\n插件核心还没就位，后续测试跳过。')
    console.log(`\n❌ ${pass} 通过 / ${fail} 失败\n`)
    process.exitCode = 1
    return
  }

  console.log('\n=== 1. 三份核心必须完全一致（字节级）===')
  check('core/ 与 vendor/ 逐字节比对', () => {
    const ref = loaded[PLUGINS[0]]
    for (const file of ['protocol.js', 'fountain.js', 'qr.js', 'scan.js', 'codecs.js']) {
      const refBuf = fs.readFileSync(path.join(ref.coreDir, file))
      for (const name of PLUGINS.slice(1)) {
        const other = path.join(loaded[name].coreDir, file)
        assert(fs.existsSync(other), `${name}/core/${file} 缺失`)
        assert(Buffer.compare(refBuf, fs.readFileSync(other)) === 0, `${name}/core/${file} 与 ${ref.name} 不一致`)
      }
    }
    // 公共第三方库：三份都必须有且一致
    for (const file of ['qrcode-generator.js', 'jsQR.js']) {
      const refBuf = fs.readFileSync(path.join(ref.vendorDir, file))
      for (const name of PLUGINS.slice(1)) {
        const other = path.join(loaded[name].vendorDir, file)
        assert(fs.existsSync(other), `${name}/vendor/${file} 缺失`)
        assert(Buffer.compare(refBuf, fs.readFileSync(other)) === 0, `${name}/vendor/${file} 与 ${ref.name} 不一致`)
      }
    }
    // WASM 核：raptorqr 与 decimen 必须有且内容一致；airscan-qr 按设计必须没有
    const wasmOwners = PLUGINS.filter((n) => n !== 'airscan-qr')
    const rqRef = path.join(loaded[wasmOwners[0]].vendorDir, 'raptorq.core.wasm')
    assert(fs.existsSync(rqRef), `${wasmOwners[0]} 缺少 vendor/raptorq.core.wasm`)
    const rqRefBuf = fs.readFileSync(rqRef)
    for (const name of wasmOwners.slice(1)) {
      const other = path.join(loaded[name].vendorDir, 'raptorq.core.wasm')
      assert(fs.existsSync(other), `${name} 缺少 vendor/raptorq.core.wasm`)
      assert(Buffer.compare(rqRefBuf, fs.readFileSync(other)) === 0, `${name} 的 raptorq.core.wasm 与 ${wasmOwners[0]} 不一致`)
    }
    assert(
      !fs.existsSync(path.join(loaded['airscan-qr'].vendorDir, 'raptorq.core.wasm')),
      'airscan-qr 按设计不该带 WASM 核（那会破坏"纯 HTML/JS 零依赖 + 单文件自包含"的身份）'
    )
    return '5 个 core + 2 个公共 vendor 三处一致；WASM 核在需要它的两个插件里一致'
  })

  console.log('\n=== 2. RaptorQ WASM 能力矩阵 ===')
  for (const name of PLUGINS) {
    await (async () => {
      const p = loaded[name]
      const wasmPath = path.join(p.vendorDir, 'raptorq.core.wasm')
      if (name === 'airscan-qr') {
        if (fs.existsSync(wasmPath)) {
          console.log('  ✗ airscan-qr 按设计不该带 vendor/raptorq.core.wasm')
          fail++
          return
        }
        console.log('  ✓ airscan-qr  按设计不含 WASM 核（收真 RaptorQ 流时会如实拒绝，见第 4 节）')
        pass++
        return
      }
      try {
        await prime(p)
        const st = p.raptorq.status()
        console.log(`  ✓ ${name}  WASM 可用（${(st.wasmBytes / 1024).toFixed(0)} KB, ABI v${st.abiVersion}）`)
        pass++
      } catch (err) {
        console.log(`  ✗ ${name} → ${err.message}`)
        fail++
      }
    })()
  }

  console.log('\n=== 3. 交叉配对：A 的发 → B 的收（走真实 QR 像素）===')

  // 注意 raptorqr → airscan-qr 的 RaptorQ 组合**不在**成功列表里：
  // 方案一按设计不携带 WASM 核（保持"纯 HTML/JS 零依赖 + 单文件自包含"的身份），
  // 所以它收不了真 RaptorQ 流。这是有意的边界，第 4 节专门验证它会"如实拒绝"。
  const pairs = [
    ['raptorqr', 'decimen-optical-transfer', 'raptorq', 'RaptorQ(WASM)'],
    ['airscan-qr', 'decimen-optical-transfer', 'sequential', '顺序分片'],
    ['decimen-optical-transfer', 'raptorqr', 'fountain', 'LT 喷泉码'],
    ['decimen-optical-transfer', 'airscan-qr', 'fountain', 'LT 喷泉码'],
    ['airscan-qr', 'raptorqr', 'sequential', '顺序分片'],
    ['raptorqr', 'decimen-optical-transfer', 'fountain', 'LT 喷泉码']
  ]

  for (const [sName, rName, modeKey, label] of pairs) {
    const S = loaded[sName]
    const R = loaded[rName]
    try {
      const r = crossRoundTrip(S, R, S.protocol['MODE_' + modeKey.toUpperCase()], 2400, 200, 5)
      console.log(
        `  ✓ ${sName} → ${rName}  [${label}]  播放 ${r.shown} 帧 / ${r.K} 符号` +
          `${r.backend !== '—' ? ' / 后端=' + r.backend : ''}`
      )
      pass++
    } catch (err) {
      console.log(`  ✗ ${sName} → ${rName}  [${label}] → ${err.message}`)
      fail++
    }
  }

  console.log('\n=== 4. 方案一对真 RaptorQ 流必须"如实拒绝"，不许硬解出垃圾 ===')
  try {
    const S = loaded.raptorqr
    const R = loaded['airscan-qr']
    const data = makeData(4000)
    const sender = S.codecs.createSender(S.protocol.MODE_RAPTORQ, {
      data,
      name: 'raptorq-必须被拒绝.bin',
      sessionId: S.protocol.makeSessionId(data),
      symbolSize: 400
    })
    assert(sender.backend === 'wasm', 'raptorqr 这次应当走 WASM 后端')
    const descFrame = S.protocol.encodeDescriptor(sender.descriptor)
    const desc = R.protocol.decodeFrame(descFrame)
    assert(desc && desc.extra && desc.extra.length === 12, 'RaptorQ 描述符应带 12 字节 OTI')

    const receiver = R.codecs.createReceiver(desc)
    assert(receiver.error, '方案一应当明确报"解不了"，而不是悄悄用 LT')
    assert(receiver.isComplete === false, '不应声称完成')
    assert(receiver.add(0, 0, new Uint8Array(desc.symbolSize)) === false, '不应接受任何符号')
    assert(receiver.assemble() === null, '不应产出数据')
    if (sender.free) sender.free()
    console.log(`  ✓ raptorqr → airscan-qr  [RaptorQ] 如实拒绝：${receiver.error}`)
    pass++
  } catch (err) {
    console.log(`  ✗ RaptorQ 拒绝行为 → ${err.message}`)
    fail++
  }

  console.log('\n=== 5. 大切片交叉（1400B 帧 / v27）===')
  try {
    const r = crossRoundTrip(
      loaded.raptorqr,
      loaded['decimen-optical-transfer'],
      loaded.raptorqr.protocol.MODE_RAPTORQ,
      1400 * 12,
      1400,
      0
    )
    console.log(`  ✓ raptorqr → decimen  [1400B 切片 / RaptorQ]  播放 ${r.shown} 帧`)
    pass++
  } catch (err) {
    console.log(`  ✗ 大切片交叉 → ${err.message}`)
    fail++
  }

  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`)
  process.exitCode = fail ? 1 : 0
})()
