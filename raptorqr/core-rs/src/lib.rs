//! raptorqr-core —— RFC 6330 RaptorQ 的 WASM 内核（C ABI，不依赖 wasm-bindgen）
//!
//! 设计要点：
//!  * 纯 C ABI 导出，JS 侧只需 `WebAssembly.instantiate(bytes)` 就能用，
//!    不需要 wasm-bindgen 的胶水，也就不受"本地协议下 MIME 不对、无法 streaming 实例化"的影响。
//!  * OTI（ObjectTransmissionInformation，12 字节）由**发送端显式传给接收端**，
//!    不依赖任何内部默认值，跨版本/跨实现都稳。
//!  * 数据帧里只放符号数据本身；4 字节的 PayloadId 由 (block, esi) 在两端各自重建。
//!  * Encoder 用"按需增长 + 索引"的方式惰性生成修复符号：增长按 2 倍，摊还 O(1)。

#![allow(static_mut_refs)]

use raptorq::{Decoder, Encoder, EncodingPacket, ObjectTransmissionInformation, PayloadId};
use std::collections::HashMap;

const ABI_VERSION: u32 = 1;
const MAX_REPAIR: u32 = 1 << 20;

struct EncEntry {
    encoder: Encoder,
    symbol_size: u16,
    packets: Vec<EncodingPacket>,
    /// (source_block_number, encoding_symbol_id) -> packets 下标
    index: HashMap<(u32, u32), usize>,
    generated_repair: u32,
}

struct DecEntry {
    decoder: Decoder,
    result: Option<Vec<u8>>,
    symbol_size: u32,
    source_blocks: u32,
}

static mut ENCODERS: Option<HashMap<u32, EncEntry>> = None;
static mut DECODERS: Option<HashMap<u32, DecEntry>> = None;
static mut NEXT_ID: u32 = 1;

fn enc_map() -> &'static mut HashMap<u32, EncEntry> {
    unsafe { ENCODERS.get_or_insert_with(HashMap::new) }
}

fn dec_map() -> &'static mut HashMap<u32, DecEntry> {
    unsafe { DECODERS.get_or_insert_with(HashMap::new) }
}

fn next_id() -> u32 {
    unsafe {
        let id = NEXT_ID;
        NEXT_ID = NEXT_ID.wrapping_add(1);
        id
    }
}

fn rebuild_index(entry: &mut EncEntry) {
    entry.index.clear();
    for (i, p) in entry.packets.iter().enumerate() {
        let pid = p.payload_id();
        entry
            .index
            .insert((pid.source_block_number() as u32, pid.encoding_symbol_id()), i);
    }
}

/* ------------------------------------------------------------------ */
/*                             内存与元信息                             */
/* ------------------------------------------------------------------ */

#[no_mangle]
pub extern "C" fn raptorq_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn alloc(size: u32) -> u32 {
    let mut v: Vec<u8> = Vec::with_capacity(size as usize);
    let ptr = v.as_mut_ptr();
    std::mem::forget(v);
    ptr as u32
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: u32, size: u32) {
    unsafe {
        let _ = Vec::from_raw_parts(ptr as *mut u8, 0, size as usize);
    }
}

/* ------------------------------------------------------------------ */
/*                                编码器                               */
/* ------------------------------------------------------------------ */

#[no_mangle]
pub extern "C" fn encoder_create(data_ptr: u32, data_len: u32, symbol_size: u32) -> u32 {
    if data_len == 0 || symbol_size == 0 || symbol_size > u16::MAX as u32 {
        return 0;
    }
    let data = unsafe { std::slice::from_raw_parts(data_ptr as *const u8, data_len as usize) };
    let encoder = Encoder::with_defaults(data, symbol_size as u16);
    let packets = encoder.get_encoded_packets(0);
    let id = next_id();
    let mut entry = EncEntry {
        encoder,
        symbol_size: symbol_size as u16,
        packets,
        index: HashMap::new(),
        generated_repair: 0,
    };
    rebuild_index(&mut entry);
    enc_map().insert(id, entry);
    id
}

/// 写出 12 字节 OTI，接收端靠它建解码器
#[no_mangle]
pub extern "C" fn encoder_oti(id: u32, out_ptr: u32) -> u32 {
    let entry = match enc_map().get(&id) {
        Some(e) => e,
        None => return 0,
    };
    let bytes = entry.encoder.get_config().serialize();
    unsafe {
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut u8, bytes.len());
        out.copy_from_slice(&bytes);
    }
    bytes.len() as u32
}

#[no_mangle]
pub extern "C" fn encoder_symbol_size(id: u32) -> u32 {
    // 注意：Encoder::with_defaults 的第二个参数是 MTU，真实 symbol_size 由 config 决定
    // （raptorq 会从中扣掉 4 字节的 FEC PayloadId）。
    match enc_map().get(&id) {
        Some(e) => e.encoder.get_config().symbol_size() as u32,
        None => 0,
    }
}

/// 传入的 MTU（含 4 字节 payload id），方便 JS 侧对齐
#[no_mangle]
pub extern "C" fn encoder_mtu(id: u32) -> u32 {
    match enc_map().get(&id) {
        Some(e) => e.symbol_size as u32,
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn encoder_source_blocks(id: u32) -> u32 {
    match enc_map().get(&id) {
        Some(e) => e.encoder.get_config().source_blocks() as u32,
        None => 0,
    }
}

/// 惰性生成到能提供 (block, esi) 为止
#[no_mangle]
pub extern "C" fn encoder_symbol(id: u32, block: u32, esi: u32, out_ptr: u32) -> u32 {
    let entry = match enc_map().get_mut(&id) {
        Some(e) => e,
        None => return 0,
    };
    if !entry.index.contains_key(&(block, esi)) {
        let mut next = if entry.generated_repair == 0 {
            8
        } else {
            entry.generated_repair.saturating_mul(2)
        };
        while next <= MAX_REPAIR {
            entry.packets = entry.encoder.get_encoded_packets(next);
            entry.generated_repair = next;
            rebuild_index(entry);
            if entry.index.contains_key(&(block, esi)) {
                break;
            }
            next = next.saturating_mul(2);
        }
    }
    let idx = match entry.index.get(&(block, esi)) {
        Some(i) => *i,
        None => return 0,
    };
    let data = entry.packets[idx].data();
    unsafe {
        let out = std::slice::from_raw_parts_mut(out_ptr as *mut u8, data.len());
        out.copy_from_slice(data);
    }
    data.len() as u32
}

#[no_mangle]
pub extern "C" fn encoder_free(id: u32) {
    enc_map().remove(&id);
}

/* ------------------------------------------------------------------ */
/*                                解码器                               */
/* ------------------------------------------------------------------ */

#[no_mangle]
pub extern "C" fn decoder_create(oti_ptr: u32) -> u32 {
    let bytes = unsafe { std::slice::from_raw_parts(oti_ptr as *const u8, 12) };
    let mut arr = [0u8; 12];
    arr.copy_from_slice(bytes);
    let config = ObjectTransmissionInformation::deserialize(&arr);
    let id = next_id();
    dec_map().insert(
        id,
        DecEntry {
            symbol_size: config.symbol_size() as u32,
            source_blocks: config.source_blocks() as u32,
            decoder: Decoder::new(config),
            result: None,
        },
    );
    id
}

/// 返回 1 = 已完整还原，0 = 已接受但还没齐，2 = 出错
#[no_mangle]
pub extern "C" fn decoder_add(id: u32, block: u32, esi: u32, data_ptr: u32, data_len: u32) -> u32 {
    let entry = match dec_map().get_mut(&id) {
        Some(e) => e,
        None => return 2,
    };
    if entry.result.is_some() {
        return 1;
    }
    // FFI 边界必须自己校验：让畸形输入变成错误码，而不是 panic 穿过边界
    if data_len != entry.symbol_size {
        return 3; // 符号长度与 OTI 不符
    }
    if block >= entry.source_blocks {
        return 4; // 源块号越界
    }
    let data = unsafe { std::slice::from_raw_parts(data_ptr as *const u8, data_len as usize) }.to_vec();
    let packet = EncodingPacket::new(PayloadId::new(block as u8, esi), data);
    match entry.decoder.decode(packet) {
        Some(d) => {
            entry.result = Some(d);
            1
        }
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn decoder_result_len(id: u32) -> u32 {
    match dec_map().get(&id) {
        Some(e) => e.result.as_ref().map(|d| d.len() as u32).unwrap_or(0),
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn decoder_result_ptr(id: u32) -> u32 {
    match dec_map().get(&id) {
        Some(e) => e.result.as_ref().map(|d| d.as_ptr() as u32).unwrap_or(0),
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn decoder_free(id: u32) {
    dec_map().remove(&id);
}

/* ---------------- 调试用：捕获 panic 文本 + 纯 Rust 自测 ---------------- */

static mut PANIC_BUF: [u8; 512] = [0; 512];
static mut PANIC_LEN: u32 = 0;
static mut HOOK_SET: bool = false;

#[no_mangle]
pub extern "C" fn panic_ptr() -> u32 {
    unsafe { PANIC_BUF.as_ptr() as u32 }
}

#[no_mangle]
pub extern "C" fn panic_len() -> u32 {
    unsafe { PANIC_LEN }
}

#[no_mangle]
pub extern "C" fn install_panic_hook() {
    unsafe {
        if HOOK_SET {
            return;
        }
        HOOK_SET = true;
    }
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("{}", info);
        let bytes = msg.as_bytes();
        let n = bytes.len().min(511);
        unsafe {
            PANIC_BUF[..n].copy_from_slice(&bytes[..n]);
            PANIC_LEN = n as u32;
        }
    }));
}

/// 纯 Rust 往返：完全不经过 ABI 拼装，用来判定问题在 crate 还是在 ABI
/// 返回 1=成功 2=数据不符 0=包不够
#[no_mangle]
pub extern "C" fn selftest(data_len: u32, mtu: u32, drop_every: u32) -> u32 {
    let data: Vec<u8> = (0..data_len).map(|i| (i % 251) as u8).collect();
    let encoder = Encoder::with_defaults(&data, mtu as u16);
    let config = encoder.get_config();
    let packets = encoder.get_encoded_packets(64);
    let mut decoder = Decoder::new(config);
    for (i, p) in packets.into_iter().enumerate() {
        if drop_every > 0 && (i as u32 + 1) % drop_every == 0 {
            continue;
        }
        if let Some(d) = decoder.decode(p) {
            return if d == data { 1 } else { 2 };
        }
    }
    0
}

/// 只走"重建 EncodingPacket"这条路，验证 ABI 的拼装是否正确
#[no_mangle]
pub extern "C" fn selftest_rebuild(data_len: u32, mtu: u32, drop_every: u32) -> u32 {
    let data: Vec<u8> = (0..data_len).map(|i| (i % 251) as u8).collect();
    let encoder = Encoder::with_defaults(&data, mtu as u16);
    let config = encoder.get_config();
    let packets = encoder.get_encoded_packets(64);
    let mut decoder = Decoder::new(config);
    for (i, p) in packets.into_iter().enumerate() {
        if drop_every > 0 && (i as u32 + 1) % drop_every == 0 {
            continue;
        }
        let (pid, payload) = p.split();
        let rebuilt = EncodingPacket::new(PayloadId::new(pid.source_block_number(), pid.encoding_symbol_id()), payload);
        if let Some(d) = decoder.decode(rebuilt) {
            return if d == data { 1 } else { 2 };
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn decoder_symbol_size(id: u32) -> u32 {
    match dec_map().get(&id) { Some(e) => e.symbol_size, None => 0 }
}

#[no_mangle]
pub extern "C" fn decoder_source_blocks(id: u32) -> u32 {
    match dec_map().get(&id) { Some(e) => e.source_blocks, None => 0 }
}

/// 第 block 块的源符号数（RaptorQ 会按 RFC 6330 的参数表把 K 扩展，
/// 这里返回的是**扩展后**的 K，接收端据此算进度）
#[no_mangle]
pub extern "C" fn encoder_block_source_symbols(id: u32, block: u32) -> u32 {
    let entry = match enc_map().get(&id) {
        Some(e) => e,
        None => return 0,
    };
    let config = entry.encoder.get_config();
    if block >= config.source_blocks() as u32 {
        return 0;
    }
    let total = int_div_ceil_u64(config.transfer_length(), config.symbol_size() as u64);
    let per_block = int_div_ceil_u64(total, config.source_blocks() as u64);
    let start = per_block * block as u64;
    let remain = total.saturating_sub(start);
    remain.min(per_block) as u32
}

fn int_div_ceil_u64(a: u64, b: u64) -> u64 {
    if b == 0 { return 0; }
    (a + b - 1) / b
}
