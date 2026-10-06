# 光学隔空传输 · 安卓 App

收发双角色的安卓 App，复用三个 uTools 插件**同一份**共享核心（协议 / 喷泉码 / RaptorQ WASM），
因此与桌面端完全互通：**手机可以收电脑发的码，电脑也能收手机发的码。**

## 为什么手机上要做这几个特殊处理

| 需求 | 做法 | 为什么必须 |
|---|---|---|
| **屏幕常亮** | `@capacitor-community/keep-awake` | 手机默认 30 秒息屏，光学传输要求屏幕持续显示二维码 |
| **亮度拉满** | `@capacitor-community/screen-brightness` | 自动亮度会随环境变暗，直接影响摄像头识读率；退出时恢复原亮度 |
| 沉浸式全屏 | Fullscreen API | 码区要占满屏幕；Capacitor 的 `onShowCustomView` 已实现，所以能用 |
| 摄像头 | 原生 `getUserMedia` | **Capacitor 的 `BridgeWebChromeClient.onPermissionRequest` 已内置处理**：把 `VIDEO_CAPTURE` 映射成 `CAMERA` 权限、运行时申请、批准后 `request.grant()`。所以只需在 Manifest 声明 `CAMERA`，**不用写一行 Java** |
| 保存文件 | `@capacitor/filesystem` 写 Documents + `@capacitor/share` 调起分享 | 绕开 Android 10+ 分区存储的限制；用户自己决定最终放哪 |
| 选文件 | `<input type=file>` | 安卓 WebView 直接调起系统选择器，**不需要任何插件** |

## 构建

```bash
cd android-app
npm install                      # 首次
bash setup-jdk.sh                # 首次：装 JDK 21 到 /tmp/jdk21（见下方说明）
npm run build:www                # 组装 www/（从 ../shared/ 拷核心，并自检逐字节一致）
npm run apk                      # = cap sync android + gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

装到手机：`adb install -r android/app/build/outputs/apk/debug/app-debug.apk`
（`adb` 在 `~/Library/Android/sdk/platform-tools/adb`）

### 本机环境的四个坑（工程里已经逐条处理）

1. **必须 JDK 21，但本机只有 17；而且 Gradle 自己也得跑在 21 上。** Capacitor 的
   `filesystem` / `share` 插件把 `sourceCompatibility/targetCompatibility` 设成了
   **Java 21**，所以：
   - 不设 `JAVA_HOME` → 报 `无效的源发行版：21`（Gradle 跑在 17 上，javac 不接受 `-source 21`）
   - 只设工具链路径、不设 `JAVA_HOME` → 报
     `Cannot find a Java installation ... matching: {languageVersion=21}`

   所以两件都要做：`setup-jdk.sh` 装 JDK 21，构建时 `JAVA_HOME` 指向它，
   `android/gradle.properties` 里再声明工具链路径。`npm run apk` 已经带上了全部环境变量。
   为什么不用 Android Studio 自带的 JBR：本机没装 Android Studio。
2. **沙箱不允许写 `~/.gradle`**（Gradle 会在那里建锁文件，直接报
   `Could not create parent directory for lock file`）。所以必须
   `GRADLE_USER_HOME=/tmp/gradle`，`npm run apk` 里已经带上了。
   同理 `~/.android` 也被拒（只是警告，但会刷屏），用 `ANDROID_USER_HOME=/tmp/android-user` 绕开。
3. **官方源太慢**：`services.gradle.org` 实测 26 KB/s、`dl.google.com` 50 KB/s、
   `repo.maven.apache.org` 180 KB/s。工程已改成：
   - Gradle 发行版 → `mirrors.cloud.tencent.com/gradle`（实测 **10.7 MB/s**）
   - Maven / Google 制品 → `maven.aliyun.com`（实测 **2.6 / 15.4 MB/s**）
4. **wrapper 用 `-bin` 而不是 `-all`**：少下约 70 MB，且 `-all` 对构建没有额外价值。

## 目录

```
android-app/
├── capacitor.config.json     # appId / webDir / androidScheme=https（安全上下文 → 摄像头 + crypto.subtle 可用）
├── build.mjs                 # 组装 www/：App 源码 + ../shared 的 core/vendor，并自检一致性
├── src/                      # App 源码（index.html / app.css / app.js / native.js）
├── www/                      # 生成物（cap sync 会把它打进 APK）
├── android/                  # Capacitor 生成的安卓工程（已打补丁，见下）
└── test/app.test.js          # 无头验证
```

### 对 `android/` 做的补丁

`cap sync` 不会覆盖这几处，但换机器重建工程时要重新打：

| 文件 | 改动 |
|---|---|
| `app/src/main/AndroidManifest.xml` | 加 `CAMERA` 权限；`hardware.camera` 标 `required=false`（发送端不需要摄像头，没摄像头的设备也能装） |
| `build.gradle` | 两处 `repositories` 前面插入阿里云镜像 |
| `gradle/wrapper/gradle-wrapper.properties` | `distributionUrl` → 腾讯镜像 + `-bin` |
| `gradle.properties` | 指向 `/tmp/jdk21` 的工具链路径；关闭工具链自动下载 |

前两处与 wrapper 有测试守着（`test/app.test.js`），被改回去会红。

## 验证到什么程度

```bash
node test/app.test.js
```

已经做到的（无头可验证）：

- `www/` 里的 `core/`、`vendor/` 与 `../shared/` **逐字节一致**（协议不允许漂移）
- 页面的脚本加载顺序正确（vendor → core → native → app）
- `index.html` 与 `app.js` 的 **id 交叉核对**（引用了不存在的元素会直接红）
- classic script **全局重名检查**（白屏级风险）
- `app.js` 能在桩 DOM 里 **boot 不报错**，`window.__APP__` 导出可用
- 用 App 自己那份核心跑一遍**发送 → 接收内存往返**，三种模式都能还原
- `native.js` 在没有 Capacitor 的环境下**优雅降级**而不是抛错
- 安卓配置没被改回去（CAMERA 权限 / 阿里云镜像 / 腾讯发行版）

**没有验证到的（必须真机）**：

- 摄像头在 WebView 里实际能不能起（逻辑上 Capacitor 已处理权限，但没插过真机）
- 屏幕常亮与亮度控制的实际效果
- 真机上的扫码帧率与识别率
- APK 安装与启动

也就是说：**配置层面的风险已逐条消掉，剩下的是"插上真机跑一遍"。**

## 与 uTools 插件页面的关系

App 的 UI（`src/app.js`）是**另写的手机版界面**，不是把插件页面搬过来——插件页面是为
uTools 的"主窗口 + 独立码窗"模型设计的（浏览器模式里用 iframe 模拟），在手机上不如
一个单页双 Tab 的界面顺手。

核心（`core/` + `vendor/`）是**同一份**，所以协议、模式、参数、互通性完全一致。
如果你想让那三个插件页面本身也跑在这个 App 里，把 `shared/browser/utools-shim.js`
拷进 `src/`，再把里面「虚拟文件系统 + 触发下载」两处换成 `native.js` 的
`pickFile` / `saveFile` 即可（约 80 行改动）；其余 API（iframe 码窗、事件派发）可以照用。
