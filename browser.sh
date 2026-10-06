#!/usr/bin/env bash
# browser.sh —— 免登录运行：起一个本地静态服务器，用浏览器打开插件
#
#   ./browser.sh          # 默认 8000 端口
#   ./browser.sh 9000     # 指定端口
#
# 为什么必须走 http://localhost 而不是双击 file://：
#   * 方案二/三的接收端要加载 vendor/raptorq.core.wasm，file:// 下 Chromium
#     会直接拒绝 fetch 该 scheme；
#   * localhost 是安全上下文，fetch、crypto.subtle、摄像头都能用。
#
# 注意：如果你换成局域网 IP（http://192.168.x.x:8000）在别的设备上访问，
# 摄像头仍然可用（getUserMedia 要求安全上下文，这种情况下浏览器会拒绝），
# 建议跨设备时用「手机浏览器 + standalone.html」或直接 HTTPS。
set -euo pipefail
cd "$(dirname "$0")" || exit 1

PORT="${1:-8000}"

echo ""
echo "  浏览器模式（不需要登录 uTools）"
echo "  ─────────────────────────────────────────────────────────────"
echo "  方案一 airscan-qr        http://localhost:${PORT}/airscan-qr/index.browser.html"
echo "  方案二 decimen           http://localhost:${PORT}/decimen-optical-transfer/dist/index.browser.html"
echo "  方案三 raptorqr          http://localhost:${PORT}/raptorqr/dist/index.browser.html"
echo ""
echo "  方案一单文件版（双击也能用）  airscan-qr/standalone.html"
echo ""
echo "  用法：拖放文件到页面即可发送；右上角浮动条可「选择文件发送」/「打开接收窗口」"
echo "  按 Ctrl+C 停止服务器"
echo ""

exec python3 -m http.server "${PORT}" --bind 127.0.0.1
