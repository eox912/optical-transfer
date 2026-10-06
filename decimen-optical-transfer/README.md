# decimen-optical-transfer（方案二 · 光码隔空传输）

uTools 插件：把文件编码成**动态二维码流**在屏幕上播放，另一台设备的摄像头扫描还原。
定位是三个方案里**功能最完整**的一个。

| | |
|---|---|
| 招牌模式 | `MODE_FOUNTAIN`（LT 喷泉码），1400 B 切片 / 30 fps |
| 完整性 | SHA-256 摘要写进**会话描述符的 `extra`**，接收端还原后校验并在 UI 明示通过/失败 |
| 文件名 | 描述符携带 UTF-8 文件名，保存时用 `utools.showSaveDialog` 默认填原名（含扩展名） |
| 上限 | 64 MB，LT 模式按块解码、**逐块随机写盘**（边收边落盘），不使用整体缓冲 |
| 构建 | TypeScript → `dist/`，**零依赖**（Node 内置 `module.stripTypeScriptTypes`） |
| 接收 | 支持全部三种模式：顺序分片 / LT 喷泉码 / 真 RaptorQ（WASM，带 OTI 的流） |

## 目录

```
├── package.json        # 只有 scripts，无任何依赖
├── build.mjs           # 零依赖构建 + 构建期自检
├── src/                # .ts 源码与静态资源
│   ├── plugin.json  logo.png  app.css  index.css  sender.css  receiver.css
│   ├── index.html/.ts         # 主控制面板：选文件、模式/切片/帧率、开码窗
│   ├── sender.html/.ts        # 全屏置顶码窗：固定 QR 版本 + 预渲染队列
│   ├── receiver.html/.ts      # 摄像头接收窗：进度、吞吐、剩余时间、校验结果
│   ├── preload.js             # 主窗口：读文件 / SHA-256 / 开子窗口 / 事件转发
│   ├── sender-preload.js      # 码窗：readFile / otp:start / close
│   ├── receiver-preload.js    # 接收窗：落盘管道 openSink/writeAt、流式 SHA-256、wasm 读取
│   ├── util.ts protocol-ext.ts session.ts stream.ts dom.ts types.ts
├── dist/               # 构建产物＝交给 uTools 的插件目录（含 core/ 与 vendor/）
└── test/plugin.test.js
```

## 用法

```bash
node build.mjs              # 构建（含自检：JSON/引用/CSP/残留 import）
node test/plugin.test.js    # 18 项测试
```

uTools 开发者工具里「选择工程「plugin.json」文件夹」指向 **`dist/`** 里的 `plugin.json`。

指令：`隔空传输 DOT` / `光码传输`（打开发送面板）、`扫描光码 DOT` / `光码接收`（开接收窗）、
文件管理器选中文件后超级面板 → `隔空发送（DOT）`。

## 关键实现说明

### 1. 摘要放进描述符的 `extra`

`shared/core/protocol.js` 的描述符格式是
`magic|type|sessionId|mode|flags|symbolSize|totalSymbols|blockCount|totalBytes|nameLen|name|extra|CRC32`，
其中 `extra` 是可选尾部附加区。本插件把 **32 字节 SHA-256 原始摘要**放进去，并把 `flags` 置上
`FLAG_SHA256`；接收端一收到描述符就知道期望摘要。

为什么不用文件名承载、也不另开摘要帧：`extra` 是协议里唯一合法的附加区，放这里既不污染文件名
（`name` 字段留给原名），也不需要额外帧；另外两个插件的接收端根本不读 `extra`，所以互不破坏。
注意 `extra.length === 12` 在共享核心里是 **RaptorQ 的 OTI**，本插件按长度严格区分，
绝不会把 OTI 当摘要。

### 2. 固定 QR 版本

版本取 `max(数据帧长度, 描述符帧长度)` 再算最小版本，之后**所有帧都用它渲染**，
保证像素尺寸一致、摄像头不来回重对焦。描述符带着文件名与摘要，小切片 + 长文件名时
可能比数据帧还长，所以不能只按数据帧算（否则容量溢出，而 qrcode-generator 抛的是字符串）。

### 3. 接收端：边收边落盘

LT 模式按块驱动 `OTP.fountain.BlockDecoder`（与 `codecs.js` 里 `FountainDecoder` 用的
同一个原语、同一组参数，测试里有逐字节比对）：某一块一凑满秩就立刻 `writeAt(offset)` 写到
目标文件对应偏移并**释放这个解码块**。顺序分片是单块结构，只能收齐再写（UI 里会写明）。
校验用 preload 的 `crypto.createHash` 流式摘要，64 MB 文件也只占 1 MB 缓冲。

### 4. WASM 边界（如实上报）

- **发送端**（`index.html` / `sender.html`）不加载 `vendor/raptorq.core.js`，
  编码内核是纯 JS 的 LT 喷泉码，因此面板里 RaptorQ 发送是**禁用**的，不假装可用。
- **接收端**（`receiver.html`）加载 WASM，所以**三种模式都能解**（含带 OTI 的真 RaptorQ 流）。
  加载失败时如实显示 `codecs.raptorqStatus()` 的 error，前两种模式照常工作。
- wasm 由 preload `fs.readFileSync` 读成字节再交给 `WebAssembly.instantiate`
  （不用 `instantiateStreaming`、不走 CDN，规范第 3 节坑 4）。

### 5. classic script，不是 ESM

uTools 以本地协议加载页面，模块脚本在 opaque origin 下有被 CORS 拦掉的风险，
所以所有页面脚本都是 classic `<script>`，跨文件只通过 `globalThis.DOT` 命名空间通信。
每个模块都用 IIFE 关住自己的名字——**这一步不能省**：classic script 共享同一个全局词法作用域，
两个文件各写一个 top-level `const G` 就会直接抛 `Identifier 'G' has already been declared`，
整个插件白屏。`build.mjs` 会在产物里检查是否残留 ESM `import/export` 并直接失败。
