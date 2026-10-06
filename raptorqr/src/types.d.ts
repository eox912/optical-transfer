/**
 * types.d.ts —— raptorqr 源码用的全局类型声明
 *
 * 说明：这些声明**只在编辑器/类型检查时有意义**，构建时被整文件跳过（.d.ts 不产出 JS）。
 * 因为构建只做"剥类型"，源码里不能用 enum / namespace / 构造函数参数属性。
 *
 * 所有 .ts 源码都是 classic script（IIFE 挂到全局 RQ 命名空间），不用 ESM：
 * uTools 以本地协议加载页面，`<script type="module">` 会走模块抓取，风险高于收益。
 */

/** 一个码位的绘制区域（设备像素） */
interface RQCodeBox {
  /** 码位序号 0..multiQr-1 */
  index: number
  col: number
  row: number
  x: number
  y: number
  size: number
}

/** 多码并行布局：N 个码位各自的正方形区域，互不重叠 */
interface RQLayout {
  multiQr: number
  width: number
  height: number
  hudHeight: number
  cols: number
  rows: number
  boxSize: number
  boxes: RQCodeBox[]
}

/** 用户可调参数 */
interface RQOptions {
  /** OTP.protocol.MODE_* */
  mode: number
  symbolSize: number
  fps: number
  ecc: string
  /** 并行码数 1 / 2 / 4 */
  multiQr: number
  /** 冗余度百分比，只用于估算耗时 */
  redundancy: number
}

/** 传输耗时预估 */
interface RQEstimate {
  symbolsNeeded: number
  symbolsPerSecond: number
  seconds: number
  text: string
  loops: boolean
}

/** 可扫性报告（由 OTP.codecs.scanHint 得出） */
interface RQScanReport {
  slots: number
  perSlotPx: number
  frameLength: number
  version: number
  modules: number
  pxPerModule: number
  ok: boolean
  advice: string
}

/** 帧参数 + 耗时预估 + 可扫性，全部只依赖"文件字节数"，用来在选文件前就渲染 UI */
interface RQAnalysis {
  bytes: number
  symbolSize: number
  modeKey: string
  plan: {
    totalBytes: number
    symbolSize: number
    totalSymbols: number
    blockCount: number
    symbolsPerBlock: number
    maxBlockSymbols: number
  }
  frameLength: number
  version: number
  modules: number
  symbolLimit: number
  /** true = plan 是按镜像常量预测的；false = 来自真实 sender（WASM 必须走这条） */
  estimatedPlan: boolean
  dataVersion: number
  descriptorVersion: number
  effectiveMultiQr: number
  clampedMultiQr: boolean
  scan: RQScanReport
  estimate: RQEstimate
}

/** 一个码位在一次 tick 里要播的符号坐标 */
interface RQTickCoord {
  index: number
  blockIndex: number
  esi: number
}

/** 一次 tick 编码出来的 N 个 QR 矩阵 */
interface RQTick {
  tickIndex: number
  coords: RQTickCoord[]
  matrices: Array<{ version: number; moduleCount: number; isDark: (r: number, c: number) => boolean }>
}

/** 主面板状态 */
interface RQPanelState {
  action: any
  files: Array<{ name: string; path: string; size: number | null; isDirectory: boolean }>
  entry: { name: string; path: string; bytes: Uint8Array } | null
  options: RQOptions
  analysis: RQAnalysis | null
  /** 真实 sender 的探针信息（WASM 的 plan/symbolSize 只能从它身上拿） */
  probe: { plan: any; symbolSize: number; frameLength: number; descriptor: any } | null
  descriptor: any
  error: string
  notice: string
  savedTo: string
}

declare var RQ: any
declare var OTP: any
declare var utools: any
