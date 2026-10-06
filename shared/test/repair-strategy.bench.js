/**
 * repair-strategy.bench.js —— 修复符号度数策略的实测对比
 *
 *   node shared/test/repair-strategy.bench.js
 *
 * 衡量指标是**发送端需要播放多少帧**（frames/K），这才是用户能感知的成本：
 * 光学信道是单向的，播放得越久用户盯屏幕的时间越长。
 */
'use strict'

const protocol = require('../core/protocol.js')
const fountain = require('../core/fountain.js')

function runOnce(K, symbolSize, lossEvery, strategy) {
  fountain.setRepairStrategy(strategy)
  const totalBytes = K * symbolSize
  const data = new Uint8Array(totalBytes)
  for (let i = 0; i < totalBytes; i++) data[i] = (i * 31 + 7) & 0xff

  const sessionId = protocol.makeSessionId(data)
  const plan = protocol.planBlocks(totalBytes, symbolSize, 1 << 20) // 强制单块，K 可控
  const enc = fountain.FountainEncoder(data, plan, sessionId)
  const dec = fountain.FountainDecoder({
    sessionId,
    symbolSize,
    totalSymbols: plan.totalSymbols,
    blockCount: plan.blockCount,
    totalBytes
  })

  let frames = 0
  let dependent = 0
  let esi = 0
  const t0 = Date.now()
  while (!dec.isComplete) {
    frames++
    if (lossEvery && frames % lossEvery === 0) {
      // 丢帧：接收端看不到，但发送端的 esi 照样往前走
    } else {
      const sym = enc.symbol(0, esi)
      if (!dec.add(0, esi, sym)) dependent++
    }
    esi++
    if (esi > 500000) throw new Error('未收敛')
  }
  const ms = Date.now() - t0
  const raw = dec.assemble()
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== data[i]) throw new Error('还原数据不符')
  }
  return { frames, ratio: frames / K, dependent, ms }
}

const strategies = ['soliton', 'hybrid', 'dense']
const losses = [0, 3, 7, 20]
const sizes = [64, 256, 1024]

console.log('\n修复符号策略对比：帧数 / K（越小越好），括号内为耗时 ms\n')
console.log('K     丢包     ' + strategies.map((s) => s.padEnd(18)).join(''))
console.log('-'.repeat(70))

for (const K of sizes) {
  for (const loss of losses) {
    const cells = []
    for (const s of strategies) {
      const r = runOnce(K, 512, loss, s)
      cells.push(`${r.ratio.toFixed(3)}x (${r.ms}ms)`.padEnd(18))
    }
    console.log(`${String(K).padEnd(6)}1/${String(loss).padEnd(6)}${cells.join('')}`)
  }
}

console.log('\n编码端 CPU 成本对比（生成 2000 个修复符号，K=1024）：')
for (const s of strategies) {
  fountain.setRepairStrategy(s)
  const K = 1024
  const symbolSize = 512
  const data = new Uint8Array(K * symbolSize)
  const plan = protocol.planBlocks(data.length, symbolSize, 1 << 20)
  const enc = fountain.FountainEncoder(data, plan, 1234)
  const t0 = Date.now()
  for (let i = 0; i < 2000; i++) enc.symbol(0, K + i)
  console.log(`  ${s.padEnd(10)} ${Date.now() - t0} ms`)
}
