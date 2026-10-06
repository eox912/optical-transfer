/**
 * session.ts —— 发送端会话：描述符、摘要、帧序列、速率估算
 *
 * 这是本插件的"内容层"，页面只负责把它渲染出来。
 *
 * 关键约定（规范第 1 节）：先算出一个固定的 QR 版本，之后**所有帧
 * （描述符帧 + 数据帧）都用这个版本渲染**，每帧像素尺寸完全一致，
 * 摄像头不会因为码大小跳变而反复重对焦。
 *
 * 版本要按 max(数据帧长度, 描述符帧长度) 取：描述符里带着文件名和
 * 32 字节 SHA-256 摘要，小切片 + 长文件名时描述符可能反而比数据帧长，
 * 只按数据帧算版本会让描述符帧容量溢出（qrcode-generator 溢出抛的是字符串）。
 */
import type {
  CreateSenderParams,
  BuildPlanParams,
  DigestResult,
  Estimate,
  SendPlan,
  SenderHandle,
  SessionApi
} from './types.ts'

/* classic script 之间共享同一个全局词法作用域（同一个 <script> 作用域链），
   所以每个模块都用 IIFE 把自己的名字关起来，只通过 globalThis.DOT 对外暴露。
   这与 shared/core/*.js 的写法一致；不这样做，两个文件里的 top-level const 会直接
   抛 'Identifier has already been declared'，插件在浏览器里会整体白屏。 */
;(function () {
  'use strict'

  const G: any = typeof globalThis !== 'undefined' ? globalThis : {}
  const DOT: any = (G.DOT = G.DOT || {})

  /** 本插件的硬上限：64MB */
  const MAX_BYTES = 64 * 1024 * 1024

  function protocol(): any {
    return DOT.util.core().protocol
  }
  function codecs(): any {
    return DOT.util.core().codecs
  }
  function qrlib(): any {
    return DOT.util.core().qr
  }

  /* ------------------------------------------------------------------ */
  /*                              参数校验                                */
  /* ------------------------------------------------------------------ */

  function assertSendableSize(totalBytes: number): void {
    if (typeof totalBytes !== 'number' || !isFinite(totalBytes) || totalBytes < 0) {
      throw new Error('文件大小非法：' + totalBytes)
    }
    if (totalBytes > MAX_BYTES) {
      throw new Error('超出 64MB 上限（' + DOT.util.formatBytes(totalBytes) + '）')
    }
  }

  /** 给定帧字节数求最小 QR 版本，并挡住超出 Version 40 容量的切片 */
  function versionForBytes(byteLength: number, ecc: string): number {
    const max = protocol().MAX_FRAME_BYTES
    if (byteLength > max) {
      throw new Error('切片过大：单帧 ' + byteLength + ' 字节，超出 QR 上限 ' + max + ' 字节')
    }
    return qrlib().versionFor(byteLength, ecc)
  }

  /** 只看切片大小时的版本（面板展示用） */
  function versionForParams(symbolSize: number, ecc: string): number {
    if (symbolSize < 1) throw new Error('切片必须大于 0')
    return versionForBytes(codecs().frameLengthFor(symbolSize), ecc)
  }

  /* ------------------------------------------------------------------ */
  /*                              SHA-256                                */
  /* ------------------------------------------------------------------ */

  function digestBackend(): string {
    const subtle = G.crypto && G.crypto.subtle
    if (subtle && typeof subtle.digest === 'function') return 'WebCrypto (crypto.subtle)'
    const bridge = G.utoolsBridge
    if (bridge && typeof bridge.sha256Bytes === 'function') return 'Node crypto（preload 回退）'
    return '不可用'
  }

  /**
   * 计算字节的 SHA-256（十六进制）。
   * 首选 WebCrypto；crypto.subtle 在非安全上下文里会缺失，此时回退到 preload 的
   * Node crypto，并在 UI 上如实显示用的是哪一个（见 digestBackend()）。
   */
  function sha256Hex(bytes: Uint8Array): Promise<string> {
    const subtle = G.crypto && G.crypto.subtle
    if (subtle && typeof subtle.digest === 'function') {
      return Promise.resolve(subtle.digest('SHA-256', bytes)).then((buf: ArrayBuffer) =>
        DOT.ext.toHex(new Uint8Array(buf))
      )
    }
    const bridge = G.utoolsBridge
    if (bridge && typeof bridge.sha256Bytes === 'function') {
      try {
        return Promise.resolve(String(bridge.sha256Bytes(bytes)))
      } catch (err) {
        return Promise.reject(err)
      }
    }
    return Promise.reject(new Error('当前环境没有 crypto.subtle，也没有 preload 的 sha256Bytes 回退'))
  }

  /* ------------------------------------------------------------------ */
  /*                              速率估算                                */
  /* ------------------------------------------------------------------ */

  function estimateFor(
    symbolSize: number,
    fps: number,
    repeatDescriptor: number,
    totalSymbols: number,
    totalBytes: number,
    loops: boolean
  ): Estimate {
    const rawRate = symbolSize * fps
    /* 每 R 个数据帧插 1 个描述符帧，占总帧数的 1/(R+1) */
    const usefulRate = rawRate * (repeatDescriptor / (repeatDescriptor + 1))
    if (loops) {
      /* 顺序分片：一轮 = totalSymbols 帧，按 35% 的丢帧余量估 */
      return { rawRate, usefulRate, seconds: (totalSymbols / fps) * 1.35, loops: true }
    }
    /* 喷泉码：LT 的 ε 经验值取 15% */
    return { rawRate, usefulRate, seconds: (totalBytes * 1.15) / usefulRate, loops: false }
  }

  /* ------------------------------------------------------------------ */
  /*                              发送端会话                              */
  /* ------------------------------------------------------------------ */

  function createSenderHandle(params: CreateSenderParams): SenderHandle {
    const P = protocol()
    const C = codecs()
    const Q = qrlib()
    const bytes = params.bytes
    const symbolSize = params.symbolSize
    const ecc = params.ecc || 'L'
    const fps = params.fps
    const repeatDescriptor = Math.max(1, params.repeatDescriptor || 17)

    assertSendableSize(bytes.length)
    if (symbolSize < 1) throw new Error('切片必须大于 0')

    const sessionId = params.sessionId == null ? P.makeSessionId(bytes) : params.sessionId
    const sender = C.createSender(params.mode, {
      data: bytes,
      name: params.name,
      sessionId,
      symbolSize,
      /* 可选：限制单块符号数。真实用法不需要它（64MB 自然切成几十块），
         主要是为了让测试能在小数据上构造"多块 + 逐块落盘"的场景。 */
      maxBlockSymbols: params.maxBlockSymbols
    })

    const digestHex = String(params.digestHex || '')
    const flags = digestHex ? P.FLAG_SHA256 : 0
    /* 摘要（32 字节）直接作为描述符的 extra —— 见 protocol-ext.ts 的说明 */
    const descriptorFrame = P.encodeDescriptor(
      Object.assign({}, sender.descriptor, {
        flags: flags,
        extra: digestHex ? DOT.ext.digestExtra(digestHex) : null
      })
    )

    const version = versionForBytes(Math.max(sender.frameLength, descriptorFrame.length), ecc)

    const modeKey = C.modeKey(params.mode)
    let modeNote = ''
    if (params.mode === P.MODE_FOUNTAIN && sender.backend === 'js') {
      modeNote = 'JS 内核：LT 喷泉码（本插件的发送端不含 WASM）'
    } else if (params.mode === P.MODE_RAPTORQ && sender.backend !== 'wasm') {
      modeNote = '发送端没有 WASM 内核，RaptorQ 已被面板禁用；这条流其实是 LT'
    }

    let dataIndex = 0
    let sinceControl = 0
    let pendingControl = 1

    function reset(): void {
      dataIndex = 0
      sinceControl = 0
      pendingControl = 1
    }

    function next(): any {
      if (pendingControl === 1) {
        pendingControl = 0
        sinceControl = 0
        return { kind: 'descriptor', blockIndex: 0, esi: 0, bytes: descriptorFrame }
      }
      if (sinceControl >= repeatDescriptor) {
        pendingControl = 1
        return next()
      }
      const coord = sender.frameCoord(dataIndex)
      dataIndex++
      sinceControl++
      const payload = sender.symbol(coord.blockIndex, coord.esi)
      return {
        kind: 'data',
        blockIndex: coord.blockIndex,
        esi: coord.esi,
        bytes: P.encodeDataFrame(sessionId, coord.blockIndex, coord.esi, payload)
      }
    }

    return {
      mode: params.mode,
      modeKey: modeKey,
      backend: sender.backend,
      symbolSize: symbolSize,
      fps: fps,
      ecc: ecc,
      repeatDescriptor: repeatDescriptor,
      version: version,
      frameLength: sender.frameLength,
      moduleCount: Q.moduleCountForVersion(version),
      totalSymbols: sender.plan.totalSymbols,
      blockCount: sender.plan.blockCount,
      symbolsPerBlock: sender.plan.symbolsPerBlock,
      sessionId: sessionId,
      name: sender.descriptor.name,
      totalBytes: sender.descriptor.totalBytes,
      digestHex: digestHex,
      flags: flags,
      loops: Boolean(sender.loops),
      modeNote: modeNote,
      descriptorFrame: descriptorFrame,
      estimate: estimateFor(
        symbolSize,
        fps,
        repeatDescriptor,
        sender.plan.totalSymbols,
        sender.descriptor.totalBytes,
        Boolean(sender.loops)
      ),
      next,
      reset
    }
  }

  /** 主面板用：算出摘要 + 描述符 + 统计，但不把编码器留在内存里 */
  function buildPlan(params: BuildPlanParams): Promise<SendPlan> {
    assertSendableSize(params.bytes.length)
    return sha256Hex(params.bytes).then((digestHex) => {
      const handle = createSenderHandle({
        bytes: params.bytes,
        name: params.name,
        mode: params.mode,
        symbolSize: params.symbolSize,
        fps: params.fps,
        ecc: params.ecc,
        repeatDescriptor: params.repeatDescriptor,
        digestHex: digestHex
      })
      return {
        filePath: params.filePath,
        name: handle.name,
        totalBytes: handle.totalBytes,
        mode: handle.mode,
        modeKey: handle.modeKey,
        modeLabel: codecs().infoFor(handle.mode).label,
        backend: handle.backend,
        symbolSize: handle.symbolSize,
        fps: handle.fps,
        ecc: handle.ecc,
        repeatDescriptor: handle.repeatDescriptor,
        version: handle.version,
        frameLength: handle.frameLength,
        moduleCount: handle.moduleCount,
        totalSymbols: handle.totalSymbols,
        blockCount: handle.blockCount,
        symbolsPerBlock: handle.symbolsPerBlock,
        sessionId: handle.sessionId,
        digestHex: digestHex,
        digestBackend: digestBackend(),
        flags: handle.flags,
        loops: handle.loops,
        estimate: handle.estimate,
        descriptorFrame: handle.descriptorFrame
      } as SendPlan
    })
  }

  /* ------------------------------------------------------------------ */
  /*                              完整性校验                              */
  /* ------------------------------------------------------------------ */

  function verifyDigest(actualHex: string, expectedHex: string): DigestResult {
    const expected = String(expectedHex || '').toLowerCase()
    const actual = String(actualHex || '').toLowerCase()
    if (!expected) {
      return { ok: false, status: 'unavailable', expected: '', actual: actual, label: '发送端未提供摘要' }
    }
    if (actual !== expected) {
      return { ok: false, status: 'mismatch', expected: expected, actual: actual, label: '校验失败' }
    }
    return { ok: true, status: 'match', expected: expected, actual: actual, label: '校验通过' }
  }

  /** 校验并返回结果；不一致时**必须报错**，不允许静默通过 */
  function assertDigest(actualHex: string, expectedHex: string): DigestResult {
    const result = verifyDigest(actualHex, expectedHex)
    if (result.status === 'mismatch') {
      throw new Error(
        'SHA-256 校验失败：接收到的字节与发送端摘要不一致\n  期望 ' +
          result.expected +
          '\n  实际 ' +
          result.actual
      )
    }
    return result
  }

  function checksumBadge(status: string): { label: string; kind: string } {
    if (status === 'match') return { label: '校验通过', kind: 'ok' }
    if (status === 'mismatch') return { label: '校验失败', kind: 'bad' }
    if (status === 'unavailable') return { label: '发送端未提供摘要', kind: 'warn' }
    return { label: '等待校验', kind: 'idle' }
  }

  ;(G.DOT as any).session = {
    MAX_BYTES,
    MAX_FRAME_BYTES: 2953,
    assertSendableSize,
    versionForParams,
    versionForBytes,
    digestBackend,
    sha256Hex,
    createSenderHandle,
    buildPlan,
    verifyDigest,
    assertDigest,
    checksumBadge,
    estimateFor
  } satisfies SessionApi
})()
