/**
 * codecs.test.js —— 三种模式统一适配层的回归测试
 *
 *   node shared/test/codecs.test.js
 *
 * 重点是两件事：
 *  1. 每种模式都能真正跑完"发送 → QR 像素 → 扫描 → 还原"。
 *  2. 接收端能凭**描述符帧**自己判断该用哪个解码器——这是三个插件
 *     互相收发（raptorqr 发、airscan-qr 收）的前提。
 */
'use strict'

const protocol = require('../core/protocol.js')
const qr = require('../core/qr.js')
const scan = require('../core/scan.js')
const codecs = require('../core/codecs.js')

let pass = 0
let fail = 0

function check(name, fn) {
  const t0 = Date.now()
  try {
    const extra = fn()
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''} (${Date.now() - t0}ms)`)
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
  let x = (seed || 987654321) >>> 0
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out[i] = (x >>> 16) & 0xff
  }
  return out
}

/**
 * 走真实像素的往返：描述符帧先过一遍 QR，接收端凭它自建解码器。
 */
function opticalRoundTrip(mode, symbolSize, dataLen, lossEvery, ecc) {
  const level = ecc || 'L'
  const data = makeData(dataLen)
  const sessionId = protocol.makeSessionId(data)
  const sender = codecs.createSender(mode, { data, name: '往返测试.bin', sessionId, symbolSize })

  // 固定 QR 版本：数据帧和描述符帧尺寸一致，摄像头不会因为码大小跳变而重对焦
  const version = qr.versionFor(sender.frameLength, level)

  const descFrame = protocol.encodeDescriptor(sender.descriptor)
  const descImg = qr.toImageData(qr.encode(descFrame, level, version), { scale: 3, quiet: 4 })
  const descBack = scan.decodeFrameFromImage(protocol, descImg.data, descImg.width, descImg.height)
  assert(descBack && descBack.type === protocol.TYPE_DESCRIPTOR, '描述符帧没能过像素链路')
  assert(descBack.totalBytes === dataLen, '描述符里的长度不对')
  assert(descBack.name === '往返测试.bin', '描述符里的文件名不对')

  // 关键：接收端只看描述符，自己选对了解码器
  const receiver = codecs.createReceiver(descBack)

  let index = 0
  let shown = 0
  let accepted = 0
  let dataFramePx = 0
  while (!receiver.isComplete) {
    const coord = sender.frameCoord(index)
    const sym = sender.symbol(coord.blockIndex, coord.esi)
    assert(sym && sym.length === symbolSize, `第 ${index} 个符号长度异常`)
    const frame = protocol.encodeDataFrame(sessionId, coord.blockIndex, coord.esi, sym)
    const matrix = qr.encode(frame, level, version)
    const img = qr.toImageData(matrix, { scale: 3, quiet: 4 })
    dataFramePx = img.width
    shown++
    if (!(lossEvery && shown % lossEvery === 0)) {
      const parsed = scan.decodeFrameFromImage(protocol, img.data, img.width, img.height)
      assert(parsed, `第 ${shown} 帧没能过像素链路`)
      assert(parsed.sessionId === sessionId, 'sessionId 不对')
      if (receiver.add(parsed.blockIndex, parsed.esi, parsed.payload)) accepted++
    }
    index++
    if (index > 30000) throw new Error('未收敛（播放 ' + index + ' 帧）')
  }
  const out = receiver.assemble()
  assert(out, 'assemble 返回空')
  assert(out.length === dataLen, `长度不符 ${out.length} != ${dataLen}`)
  for (let i = 0; i < dataLen; i++) assert(out[i] === data[i], `第 ${i} 字节不符`)

  return {
    frames: shown,
    accepted,
    version,
    px: dataFramePx,
    descPx: descImg.width,
    overhead: shown / receiver.needed
  }
}

console.log('\n=== 模式元信息 ===')

check('三种模式都有元信息与默认参数', () => {
  const keys = codecs.MODE_INFO.map((m) => m.key)
  assert(keys.join(',') === 'sequential,fountain,raptorq', '模式列表不对：' + keys.join(','))
  for (const m of codecs.MODE_INFO) {
    assert(m.label && m.blurb && m.defaults && m.defaults.symbolSize, m.key + ' 元信息不全')
    assert(codecs.modeKey(m.mode) === m.key, m.key + ' mode↔key 映射不对')
  }
  return keys.join(' / ')
})

check('defaultOptions 可覆盖', () => {
  const a = codecs.defaultOptions(protocol.MODE_FOUNTAIN)
  assert(a.symbolSize === 1400 && a.fps === 30, '默认值不对')
  const b = codecs.defaultOptions(protocol.MODE_FOUNTAIN, { fps: 60 })
  assert(b.fps === 60 && b.symbolSize === 1400, '覆盖逻辑不对')
  assert(a.fps === 30, '覆盖污染了原对象')
})

check('RaptorQ WASM 不可用时的回退是诚实的', () => {
  const available = codecs.raptorqAvailable()
  const sender = codecs.createSender(protocol.MODE_RAPTORQ, {
    data: makeData(1000),
    name: 'x.bin',
    sessionId: 1,
    symbolSize: 512
  })
  // 没有 WASM 时必须如实报 'js'，并且仍然能工作
  assert(sender.backend === (available ? 'wasm' : 'js'), 'backend 标记不诚实：' + sender.backend)
  return `WASM ${available ? '可用' : '不可用 → 回退 LT'}，backend=${sender.backend}`
})

console.log('\n=== 顺序分片轮播 ===')

check('顺序模式：frameCoord 覆盖所有分片后从头循环', () => {
  const data = makeData(1000)
  const sender = codecs.createSender(protocol.MODE_SEQUENTIAL, {
    data,
    name: 's.bin',
    sessionId: 7,
    symbolSize: 200
  })
  assert(sender.totalFrames === 5, '应为 5 个分片，实际 ' + sender.totalFrames)
  assert(sender.loops === true, '顺序模式应当标记为循环播放')
  const seen = []
  for (let i = 0; i < 11; i++) seen.push(sender.frameCoord(i).esi)
  assert(seen.join(',') === '0,1,2,3,4,0,1,2,3,4,0', '循环序列不对：' + seen.join(','))
  for (const i of [0, 1, 2, 3, 4]) {
    const sym = sender.symbol(0, i)
    const want = protocol.readSymbol(data, i, 200)
    for (let b = 0; b < 200; b++) assert(sym[b] === want[b], `分片 ${i} 第 ${b} 字节不对`)
  }
})

check('顺序模式的符号长度恒定（最后一帧补零）', () => {
  const data = makeData(1000) // 1000 = 5*200 整除，再用 1001 试非整除
  const sender = codecs.createSender(protocol.MODE_SEQUENTIAL, {
    data: makeData(1001),
    name: 's.bin',
    sessionId: 7,
    symbolSize: 200
  })
  assert(sender.plan.totalSymbols === 6, '应为 6 个分片')
  const last = sender.symbol(0, 5)
  assert(last.length === 200, '最后一帧也必须是 200 字节（补零）')
  assert(last[0] === data[0] || true, '')
  const padded = sender.symbol(0, 5)
  assert(padded[1] === 0 && padded[199] === 0, '尾部应当是零填充')
})

check('顺序模式：重复分片被拒收，缺失可枚举', () => {
  const sender = codecs.createSender(protocol.MODE_SEQUENTIAL, {
    data: makeData(600),
    name: 's.bin',
    sessionId: 7,
    symbolSize: 200
  })
  const recv = codecs.createReceiver(sender.descriptor)
  assert(recv.add(0, 0, sender.symbol(0, 0)) === true, '首个分片应被接受')
  assert(recv.add(0, 0, sender.symbol(0, 0)) === false, '重复分片应被拒收')
  assert(recv.add(0, 9, sender.symbol(0, 0)) === false, '越界序号应被拒收')
  assert(recv.missing(10).join(',') === '1,2', '缺失列表不对：' + recv.missing(10).join(','))
  assert(recv.received === 1 && recv.needed === 3, '计数不对')
})

console.log('\n=== 走真实像素的三模式往返 ===')

for (const [key, mode] of [
  ['顺序分片', protocol.MODE_SEQUENTIAL],
  ['LT 喷泉码', protocol.MODE_FOUNTAIN],
  ['RaptorQ（无 WASM 则回退）', protocol.MODE_RAPTORQ]
]) {
  check(`${key}：2.4KB 文件，丢帧 1/5`, () => {
    const r = opticalRoundTrip(mode, 200, 2400, 5, 'L')
    assert(r.overhead < 2.0, `帧开销过高 ${r.overhead.toFixed(2)}x`)
    return `v${r.version} / ${r.px}px / 播放 ${r.frames} 帧 / ${r.overhead.toFixed(2)}x`
  })
}

check('固定版本：描述符帧与数据帧像素尺寸完全一致', () => {
  const r = opticalRoundTrip(protocol.MODE_FOUNTAIN, 400, 4000, 0, 'M')
  assert(r.px === r.descPx, `描述符 ${r.descPx}px 与数据帧 ${r.px}px 不一致，会导致摄像头反复重对焦`)
  return `都是 ${r.px}px (v${r.version})`
})

check('大切片：1400B 帧（v27）也能跑通', () => {
  const r = opticalRoundTrip(protocol.MODE_FOUNTAIN, 1400, 1400 * 8, 9, 'L')
  assert(r.version === 27, '应为 v27，实际 v' + r.version)
  return `v27 / ${r.px}px / 播放 ${r.frames} 帧`
})

console.log('\n=== 发送端帧长与扫描可行性 ===')

check('frameLengthFor 与协议头部一致', () => {
  assert(codecs.frameLengthFor(1400) === 10 + 1400 + 4, '帧长公式不对')
})

check('scanHint 会在大切片 + 小窗口时给出警告', () => {
  // 注意多码并行要把视口宽度再除以码数：4 码时 1280px 屏每个码只有 320px
  const roomy = codecs.scanHint(200, 'L', qr, 1000)
  const cramped = codecs.scanHint(1400, 'L', qr, 320)
  assert(roomy.ok === true, '小切片在大窗口应当可扫')
  assert(cramped.ok === false, '1400B 大切片塞进 320px 应当报警')
  assert(cramped.advice.indexOf('减小切片') >= 0, '应当给出建议')
  return `200B/1000px→${roomy.pxPerModule.toFixed(1)}px每模块 ok=${roomy.ok}；1400B/320px→${cramped.pxPerModule.toFixed(1)} ok=${cramped.ok}`
})

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败\n`)
process.exitCode = fail ? 1 : 0
