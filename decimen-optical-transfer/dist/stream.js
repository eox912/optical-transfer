/**
 * stream.ts —— 接收端解码（支持边收边落盘）
 *
 * 三条路径，按描述符自动选：
 *
 *  1) LT 流式路径（LT 喷泉码；以及 RaptorQ 描述符但**没有 OTI** 时，
 *     说明发送端当时回退成了 LT —— 共享核心 codecs.js 就是这么判定的）
 *     按块直接驱动 shared/core/fountain.js 的 BlockDecoder —— 也就是
 *     codecs.js 里 FountainDecoder 内部用的同一个原语、同一组参数
 *     （k、symbolSize、sessionId、blockIndex 完全一致，数学上等价，测试里有逐字节比对）。
 *     某一块一凑满秩就立刻 writeAt(offset) 写进目标文件并**释放这个解码块**，
 *     内存里只留"还没解出来的块"，不会攒出整个文件。
 *
 *  2) 缓冲路径（顺序分片；带 OTI 的真 RaptorQ）
 *     交给 OTP.codecs.createReceiver（顺序分片槽位 / WASM RaptorQ 解码器），
 *     收齐后 assemble() 拿到字节再落盘。顺序分片本身是单块结构，没有逐块落盘的余地。
 *
 *  3) 解不了（带 12 字节 OTI 的 RaptorQ 流，但本端 WASM 内核不可用）
 *     codecs 会返回 UnsupportedReceiver —— 这里如实把它的 error 透出去，
 *     **绝不**偷偷用 LT 去解（编码方式不同，只会得到垃圾）。
 *
 * 如果描述符声明了 FLAG_SHA256，摘要（32 字节）就在描述符的 extra 里，
 * 这里直接取出来给上层做校验，不需要额外的摘要帧。
 */
                                                                 

                                                    
                                                   
                                                            
                                                            
 (function () {
  'use strict'

  const G      = typeof globalThis !== 'undefined' ? globalThis : {}
  const DOT      = (G.DOT = G.DOT || {})

  function planOf(descriptor     )      {
    const blockCount = Math.max(1, descriptor.blockCount)
    return {
      totalBytes: descriptor.totalBytes,
      symbolSize: descriptor.symbolSize,
      totalSymbols: descriptor.totalSymbols,
      blockCount: blockCount,
      symbolsPerBlock: Math.ceil(descriptor.totalSymbols / blockCount)
    }
  }

  function symbolsInBlock(plan     , blockIndex        )         {
    return Math.max(
      0,
      Math.min(plan.symbolsPerBlock, plan.totalSymbols - blockIndex * plan.symbolsPerBlock)
    )
  }

  /**
   * 能不能用 LT 的 BlockDecoder 流式解？
   * 只有"这条流真的是 LT 编码"才行：
   *   - MODE_FOUNTAIN：是 LT；
   *   - MODE_RAPTORQ 且 extra 里没有 12 字节 OTI：发送端当时回退成了 LT，也是 LT；
   *   - MODE_RAPTORQ 且带 OTI：真 RaptorQ，LT 解不了，必须走 codecs（要 WASM）。
   */
  function canStreamLT(descriptor     , protocol     )          {
    if (descriptor.mode === protocol.MODE_FOUNTAIN) return true
    if (descriptor.mode === protocol.MODE_RAPTORQ && !DOT.ext.hasOti(descriptor)) return true
    return false
  }

  function createStreamReceiver(descriptor     , sink             )                 {
    const core = DOT.util.core()
    const protocol = core.protocol
    const codecs = core.codecs
    const fountain = core.fountain

    const plan = planOf(descriptor)
    const streaming = canStreamLT(descriptor, protocol)
    const digestHex                = DOT.ext.digestFromDescriptor(descriptor)

    let rankTotal = 0
    let blocksDone = 0

    function route(frame     , target     )         {
      if (!frame || frame.sessionId !== descriptor.sessionId) return 'ignored'
      if (frame.type === protocol.TYPE_DESCRIPTOR) return 'descriptor'
      if (frame.type !== protocol.TYPE_DATA) return 'ignored'
      return target.add(frame.blockIndex, frame.esi, frame.payload) ? 'data' : 'ignored'
    }

    if (!streaming) {
      /* -------- 缓冲路径：顺序分片 / WASM RaptorQ / 解不了 -------- */
      const inner = codecs.createReceiver(descriptor)
      const unsupported = inner.backend === 'unavailable' || typeof inner.add !== 'function'
      const buffered      = {
        streaming: false,
        mode: descriptor.mode,
        symbolSize: plan.symbolSize,
        blockCount: plan.blockCount,
        totalSymbols: plan.totalSymbols,
        totalBytes: plan.totalBytes,
        unsupported: unsupported,
        error: inner.error || '',
        digestHex: digestHex,
        get isComplete()          {
          return inner.isComplete
        },
        get progress()         {
          return inner.progress
        },
        get received()         {
          return inner.received
        },
        get needed()         {
          return inner.needed
        },
        get rankBytes()         {
          return inner.received * plan.symbolSize
        },
        get blocksDone()         {
          return inner.isComplete ? plan.blockCount : 0
        },
        add(blockIndex        , esi        , payload            )          {
          return inner.add(blockIndex, esi, payload)
        },
        missing(limit         )           {
          return typeof inner.missing === 'function' ? inner.missing(limit) : []
        },
        assemble()                    {
          return inner.assemble()
        },
        feed(frame     )         {
          return route(frame, buffered)
        }
      }
      return buffered                  
    }

    /* -------- LT 流式路径：逐块解码 + 逐块落盘 + 逐块释放 -------- */
    const decoders        = new Array(plan.blockCount).fill(null)
    for (let b = 0; b < plan.blockCount; b++) {
      const k = Math.max(1, symbolsInBlock(plan, b))
      decoders[b] = fountain.BlockDecoder(k, plan.symbolSize, descriptor.sessionId, b)
    }

    function flushBlock(blockIndex        )       {
      const decoder = decoders[blockIndex]
      if (!decoder || !decoder.isComplete) return
      const blockBytes = decoder.result()
      const offset = blockIndex * plan.symbolsPerBlock * plan.symbolSize
      const length = Math.max(0, Math.min(blockBytes.length, plan.totalBytes - offset))
      if (sink && length > 0) sink.writeAt(offset, blockBytes.subarray(0, length))
      decoders[blockIndex] = null // 关键：立刻释放这一块的符号与解，内存不随文件大小增长
      blocksDone++
    }

    const streamingReceiver      = {
      streaming: true,
      mode: descriptor.mode,
      symbolSize: plan.symbolSize,
      blockCount: plan.blockCount,
      totalSymbols: plan.totalSymbols,
      totalBytes: plan.totalBytes,
      unsupported: false,
      error: '',
      digestHex: digestHex,
      get isComplete()          {
        return blocksDone >= plan.blockCount
      },
      get progress()         {
        return plan.totalSymbols ? rankTotal / plan.totalSymbols : 1
      },
      get received()         {
        return rankTotal
      },
      get needed()         {
        return plan.totalSymbols
      },
      get rankBytes()         {
        return rankTotal * plan.symbolSize
      },
      get blocksDone()         {
        return blocksDone
      },
      add(blockIndex        , esi        , payload            )          {
        if (blockIndex < 0 || blockIndex >= plan.blockCount) return false
        const decoder = decoders[blockIndex]
        if (!decoder) return false // 这一块已经落盘并释放了
        if (payload.length !== plan.symbolSize) return false
        if (!decoder.add(esi, payload)) return false
        rankTotal++
        if (decoder.isComplete) flushBlock(blockIndex)
        return true
      },
      missing()           {
        return []
      },
      assemble()                    {
        /* 流式路径的字节已经在磁盘上，不再攒一份 */
        return null
      },
      feed(frame     )         {
        return route(frame, streamingReceiver)
      }
    }
    return streamingReceiver                  
  }

  ;(G.DOT       ).stream = { createStreamReceiver }                    
})()
