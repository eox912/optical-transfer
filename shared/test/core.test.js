/**
 * shared/test/core.test.js —— 共享核心的回归测试（Node 直接跑，无测试框架）
 *
 *   node shared/test/core.test.js
 *
 * 最重要的一条是最后的「整链路」测试：它把帧编码成 QR、自己渲染成像素、
 * 再交给**独立的**解码器 jsQR 读回来。任何一个环节（协议、QR 编码、
 * latin1 覆写、CRC、喷泉码）出错都会在这里暴露。
 */
'use strict'

const protocol = require('../core/protocol.js')
const fountain = require('../core/fountain.js')
const qr = require('../core/qr.js')
const scan = require('../core/scan.js')

let pass = 0
let fail = 0

function check(name, fn) {
  const t0 = Date.now()
  try {
    const extra = fn()
    const ms = Date.now() - t0
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''} (${ms}ms)`)
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
  let x = (seed || 12345) >>> 0
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out[i] = (x >>> 16) & 0xff
  }
  return out
}

console.log('\n=== 1. 协议层：帧编解码 ===')

check('描述符帧往返（含中文文件名）', () => {
  const frame = protocol.encodeDescriptor({
    sessionId: 0xbeef,
    mode: protocol.MODE_FOUNTAIN,
    symbolSize: 1400,
    totalSymbols: 3,
    blockCount: 1,
    totalBytes: 3001,
    name: '测试文件·report.pdf'
  })
  const f = protocol.decodeFrame(frame)
  assert(f, '解帧失败')
  assert(f.type === protocol.TYPE_DESCRIPTOR, 'type 不对')
  assert(f.sessionId === 0xbeef, 'sessionId 不对')
  assert(f.mode === protocol.MODE_FOUNTAIN, 'mode 不对')
  assert(f.symbolSize === 1400, 'symbolSize 不对')
  assert(f.totalBytes === 3001, 'totalBytes 不对')
  assert(f.name === '测试文件·report.pdf', '文件名不对：' + f.name)
  return `${frame.length}B 帧`
})

check('数据帧往返', () => {
  const payload = makeData(1400, 7)
  const frame = protocol.encodeDataFrame(0x1234, 2, 987654, payload)
  const f = protocol.decodeFrame(frame)
  assert(f && f.type === protocol.TYPE_DATA, '解帧失败')
  assert(f.sessionId === 0x1234 && f.blockIndex === 2 && f.esi === 987654, '头部字段不对')
  assert(f.payload.length === 1400, '载荷长度不对')
  for (let i = 0; i < payload.length; i++) assert(f.payload[i] === payload[i], '载荷第 ' + i + ' 字节不对')
  return `${frame.length}B 帧`
})

check('CRC32 能挡住单字节篡改', () => {
  const frame = protocol.encodeDataFrame(1, 0, 0, makeData(64, 3))
  for (const pos of [0, 1, 5, 20, frame.length - 1]) {
    const bad = Uint8Array.from(frame)
    bad[pos] ^= 0x01
    assert(protocol.decodeFrame(bad) === null, `第 ${pos} 字节被改后竟然通过了校验`)
  }
})

check('magic 不符 / 长度不足 → null', () => {
  const frame = protocol.encodeDataFrame(1, 0, 0, makeData(32, 9))
  const badMagic = Uint8Array.from(frame)
  badMagic[0] = 0x00
  assert(protocol.decodeFrame(badMagic) === null, 'magic 不符应为 null')
  assert(protocol.decodeFrame(frame.subarray(0, 5)) === null, '截断帧应为 null')
  assert(protocol.decodeFrame(new Uint8Array(0)) === null, '空帧应为 null')
  assert(protocol.decodeFrame(null) === null, 'null 应为 null')
})

check('会话 ID 派生：内容变则 ID 变，内容同则 ID 同', () => {
  const a = makeData(500, 1)
  const b = makeData(500, 1)
  const c = makeData(500, 2)
  assert(protocol.makeSessionId(a) === protocol.makeSessionId(b), '同内容应得同 ID')
  assert(protocol.makeSessionId(a) !== protocol.makeSessionId(c), '异内容应得异 ID')
  assert(protocol.makeSessionId(a) >= 0 && protocol.makeSessionId(a) <= 0xffff, 'ID 应在 u16 范围内')
})

console.log('\n=== 2. 分块规划 ===')

check('分块规划自洽（含非整除、超单块上限）', () => {
  const cases = [
    [1, 1400, 1024],
    [1400, 1400, 1024],
    [1401, 1400, 1024],
    [1400 * 1024, 1400, 1024],
    [1400 * 1025, 1400, 1024],
    [1400 * 3000 + 7, 1400, 1024]
  ]
  const notes = []
  for (const [total, sym, max] of cases) {
    const plan = protocol.planBlocks(total, sym, max)
    let sum = 0
    for (let b = 0; b < plan.blockCount; b++) sum += protocol.symbolsInBlock(plan, b)
    assert(sum === plan.totalSymbols, `符号数不自洽：${sum} != ${plan.totalSymbols}`)
    assert(plan.symbolsPerBlock <= max || plan.blockCount === 1, '单块超过上限')
    assert(plan.blockCount >= 1, 'blockCount 至少为 1')
    notes.push(`${protocol.formatBytes(total)}→${plan.blockCount}块`)
  }
  return notes.join(' ')
})

console.log('\n=== 3. LT 喷泉码 ===')

function fountainRoundTrip(totalBytes, symbolSize, lossEvery, maxBlockSymbols) {
  const data = makeData(totalBytes, 42)
  const sessionId = protocol.makeSessionId(data)
  const plan = protocol.planBlocks(totalBytes, symbolSize, maxBlockSymbols)
  const enc = fountain.FountainEncoder(data, plan, sessionId)
  const dec = fountain.FountainDecoder({
    sessionId,
    symbolSize: plan.symbolSize,
    totalSymbols: plan.totalSymbols,
    blockCount: plan.blockCount,
    totalBytes: plan.totalBytes
  })

  let frames = 0
  let useful = 0
  let duplicate = 0
  let esi = 0
  const t0 = Date.now()
  while (!dec.isComplete) {
    for (let b = 0; b < plan.blockCount; b++) {
      frames++
      if (lossEvery && frames % lossEvery === 0) continue // 模拟丢帧
      const sym = enc.symbol(b, esi)
      if (dec.add(b, esi, sym)) useful++
      else duplicate++
      if (dec.isComplete) break
    }
    esi++
    if (esi > 200000) throw new Error('解码未收敛')
  }
  const ms = Date.now() - t0
  const out = dec.assemble()
  assert(out, 'assemble 返回空')
  assert(out.length === totalBytes, `长度不符：${out.length} != ${totalBytes}`)
  for (let i = 0; i < totalBytes; i++) {
    if (out[i] !== data[i]) throw new Error(`第 ${i} 字节不符（共 ${totalBytes}B）`)
  }
  // 完成后必须沿用"已完成"状态拒绝新符号
  assert(dec.add(0, esi + 1, enc.symbol(0, esi + 1)) === false, '完成后仍接受了新符号')
  return {
    ms,
    // 真正的成本指标：发送端一共播放了多少帧 / 源符号数
    overhead: frames / plan.totalSymbols,
    useful,
    frames,
    duplicate,
    blocks: plan.blockCount
  }
}

check('零丢包往返（1 字节）', () => {
  const r = fountainRoundTrip(1, 256, 0, 1024)
  assert(r.overhead <= 1.01, '零丢包时系统化前缀应当 1 帧 1 个符号，实际 ' + r.overhead.toFixed(3))
  return `播放 ${r.frames} 帧，开销 ${r.overhead.toFixed(3)}x`
})

check('零丢包往返（200KB，强制切 3 块）', () => {
  const r = fountainRoundTrip(200 * 1024, 1400, 0, 64)
  assert(r.blocks >= 3, '应切成至少 3 块，实际 ' + r.blocks)
  assert(r.overhead <= 1.01, '零丢包开销应接近 1.0')
  return `${r.blocks} 块，播放 ${r.frames} 帧，开销 ${r.overhead.toFixed(3)}x`
})

// 上限取自 shared/test/repair-strategy.bench.js 的实测值，留了一点余量。
// 纯 LT（soliton）在 K=64 丢包 1/3 时要 2.56x，稠密修复符号只要 1.48x。
for (const [loss, maxOverhead] of [
  [3, 1.6],
  [7, 1.35],
  [20, 1.15]
]) {
  check(`丢包 1/${loss} 仍能还原（64KB）`, () => {
    const r = fountainRoundTrip(64 * 1024, 1024, loss, 64)
    assert(
      r.overhead < maxOverhead,
      `帧开销 ${r.overhead.toFixed(3)}x 超过上限 ${maxOverhead}x（发送端要多播太多帧）`
    )
    return `播放 ${r.frames} 帧 / ${r.overhead.toFixed(3)}x`
  })
}

check('重复帧会被识别为线性相关', () => {
  const data = makeData(64 * 1400, 5)
  const sessionId = protocol.makeSessionId(data)
  const plan = protocol.planBlocks(data.length, 1400, 1024)
  const enc = fountain.FountainEncoder(data, plan, sessionId)
  const dec = fountain.FountainDecoder({
    sessionId,
    symbolSize: 1400,
    totalSymbols: plan.totalSymbols,
    blockCount: plan.blockCount,
    totalBytes: data.length
  })
  const sym = enc.symbol(0, 64)
  assert(dec.add(0, 64, sym) === true, '首次应为有效符号')
  assert(dec.add(0, 64, sym) === false, '重复同一 esi 应为无效')
  const sym2 = enc.symbol(0, 64)
  assert(dec.add(0, 64, sym2) === false, '重复同一 esi（重新计算）应为无效')
})

check('确定性：同样的 esi 在两端算出同样的符号', () => {
  const data = makeData(64 * 1400, 11)
  const sessionId = 0x4242
  const plan = protocol.planBlocks(data.length, 1400, 1024)
  const enc = fountain.FountainEncoder(data, plan, sessionId)
  for (const esi of [0, 5, 63, 64, 65, 200, 1234]) {
    const a = enc.symbol(0, esi)
    const b = fountain.BlockEncoder(
      (() => {
        const k = plan.symbolsPerBlock
        const padded = new Uint8Array(k * 1400)
        padded.set(data.subarray(0, k * 1400))
        return padded
      })(),
      plan.symbolsPerBlock,
      1400,
      sessionId,
      0
    ).symbol(esi)
    for (let i = 0; i < a.length; i++) assert(a[i] === b[i], `esi=${esi} 第 ${i} 字节不一致`)
  }
})

check('2MB 大文件解码性能', () => {
  const r = fountainRoundTrip(2 * 1024 * 1024, 1400, 9, 1024)
  assert(r.ms < 15000, '解码过慢：' + r.ms + 'ms')
  return `${r.blocks} 块，${r.ms}ms，开销 ${r.overhead.toFixed(3)}`
})

console.log('\n=== 4. QR 容量 ===')

check('各纠错等级单帧上限', () => {
  const notes = []
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    const max = qr.maxFrameBytes(ecc)
    assert(max > 0, ecc + ' 容量异常')
    notes.push(`${ecc}=${max}B`)
  }
  assert(qr.maxFrameBytes('L') === protocol.MAX_FRAME_BYTES, 'ECC L 上限应为 2953')
  return notes.join(' ')
})

check('1400B 帧 → QR Version 27（125×125）', () => {
  const v = qr.versionFor(1400, 'L')
  assert(v === 27, '应为 v27，实际 v' + v)
  assert(qr.moduleCountForVersion(27) === 125, 'v27 应为 125 模块')
  return 'v27 / 125×125，与 AirFerry 实测一致'
})

console.log('\n=== 5. 整链路：帧 → QR → 像素 → jsQR → 解帧 ===')

check('描述符帧过一遍真实 QR 像素', () => {
  const frame = protocol.encodeDescriptor({
    sessionId: 0x0a0b,
    mode: protocol.MODE_FOUNTAIN,
    symbolSize: 512,
    totalSymbols: 12,
    blockCount: 1,
    totalBytes: 6000,
    name: '整链路测试.bin'
  })
  const matrix = qr.encode(frame, 'M')
  const img = qr.toImageData(matrix, { scale: 3, quiet: 4 })
  const back = scan.decodeFrameFromImage(protocol, img.data, img.width, img.height)
  assert(back, 'jsQR 未识别或 CRC 失败')
  assert(back.type === protocol.TYPE_DESCRIPTOR, 'type 不对')
  assert(back.name === '整链路测试.bin', '文件名不对：' + back.name)
  assert(back.totalBytes === 6000 && back.symbolSize === 512, '字段不对')
  return `v${matrix.version} / ${img.width}px`
})

check('完整文件靠"QR 像素"传完（喷泉码 + 丢帧）', () => {
  const data = makeData(3000, 2024)
  const symbolSize = 200
  const sessionId = protocol.makeSessionId(data)
  const plan = protocol.planBlocks(data.length, symbolSize, 32)
  const enc = fountain.FountainEncoder(data, plan, sessionId)
  const dec = fountain.FountainDecoder({
    sessionId,
    symbolSize,
    totalSymbols: plan.totalSymbols,
    blockCount: plan.blockCount,
    totalBytes: plan.totalBytes
  })

  let shown = 0
  let decoded = 0
  let esi = 0
  let totalPixels = 0
  while (!dec.isComplete) {
    for (let b = 0; b < plan.blockCount && !dec.isComplete; b++) {
      const sym = enc.symbol(b, esi)
      const frame = protocol.encodeDataFrame(sessionId, b, esi, sym)
      const matrix = qr.encode(frame, 'L', qr.versionFor(frame.length, 'L'))
      const img = qr.toImageData(matrix, { scale: 3, quiet: 4 })
      totalPixels += img.width * img.height
      shown++
      if (shown % 6 === 0) continue // 模拟 1/6 的帧没被扫到

      const parsed = scan.decodeFrameFromImage(protocol, img.data, img.width, img.height)
      assert(parsed, `第 ${shown} 帧经过 QR 像素后没能解出来`)
      assert(parsed.sessionId === sessionId, 'sessionId 不对')
      if (dec.add(parsed.blockIndex, parsed.esi, parsed.payload)) decoded++
    }
    esi++
    if (esi > 5000) throw new Error('未收敛')
  }
  const out = dec.assemble()
  assert(out && out.length === data.length, '长度不对')
  for (let i = 0; i < data.length; i++) assert(out[i] === data[i], `第 ${i} 字节不符`)
  return `${data.length}B / 播放 ${shown} 帧 / 有效 ${decoded} 帧 / ${plan.blockCount} 块`
})

check('真实尺寸帧（1400B）也能过像素链路', () => {
  const payload = makeData(1400, 77)
  const frame = protocol.encodeDataFrame(0x9999, 0, 1234, payload)
  const matrix = qr.encode(frame, 'L') // 自动选版本，应为 v27
  const img = qr.toImageData(matrix, { scale: 4, quiet: 4 })
  const back = scan.decodeFrameFromImage(protocol, img.data, img.width, img.height)
  assert(back, '未识别')
  assert(back.esi === 1234, 'esi 不对')
  for (let i = 0; i < payload.length; i++) assert(back.payload[i] === payload[i], '第 ' + i + ' 字节不符')
  return `v${matrix.version} / ${img.width}×${img.height}px`
})

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`)
process.exitCode = fail ? 1 : 0
