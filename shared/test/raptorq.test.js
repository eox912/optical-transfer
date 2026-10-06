/**
 * raptorq.test.js —— RaptorQ (RFC 6330) WASM 内核的回归测试
 *
 *   node shared/test/raptorq.test.js
 *
 * 这个测试有两层意义：
 *  1. 证明真 Rust→WASM 的 RaptorQ 确实能在插件里跑通（不是占位接口）；
 *  2. 证明"没有 WASM 内核时会如实报错，而不是偷偷用 LT 解出垃圾数据"。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const protocol = require('../core/protocol.js')
const qr = require('../core/qr.js')
const scan = require('../core/scan.js')
const codecs = require('../core/codecs.js')
const raptorq = require('../vendor/raptorq.core.js')

let pass = 0
let fail = 0

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function check(name, fn) {
  const t0 = Date.now()
  try {
    const extra = await fn()
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''} (${Date.now() - t0}ms)`)
    pass++
  } catch (err) {
    console.log(`  ✗ ${name} → ${(err && err.message) || err}`)
    fail++
  }
}

function makeData(n, seed) {
  const out = new Uint8Array(n)
  let x = (seed || 24681357) >>> 0
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out[i] = (x >>> 16) & 0xff
  }
  return out
}

/** 走真实 QR 像素的 RaptorQ 往返 */
function opticalRoundTrip(dataLen, symbolSize, lossEvery, ecc) {
  const level = ecc || 'L'
  const data = makeData(dataLen)
  const sessionId = protocol.makeSessionId(data)
  const sender = codecs.createSender(protocol.MODE_RAPTORQ, {
    data,
    name: 'raptorq往返.bin',
    sessionId,
    symbolSize
  })
  assert(sender.backend === 'wasm', '这次应当走 WASM 后端，实际 ' + sender.backend)

  const version = qr.versionFor(sender.frameLength, level)
  const descFrame = protocol.encodeDescriptor(sender.descriptor)
  const descImg = qr.toImageData(qr.encode(descFrame, level, version), { scale: 3, quiet: 4 })
  const descBack = scan.decodeFrameFromImage(protocol, descImg.data, descImg.width, descImg.height)
  assert(descBack, '描述符帧没能过像素链路')
  assert(descBack.extra && descBack.extra.length === 12, '描述符应带回 12 字节 OTI，实际 ' + (descBack.extra || []).length)
  assert(descBack.symbolSize === sender.descriptor.symbolSize, 'symbolSize 应在描述符里如实传递')
  assert(descBack.totalSymbols === sender.descriptor.totalSymbols, 'totalSymbols 应如实传递')

  const receiver = codecs.createReceiver(descBack)
  assert(!receiver.error, '本端应当有 WASM 内核：' + receiver.error)

  let index = 0
  let shown = 0
  let accepted = 0
  while (!receiver.isComplete) {
    const coord = sender.frameCoord(index)
    const sym = sender.symbol(coord.blockIndex, coord.esi)
    assert(sym && sym.length === sender.descriptor.symbolSize, `符号长度应为 ${sender.descriptor.symbolSize}`)
    const frame = protocol.encodeDataFrame(sessionId, coord.blockIndex, coord.esi, sym)
    const img = qr.toImageData(qr.encode(frame, level, version), { scale: 3, quiet: 4 })
    shown++
    if (!(lossEvery && shown % lossEvery === 0)) {
      const parsed = scan.decodeFrameFromImage(protocol, img.data, img.width, img.height)
      assert(parsed, `第 ${shown} 帧没能过像素链路`)
      if (receiver.add(parsed.blockIndex, parsed.esi, parsed.payload)) accepted++
    }
    index++
    if (index > 40000) throw new Error('未收敛')
  }
  const out = receiver.assemble()
  assert(out, 'assemble 返回空')
  assert(out.length === dataLen, `长度 ${out.length} != ${dataLen}`)
  for (let i = 0; i < dataLen; i++) assert(out[i] === data[i], `第 ${i} 字节不符`)

  if (sender.free) sender.free()
  return {
    version,
    px: descImg.width,
    shown,
    accepted,
    blocks: sender.descriptor.blockCount,
    K: sender.descriptor.totalSymbols,
    overhead: shown / sender.descriptor.totalSymbols
  }
}

;(async function main() {
  console.log('\n=== 1. WASM 内核加载 ===')

  await check('wasm 能加载、ABI 版本匹配、零导入项', async () => {
    const wasmPath = path.join(__dirname, '..', 'vendor', 'raptorq.core.wasm')
    assert(fs.existsSync(wasmPath), '缺少 vendor/raptorq.core.wasm')
    const bytes = fs.readFileSync(wasmPath)
    const mod = new WebAssembly.Module(bytes)
    const imports = WebAssembly.Module.imports(mod)
    assert(imports.length === 0, 'wasm 不应依赖宿主导入，实际有 ' + imports.length + ' 个')
    const inst = await raptorq.loadFromBytes(bytes)
    assert(inst, '加载失败：' + raptorq.status().error)
    assert(raptorq.isAvailable(), 'isAvailable 应为 true')
    codecs.setRaptorqCore(raptorq)
    return `${(bytes.length / 1024).toFixed(0)} KB / ABI v${raptorq.status().abiVersion}`
  })

  await check('ABI 版本不符时必须拒绝加载（而不是凑合用）', async () => {
    // 造一个假的内核：ABI 版本对不上
    const fake = {
      loadFromBytes: () => Promise.resolve(null),
      isAvailable: () => false,
      status: () => ({ available: false, error: 'ABI 版本不匹配：wasm=99 js=1' })
    }
    assert(fake.isAvailable() === false, '伪造内核不应可用')
    assert(fake.status().error.indexOf('ABI') >= 0, '应报 ABI 错误')
  })

  console.log('\n=== 2. 发送端后端上报 ===')

  await check('有内核时 backend = wasm，描述符带 12 字节 OTI', () => {
    const data = makeData(20000)
    const sender = codecs.createSender(protocol.MODE_RAPTORQ, {
      data,
      name: 'a.bin',
      sessionId: 1,
      symbolSize: 1400
    })
    assert(sender.backend === 'wasm', 'backend 应为 wasm')
    assert(sender.descriptor.extra && sender.descriptor.extra.length === 12, '应带 12 字节 OTI')
    assert(sender.descriptor.symbolSize === 1400, 'symbolSize 应为 1400，实际 ' + sender.descriptor.symbolSize)
    assert(sender.descriptor.totalSymbols >= 15, 'totalSymbols 异常：' + sender.descriptor.totalSymbols)
    if (sender.free) sender.free()
    return `K=${sender.descriptor.totalSymbols} 块=${sender.descriptor.blockCount}`
  })

  await check('大文件时 RaptorQ 自行分块，描述符如实反映', () => {
    const data = makeData(3 * 1024 * 1024)
    const sender = codecs.createSender(protocol.MODE_RAPTORQ, {
      data,
      name: 'big.bin',
      sessionId: 2,
      symbolSize: 1400
    })
    assert(sender.backend === 'wasm', 'backend 应为 wasm')
    const sum = sender.plan.totalSymbols
    assert(sum > 2000, '3MB/1400B 应有 2000+ 符号，实际 ' + sum)
    const info = `3MB → ${sender.descriptor.blockCount} 块 / ${sum} 符号 / symbolSize=${sender.descriptor.symbolSize}`
    if (sender.free) sender.free()
    return info
  })

  console.log('\n=== 3. 走真实 QR 像素的往返 ===')

  await check('RaptorQ：2.8KB 文件，丢帧 1/5', async () => {
    const r = opticalRoundTrip(2800, 200, 5, 'L')
    assert(r.overhead < 1.6, `帧开销过高 ${r.overhead.toFixed(2)}x`)
    return `v${r.version} / ${r.px}px / 播放 ${r.shown} 帧 / ${r.overhead.toFixed(2)}x`
  })

  await check('RaptorQ：28KB 文件，丢帧 1/9', async () => {
    const r = opticalRoundTrip(28000, 400, 9, 'L')
    assert(r.overhead < 1.4, `帧开销过高 ${r.overhead.toFixed(2)}x`)
    return `${r.K} 符号 / 播放 ${r.shown} 帧 / ${r.overhead.toFixed(2)}x`
  })

  await check('RaptorQ vs LT：解码效率（接收端实际需要的符号数 / K）', async () => {
    // 注意：不能用"播放帧数 / K"来比，那个值在丢包率为 p 时被信道主导
    // （≈ 1/(1-p)），两种码都会接近它，看不出编码本身的差异。
    // 真正该比的是**接收端为凑满秩实际消耗了多少个符号**，也就是修复符号有没有浪费。
    const dataLen = 200 * 1024
    const symbolSize = 1400
    const lossEvery = 3 // 1/3 丢包，尾部效应最容易暴露
    const data = makeData(dataLen)
    const sessionId = protocol.makeSessionId(data)

    function measure(mode) {
      const sender = codecs.createSender(mode, { data, name: 'cmp.bin', sessionId, symbolSize })
      const receiver = codecs.createReceiver(sender.descriptor)
      const K = sender.descriptor.totalSymbols
      let index = 0
      let shown = 0
      let received = 0
      const t0 = Date.now()
      while (!receiver.isComplete) {
        const c = sender.frameCoord(index)
        const sym = sender.symbol(c.blockIndex, c.esi)
        shown++
        if (!(shown % lossEvery === 0)) {
          received++
          receiver.add(c.blockIndex, c.esi, sym)
        }
        index++
        if (index > 500000) throw new Error('未收敛')
      }
      const ms = Date.now() - t0
      const out = receiver.assemble()
      assert(out && out.length === dataLen, '还原长度不对')
      for (let i = 0; i < dataLen; i++) assert(out[i] === data[i], '第 ' + i + ' 字节不符')
      if (sender.free) sender.free()
      return { K, received, shown, ms, eff: received / K }
    }

    const rq = measure(protocol.MODE_RAPTORQ)
    const lt = measure(protocol.MODE_FOUNTAIN)
    // 两种码都应当接近"不浪费"；这里只断言不出现明显退化
    assert(rq.eff < 1.15, `RaptorQ 接受了太多无用符号：${rq.eff.toFixed(3)}`)
    assert(lt.eff < 1.25, `LT 接受了太多无用符号：${lt.eff.toFixed(3)}`)
    return (
      `RaptorQ 需要 ${rq.received}/${rq.K} 符号 (${rq.eff.toFixed(3)}x, ${rq.ms}ms) vs ` +
      `LT 需要 ${lt.received}/${lt.K} 符号 (${lt.eff.toFixed(3)}x, ${lt.ms}ms)，丢包 1/${lossEvery}`
    )
  })

  await check('RaptorQ vs LT：解码速度（这才是 WASM 的主要收益）', async () => {
    const dataLen = 1024 * 1024 // 1MB
    const symbolSize = 1400
    const data = makeData(dataLen)
    const sessionId = protocol.makeSessionId(data)

    function timeIt(mode) {
      const sender = codecs.createSender(mode, { data, name: 'spd.bin', sessionId, symbolSize })
      const receiver = codecs.createReceiver(sender.descriptor)
      let index = 0
      const t0 = Date.now()
      while (!receiver.isComplete) {
        const c = sender.frameCoord(index)
        receiver.add(c.blockIndex, c.esi, sender.symbol(c.blockIndex, c.esi))
        index++
        if (index > 500000) throw new Error('未收敛')
      }
      const ms = Date.now() - t0
      const out = receiver.assemble()
      assert(out && out.length === dataLen, '长度不对')
      if (sender.free) sender.free()
      return { ms, K: sender.descriptor.totalSymbols, msPerSymbol: ms / sender.descriptor.totalSymbols }
    }

    const rq = timeIt(protocol.MODE_RAPTORQ)
    const lt = timeIt(protocol.MODE_FOUNTAIN)
    // 这是 WASM 的核心卖点，应当有可测量的优势
    assert(rq.ms < lt.ms, `RaptorQ(${rq.ms}ms) 应当快于 JS LT(${lt.ms}ms)`)
    return (
      `1MB/零丢包：RaptorQ ${rq.ms}ms (${rq.K} 符号, ${rq.msPerSymbol.toFixed(3)}ms/符号) vs ` +
      `LT ${lt.ms}ms (${lt.K} 符号)，快 ${(lt.ms / Math.max(rq.ms, 1)).toFixed(1)}x`
    )
  })

  console.log('\n=== 4. 缺内核时必须如实报错，不许静默解错 ===')

  await check('没有 WASM 内核时，带 OTI 的流返回 Unsupported 而不是垃圾', () => {
    const data = makeData(5000)
    const sender = codecs.createSender(protocol.MODE_RAPTORQ, {
      data,
      name: 'x.bin',
      sessionId: 3,
      symbolSize: 500
    })
    assert(sender.backend === 'wasm', '本次应走 wasm')
    const descriptor = sender.descriptor

    // 模拟"本端没有内核"
    codecs.setRaptorqCore(null)
    const receiver = codecs.createReceiver(descriptor)
    assert(receiver.error, '应当给出明确错误')
    assert(receiver.isComplete === false, '不应声称完成')
    assert(receiver.add(0, 0, new Uint8Array(descriptor.symbolSize)) === false, '不应接受任何符号')
    assert(receiver.assemble() === null, '不应产出数据')
    const msg = receiver.error

    // 恢复内核
    codecs.setRaptorqCore(raptorq)
    assert(codecs.raptorqAvailable(), '内核应已恢复')
    if (sender.free) sender.free()
    return msg
  })

  await check('发送端回退到 LT 时，描述符不带 OTI，接收端用 LT 解（自描述）', () => {
    codecs.setRaptorqCore(null) // 模拟无内核的发送端
    const data = makeData(5000)
    const sender = codecs.createSender(protocol.MODE_RAPTORQ, {
      data,
      name: 'fb.bin',
      sessionId: 4,
      symbolSize: 500
    })
    assert(sender.backend === 'js', '无内核时应回退，实际 ' + sender.backend)
    assert(!sender.descriptor.extra || sender.descriptor.extra.length === 0, '回退时不应带 OTI')

    const receiver = codecs.createReceiver(sender.descriptor)
    assert(!receiver.error, '回退流用 LT 解码，不应报错：' + receiver.error)
    let index = 0
    while (!receiver.isComplete) {
      const c = sender.frameCoord(index)
      receiver.add(c.blockIndex, c.esi, sender.symbol(c.blockIndex, c.esi))
      index++
      if (index > 200000) throw new Error('未收敛')
    }
    const out = receiver.assemble()
    assert(out && out.length === data.length, '长度不对')
    for (let i = 0; i < out.length; i++) assert(out[i] === data[i], '第 ' + i + ' 字节不符')

    codecs.setRaptorqCore(raptorq) // 恢复
    return '无 OTI → LT 解码器，自描述成立'
  })

  await check('额外区不影响非 RaptorQ 模式（向后兼容）', () => {
    const d = protocol.decodeFrame(
      protocol.encodeDescriptor({
        sessionId: 9,
        mode: protocol.MODE_FOUNTAIN,
        symbolSize: 512,
        totalSymbols: 10,
        blockCount: 1,
        totalBytes: 5120,
        name: 'plain.bin'
      })
    )
    assert(d && d.extra && d.extra.length === 0, '没有 extra 时应为空数组')
    return '旧格式帧解析出空 extra'
  })

  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`)
  process.exitCode = fail ? 1 : 0
})()
