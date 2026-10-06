# raptorqr-core —— RaptorQ (RFC 6330) 的 WASM 内核

这是**随插件发布的那份 wasm 的真实源码**。产物：

```
../../shared/vendor/raptorq.core.wasm   # 246,922 字节
../../vendor/raptorq.core.wasm          # 同上（插件内的一份）
```

## 可复现性

已验证：从本目录重新编译得到的 wasm 与随包发布的**逐字节相同**。

```
sha256: 056f1a84256144f1...（前 16 位）
cargo build --release --target wasm32-unknown-unknown   # rustc 1.98.1
```

## 为什么不用 wasm-bindgen

产物**零导入项**（`WebAssembly.Module.imports()` 返回空数组），JS 侧只要
`WebAssembly.instantiate(bytes)` 就能用，不需要任何胶水。这一点很关键：

- uTools 以本地协议加载页面时，返回的 MIME 多半不是 `application/wasm`，
  `instantiateStreaming` 会被拒绝；
- 发布时不允许请求网络资源，所以 wasm 必须随插件打包；
- 没有 wasm-bindgen 的宿主导入，就不会出现"模块导入无法满足"导致实例化失败。

## 为什么依赖 `raptorq` crate 能编到 wasm

`raptorq = "2"`（Apache-2.0，cberner/raptorq）的 `rand` **只是 dev-dependency**，
所以编译到 `wasm32-unknown-unknown` 时不需要 `getrandom` 的 wasm 后端，
也就不会引入 `wasm-bindgen` 的隐式导入。这是选它的决定性原因。

## C ABI

编码器：

| 导出 | 说明 |
|---|---|
| `raptorq_abi_version() -> u32` | 当前为 `1`；胶水层会校验，不匹配就拒绝加载 |
| `alloc(size) -> ptr` / `dealloc(ptr, size)` | wasm 线性内存分配（JS 侧写数据用） |
| `encoder_create(data_ptr, data_len, mtu) -> id` | 失败返回 `0`。**`mtu` 是最大包长，不是 symbol_size** |
| `encoder_symbol_size(id) -> u32` | 真实 symbol_size（由 OTI 决定，可能小于 mtu） |
| `encoder_source_blocks(id) -> u32` | RaptorQ 自行划分的源块数 |
| `encoder_block_source_symbols(id, block) -> u32` | 第 block 块的源符号数（RFC 6330 扩展后的 K） |
| `encoder_oti(id, out12) -> u32` | 写出 12 字节 OTI，接收端靠它建解码器 |
| `encoder_symbol(id, block, esi, out_ptr) -> len` | 惰性生成第 `esi` 个符号（esi 可无限增长），返回写入长度 |
| `encoder_free(id)` | |

解码器：

| 导出 | 说明 |
|---|---|
| `decoder_create(oti_ptr) -> id` | 从 12 字节 OTI 建解码器 |
| `decoder_add(id, block, esi, ptr, len) -> u32` | `1`=已完整还原，`0`=已接受，`3`=符号长度不符，`4`=块号越界，`2`=无此 id |
| `decoder_result_ptr(id)` / `decoder_result_len(id)` | 还原出的字节 |
| `decoder_free(id)` | |

FFI 边界会自己校验参数（长度、块号），把畸形输入变成**错误码**而不是 panic
穿过边界——这一点是实测踩出来的：0 字节的符号会让 crate 内部 panic 成
`unreachable`，在 wasm 里几乎无法调试。

## 设计要点

- **OTI 显式传递**：不依赖 `with_defaults` 这类内部默认值，跨版本/跨实现都稳。
- **数据帧只带符号数据**：4 字节 `PayloadId` 由 `(block, esi)` 在两端各自重建，
  所以单帧开销与协议其余模式完全一致。
- **惰性生成 + 索引**：修复符号按 2 倍增长按需生成，摊还 O(1)，
  不会为了一次取符号把整批包都算一遍。

## 编译

```bash
rustup target add wasm32-unknown-unknown
cd raptorqr && ./scripts/build-wasm.sh
```

国内网络提示：官方源 `static.rust-lang.org` 实测只有 ~50 KB/s，
换清华镜像快到秒级（阿里云的 Rust 源实测停在 1.96，会 404）：

```bash
export RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup
```

沙箱友好的重定向（如果 `~/.cargo`、`~/.rustup` 不可写）：

```bash
export CARGO_HOME=/tmp/cargo RUSTUP_HOME=/tmp/rustup
```

## 专利提示

RaptorQ 源自 RFC 6330，算法背景涉及 Qualcomm 的专利族。`raptorq` crate 本身
以 Apache-2.0 分发，但**商用前请自行评估专利许可**。
