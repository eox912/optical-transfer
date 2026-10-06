/**
 * types.ts —— 纯类型文件
 *
 * 这个文件里只有 `export interface` / `export type`，构建时会被
 * module.stripTypeScriptTypes 完全擦掉（剥完只剩注释，因此不产出 dist/types.js）。
 * 它存在的意义是让各个 classic script 之间也能拿到完整的类型提示。
 */

export interface CoreRef {
  protocol: any
  fountain: any
  qr: any
  scan: any
  codecs: any
}

export interface UtilApi {
  root(): any
  core(): CoreRef
  formatBytes(n: number): string
  formatRate(bytesPerSec: number): string
  formatDuration(seconds: number): string
  now(): number
}

export interface ExtApi {
  DIGEST_BYTES: number
  OTI_BYTES: number
  toHex(bytes: Uint8Array): string
  hexToBytes(hex: string): Uint8Array
  /** 十六进制摘要 → 描述符 extra 的 32 字节 */
  digestExtra(hex: string): Uint8Array
  /** 描述符 → 摘要十六进制；没声明 FLAG_SHA256 或 extra 不是 32 字节则返回 null */
  digestFromDescriptor(descriptor: any): string | null
  /** extra 是不是 RaptorQ 的 12 字节 OTI */
  hasOti(descriptor: any): boolean
}

export interface FrameStep {
  kind: 'descriptor' | 'data'
  blockIndex: number
  esi: number
  bytes: Uint8Array
}

export interface Estimate {
  rawRate: number
  usefulRate: number
  seconds: number
  loops: boolean
}

export interface SenderHandle {
  mode: number
  modeKey: string
  backend: string
  symbolSize: number
  fps: number
  ecc: string
  repeatDescriptor: number
  version: number
  frameLength: number
  moduleCount: number
  totalSymbols: number
  blockCount: number
  symbolsPerBlock: number
  sessionId: number
  name: string
  totalBytes: number
  digestHex: string
  flags: number
  loops: boolean
  modeNote: string
  descriptorFrame: Uint8Array
  estimate: Estimate
  next(): FrameStep
  reset(): void
}

export interface SendPlan {
  filePath: string
  name: string
  totalBytes: number
  mode: number
  modeKey: string
  modeLabel: string
  backend: string
  symbolSize: number
  fps: number
  ecc: string
  repeatDescriptor: number
  version: number
  frameLength: number
  moduleCount: number
  totalSymbols: number
  blockCount: number
  symbolsPerBlock: number
  sessionId: number
  digestHex: string
  digestBackend: string
  flags: number
  loops: boolean
  estimate: Estimate
  descriptorFrame: Uint8Array
}

export interface CreateSenderParams {
  bytes: Uint8Array
  name: string
  mode: number
  symbolSize: number
  fps: number
  ecc: string
  repeatDescriptor: number
  sessionId?: number
  digestHex: string
  maxBlockSymbols?: number
}

export interface BuildPlanParams {
  filePath: string
  name: string
  bytes: Uint8Array
  mode: number
  symbolSize: number
  fps: number
  ecc: string
  repeatDescriptor: number
}

export interface DigestResult {
  ok: boolean
  status: 'match' | 'mismatch' | 'unavailable'
  expected: string
  actual: string
  label: string
}

export interface Sink {
  writeAt(offset: number, bytes: Uint8Array): number
  writeAll(bytes: Uint8Array): number
  finish(): any
}

export interface StreamReceiver {
  streaming: boolean
  mode: number
  symbolSize: number
  blockCount: number
  totalSymbols: number
  totalBytes: number
  digestHex: string | null
  unsupported: boolean
  error: string
  readonly progress: number
  readonly received: number
  readonly needed: number
  readonly isComplete: boolean
  readonly rankBytes: number
  readonly blocksDone: number
  feed(frame: any): 'descriptor' | 'digest' | 'data' | 'ignored'
  add(blockIndex: number, esi: number, payload: Uint8Array): boolean
  missing(limit?: number): number[]
  assemble(): Uint8Array | null
}

export interface SessionApi {
  MAX_BYTES: number
  MAX_FRAME_BYTES: number
  assertSendableSize(totalBytes: number): void
  versionForParams(symbolSize: number, ecc: string): number
  versionForBytes(byteLength: number, ecc: string): number
  digestBackend(): string
  sha256Hex(bytes: Uint8Array): Promise<string>
  createSenderHandle(params: CreateSenderParams): SenderHandle
  buildPlan(params: BuildPlanParams): Promise<SendPlan>
  verifyDigest(actualHex: string, expectedHex: string): DigestResult
  assertDigest(actualHex: string, expectedHex: string): DigestResult
  checksumBadge(status: string): { label: string; kind: string }
  estimateFor(
    symbolSize: number,
    fps: number,
    repeatDescriptor: number,
    totalSymbols: number,
    totalBytes: number,
    loops: boolean
  ): Estimate
}

export interface StreamApi {
  createStreamReceiver(descriptor: any, sink: Sink | null): StreamReceiver
}

export interface DomNode {
  tagName: string
  className: string
  textContent: string
  children: DomNode[]
  appendChild(node: DomNode): DomNode
  addEventListener(type: string, fn: (event: any) => void): void
  [key: string]: any
}

export interface DomApi {
  el(tag: string, className?: string, text?: string): any
  clear(node: any): void
  button(label: string, onClick: () => void, variant?: string): any
  kvList(rows: Array<[string, string]>): any
  actions(): any
  toast(message: string, kind?: string): void
  setText(node: any, text: string): void
  on(target: any, type: string, fn: (event: any) => void): void
  byId(id: string): any
  root(): any
  guard<T>(errors: string[] | null, label: string, fn: () => T): T | undefined
}

export interface DotState {
  plan: SendPlan | null
  pending: Promise<any> | null
  mode: number
  symbolSize: number
  fps: number
  ecc: string
  repeatDescriptor: number
  filePath: string
  fileInfo: { path: string; name: string; bytes: number } | null
  digestHex: string
  lastAction: any
  senderOpen: boolean
  progress: any
  errors: string[]
}

export interface DotNamespace {
  util: UtilApi
  ext: ExtApi
  session: SessionApi
  stream: StreamApi
  dom: DomApi
  state: DotState
  booted?: boolean
}
