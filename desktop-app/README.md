# 光学隔空传输 · 桌面版（Electron）

桌面版不是"再多一个平台"——它**补上了前面几轮一直缺的那块能力**。

| 能力 | 浏览器模式 / PWA | uTools 插件 | **桌面版** |
|---|---|---|---|
| 码窗真的盖住其他应用 | ✗（F11 全屏仍会被其他窗口遮住） | ✓（需登录 uTools） | **✓ `setAlwaysOnTop(true,'screen-saver')`** |
| 屏幕不睡眠 / 不变暗 | ✗ | ✗（要装插件） | **✓ `powerSaveBlocker`（Electron 内置）** |
| 保存到指定路径 | ✗（只能"下载"） | ✓ | **✓ 原生保存对话框** |
| 无摄像头时从屏幕取帧 | ✗ | ✓（`screenCapture`） | **✓ `desktopCapturer`** |
| Windows 上调屏幕亮度 | ✗ | ✗ | **✓ WMI** |

光学传输有两个硬需求：**码要一直显示在最前面**、**屏幕不能睡**。这两点浏览器做不到、
uTools 要登录，自己用 Electron 就能拿到。

## 运行 / 打包

```bash
cd desktop-app
npm install          # 首次；Electron 二进制走 npmmirror（见下）
npm run build:www    # 组装 www/（从 ../shared 与 ../android-app/src 取，并逐字节自检）
npm start            # 本地跑起来
npm run smoke        # 真 Electron 进程的冒烟测试（无头可跑）
npm run dist:win     # 打 Windows 包：NSIS 安装版 + 免安装 portable 版
```

产物在 `dist/`：
- `OpticalTransfer-Setup-0.1.0-x64.exe`（安装版）
- `OpticalTransfer-Portable-0.1.0-x64.exe`（免安装）

### 本机环境的坑

1. **Electron 二进制默认从 GitHub releases 下，实测只有 13 KB/s。** 必须换镜像：
   ```bash
   export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"     # 实测 7-9 MB/s
   export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
   ```
2. **打包 Windows 包不需要系统装 Wine**：electron-builder 会自己下预编译的
   `nsis` 与 `winCodeSign`（后者自带 macOS 版 wine 供 `rcedit` 改 exe 图标/版本用）。
   本机 `wine`/`mono`/`makensis` 全都没有，仍然能出包。
3. **下载缓存重定向**（沙箱不允许写 `~/.npm`、`~/.cache`）：
   `npm --cache /tmp/npm-cache install`。
4. **`electron-builder` 的 Electron 缓存路径写死，环境变量管不住它**：
   它会把下好的 zip 往 `~/Library/Caches/electron` 搬，沙箱下报
   `EPERM: mkdir '/Users/<你的用户名>/Library/Caches/electron'`（`ELECTRON_CACHE` /
   `electron_config_cache` / `ELECTRON_BUILDER_CACHE` 都试过，无效）。
   **解法是把 `HOME` 整个重定向**，它算出来的路径自然落到可写处：
   ```bash
   mkdir -p /tmp/ot-home/Library/Caches
   HOME=/tmp/ot-home ./node_modules/.bin/electron-builder --win --x64
   ```
   另外 `npm install` 时 Electron 的 postinstall 不会自动跑（install scripts 被拦），
   要手动补一次：
   ```bash
   ELECTRON_CACHE=/tmp/electron-cache electron_config_cache=/tmp/electron-cache \
     node node_modules/electron/install.js
   ```

## 已构建并验证的产物

```
dist/OpticalTransfer-Setup-0.1.0-x64.exe      106 MB  PE32 / Nullsoft 安装包
dist/OpticalTransfer-Portable-0.1.0-x64.exe   106 MB  PE32 / Nullsoft 免安装版
dist/win-unpacked/                                    解包目录（含 OpticalTransfer.exe）
```

在 macOS 上交叉构建成功，且逐项验证过：

| 验证项 | 结果 |
|---|---|
| 产物类型 | `PE32 executable (GUI) Intel 80386, for MS Windows, Nullsoft Installer self-extracting archive` |
| NSIS 工具链 | 自动下载 `nsis-3.0.4.1` + `nsis-resources-3.4.1` 并成功打包 |
| exe 签名/元数据 | electron-builder 用**自带的 macOS 版 wine** 跑 `signtool.exe` 写入（本机无系统 wine） |
| `app.asar` 内容 | `/www/{index.html,app.css,app.js,main.js,native.js,preload.js}` + `core/×5` + `vendor/×4`，**含 `raptorq.core.wasm`** |
| 图标 | ⚠️ 用的是 **Electron 默认图标**（`build/icon.ico` 没提供），日志里明确写了 |

图标没做成产品级的——需要放一个 `build/icon.ico`（256×256 多尺寸）再重新打包。

**没验证到的**：这两个 exe 在真实 Windows 上**能不能跑起来**（本机是 macOS，没法执行）。
逻辑上 Electron 的 Windows 运行时是同一套代码（Mac 版已实测通过冒烟测试），
但真实 Windows 的摄像头、WMI 亮度、安装/卸载流程都必须在 Windows 上跑一遍。

## 目录

```
desktop-app/
├── package.json      # electron + electron-builder；build 段是打包配置
├── build.mjs         # 组装 www/：共用界面 + Electron 原生层 + 共享核心，并逐字节自检
├── src/
│   ├── main.js       # Electron 主进程：窗口、置顶、屏幕不睡眠、对话框、屏幕捕获、亮度
│   ├── preload.js    # contextBridge 暴露能力（contextIsolation 开着）
│   └── native.js     # 渲染进程侧的 window.Native 实现（与安卓版同接口）
├── www/              # 生成物（electron-builder 只打包这里）
└── test/desktop.test.js
```

### 三个平台共用一份 UI

`index.html` / `app.css` / `app.js` **不是** desktop-app 自己的，而是从
`../android-app/src/` 原样拷过来的——它们只依赖 `window.Native.*`，所以安卓与桌面
共用同一份界面代码。每个平台各提供一个 `native.js` 实现同一套接口：

| `window.Native` 方法 | 安卓实现 | 桌面实现 |
|---|---|---|
| `keepAwake(on)` | `@capacitor-community/keep-awake` + `screen-brightness` | `powerSaveBlocker` + Windows WMI |
| `pickFile(accept)` | `<input type=file>` | 原生打开对话框 |
| `saveFile(name, bytes)` | `Filesystem` 写 Documents + `Share` | 原生保存对话框 + 在文件管理器中定位 |
| `enterFullscreen()` | Fullscreen API | `setFullScreen` + `setAlwaysOnTop('screen-saver')` |
| `envInfo()` | Capacitor 插件探测 | `process.platform` + 能力表 |

`test/desktop.test.js` 里有三条契约测试守着这件事：安卓与桌面的接口集合必须覆盖
共用 UI 需要的全部方法、`app.js` 里不许出现任何平台专属 API、UI 文件必须逐字节一致。

## 验证到什么程度

```bash
node test/desktop.test.js    # 17 项，无头可跑
npm run smoke                # 真 Electron 进程 + 真 wasm + 真往返
```

静态侧（17 项）重点覆盖**运行时才会暴露的跨文件契约**：

- `main.js` 注册的 9 个 IPC 通道 ↔ `preload.js` invoke 的通道，一一对应（拼错会当场红）
- `preload.js` 暴露的键 ↔ `native.js` 实际用到的键，完全覆盖
- 安卓 `native.js` 的接口 ⊆ 桌面 `native.js` 的接口
- `www/core`、`www/vendor` 与 `shared/` 逐字节一致；UI 与 `android-app/src` 逐字节一致
- 页面脚本顺序、id 交叉核对、classic script 全局重名（白屏级）
- 桌面版的存在理由真的实现了：`prevent-display-sleep`、`screen-saver` 置顶、
  原生对话框、`desktopCapturer`、WMI 亮度
- electron-builder 配置（nsis + portable、files 含 www、main 指向 www/main.js）

冒烟测试（`npm run smoke`）在一个**真实 Electron 进程**里验证：页面能加载、
`OTP` 三种模式就位、`window.Native` 与 `__APP__` 已注入、关键 DOM 元素齐全、
**WASM 内核能加载并跑通真 RaptorQ 往返**、**帧→QR 像素→jsQR 解回一致**、
全屏+置顶+屏幕不睡眠真的调用成功、渲染进程无报错。

**没有验证到的**：

- **Windows 上的实际运行**（本机是 macOS，只能产出安装包，没法执行它）
- Windows 上的实际摄像头画面、WMI 亮度在真显示器上的效果
- 真机长时间传输下的稳定性与热耗
