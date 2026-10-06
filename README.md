# 光学隔空传输 · 三个 uTools 插件

把文件/文本编码成**连续播放的动态二维码**在屏幕上播，另一端用**摄像头扫描**还原。
单向光学信道，不依赖网络、蓝牙、数据线——适合物理隔离或跨隔离网传小文件。

三个方案做成三个**独立插件**，共享同一份协议核心，因此**可以互相收发、交叉对比**：
用 raptorqr 发、用 airscan-qr 收，验证的是同一套帧协议。

```
.
├── airscan-qr/                 方案一：纯 HTML/JS 零依赖，不需要构建
├── decimen-optical-transfer/   方案二：TypeScript + 构建，LT 喷泉码 + SHA-256
├── raptorqr/                   方案三：Rust→WASM 真 RaptorQ + 多码并行
├── shared/                     共享协议核心、测试、实现规范、浏览器替身层
├── android-app/                安卓 App（Capacitor，复用同一份核心与 UI）
├── desktop-app/                Windows 桌面版（Electron，真置顶码窗 + 屏幕不睡眠）
├── browser-extension/          浏览器扩展（Chrome/Edge MV3，置顶码窗 + 屏幕常亮）
├── demo-utools-plugin/         第一轮那个 uTools 骨架 demo（与本项目无关，可删）
├── browser.sh                  起本地静态服务器，免登录在浏览器里跑三个插件
└── verify.sh                   一键验证（一致性 + 语法 + 全部测试 + 跨插件互通）
```

---

## 一、三个方案的区别

| | **airscan-qr** | **decimen-optical-transfer** | **raptorqr** |
|---|---|---|---|
| 招牌模式 | 顺序分片轮播 | LT 喷泉码 | **RaptorQ (RFC 6330)** |
| 编码核心 | JS | JS | **Rust → WASM** |
| 默认切片 / 帧率 | 400 B / 10 fps | 1400 B / 30 fps | 1400 B / 60 fps |
| 构建 | 无，扁平文件直接可用 | `node build.mjs` → `dist/` | `node build.mjs` + Rust → `dist/` |
| 独有能力 | `standalone.html` 单文件版（浏览器直接打开就能用）；切片 200–800 B、帧率 1–30 可调 | SHA-256 完整性校验；保留文件名与扩展名；最大 64 MB；边收边落盘 | **1/2/4 码并行播放**；QR 版本/帧率/冗余度可调；WASM 核 |
| 接收端能解的模式 | 顺序 + LT（**收不了真 RaptorQ**，会如实拒绝） | 三种全支持 | 三种全支持 |
| 自带 WASM 核 | ✗（有意不带，保持身份） | ✓ | ✓ |

发送端可切换模式（默认各自的招牌模式），接收端凭描述符自描述。这样才能做真正的交叉对比。

**关于"方案一为什么有意不带 WASM 核"**：它的身份是"纯 HTML/JS、零依赖、单文件可自包含"
（`standalone.html` 双击即用就是靠这个）。塞进 241 KB 的 wasm 会同时破坏这两个卖点。
代价是它收不了真 RaptorQ 流——但它会**如实拒绝并说明原因**，而不是偷偷用 LT 解出垃圾数据。
这个边界有专门的测试守着（`interop.test.js` 第 4 节）。

---

## 二、实测数据（全部可用 `./verify.sh` 复现）

### 1. 走真实 QR 像素的三模式对比

2.4 KB 文件、200 B 切片、模拟丢掉 1/5 的帧，帧要真的经过
「编码 → 渲染成像素 → 独立解码器 jsQR 读回 → CRC 校验 → 解码还原」：

| 模式 | 需要播放的帧数 | 相对源符号数 |
|---|---|---|
| 顺序分片轮播 | 22 帧 | **1.83×** |
| LT 喷泉码 | 17 帧 | **1.42×** |
| RaptorQ (WASM) | 17 帧 | **1.21×** |

顺序模式没有喷泉编码，丢了只能等下一轮，所以明显吃亏；这也是"为什么值得上喷泉码"的直接证据。

### 2. QR 容量（决定了每帧能塞多少）

| 纠错等级 | 单帧上限（Byte 模式） |
|---|---|
| L | **2953 B** |
| M | 2331 B |
| Q | 1663 B |
| H | 1273 B |

1400 B 的帧 → **QR Version 27（125×125 模块）**。
这个数字与 AirFerry 工程文档里"1464 B 帧 → V27"的记录吻合，说明编码/渲染路径与真实工程一致。

### 3. LT 喷泉码的修复符号策略（实测调优）

纯 LT（Robust Soliton）在"只差最后几个符号"时效率很差：缺失变量只剩 m 个时，
一个度为 d 的修复符号能覆盖到它的概率只有约 `m·d/K`。实测 K=64、丢包 1/3：

| 修复符号度数策略 | 需要播放的帧数 | 编码 CPU（2000 个符号） |
|---|---|---|
| 纯 Robust Soliton | 2.56× | 10 ms |
| **稠密（K/2 度）** | **1.48×** | 391 ms |

稠密修复符号把帧数砍掉约 1/3，而编码端每符号只要 0.2 ms——60 fps 下占用 CPU 约 1%，
完全划算，所以本项目的默认策略是稠密。

### 4. RaptorQ (WASM) 的真实收益

| | RaptorQ (WASM) | JS 版稠密 LT |
|---|---|---|
| 1 MB 零丢包解码 | **1 ms** | 7 ms |
| 2 MB 丢包 1/11 解码 | **20 ms** | 99 ms |
| 接收端实际需要的符号数 / K | 1.000× | 1.000× |

这里有个**反直觉的结论**：我这份稠密 LT 解码器在"接收端实际需要的符号数"上
已经和 RaptorQ 一样不浪费（都是 1.000×），**所以 RaptorQ 的真正优势是解码速度（约 5–7 倍），
而不是修复符号开销**。WASM 的价值在于把 O(K²) 的消元从 JS 挪到 Rust。

> 需要说明的是：常见说法里"RaptorQ 开销远低于 LT"，在**稠密修复符号 + 稠密消元**
> 这套实现下并不成立。这个结论是实测出来的，不是照搬宣传。

### 5. 跨插件互通

`shared/test/interop.test.js` 会加载**三个插件各自的 core/ 与 vendor/**（不是 shared/），
然后交叉配对跑真实像素往返，共 15 项断言：

```
✓ raptorqr → decimen      [RaptorQ/WASM]      ✓ raptorqr → decimen   [LT 喷泉码]
✓ airscan-qr → decimen    [顺序分片]           ✓ decimen → raptorqr   [LT 喷泉码]
✓ decimen → airscan-qr    [LT 喷泉码]          ✓ airscan-qr → raptorqr [顺序分片]
✓ raptorqr → decimen      [1400B 大切片 / RaptorQ]
✓ raptorqr → airscan-qr   [RaptorQ] → 按设计**如实拒绝**，并断言没有产出任何数据
```

同时做**字节级一致性比对**：三个插件的 `core/`（5 个文件）必须完全一致，
公共 `vendor/` 库一致，WASM 核在需要它的两个插件里一致、且**必须不存在**于方案一。
谁偷偷改了协议，这个测试就会红。

### 6. 交付验证

```bash
./verify.sh     # → ✅ 全部通过（18 项）
```

| 层级 | 测试数 |
|---|---|
| 共享核心（协议 / 喷泉码 / 三模式 / RaptorQ WASM） | 43 |
| classic script 全局重名检查（白屏级，26 个页面） | 26 |
| 跨插件互通验收 | 15 |
| 浏览器替身层（含 SHA-256 已知答案测试） | 21 |
| airscan-qr / decimen / raptorqr 各自的插件测试 | 23 / 18 / 40 |
| 安卓 App | 15 |
| 桌面版（含跨文件契约与自我解析 thenable 回归） | 19 |
| 浏览器扩展（含降级链桩 DOM 实测与 manifest 三方契约） | 36 |
| **合计** | **256 项，0 失败** |

另有一次**真 Electron 进程的冒烟测试**（`cd desktop-app && npm run smoke`，14 项断言，
需要图形环境所以不进 verify.sh）：真 WASM 加载、真 RaptorQ 往返、真 QR 像素往返、
全屏置顶、屏幕不睡眠。本机连跑 3 次稳定通过。

---

## 三、接进 uTools

> **不想登录 uTools？** 直接跳到下面第四节「浏览器模式」——三个插件都能在纯浏览器里跑，
> 一个账号都不用登。uTools 的「接入开发」和「打包 UPXS」都在开发者工具里，绕不开登录。

uTools → 搜索「uTools 开发者工具」→ 新建项目 → **选择工程「plugin.json」文件夹**：

| 方案 | 要选的 plugin.json |
|---|---|
| airscan-qr | `airscan-qr/plugin.json` |
| decimen-optical-transfer | 先 `cd decimen-optical-transfer && node build.mjs`，再选 `dist/plugin.json` |
| raptorqr | 先 `cd raptorqr && node build.mjs`，再选 `dist/plugin.json` |

然后「接入开发」→「打开」。改完代码按 `Ctrl/Cmd + R` 刷新；改 `plugin.json` 需要重新接入。

**触发方式**：搜索插件关键词打开控制面板；或在文件管理器选中文件后唤出超级面板，
选择"隔空发送"直接开播。发送端会开一个**全屏无边框置顶窗口**专门播码
（`utools.createBrowserWindow`），主窗口负责选文件和调参数。

### 编译 RaptorQ 的 Rust 核（可选）

`raptorqr` 的 WASM 核已经**预编译好并随插件提供**（`vendor/raptorq.core.wasm`，241 KB），
开箱即用。只有你要改核心算法时才需要重新编译：

```bash
rustup target add wasm32-unknown-unknown
cd raptorqr && ./scripts/build-wasm.sh
```

> 国内网络提示：官方源 `static.rust-lang.org` 实测只有 ~50 KB/s，
> 换清华镜像快到秒级：
> `export RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup`
> （阿里云的 Rust 源实测停在 1.96，会 404，别用。）

如果 WASM 缺失或加载失败，插件会**如实显示"已回退 LT (JS)"**并继续工作，不会假装。

---

## 四、浏览器模式（完全不需要登录）

uTools 的「接入开发」与「打包离线安装包」都在开发者工具里，绕不开登录账号。
但三个插件的页面本身几乎不直接依赖 uTools——它们调用的是 preload 注入的
`window.utoolsBridge` 与 `window.utools`。所以本项目额外提供了一份**浏览器替身层**：
注入同一套 API 的浏览器实现，**页面源码一个字都不用改**。

```bash
./browser.sh          # 起本地静态服务器并打印三个地址
```

| 方案 | 浏览器地址 |
|---|---|
| airscan-qr | `http://localhost:8000/airscan-qr/index.browser.html` |
| decimen | `http://localhost:8000/decimen-optical-transfer/dist/index.browser.html` |
| raptorqr | `http://localhost:8000/raptorqr/dist/index.browser.html` |

用法：**把文件拖到页面任意位置**即可发送；右上角浮动条可「选择文件发送」/「打开接收窗口」。

### 为什么必须用 localhost 而不是双击 file://

- 方案二/三的接收端要加载 `vendor/raptorq.core.wasm`，而 `file://` 下 Chromium
  会直接拒绝 `fetch` 该 scheme；
- `localhost` 是安全上下文，`fetch`、`crypto.subtle`、`getUserMedia` 都能用。

例外：方案一的 `airscan-qr/standalone.html` 是**自包含单文件**（0 个外部引用），
双击用 Chrome 打开就能用，摄像头在 `file://` 下也可用——这正是它的设计卖点。

### 替身层做了什么

| uTools 能力 | 浏览器实现 |
|---|---|
| `showOpenDialog` / `readFile` / `statPath` / `sha` / `sha256Bytes` | 虚拟文件系统（VFS）：合成假路径 + 内存字节 |
| `showSaveDialog` + `writeFile` | `Blob` + `URL.createObjectURL` 触发下载（保留原文件名） |
| `createBrowserWindow` / `openSenderWindow` / `openScanWindow` | 同源 **iframe** 全屏承载，payload 走对象引用（不做序列化） |
| `sendToParent` / `getLastProgress` | 同页跨帧直连 |
| `screenCapture` | `getDisplayMedia()` 抓一帧 |
| `getUserMedia` | 浏览器原生 |
| `copyText` / `showNotification` / `dbStorage` | clipboard / toast / localStorage |
| `plugin.json` 的指令表 | 启动时 `fetch('plugin.json')` 读出，据此决定选完文件派发到哪个 code |

两个关键设计：

1. **`showOpenDialog` 在 uTools 里是同步 API，而浏览器选文件是异步的。** 替身立刻返回 `[]`，
   等用户真的选完文件后**派发插件进入事件**，复用插件本来就支持的 `*-send-files`
   匹配指令链路——这样不用改任何页面逻辑。
2. **面板页额外挂了一个"外壳"**（`browser-shell.js`：浮动条 + 整页拖放区）。
   必须有它，因为方案一的面板压根没有 `showOpenDialog`——它的文件来自 uTools 的
   "匹配文件"指令，没有外壳就完全没法在浏览器里选文件。

### 怎么验证的（没有浏览器也能建立可信度）

`shared/browser/browser.test.js`（21 项）用两招守这条链路：

1. **把替身真的加载进桩 DOM**，内省它实际挂上去的键（而不是用正则猜它实现了什么），
   再**静态扫出三个插件页面脚本里每一个 `bridge.X` / `utools.X` 调用**逐个断言有实现。
   这个过程真实抓到了两个缺口：
   - `sha256Bytes` 没实现；
   - `loadFeatureCodes()` 裸调 `fetch`，在拿不到 fetch 的环境下会让整个替身抛异常 →
     `window.utools` 装不上 → **页面全废**。
2. **已知答案测试**：替身内置的同步 SHA-256 与 Node 的 `crypto` 在 15 个长度上逐字节一致
   （含 55/56/64 等填充边界）。为什么真写一个同步实现而不是留占位：
   `crypto.subtle` **只在安全上下文可用**，用局域网 IP（`http://192.168.x.x:8000`）
   访问时它就是唯一可用的兜底。

---

## 五、安卓 App（收发双角色，已构建通过）

`android-app/` 是一个 Capacitor 安卓工程，**复用同一份共享核心**（`build.mjs` 会把
`shared/core` 与 `shared/vendor` 拷进 `www/` 并逐字节自检），所以手机与桌面端完全互通。
**已实际构建成功：`app-debug.apk`，4.3 MB。**

```bash
cd android-app
npm install            # 首次
bash setup-jdk.sh      # 首次：装 JDK 21 到 /tmp/jdk21（原因见下）
npm run apk            # 一键盘 APK
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

手机上必须额外处理的两件事，也正是它值得做成 App 的原因：

| 需求 | 做法 | 为什么浏览器做不到 |
|---|---|---|
| **屏幕常亮 + 亮度拉满** | `@capacitor-community/keep-awake` + `screen-brightness` | 息屏或自动降亮度会**直接中断光学传输** |
| 沉浸式全屏码窗 | Fullscreen API（Capacitor 已实现 `onShowCustomView`） | 浏览器全屏仍带浏览器外壳 |
| 摄像头 | `getUserMedia`；**Capacitor 的 `BridgeWebChromeClient.onPermissionRequest` 已内置处理权限**，只需 Manifest 声明 `CAMERA`，不用写 Java | — |
| 保存文件 | `Filesystem` 写 Documents + `Share` 调起系统分享 | 浏览器只能"下载" |

**已在 APK 上验证的**：包名 `cn.optical.transfer`、`CAMERA` 权限在 Manifest 里、
targetSdk 36、web 资产（含 **246,922 字节的 RaptorQ wasm**）全部打进包、
**v2 签名有效**（可直接 `adb install`）、`hardware.camera` 标为非必需（没摄像头的设备也能装）。

**必须真机验证的**：摄像头在 WebView 里能否起、常亮与亮度的实际效果、
真机扫码帧率、App 启动。详细的四个本机环境坑（JDK 21 得同时设 `JAVA_HOME` /
`~/.gradle` 被沙箱拒 / 官方源只有 26 KB/s / wrapper 用 `-bin`）见 `android-app/README.md`。

---

## 六、Windows 桌面版（已构建通过）

`desktop-app/` 是一个 Electron 工程。它**不是"再多一个平台"——而是补上了前面几轮一直缺的能力**：

| 能力 | 浏览器 / PWA | uTools 插件 | **桌面版** |
|---|---|---|---|
| 码窗真的盖住其他应用 | ✗（F11 全屏仍会被遮住） | ✓（需登录） | **✓ `setAlwaysOnTop(true,'screen-saver')`** |
| 屏幕不睡眠 / 不变暗 | ✗ | ✗ | **✓ `powerSaveBlocker`（Electron 内置）** |
| 保存到指定路径 | ✗ | ✓ | **✓ 原生保存对话框** |
| 无摄像头时从屏幕取帧 | ✗ | ✓ | **✓ `desktopCapturer`** |
| Windows 上调亮度 | ✗ | ✗ | **✓ WMI** |

**已实际构建成功**（在 macOS 上交叉构建，本机无 wine / mono / makensis）：

```
desktop-app/dist/OpticalTransfer-Setup-0.1.0-x64.exe      106 MB  NSIS 安装包
desktop-app/dist/OpticalTransfer-Portable-0.1.0-x64.exe   106 MB  免安装版
```

```bash
cd desktop-app && npm install
node node_modules/electron/install.js        # postinstall 被拦，手动补一次
HOME=/tmp/ot-home ./node_modules/.bin/electron-builder --win --x64
```

已在产物上验证：两个 exe 都是有效的 `PE32 / Nullsoft Installer`；NSIS 3.0.4.1 自动下载并成功打包；
exe 的签名与元数据由 electron-builder **自带的 macOS 版 wine** 写入（本机没有系统 wine）；
`app.asar` 里含 `/www/{index.html,app.js,main.js,preload.js}` + `core/×5` + `vendor/×4`（**含 `raptorq.core.wasm`**）。
⚠️ 用的是 Electron 默认图标——需要放一个 `build/icon.ico` 才是产品级。

**真机冒烟测试已通过**（`npm run smoke`：真 Electron 进程，连跑 3 次稳定）：
页面加载、三种模式就位、`window.Native` 注入、**WASM 加载并跑通真 RaptorQ 往返**、
**帧→QR 像素→jsQR 解回一致**、全屏置顶成功、屏幕不睡眠开启、渲染进程无报错。

**没验证到的**：这两个 exe 在真实 Windows 上能否启动、Windows 摄像头、WMI 亮度、
安装/卸载流程——本机是 macOS，执行不了。细节见 `desktop-app/README.md`。

> 三个平台共用**同一份** `index.html` / `app.css` / `app.js`：`desktop-app/build.mjs`
> 直接从 `android-app/src/` 拷过去，每个平台只提供一个实现同一套 `window.Native` 接口的
> `native.js`。有测试守着这份契约（接口集合必须覆盖共用 UI 的全部调用、UI 文件逐字节一致）。

---

## 七、浏览器扩展（Chrome / Edge MV3，已构建通过）

`browser-extension/` 把 uTools 插件那套能力做成一个浏览器扩展：**不用登录、不用起服务器、离线可用**。
它补上了 localhost 浏览器模式一直缺的几件事：

| 能力 | 浏览器模式 | uTools 插件 | 桌面版 | **浏览器扩展** |
|---|---|---|---|---|
| 零服务器 / 离线 | ✗ | ✓ | ✓ | **✓** |
| origin 稳定（安全上下文） | ✗ 换端口就变；局域网 IP 下 `getUserMedia` 直接被拒 | ✓ | ✓ | **✓ `chrome-extension://`** |
| 屏幕不睡眠 | ✗ | ✗ | ✓ | **✓ Screen Wake Lock（标准 API）** |
| 保存到指定路径 | ✗ 只能"下载" | ✓ | ✓ | **✓ 真"另存为"** |
| 码窗浮在其它应用之上 | ✗ | ✓（要登录） | ✓ | **✓ Document Picture-in-Picture** |
| 调屏幕亮度 | ✗ | ✗ | ✓（仅 Windows） | ✗ **拿不到，如实报缺** |

```bash
cd browser-extension && node build.mjs
# Chrome/Edge → chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 dist/
```

**真正新写的只有一个 `native.js` + 一个 `background.js` + 一个 `manifest.json`**——界面照样是从
`android-app/src/` 原样拷过来的共用 UI，一个字没改。这已经是第三个平台用同一套办法接上了。

两个关键实现决定：

1. **置顶码窗用 Document PiP，且不搬 DOM。** `chrome.windows` 没有 `alwaysOnTop`，但 Document PiP
   开出来的窗口按定义就是系统级置顶的。实现是在 PiP 窗口里放一块 canvas，每帧把主窗口的
   `#code-canvas` **1:1 位拷贝**过去——搬 DOM 会让共用 UI 里的 `window.innerWidth` 与
   `getBoundingClientRect()` 分处两个文档，尺寸换算立刻错乱。
   **代价**：主窗口那个标签页被切到后台时浏览器会节流编码循环（掉到 ~1fps），
   所以 PiP 的用法是「标签页保持前台，码窗浮在上面」；要随便切标签页就得用桌面版。
2. **常亮用标准的 Screen Wake Lock，不用 `chrome.power`。** 于是
   `permissions` **只有 `downloads` 一项**（就为了"另存为"的第 2 档降级）。
   坑：wake lock 在文档转 hidden 时会被系统自动释放，必须挂 `visibilitychange` 补申请。

保存文件走三档降级：`showSaveFilePicker`（真另存为）→ `chrome.downloads({saveAs:true})` →
`Blob` 下载；**用户在另存为里取消 → 返回 `{cancelled:true}`，绝不换个方式偷偷再存一遍**。

36 项无头验证里，最值钱的是**桩 DOM 真跑一遍降级链**（不是正则猜它写了没有），以及
**manifest ↔ 文件系统 ↔ 代码**的三方交叉：SW 文件存在、图标是**声明尺寸的真 PNG**（读 IHDR 校验）、
CSP 带 `wasm-unsafe-eval`（少了它 RaptorQ 的 wasm 会被**静默**拦掉）、
代码里每个 `chrome.*` 调用与声明的权限一一对得上。

**没验证到的**：沙箱里没有 Chrome 也没有摄像头，所以「扩展能加载」「PiP 窗口到底是不是真的置顶」
「摄像头授权与扫码帧率」必须手工跑一遍。**其中 PiP 置顶是整个方案的关键假设。**
细节与踩到的 6 个坑见 `browser-extension/README.md`。

---

## 八、架构

### 帧协议 v1（`shared/core/protocol.js`）

所有帧都是纯二进制，走 QR 的 Byte 模式，尾部带 CRC32。

```
描述符帧 (type=0)                          数据帧 (type=1)
magic(1) type(1) sessionId(2)              magic(1) type(1) sessionId(2)
mode(1) flags(1) symbolSize(2)             blockIndex(2) esi(4)
totalSymbols(4) blockCount(2)              payload(symbolSize)
totalBytes(4) nameLen(1) name(n)           crc32(4)
[extra(m)]  ← 可选：RaptorQ 用它带 12 字节 OTI
crc32(4)
```

几个刻意的设计决定：

- **`totalSymbols` 用 u32**：按 400 B 切片时 u16 只能表示 26 MB，撑不起 64 MB 目标。
- **固定 QR 版本**：发送端先算 `qr.versionFor(frameLength, ecc)`，之后**所有帧
  （含描述符帧）都用同一个 version 渲染**。这样每帧像素尺寸完全一致，
  摄像头不会因为码大小跳变而反复重对焦。有测试专门守这条。
- **可选 `extra` 区**：向后兼容，旧解析器会忽略它；没有 extra 时解析出空数组。
- **会话 ID**：由文件内容派生，接收端据此丢弃上一次传输的残帧。

### 三种模式（`shared/core/codecs.js`）

| 模式 | 发送端 | 接收端 |
|---|---|---|
| `MODE_SEQUENTIAL` | esi 就是分片序号，播完一轮从头再来 | 槽位数组，凑满即完成 |
| `MODE_FOUNTAIN` | LT 喷泉码，esi 只增不减 | 增量 GF(2) 行化简（RREF） |
| `MODE_RAPTORQ` | Rust/WASM 的 RFC 6330 实现 | WASM 解码器（凭 OTI 建） |

**接收端凭描述符自描述**，不需要协商：

- 描述符里**带 12 字节 OTI** → 发送端真的用了 WASM RaptorQ；本端没有 WASM 核时
  返回明确的 `UnsupportedReceiver` 错误。**绝不偷偷用 LT 解**——两种编码方式不同，
  硬解只会得到垃圾数据。
- 描述符里**没有 OTI** → 发送端当时回退到了 LT，用 LT 解码器即可。

### RaptorQ 的 WASM 核（`raptorqr/core-rs/`）

- Rust crate，`crate-type = ["cdylib"]`，目标 `wasm32-unknown-unknown`。
- **不用 wasm-bindgen**：手写 C ABI，产物**零导入项**，JS 侧只要
  `WebAssembly.instantiate(bytes)` 就能用。
- 依赖 `raptorq = "2"`（RFC 6330 实现，Apache-2.0）。它的 `rand` 只是 dev-dependency，
  所以没有 getrandom 的 wasm 后端问题——这点是选它的关键。
- OTI 由发送端显式传给接收端，不依赖任何内部默认值。
- FFI 边界自己校验参数（符号长度/块号越界），把畸形输入变成错误码而不是 panic。

---

## 九、必须避开的坑（都是本会话实测踩到的）

1. **不要给插件 HTML 加 CSP meta。** uTools 以本地协议加载页面，origin 是 opaque 的，
   `script-src 'self'` 会把 JS 直接拦掉 → 白屏。
2. **`qrcode.stringToBytes` 被覆写成 latin1 了**，所以**任何 JS 字符串都必须先
   `OTP.protocol.utf8Encode()` 转字节**再进协议层，否则中文会被按位截断成乱码。
3. **qrcode-generator 容量溢出时抛的是字符串，不是 Error。**
   `catch (e) { e.message }` 会是 undefined，要用 `String(e)`。
4. **WASM 不要用 `instantiateStreaming`，也不要从 CDN 加载。** 本地协议下 MIME
   多半不是 `application/wasm`；uTools 发布时也禁止请求网络资源。
   正确做法：先拿 ArrayBuffer 再 instantiate，文件随插件打包。
5. **运行时基线是 Chromium 91 / Node 14**（官方 FAQ 口径）：
   别用 `Array.prototype.at`、`structuredClone`、`Object.hasOwn`、`??=`。
6. **`raptorq` 的 `Encoder::with_defaults(data, mtu)` 第二参是 MTU 不是 symbol_size**，
   真实 symbol_size 要读 `config.symbol_size()`；而且 RaptorQ 会按 RFC 6330 的参数表
   **扩展 K、自行划分源块**，所以帧坐标必须以内核上报的结构为准，不能沿用
   `planBlocks()` 的结果。
7. **本机文件沙箱只允许写工作区。** `npm`/`cargo`/`rustup` 默认往 `~/.npm`、`~/.cargo`、
   `~/.rustup` 写会被拒。重定向即可：
   `npm --cache /tmp/npm-cache ...`、`CARGO_HOME=/tmp/cargo`、`RUSTUP_HOME=/tmp/rustup`。
8. **classic script 共享同一个全局词法作用域，顶层重名会让整个页面白屏。**
   uTools 插件页面用的是 classic script（不是 ES module），所以
   `a.js: const G = ...` 与 `b.js: const G = ...` 会让第二个脚本在**实例化阶段**就抛
   `SyntaxError: Identifier 'G' has already been declared`，此后页面 JS 全部不执行。
   而 `node --check` 逐个文件看都是合法的，**查不出来**。
   本项目真实踩过：方案二最初在 8 个 TS 模块里各写了 top-level `const G` / `const DOT`。
   解法是每个模块用 IIFE 关住自己的名字，只通过 `globalThis.X` 暴露。
   `shared/test/globals.test.js` 专门守这条（对每个页面把所有 classic 脚本按顺序
   实例化进同一个上下文，只看这一类早期错误）。
9. **preload 读 wasm 的返回值要宽容处理。** `readBinary` 若返回 `ArrayBuffer`，
   它只有 `byteLength` 没有 `length`，用 `bytes.length` 判空会误判成"返回空"，
   结果是**浏览器里 WASM 永远起不来**（而且 Node 侧的互通测试走的是
   `require` + `loadFromBytes`，**测不到这条浏览器路径**）。
   `vendor/raptorq.core.js` 现在同时接受 `Uint8Array` / Node `Buffer` / `ArrayBuffer`
   / 任意 TypedArray。
10. **"固定 QR 版本"要取数据帧与描述符帧版本的较大值。** 描述符帧带着文件名
    （+32 字节 SHA-256 / +12 字节 OTI），切片很小时它反而比数据帧更长；
    只按数据帧算版本会溢出（而 qrcode-generator 溢出的正是字符串）。

---

## 十、验证

```bash
./verify.sh
```

五步：① 三份核心字节级一致 ② 插件交付自检（CSP / 脚本顺序 / 资源缺失 / preload 桥）
③ 全部 `.js` 语法检查 ④ 共享核心测试（协议 / 喷泉码 / 三模式 / RaptorQ / 全局重名 /
跨插件互通 / 浏览器替身）⑤ 三个插件各自的测试 + 安卓 App + 桌面版 + 浏览器扩展。

单独跑某一项：

```bash
node shared/test/core.test.js        # 协议层 + 喷泉码 + 整链路像素往返
node shared/test/codecs.test.js      # 三种模式适配层
node shared/test/raptorq.test.js     # RaptorQ WASM 核
node shared/test/globals.test.js     # classic script 全局重名（白屏级）
node shared/test/interop.test.js     # 跨插件互通验收
node shared/browser/browser.test.js  # 浏览器替身层
node shared/audit.mjs                # 插件交付自检
node shared/sync-core.mjs            # 把 shared/ 的核心同步到三个插件
node shared/browser/make-browser-entries.mjs   # 生成浏览器入口
cd browser-extension && node test/extension.test.js   # 浏览器扩展（Chrome/Edge MV3）
```

---

## 十一、已知限制

- **接收端需要摄像头授权。** 插件里的 `getUserMedia` 是可行的（插件市场已有
  「摄像头扫码枪」728 人在用），但 macOS 上依赖 uTools 底座的授权；
  三个插件都准备了降级路径（截图框选 / 导入图片文件）。
- **浏览器模式的取舍**（见第四节）：
  - 「保存」变成**浏览器下载**，不能像 uTools 里那样自选路径；
  - 截屏走 `getDisplayMedia()`，需要用户授权，且浏览器会要求选一个共享目标；
  - **必须 localhost 或 https**（安全上下文）。用局域网 IP 时 `crypto.subtle`
    会不可用（已有内置纯 JS SHA-256 兜底），但 `getUserMedia` 会直接被拒——
    跨设备场景请改用手机浏览器打开 `standalone.html`；
  - 发送端码窗是 iframe 覆盖层而非真正的置顶系统窗口，**不能盖住其他应用**。
    要"全屏置顶盖住桌面"，需要 uTools 的 `createBrowserWindow`，也就是要登录。
- **浏览器扩展的取舍**（见第七节）：
  - **调不了屏幕亮度**——`envInfo` 里恒为 `ScreenBrightness: false`，如实报缺（安卓/桌面才有）；
  - **没有多码并行**：共用 UI 只做单码，要 1/2/4 码并行得移植 raptorqr 自己的页面；
  - **没有"从屏幕取帧"入口**：共用 UI 的接收端只有摄像头 + 导入帧图片两条路；
  - 置顶码窗走 Document PiP，**需要 Chrome/Edge 116+**，且要求主窗口标签页保持前台
    （切到后台会被节流到 ~1fps），另外「PiP 窗口是否真的置顶」还没在真机验证过；
  - 上架 Chrome Web Store 要过审，`downloads` 权限需要写用途说明（开发期用"加载已解压"即可）。
- **我没有在真机验证过的东西**：uTools 里的 `createBrowserWindow`、IPC 转发、
  真实 `getUserMedia` 扫码，浏览器里的摄像头与画布渲染循环，以及浏览器扩展的加载、
  Document PiP 置顶效果与另存为对话框。沙箱里既没有 uTools 也没有摄像头，
  这几条**只做到了语法与逻辑级验证**（外加生成页面的加载顺序、静态 API 覆盖校验，
  以及扩展那 36 项里用桩 DOM 真跑出来的降级链）。第一次真机跑必然要冒烟一遍。
- **没有反向信道。** 接收端无法"请求重发第 7 帧"，这正是要上喷泉码的原因。
  顺序模式只能靠轮播补齐，实测开销明显更高。
- **单帧上限 2953 B**（QR v40 / ECC L）。超过就只能减小切片或提高帧率。
- **大文件受接收端内存限制。** `decimen` 做了边收边落盘，另外两个目前是一次性还原。
- **多码并行对窗口尺寸敏感**：4 码并行要求每个码位分到足够像素，
  `codecs.scanHint()` 会在码太密时给出警告。
- 本项目是**工程对照实现**，不是上游那三个项目的代码搬运。协议、编解码、
  uTools 集成、测试都是本仓库自己写的；QR 编解码用了 MIT 的 `qrcode-generator`
  与 Apache-2.0 的 `jsQR`，RaptorQ 用了 Apache-2.0 的 `raptorq` crate（见
  `shared/vendor/THIRD-PARTY.md`）。
