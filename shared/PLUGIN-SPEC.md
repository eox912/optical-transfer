# 三个 uTools 插件实现规范（照此执行，不要自行发明）

目标：把"屏幕播放动态二维码 → 摄像头扫描还原"做成完整收发链路，
分三个独立插件文件夹交付，三者协议互通、可以互相收发、可交叉对比。

---

## 1. 共享核心（**已写好并测试通过，只许原样复制，不许改**）

源目录 `../shared/`，每个插件都要把 `core/` 和 `vendor/` 复制进自己的插件根目录
（uTools 打包时整个文件夹就是插件，不能引用插件目录之外的文件）。

| 文件 | 浏览器全局 | 职责 |
|---|---|---|
| `core/protocol.js` | `OTP.protocol` | 帧编解码、CRC32、分块规划 |
| `core/fountain.js` | `OTP.fountain` | LT 喷泉码编解码 |
| `core/qr.js` | `OTP.qr` | QR 生成 + 渲染（含 canvas 多码布局） |
| `core/scan.js` | `OTP.scan` | jsQR 识别 + 解帧 |
| `core/codecs.js` | `OTP.codecs` | **三种模式的统一适配层** |
| `vendor/qrcode-generator.js` | `qrcode` | QR 编码（MIT, Kazuhiko Arase） |
| `vendor/jsQR.js` | `jsQR` | QR 解码（Apache-2.0, cozmo） |

浏览器加载顺序固定：vendor 两个 → core 五个（`codecs.js` 最后）。

### 关键 API

```js
// ---- protocol ----
OTP.protocol.encodeDescriptor({sessionId, mode, symbolSize, totalSymbols, blockCount, totalBytes, name}) -> Uint8Array
OTP.protocol.encodeDataFrame(sessionId, blockIndex, esi, payload) -> Uint8Array
OTP.protocol.decodeFrame(bytes) -> null | {type, sessionId, ...}   // CRC 失败返回 null
OTP.protocol.makeSessionId(data) -> number
OTP.protocol.utf8Encode(str) -> Uint8Array      // 必须用它把文本转字节
OTP.protocol.formatBytes(n) -> string
OTP.protocol.TYPE_DESCRIPTOR / TYPE_DATA
OTP.protocol.MODE_SEQUENTIAL / MODE_FOUNTAIN / MODE_RAPTORQ
OTP.protocol.DATA_HEADER_BYTES

// ---- codecs（发送端）----
const sender = OTP.codecs.createSender(mode, {data, name, sessionId, symbolSize})
sender.descriptor                              // 送给 encodeDescriptor
sender.frameLength                             // 数据帧总长，用来固定 QR 版本
sender.totalFrames                             // 顺序模式是一个循环长度；喷泉码为 Infinity
sender.frameCoord(i) -> {blockIndex, esi}      // 第 i 次播放该取哪个符号
sender.symbol(blockIndex, esi) -> Uint8Array
sender.backend                                 // 'js' | 'wasm'（如实显示，不许假装）

// ---- codecs（接收端）----
const receiver = OTP.codecs.createReceiver(descriptorFrame)  // 凭描述符自动选解码器
receiver.add(blockIndex, esi, payload) -> boolean
receiver.progress / received / needed / isComplete
receiver.assemble() -> Uint8Array | null

// ---- qr ----
OTP.qr.versionFor(byteLength, ecc) -> number    // 最小可容纳版本
OTP.qr.encode(bytes, ecc, version) -> {version, moduleCount, isDark(r,c)}
OTP.qr.drawInto(ctx, qr, x, y, boxSize, opts)   // 多码并行时往指定区域画
OTP.qr.drawToCanvas(canvas, qr, opts)

// ---- scan ----
OTP.scan.decodeFrameFromImage(protocol, rgba, w, h) -> frame | null
OTP.scan.drawScaled(canvas, source, sw, sh, maxWidth) -> ImageData
```

**固定 QR 版本**：发送端先算 `version = OTP.qr.versionFor(sender.frameLength, ecc)`，
之后**所有帧（含描述符帧）都用这个 version 渲染**。这样每帧像素尺寸完全一致，
摄像头不会因为码大小跳变而反复重对焦。这条已被测试覆盖，必须遵守。

---

## 2. uTools 集成（照抄，不要自己发明）

### plugin.json

```json
{
  "main": "index.html",
  "logo": "logo.png",
  "preload": "preload.js",
  "pluginSetting": { "single": true, "height": 620 },
  "features": [
    { "code": "PREFIX-send", "explain": "打开发送面板", "cmds": ["关键词一", "关键词二"] },
    { "code": "PREFIX-receive", "explain": "打开摄像头接收窗口", "cmds": ["关键词三"] },
    { "code": "PREFIX-send-files", "explain": "把选中的文件隔空发送",
      "cmds": [{ "type": "files", "label": "隔空发送这些文件", "maxLength": 50 }] }
  ]
}
```
`PREFIX` 用每个插件自己的前缀（`asq` / `dot` / `rq`），关键词要有辨识度。
`main` 必须是相对路径的 `.html`；`features[].code` 必须唯一。

### preload.js（主窗口）—— 完整模式

```js
const fs = require('fs')
const path = require('path')
const { ipcRenderer } = require('electron')

const api = typeof utools !== 'undefined' ? utools : null
let codeWindow = null      // 发送码窗
let scanWindow = null      // 接收窗口

/** 打开全屏码窗：用显示器的 bounds 手工铺满，比 fullscreen 在各平台更可控 */
function openSenderWindow(payload) {
  if (codeWindow && !codeWindow.isDestroyed()) { try { codeWindow.close() } catch (e) {} }
  const display = api.getPrimaryDisplay()
  const b = display.bounds
  const win = api.createBrowserWindow('sender.html', {
    show: false,
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, alwaysOnTop: true, skipTaskbar: true, autoHideMenuBar: true,
    backgroundColor: '#0b0b0f', closeable: true,
    webPreferences: { preload: 'sender-preload.js' }
  }, () => {
    try { win.setAlwaysOnTop(true, 'screen-saver') } catch (e) {}
    win.show()
    win.webContents.send('otp:start', payload)   // 主窗口 → 子窗口：只能 webContents.send
  })
  codeWindow = win
}

// 子窗口 → 主窗口：utools.sendToParent，这里用 ipcRenderer.on 接
ipcRenderer.on('otp:close-sender', () => { if (codeWindow && !codeWindow.isDestroyed()) codeWindow.close() })
ipcRenderer.on('otp:progress', (event, payload) => { /* 转发给主界面 */ })

window.utoolsBridge = {
  readFile(filePath) { const buf = fs.readFileSync(filePath); return { name: path.basename(filePath), bytes: new Uint8Array(buf) } },
  getPath(name) { try { return api.getPath(name) } catch (e) { return require('os').homedir() } },
  writeFile(target, bytes) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, Buffer.from(bytes)); return target },
  showSaveDialog(options) { return api.showSaveDialog(options) },
  openSenderWindow,
  openScanWindow() { /* 同 openSenderWindow，换成 receiver.html / receiver-preload.js，窗口做成可缩放普通窗口 */ },
  isDev() { return Boolean(api && api.isDev && api.isDev()) },
  platform: process.platform,
  versions: { node: process.versions.node }
}
```

### 子窗口 preload（`sender-preload.js` / `receiver-preload.js`）

```js
const { ipcRenderer } = require('electron')
ipcRenderer.on('otp:start', (event, payload) => {
  window.dispatchEvent(new CustomEvent('otp:start', { detail: payload }))
})
// 也可能在页面脚本就绪前就收到了，所以要缓存一份给页面补取
let lastPayload = null
ipcRenderer.on('otp:start', (event, payload) => { lastPayload = payload })
window.utoolsBridge = {
  getStartPayload: () => lastPayload,
  close: () => { try { utools.sendToParent('otp:close-sender') } catch (e) { window.close() } },
  sendToParent: (channel, data) => { try { utools.sendToParent(channel, data) } catch (e) {} },
  writeFile(filePath, bytes) { /* 需要 fs 时在这里做 */ },
  showSaveDialog(options) { return utools.showSaveDialog(options) }
}
```

**注意**：`createBrowserWindow` 的 `url` 与 `webPreferences.preload` **都是相对路径**。
子窗口要能关闭必须传 `closeable: true`。

---

## 3. 必须避开的坑（本会话已实测确认）

1. **不要给 HTML 加 CSP meta。** uTools 以本地协议加载页面，origin 是 opaque 的，
   `script-src 'self'` 会把 `index.js` 直接拦掉 → 白屏。
2. **`qrcode.stringToBytes` 已被 `core/qr.js` 覆写为 latin1。** 因此
   **任何 JS 字符串都必须先 `OTP.protocol.utf8Encode()` 转成字节**再进协议层，
   否则中文会被按位截断成乱码。已在测试中踩到过。
3. **qrcode-generator 容量溢出时抛的是字符串，不是 Error。**
   `catch (e) { e.message }` 会是 undefined，用 `String(e)`。
4. **WASM 一律不要用 `WebAssembly.instantiateStreaming`，也不要用 CDN。**
   本地协议下 MIME 多半不是 `application/wasm`；且 uTools 发布时禁止请求网络资源。
   正确做法：preload 里 `fs.readFileSync` 成 ArrayBuffer，再 `WebAssembly.instantiate(bytes)`。
5. **运行时基线按 Chromium 91 / Node 14 写**（官方 FAQ 口径）：
   不要用 `Array.prototype.at`、`structuredClone`、`Object.hasOwn`、`??=` 之类。
6. **摄像头**：接收窗口用 `navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}})`，
   插件市场已有「摄像头扫码枪」证明可行。但**必须准备降级**：失败时提示改用
   `utools.screenCapture(...)` 框选截图或导入图片文件来识别。
7. **沙箱**：本机文件沙箱只允许写工作区，`npm`/`cargo` 缓存必须重定向，例如
   `npm --cache /tmp/npm-cache install ...`、`CARGO_HOME=/tmp/cargo`。
8. **发布时清理**：插件目录里不要留 `.git/`、`*.js.map`、`node_modules/`。

---

## 4. 目录结构

### airscan-qr（方案一：零依赖、不需要构建）
```
airscan-qr/
├── plugin.json  logo.png  preload.js
├── index.html  index.js  index.css          # 主控制面板
├── sender.html sender.js sender-preload.js  # 全屏码窗
├── receiver.html receiver.js receiver-preload.js
├── standalone.html                          # 【招牌】单文件版本，浏览器直接打开，收发都在一个文件里
├── core/  vendor/
└── test/plugin.test.js
```

### decimen-optical-transfer（方案二：TypeScript + 构建到 dist）
```
decimen-optical-transfer/
├── package.json          # 只放 scripts，不依赖任何 npm 包
├── build.mjs             # 【零依赖构建】用 Node 内置 module.stripTypeScriptTypes 剥类型
├── src/                  # .ts 源码 + 静态资源
├── dist/                 # 构建产物 = 交给 uTools 的插件目录（含 core/ vendor/）
└── test/plugin.test.js
```
`build.mjs` 参考写法（Node ≥ 22.13 内置，不要引入 esbuild/vite）：
```js
import { stripTypeScriptTypes } from 'node:module'
// 读 src/**/*.ts → stripTypeScriptTypes(code, {mode:'strip'}) → 改写 import 说明符 .ts→.js → 写 dist/
// 静态资源（html/css/logo.png/core/vendor）直接 copyFileSync
```
`package.json` 的 scripts：`"build": "node build.mjs"`、`"test": "node test/plugin.test.js"`。

### raptorqr（方案三：Rust→WASM + 多码并行）
```
raptorqr/
├── package.json  build.mjs   # 同方案二
├── core-rs/                  # Rust crate（cdylib，目标 wasm32-unknown-unknown）
│   ├── Cargo.toml  src/lib.rs
├── scripts/build-wasm.sh     # 编译 Rust（需要 rustup target add wasm32-unknown-unknown）
├── src/  dist/
└── test/plugin.test.js
```
**WASM 集成要求**：`vendor/raptorq.core.js` 负责加载 `vendor/raptorq.core.wasm`，
暴露 `OTP.raptorqCore = { isAvailable(), createEncoder(data, plan, sessionId), createDecoder(descriptor) }`。
**wasm 缺失或加载失败时必须 `isAvailable()` 返回 false**，`codecs.js` 会自动回退到 LT 喷泉码，
UI 上要如实显示"WASM 未启用 → 已回退 LT"，不许假装。

---

## 5. 三个方案的差异化要求（这是交付的核心价值，不能做成三胞胎）

| | airscan-qr | decimen-optical-transfer | raptorqr |
|---|---|---|---|
| 招牌模式 | `MODE_SEQUENTIAL` | `MODE_FOUNTAIN` | `MODE_RAPTORQ` |
| 默认切片 | 400B | 1400B | 1400B |
| 默认帧率 | 10 fps | 30 fps | 60 fps |
| 构建 | 无，扁平文件 | TS → dist | TS + Rust → dist |
| 独有 | `standalone.html` 单文件；切片 200–800B、帧率 1–30 可调；"智能补发"= 轮播时优先重播缺失序号 | SHA-256 完整性校验；保留文件名与扩展名；64MB 上限；边收边落盘 | 多码并行 1/2/4 码；QR 版本/帧率/冗余度可调；WASM 核 |

**所有插件的接收端都必须支持全部三种模式**（`OTP.codecs.createReceiver` 已自动处理），
并且 UI 上要能显示"当前收到的是哪种模式"。

发送端要提供模式切换（默认自己的招牌模式），这样才能做交叉对比。

---

## 6. 测试要求（硬性）

每个插件必须带 `test/plugin.test.js`，用 **Node + 桩 DOM** 跑通主流程，
不得只做语法检查。参考第一轮 `demo-utools-plugin` 里已经验证过的桩 DOM 写法
（`createNode` / `walk` / `findByText` / 假 `utools` 对象）。

至少要覆盖：
1. 主面板在无 action 时能渲染；
2. 匹配指令带文件进入时，能读文件并算出正确的描述符（检查 totalBytes / totalSymbols / name）；
3. 三种模式各自 `createSender` → `createReceiver` 的**内存往返**（不经过像素）能还原字节；
4. 经过**真实 QR 像素**的往返（用 `OTP.qr.toImageData` + `OTP.scan.decodeFrameFromImage`）；
5. 发送端所有帧（含描述符）的 QR 模块数一致；
6. 参数边界：1 字节文件、非整除切片、超大切片。

跑测方式：`node <plugin>/test/plugin.test.js`，退出码非 0 视为失败。

---

## 7. RaptorQ WASM 内核的接入（三个插件都要带，缺了就收不了 RaptorQ 流）

`shared/vendor/` 里有三个文件必须一起复制进插件的 `vendor/`：

| 文件 | 说明 |
|---|---|
| `raptorq.core.wasm` | Rust 编译产物（241 KB，**零导入项**，不需要 wasm-bindgen 胶水） |
| `raptorq.core.js` | 加载器 + C ABI 封装，暴露 `OTP.raptorqCore` |
| `qrcode-generator.js` / `jsQR.js` | 同前 |

**为什么三个插件都要带**：RaptorQ 编码出来的流**只有 RaptorQ 解码器能解**，
LT 解码器硬解只会得到垃圾。所以只要发送端可能用 RaptorQ（raptorqr 的默认模式），
所有插件的接收端就都必须具备 WASM 内核，否则交叉收发会失败。
`codecs.js` 已经做了自描述：描述符的 `extra` 区里带 12 字节 OTI，
带 OTI 的流没有内核时会返回 `UnsupportedReceiver` 并给出明确错误，绝不静默解错。

**接入方式（照抄）**：

1. HTML 里脚本顺序必须是 vendor 全部 → core 全部（`codecs.js` 最后）：
```html
<script src="vendor/qrcode-generator.js"></script>
<script src="vendor/jsQR.js"></script>
<script src="vendor/raptorq.core.js"></script>
<script src="core/protocol.js"></script>
<script src="core/fountain.js"></script>
<script src="core/qr.js"></script>
<script src="core/scan.js"></script>
<script src="core/codecs.js"></script>
<script src="app.js"></script>
```

2. 页面初始化时必须 **await** 一次加载（加载失败是静默降级，不会抛异常）：
```js
await OTP.raptorqCore.load()          // 默认取 vendor/raptorq.core.wasm
// 或：不走 fetch，用 preload 读文件（更稳，绕开本地协议的 MIME 问题）
await OTP.raptorqCore.load({ readBytes: (p) => window.utoolsBridge.readBinary(p) })
```

3. UI 上如实展示后端，不许假装：
```js
const s = OTP.codecs.raptorqStatus()
// s.available / s.wasmBytes / s.error
// 发送端：sender.backend === 'wasm' ? 'RaptorQ (WASM)' : '已回退 LT (JS)'
// 接收端：receiver.backend === 'unavailable' 时把 receiver.error 显示出来
```

**注意**：`load()` 永远不 reject，所以可以无脑 await；但它也**不会**在
`isAvailable()` 为 false 时假装成功——`codecs.js` 会据此自动选择 LT 回退。

---

## 8. 交付前自检清单

- [ ] 所有引用的文件都存在（plugin.json / html 里的 src/href / preload 路径）
- [ ] HTML 里没有 CSP meta
- [ ] 没有把 JS 字符串直接塞进协议层（必须 utf8Encode）
- [ ] 没有引用插件目录之外的文件
- [ ] `node test/plugin.test.js` 全绿
- [ ] `node --check` 通过所有 .js
- [ ] plugin.json 是合法 JSON，features[].code 唯一
- [ ] 接收端三种模式都能解
- [ ] WASM/后端能力如实上报，没有假装
