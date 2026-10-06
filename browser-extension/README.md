# 光学隔空传输 · 浏览器扩展版（Chrome / Edge MV3）

**不用登录、不用起服务器、离线可用**——把 uTools 插件那套能力做成一个浏览器扩展。

它**不是"再多一个平台"**，而是补上了 localhost 浏览器模式一直缺的三件事：

| 能力 | localhost 浏览器模式 | uTools 插件 | 桌面版 | **本扩展** |
|---|---|---|---|---|
| 零服务器 / 离线 | ✗ 要跑 `browser.sh` | ✓ | ✓ | **✓** |
| origin 稳定（安全上下文） | ✗ 换端口就变 / 局域网 IP 下 `getUserMedia` 直接被拒 | ✓ | ✓ | **✓ `chrome-extension://`** |
| 摄像头授权 | 每次新 origin 重授 | ✓ | ✓ | **✓ 授一次长期有效** |
| 屏幕不睡眠 | ✗ | ✗ | ✓ | **✓ Screen Wake Lock** |
| 保存到指定路径 | ✗ 只能"下载" | ✓ | ✓ | **✓ 真"另存为"** |
| 码窗浮在其它应用之上 | ✗ | ✓（要登录） | ✓ | **✓ Document PiP** |
| 调屏幕亮度 | ✗ | ✗ | ✓（仅 Windows） | ✗ **拿不到，如实报缺** |
| 多码并行（1/2/4） | ✗ | raptorqr 有 | ✗ | ✗（要移植 raptorqr 页面） |
| 需要装什么 | 浏览器 | uTools + 账号 | 106 MB exe | 浏览器扩展 |

## 安装 / 构建

```bash
cd browser-extension
node build.mjs          # 组装 dist/
```

Chrome / Edge → `chrome://extensions` → 打开**开发者模式** → **加载已解压的扩展程序** → 选 `browser-extension/dist/`。

然后点工具栏图标（或 `chrome://extensions` 里的"扩展程序选项"旁边的图标）打开 App 页面。

> `dist/` 是生成物。要分发就 `chrome://extensions` → **打包扩展程序** → 选 `dist/`，得到 `.crx` + `.pem`。
> 上架 Chrome Web Store 需要把 `downloads` 权限的用途写清（本扩展只用它做"另存为"降级）。

## 三条主线

### 1. 置顶码窗 = Document Picture-in-Picture

这是本扩展最值钱的一项。`chrome.windows` 没有 `alwaysOnTop`，但 **Document PiP**（Chrome/Edge 116+）
开出来的窗口按定义就是**系统级浮于其它窗口之上**的，而且尺寸可指定——正好是光学传输要的。

实现上**不搬 DOM**，而是在 PiP 窗口里放一块 canvas，每帧把主窗口的 `#code-canvas`
**1:1 位拷贝**过去：

- 搬 DOM 会让共用 UI 里的 `window.innerWidth` 与 `getBoundingClientRect()` 分处两个文档，
  尺寸换算立刻错乱（PiP 窗口的 `innerWidth` 和主窗口的不是一个值）；
- 位拷贝是 1:1 像素且**共用 UI 一行都不用改**——这是三端共用一份 UI 的前提。

**代价（必须知道）**：主窗口那个标签页如果被切到后台，浏览器会节流
`requestAnimationFrame` / `setTimeout`，编码循环会掉到 ~1fps，传输就停了。
所以 PiP 的正确用法是「**这个标签页保持在前台**，码窗浮在上面，你同时用别的应用」。
要彻底盖住一切、允许随便切标签页，那还是得用桌面版。

### 2. 屏幕常亮 = Screen Wake Lock（标准 API，不是 `chrome.power`）

`navigator.wakeLock.request('screen')`：

- 是**标准 API**，不需要任何权限（所以 manifest 的 `permissions` 只有 `downloads` 一项）；
- `chrome.power` 是 Chrome 专有、平台支持不一致、还要多要一个权限，**没用它**。

一个坑：**wake lock 在文档转为 hidden 时会被系统自动释放**，所以挂了一个
`visibilitychange` 兜底重新申请——不挂的话"切走再切回"就再也不常亮了，而且是静默失效。

### 3. 保存文件 = 三档降级，取消/失败分得清

| 档 | 手段 | 结果 |
|---|---|---|
| 1 | `showSaveFilePicker()`（File System Access） | 真"另存为"对话框，路径用户定 → `mode: 'file-system-access'` |
| 2 | `chrome.downloads.download({saveAs:true})` | 浏览器的保存对话框 → `mode: 'chrome-downloads'` |
| 3 | `Blob` + `<a download>` | 直接落进下载目录 → `mode: 'browser-download'` |

**用户在"另存为"里取消 → 返回 `{cancelled:true}`，绝不换个方式偷偷再存一遍。**

## 权限

`permissions: ["downloads"]`——**只有这一项**，就是为了第 2 档的"另存为"。
摄像头、常亮、置顶码窗、另存为的第一档都**不需要**扩展权限。

测试里有一条专门的契约：把代码里出现的每个 `chrome.*` 调用与 manifest 声明的权限对起来，
两边对不上就红（"用了没声明的 API"和"声明了没用到的权限"都算错）。

## 验证到什么程度

```bash
node build.mjs && node test/extension.test.js      # 36 项
```

静态 + 桩 DOM 部分（36 项）重点覆盖**只在 Chrome 加载时才暴露的那类错**：

- **manifest ↔ 文件系统 ↔ 代码**三方交叉：SW 文件存在、`getURL` 的目标存在、
  图标是**声明尺寸的真 PNG**（读 IHDR 校验，不是拿大图糊弄）、
  `permissions` 与代码里的 `chrome.*` 调用一一对得上；
- **MV3 硬约束**：无内联 `<script>`、无内联事件处理器（`onclick=`）、无 `eval`/`new Function`、
  无 CSP meta、无网络资源、`classic script` 全局无重名（白屏级）；
- **`wasm-unsafe-eval`**：CSP 少了它，RaptorQ 的 wasm 会被静默拦掉 → 悄悄回退 LT；
- **降级链用桩 DOM 真跑一遍**（不是正则猜）：PiP 打开 + 位拷贝 + 关窗即停止、
  PiP 不可用/PiP 抛异常 → 退回全屏、另存为取消 → 不再偷偷下载；
- **`keepAwake` 返回值不自我解析成 thenable**（桌面版上曾让 V8 直接 SIGTRAP 崩溃）；
- 核心与 `shared/` 逐字节一致、UI 与 `android-app/src/` 逐字节一致。

**没有验证到的**（沙箱里没有 Chrome、也没有摄像头）：

- 扩展能否在真 Chrome 里加载通过、service worker 是否能起来；
- **Document PiP 窗口到底是不是真的置顶**（这条是整个方案的关键假设，必须先手工验一次）；
- 摄像头在扩展页面里的授权与扫码帧率、Wake Lock 在真机上的实际效果；
- 另存为对话框的实际行为、PiP 窗口的尺寸是否被系统钳制。

## 目录

```
browser-extension/
├── manifest.json        # MV3 清单（权限只有 downloads）
├── build.mjs            # 组装 dist/：共用界面 + 扩展层 + 共享核心 + 图标，并逐字节自检
├── src/
│   ├── native.js        # 扩展层的 window.Native 实现（接口与安卓/桌面版完全一致）
│   └── background.js    # service worker：点图标开 App 页面（只管入口，不存状态）
├── dist/                # 生成物（"加载已解压的扩展程序"选这个目录）
└── test/extension.test.js
```

### 三端共用一份 UI（这是本目录能这么小的原因）

`index.html` / `app.css` / `app.js` **不是**本目录的，而是从 `../android-app/src/` 原样拷过来的——
它们只依赖 `window.Native.*` 的 7 个方法，所以安卓、桌面、扩展**共用同一份界面代码**：

| `window.Native` | 安卓实现 | 桌面实现 | 扩展实现 |
|---|---|---|---|
| `keepAwake(on)` | KeepAwake + ScreenBrightness 插件 | `powerSaveBlocker` + WMI | **Screen Wake Lock**（亮度如实报缺） |
| `pickFile(accept)` | `<input type=file>` | 原生打开对话框 | `<input type=file>` |
| `saveFile(name, bytes)` | Filesystem + Share | 原生保存对话框 | **另存为 → downloads → 下载** |
| `enterFullscreen()` | Fullscreen API | `setFullScreen` + `setAlwaysOnTop('screen-saver')` | **Document PiP**，退回 Fullscreen API |
| `exitFullscreen()` | Fullscreen API | 同上 | 关掉 PiP / 退出全屏 |
| `isNative()` | Capacitor 探测 | `true` | 是否在扩展里 |
| `envInfo()` | Capacitor 插件探测 | `process.platform` + 能力表 | **能力探测表**（如实报缺亮度） |

所以让这个平台跑起来，真正新写的只有一个 `native.js` + 一个 `background.js` + 一个 `manifest.json`。

## 踩到的坑（都是本会话实测）

1. **`action.default_popup` 会让 `action.onClicked` 永远不触发。** 写进 manifest 的那一刻，
   点图标就只会弹一个空 popup，而不会打开页面。测试里专门守着这条。
2. **MV3 的 CSP 必须放行 `wasm-unsafe-eval`**，否则 `WebAssembly.instantiate` 被拦，
   RaptorQ **静默**回退到 LT（页面还能用，只是慢）。manifest 里显式写死这条 CSP。
3. **`chrome.tabs.query({url})` 需要额外的 `tabs` 权限。** 为了"点图标时聚焦已有标签页"
   而多要一个权限不值得，所以直接 `tabs.create`——宁可多开一个标签页。
4. **PiP 窗口不能搬 DOM**（见上），而且 `requestWindow` 需要**用户手势**：
   好在 app.js 的 `startSending` 是同步跑在"开始发送"的点击里的，手势仍然有效；
   万一还是失败，会退回全屏而不是什么都不做。
5. **wake lock 会被系统自动释放**（文档转 hidden 时），必须挂 `visibilitychange` 补申请。
6. **亮度拿不到就是拿不到。** 不假装成功：`envInfo().plugins.ScreenBrightness` 恒为 `false`，
   UI 徽标上会如实显示"缺 ScreenBrightness"，`keepAwake` 的 `errors` 里也写明原因。
