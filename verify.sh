#!/usr/bin/env bash
# verify.sh —— 一键验证整个工作区
#
#   ./verify.sh
#
# 做三件事：
#   1. 共享核心与各插件的 core/vendor 是否一致（防漂移）
#   2. 全部 .js 语法检查
#   3. 共享核心 + 三个插件的全部测试
set -uo pipefail
cd "$(dirname "$0")" || exit 1

pass=0
fail=0
step() { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }
ok()   { echo "  ✅ $1"; pass=$((pass + 1)); }
bad()  { echo "  ❌ $1"; fail=$((fail + 1)); }

step "1/5 共享核心一致性（三个插件必须携带同一份 core/vendor）"
if node shared/sync-core.mjs --check; then ok "core/vendor 一致"; else bad "core/vendor 有漂移，跑 node shared/sync-core.mjs 同步"; fi

step "2/5 插件交付自检（CSP / 脚本顺序 / 资源缺失 / preload 桥）"
if node shared/audit.mjs; then ok "交付自检通过"; else bad "交付自检有问题（见上）"; fi

step "3/5 语法检查"
syntax_fail=0
while IFS= read -r f; do
  if ! node --check "$f" >/dev/null 2>&1; then
    echo "      语法错误: $f"
    syntax_fail=$((syntax_fail + 1))
  fi
done < <(find . -name '*.js' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -name 'qrcode-generator.js' -not -name 'jsQR.js')
if [ "$syntax_fail" -eq 0 ]; then ok "所有 .js 通过 node --check"; else bad "$syntax_fail 个文件语法错误"; fi

step "4/5 共享核心测试（含全局重名检查与跨插件互通验收）"
for t in shared/test/core.test.js shared/test/codecs.test.js shared/test/raptorq.test.js shared/test/globals.test.js shared/test/interop.test.js shared/browser/browser.test.js; do
  if [ -f "$t" ]; then
    if out=$(node "$t" 2>&1); then
      ok "$t — $(echo "$out" | grep -oE '[0-9]+ 通过 / [0-9]+ 失败' | tail -1)"
    else
      bad "$t"; echo "$out" | tail -20
    fi
  else
    bad "$t 不存在"
  fi
done

step "5/5 三个插件各自的测试 + 安卓 App + 桌面版 + 浏览器扩展"
for p in airscan-qr decimen-optical-transfer raptorqr; do
  t="$p/test/plugin.test.js"
  if [ -f "$t" ]; then
    if out=$(node "$t" 2>&1); then
      ok "$t — $(echo "$out" | grep -oE '[0-9]+ 通过 / [0-9]+ 失败' | tail -1)"
    else
      bad "$t"; echo "$out" | tail -25
    fi
  else
    bad "$t 不存在"
  fi
done

# 安卓 App：先重新组装 www/（保证核心与 shared 一致），再跑它的无头验证
if [ -d android-app ]; then
  if (cd android-app && node build.mjs >/dev/null 2>&1); then
    ok "android-app/build.mjs 组装 www/ 通过"
  else
    bad "android-app/build.mjs 失败"
  fi
  t="android-app/test/app.test.js"
  if [ -f "$t" ]; then
    if out=$(node "$t" 2>&1); then
      ok "$t — $(echo "$out" | grep -oE '[0-9]+ 通过 / [0-9]+ 失败' | tail -1)"
    else
      bad "$t"; echo "$out" | tail -25
    fi
  else
    bad "$t 不存在"
  fi
fi

# 桌面版（Electron）：同样先重新组装 www/，再跑无头验证。
# 真 Electron 进程的冒烟测试需要图形环境，交给 `npm run smoke` 单独跑。
if [ -d desktop-app ]; then
  if (cd desktop-app && node build.mjs >/dev/null 2>&1); then
    ok "desktop-app/build.mjs 组装 www/ 通过"
  else
    bad "desktop-app/build.mjs 失败"
  fi
  t="desktop-app/test/desktop.test.js"
  if [ -f "$t" ]; then
    if out=$(node "$t" 2>&1); then
      ok "$t — $(echo "$out" | grep -oE '[0-9]+ 通过 / [0-9]+ 失败' | tail -1)"
    else
      bad "$t"; echo "$out" | tail -25
    fi
  else
    bad "$t 不存在"
  fi
fi

# 浏览器扩展（Chrome/Edge MV3）：同样先重新组装 dist/，再跑无头验证。
# 真机部分（Chrome 加载扩展、置顶码窗、摄像头扫码）必须在浏览器里手工跑一遍。
if [ -d browser-extension ]; then
  if (cd browser-extension && node build.mjs >/dev/null 2>&1); then
    ok "browser-extension/build.mjs 组装 dist/ 通过"
  else
    bad "browser-extension/build.mjs 失败"
  fi
  t="browser-extension/test/extension.test.js"
  if [ -f "$t" ]; then
    if out=$(node "$t" 2>&1); then
      ok "$t — $(echo "$out" | grep -oE '[0-9]+ 通过 / [0-9]+ 失败' | tail -1)"
    else
      bad "$t"; echo "$out" | tail -25
    fi
  else
    bad "$t 不存在"
  fi
fi

printf '\n\033[1m================================\033[0m\n'
if [ "$fail" -eq 0 ]; then
  echo "✅ 全部通过（$pass 项）"
else
  echo "❌ $fail 项失败 / $pass 项通过"
fi
exit $((fail > 0))
