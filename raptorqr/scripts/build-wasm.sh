#!/usr/bin/env bash
#
# scripts/build-wasm.sh —— 把 core-rs/ 编成 vendor/raptorq.core.wasm
#
#   bash scripts/build-wasm.sh
#
# 产物固定落在 vendor/raptorq.core.wasm，文件名必须与
# vendor/raptorq.core.js 里的 DEFAULT_URL 一致。
#
# 注意：
#   * 本脚本只负责"有 Rust 工具链时怎么重建"；日常开发不需要跑它，
#     wasm 已经随插件打包在 vendor/ 里。
#   * 本机文件沙箱可能不允许写 ~/.cargo / ~/.rustup。此时把缓存重定向到
#     工作区或 /tmp（见下面的 CARGO_HOME / RUSTUP_HOME 处理），
#     例如：CARGO_HOME=/tmp/cargo RUSTUP_HOME=/tmp/rustup bash scripts/build-wasm.sh
#
set -euo pipefail

TARGET="wasm32-unknown-unknown"
CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${CRATE_DIR}/vendor"
OUT_FILE="${OUT_DIR}/raptorq.core.wasm"
ARTIFACT_DIR="${CRATE_DIR}/core-rs/target/${TARGET}/release"

# 沙箱友好：允许外部覆盖 cargo / rustup 的缓存目录
: "${CARGO_HOME:=${HOME}/.cargo}"
: "${RUSTUP_HOME:=${HOME}/.rustup}"
export CARGO_HOME RUSTUP_HOME
echo "CARGO_HOME=${CARGO_HOME}"
echo "RUSTUP_HOME=${RUSTUP_HOME}"

if ! command -v cargo >/dev/null 2>&1; then
  echo "找不到 cargo：请先安装 Rust（https://rustup.rs）。" >&2
  echo "如果只是要用插件，不需要本脚本 —— vendor/raptorq.core.wasm 已经打包好了。" >&2
  exit 1
fi

echo "==> rustup target add ${TARGET}"
rustup target add "${TARGET}"

echo "==> cargo build --release --target ${TARGET}"
(
  cd "${CRATE_DIR}/core-rs"
  cargo build --release --target "${TARGET}"
)

# 不要硬编码产物文件名：Cargo.toml 里的包名一旦调整（raptorq-core / raptorqr-core）
# 就对不上，表现是"编成功了却报产物不存在"。直接从 release 目录里找（排除 deps/ 副本）。
ARTIFACT="$(find "${ARTIFACT_DIR}" -maxdepth 1 -name '*.wasm' -type f 2>/dev/null | head -1)"
if [ -z "${ARTIFACT}" ] || [ ! -f "${ARTIFACT}" ]; then
  echo "构建产物不存在：在 ${ARTIFACT_DIR} 下没找到 .wasm" >&2
  exit 1
fi
echo "==> 找到产物 $(basename "${ARTIFACT}")"

mkdir -p "${OUT_DIR}"
cp "${ARTIFACT}" "${OUT_FILE}"
echo "==> 已写入 ${OUT_FILE} ($(wc -c < "${OUT_FILE}" | tr -d ' ') 字节)"

# 自检：wasm 必须零导入项，否则插件页面里实例化会失败
node -e '
const fs = require("fs");
const p = process.argv[1];
const bytes = fs.readFileSync(p);
const mod = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(mod);
if (imports.length !== 0) {
  console.error("wasm 有 " + imports.length + " 个宿主导入项，必须为 0：", imports);
  process.exit(1);
}
const ex = new WebAssembly.Instance(mod, {}).exports;
if (typeof ex.raptorq_abi_version !== "function") {
  console.error("缺少 raptorq_abi_version 导出");
  process.exit(1);
}
console.log("==> 自检通过：零导入项，ABI v" + ex.raptorq_abi_version());
' "${OUT_FILE}"

echo "==> 别忘了重新跑一遍： node build.mjs && node test/plugin.test.js"
