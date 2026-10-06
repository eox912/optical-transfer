# 第三方组件

本项目自己实现的部分：帧协议、LT 喷泉码、三种模式的适配层、uTools 集成、全部测试。

以下第三方组件以源码形式随插件打包（uTools 发布时禁止请求网络资源，
所以不能走 CDN，必须随插件分发）。

## qrcode-generator

- **文件**：`shared/vendor/qrcode-generator.js`（各插件 `vendor/` 下同名文件）
- **版本**：1.4.4
- **作者**：Kazuhiko Arase
- **许可证**：MIT — <http://www.opensource.org/licenses/mit-license.php>
- **用途**：QR 码编码（生成模块矩阵）
- **本地改动**：`core/qr.js` 在运行时覆写了 `qrcode.stringToBytes`，改为
  latin1 的一字符一字节映射，使 Byte 模式成为 8-bit clean，从而能承载任意二进制帧。
  **原始文件本身未被修改**，覆写发生在加载之后。

> "QR Code" 是 DENSO WAVE 的注册商标。

## jsQR

- **文件**：`shared/vendor/jsQR.js`（各插件 `vendor/` 下同名文件）
- **版本**：1.4.0
- **作者**：cozmo
- **许可证**：Apache License 2.0
- **用途**：从 RGBA 像素里识别 QR 码（接收端解码）
- **用法要点**：只取 `result.binaryData`（逐字节精确），不用 `result.data`
  字符串——二进制帧经过 UTF-8 解码会被破坏。

## raptorq (Rust crate)

- **用途**：RaptorQ (RFC 6330) 编解码，编译为 WebAssembly
  （产物：`shared/vendor/raptorq.core.wasm`，源码见 `raptorqr/core-rs/`）
- **版本**：2.0.1
- **作者**：Christopher Berner
- **许可证**：Apache License 2.0
- **仓库**：<https://github.com/cberner/raptorq>
- **说明**：该 crate 的 `rand` 仅为 dev-dependency，因此编译到
  `wasm32-unknown-unknown` 时不需要 getrandom 的 wasm 后端，
  产物**零导入项**，可脱离 wasm-bindgen 胶水直接实例化。

### 关于 RaptorQ 的专利

RaptorQ 源自 RFC 6330，其算法背景涉及 Qualcomm 的专利族。
`raptorq` crate 本身以 Apache-2.0 分发，但**商用前请自行评估专利许可问题**。
本项目仅作技术对照实现使用。

## WebAssembly 产物的构建方式

`raptorqr/core-rs/` 里的 Rust crate 用以下方式构建（见 `raptorqr/scripts/build-wasm.sh`）：

```bash
rustup target add wasm32-unknown-unknown
cd raptorqr/core-rs
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/raptorqr_core.wasm ../vendor/raptorq.core.wasm
```

未使用 wasm-pack / wasm-bindgen：导出的是手写 C ABI（见 `core-rs/src/lib.rs`），
这样产物没有宿主依赖，也不受本地协议下 `application/wasm` MIME 缺失的影响。
