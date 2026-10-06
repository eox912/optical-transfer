# uTools 插件工程模板（原生 HTML + JS）

零依赖、无需构建的 uTools 插件工程，克隆/复制后改 `plugin.json` 就能跑。

已经预置了 3 类指令的可用示例：

| 指令类型 | 触发方式 | `feature.code` |
| --- | --- | --- |
| 功能指令 | 搜索框输入 `uTools 示例` / `示例插件` | `demo-home` |
| 图片匹配 | 复制/截图后唤出超级面板 → `图片另存为文件` | `demo-save-image` |
| 文件(夹)匹配 | 选中文件(夹)后唤出超级面板 → `查看文件信息` / `读取文件夹内容` | `demo-file-info` |

## 目录结构

```
.
├── plugin.json     # 插件核心配置：入口、图标、功能指令（必填）
├── index.html      # 插件界面入口（main，必须是 .html）
├── index.css       # 界面样式（自动适配深色模式）
├── index.js        # 界面逻辑：按 action.code / action.type 分发视图
├── preload.js      # 预加载脚本：Node 能力 + onPluginEnter 事件转发
├── logo.png        # 插件图标 256×256
├── package.json    # 仅用于 npm run check，无任何依赖
└── .gitignore
```

## 接入调试

1. 打开 uTools → 主面板搜索 `uTools 开发者工具` → 打开。
2. 左下角「新建项目」，填写名称/描述/平台，创建后进入该项目的开发界面。
3. 点击「选择工程「plugin.json」文件夹」，选中本目录下的 **plugin.json**。
4. 点击「接入开发」，再点「打开」即可看到界面。
5. 改完代码在插件窗口按 `Ctrl/Cmd + R` 刷新；改 `plugin.json` 需要重新「接入开发」。

> 也可以在开发者工具里直接用「新建 Vue+Vite 工程 / React+Vite 工程」，本模板是更轻的原生方案。
> 打断点、看日志：插件窗口内 `Ctrl/Cmd + Shift + I` 打开 DevTools，`preload.js` 的日志也在里面。

## 触发示例指令

- **功能指令**：搜索框输入 `uTools 示例` → 回车。
- **图片匹配**：截图或复制一张图片 → 唤出超级面板 → `图片另存为文件`；界面里点「另存为文件」会把图片写入系统「图片」目录，重名自动加 `-1`。
- **文件匹配**：文件管理器选中若干文件(夹) → 超级面板 → `查看文件信息`；可复制路径、打开、定位，文件夹还能点「读取」列出内容。
- **文件夹匹配**：只选中一个文件夹 → 超级面板 → `读取文件夹内容`。

## 改成你自己的插件

1. **`plugin.json`**
   - `main` / `logo` / `preload`：入口文件，必须是相对路径。
   - `pluginSetting.height`：初始窗口高度（默认 544，可用 `utools.setExpendHeight` 动态改）。
   - `features[].code`：功能编码，进入插件时通过 `action.code` 传给你，必须唯一。
   - `features[].cmds`：字符串即功能指令；对象即匹配指令，`type` 支持 `regex` / `over` / `img` / `files` / `window`。
2. **`index.js`**：`handleEnter(action)` 是唯一分发入口，新增 `feature` 时在这里加一个分支 + 一个 `renderXxx()`。
3. **`preload.js`**：需要 `fs` / `path` 等 Node 能力时在这里写函数，挂到 `window.utoolsBridge.services` 上再给页面用。
4. **图标**：替换 `logo.png` 即可（建议 256×256 PNG）。

> 想加 TypeScript 类型提示：`npm i -D utools-api-types`，然后在 `jsconfig.json` / `tsconfig.json` 里加 `"types": ["utools-api-types"]`。
> `plugin.json` 的 `$schema` 字段已经指向官方 JSONSchema，VS Code 里能直接补全字段。

## 常用 API 速查

| API | 用途 |
| --- | --- |
| `utools.onPluginEnter(cb)` | 进入插件，拿到 `{ code, type, payload, from }` |
| `utools.onPluginOut(cb)` | 离开插件（`isKill` 为 `true` 表示进程结束） |
| `utools.setExpendHeight(h)` | 动态调整窗口高度 |
| `utools.hideMainWindow()` / `outPlugin()` | 隐藏 / 退出插件 |
| `utools.copyText(text)` | 写入剪贴板 |
| `utools.showNotification(body)` | 系统通知 |
| `utools.dbStorage.setItem/getItem` | 本地 + 云端同步的数据存储 |
| `utools.getPath(name)` | `home` / `downloads` / `pictures` / `temp` … |
| `utools.shellOpenPath` / `shellShowItemInFolder` | 打开文件 / 在文件夹中定位 |
| `utools.getFileIcon(path)` | 取系统图标（base64 dataURL） |
| `utools.isDev()` / `isMacOS()` / `isWindows()` / `isLinux()` | 环境判断 |

完整文档：<https://www.u-tools.cn/docs/developer/basic/getting-started.html>

## 打包发布

1. 若引入构建工具，先把源码编译到 `dist/`，**只把 `dist/` 打包**，不要打包整个工程目录。
2. 本模板是原生实现，可直接用开发者工具的「打包为离线安装包」生成 `.upx`，或把上表列出的运行时文件打成一个 zip 提交到[应用市场](https://www.u-tools.cn/plugins/)。
3. 使用 Node 第三方依赖时，依赖必须和 `preload.js` 同级，且不要参与打包编译。

## 本地校验

```bash
npm run check      # 语法检查 preload.js / index.js
npm run validate   # 校验 plugin.json 是否为合法 JSON
```
