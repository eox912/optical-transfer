/**
 * background.js —— MV3 service worker
 *
 * 只做一件事：点工具栏图标 → 打开 App 页面。
 *
 * 为什么用 `chrome.action.onClicked` 而不是 `default_popup`：
 * 这个扩展没有弹窗 UI，主体是一整个标签页（摄像头 + 全屏码窗都需要完整文档），
 * 而一旦 manifest 里写了 `action.default_popup`，`onClicked` **就永远不会触发**。
 * 这条是隐藏的跨文件契约，测试里专门守着（见 test/extension.test.js）。
 *
 * ⚠️ service worker 会被随时回收，所以这里**不能**放传输状态。
 * 所有实际工作都在 App 页面（`index.html`）里，SW 只是个入口。
 *
 * 另外：不查已有标签页去 focus，因为 `chrome.tabs.query({url})` 需要额外的
 * `tabs` 权限。宁可多开一个标签页，也不为了体验多要一个权限。
 */
'use strict'

var APP_PAGE = 'index.html'

chrome.action.onClicked.addListener(function () {
  chrome.tabs.create({ url: chrome.runtime.getURL(APP_PAGE) })
})
