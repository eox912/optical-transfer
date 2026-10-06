/**
 * protocol-ext.ts —— SHA-256 摘要怎么放进会话描述符
 *
 * 共享核心的 `protocol.encodeDescriptor()` 支持一个可选的尾部附加区 `extra`
 * （放在文件名之后、CRC 之前；`decodeFrame()` 会原样解析出来）。RaptorQ 模式
 * 用它携带 12 字节 OTI，而顺序分片 / LT 喷泉码完全不使用它。
 *
 * 本插件把 SHA-256 的 **32 字节原始摘要放进 extra**，同时把描述符的 flags
 * 置上 `FLAG_SHA256`。这样：
 *   - 摘要真正"在会话描述符里"，接收端一收到描述符就知道期望摘要（招牌特性）；
 *   - 不占用文件名字段，文件名与扩展名原样保留；
 *   - 另外两个插件的接收端根本不读 extra，只是忽略，所以完全互通、互不破坏；
 *   - 描述符帧远小于数据帧，所有帧仍然共用同一个固定 QR 版本。
 *
 * 注意：`extra.length === 12` 在共享核心里有特殊含义（RaptorQ 的 OTI，
 * codecs.js 靠它区分"真 RaptorQ 流"与"RaptorQ 回退成 LT 的流"）。
 * 所以这里严格按长度区分：32 字节才当摘要，12 字节一律当 OTI。
 */
                                        

                                                    
                                                   
                                                            
                                                            
 (function () {
  'use strict'

  const G      = typeof globalThis !== 'undefined' ? globalThis : {}

  /** SHA-256 原始摘要长度 */
  const DIGEST_BYTES = 32
  /** RaptorQ OTI 长度（共享核心的约定） */
  const OTI_BYTES = 12

  function toHex(bytes            )         {
    let out = ''
    for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
    return out
  }

  function hexToBytes(hex        )             {
    const clean = String(hex || '').replace(/[^0-9a-f]/gi, '')
    const out = new Uint8Array(Math.floor(clean.length / 2))
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16)
    return out
  }

  /** 十六进制摘要 → 描述符 extra 的 32 字节 */
  function digestExtra(hex        )             {
    const bytes = hexToBytes(hex)
    if (bytes.length !== DIGEST_BYTES) {
      throw new Error('SHA-256 摘要长度不对：期望 32 字节，实际 ' + bytes.length)
    }
    return bytes
  }

  /** 描述符 → 摘要十六进制；没声明 FLAG_SHA256 或 extra 不是 32 字节则返回 null */
  function digestFromDescriptor(descriptor     )                {
    if (!descriptor) return null
    const protocol = G.DOT.util.core().protocol
    const flags = descriptor.flags || 0
    if (!(flags & protocol.FLAG_SHA256)) return null
    const extra = descriptor.extra
    if (!extra || extra.length !== DIGEST_BYTES) return null
    return toHex(extra)
  }

  /** extra 是不是 RaptorQ 的 12 字节 OTI */
  function hasOti(descriptor     )          {
    return Boolean(descriptor && descriptor.extra && descriptor.extra.length === OTI_BYTES)
  }

  G.DOT = G.DOT || {}
  ;(G.DOT       ).ext = {
    DIGEST_BYTES,
    OTI_BYTES,
    toHex,
    hexToBytes,
    digestExtra,
    digestFromDescriptor,
    hasOti
  }                 
})()
