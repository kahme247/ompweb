//! Bounded protocol-v2 framing for OMP's NDJSON RPC transport.
//! Rust port of `lib/omp/rpc-frame.ts`: logical frames larger than
//! MAX_RPC_FRAME_BYTES are carried as bounded `rpc_chunk` record sequences
//! (base64 payloads, strict reassembly validation on both directions).

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};

pub const MAX_RPC_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_RPC_REASSEMBLED_BYTES: usize = 64 * 1024 * 1024;
const RPC_CHUNK_PAYLOAD_BYTES: usize = 256 * 1024;
const MAX_CHUNK_COUNT: usize = MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES;

struct PendingChunks {
    chunk_id: String,
    count: usize,
    byte_length: usize,
    next_index: usize,
    chunks: Vec<Vec<u8>>,
    received_bytes: usize,
}

/// Decodes complete logical frames from parsed JSONL records.
#[derive(Default)]
pub struct RpcFrameDecoder {
    pending: Option<PendingChunks>,
}

fn decode_strict_base64(value: &Value) -> Result<Vec<u8>, String> {
    let s = value
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "invalid RPC chunk data".to_string())?;
    let bytes = BASE64
        .decode(s)
        .map_err(|_| "invalid RPC chunk data".to_string())?;
    // Match the TS decoder's canonical-form check (rejects non-canonical
    // encodings whose decode/encode round-trip differs).
    if BASE64.encode(&bytes) != s {
        return Err("invalid RPC chunk data".to_string());
    }
    Ok(bytes)
}

impl RpcFrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one parsed record; returns `Some(frame)` when a logical frame is
    /// complete. Errors are protocol-fatal (the TS layer disposes the process).
    pub fn push(&mut self, value: Value) -> Result<Option<Value>, String> {
        let is_chunk = value["type"] == *"rpc_chunk";
        if !is_chunk {
            if self.pending.is_some() {
                return Err("RPC chunk sequence interrupted".to_string());
            }
            if value["type"].as_str().is_none() {
                return Err("RPC frame must be an object".to_string());
            }
            return Ok(Some(value));
        }

        let chunk_id = value["chunkId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or_else(|| "invalid RPC chunk metadata".to_string())?
            .to_string();
        let as_usize = |v: &Value| v.as_u64().map(|n| n as usize);
        let (Some(index), Some(count), Some(byte_length)) = (
            as_usize(&value["index"]),
            as_usize(&value["count"]),
            as_usize(&value["byteLength"]),
        ) else {
            return Err("invalid RPC chunk metadata".to_string());
        };
        if count < 2
            || count > MAX_CHUNK_COUNT
            || index >= count
            || byte_length < MAX_RPC_FRAME_BYTES
            || byte_length > MAX_RPC_REASSEMBLED_BYTES
        {
            return Err("invalid RPC chunk metadata".to_string());
        }

        let bytes = decode_strict_base64(&value["data"])?;
        if bytes.len() > RPC_CHUNK_PAYLOAD_BYTES {
            return Err("RPC chunk payload exceeds the transport limit".to_string());
        }
        if self.pending.is_none() {
            if index != 0 {
                return Err("RPC chunk sequence must start at index 0".to_string());
            }
            self.pending = Some(PendingChunks {
                chunk_id: chunk_id.clone(),
                count,
                byte_length,
                next_index: 0,
                chunks: Vec::new(),
                received_bytes: 0,
            });
        }
        let pending = self.pending.as_mut().expect("just initialized");
        if pending.chunk_id != chunk_id
            || pending.count != count
            || pending.byte_length != byte_length
            || pending.next_index != index
        {
            return Err("RPC chunk sequence mismatch".to_string());
        }
        pending.received_bytes += bytes.len();
        pending.chunks.push(bytes);
        pending.next_index += 1;
        if pending.received_bytes > pending.byte_length {
            return Err("RPC chunk sequence exceeds declared length".to_string());
        }
        if pending.next_index < pending.count {
            return Ok(None);
        }
        if pending.received_bytes != pending.byte_length {
            return Err("RPC chunk sequence length mismatch".to_string());
        }

        let pending = self.pending.take().expect("just cleared");
        let mut joined: Vec<u8> = Vec::with_capacity(pending.byte_length);
        for chunk in &pending.chunks {
            joined.extend_from_slice(chunk);
        }
        let json = String::from_utf8(joined).map_err(|_| "RPC frame is not valid UTF-8".to_string())?;
        let frame: Value = serde_json::from_str(&json).map_err(|e| format!("RPC frame is not valid JSON: {e}"))?;
        if frame["type"].as_str().is_none() {
            return Err("RPC frame must be an object".to_string());
        }
        Ok(Some(frame))
    }
}

/// Physical JSONL lines (each already `\n`-terminated) for a logical frame at
/// the selected protocol version.
pub fn encode_rpc_frames(frame: &Value, protocol_version: u8, chunk_id: &str) -> Result<Vec<String>, String> {
    let json = serde_json::to_string(frame).map_err(|e| e.to_string())?;
    if json.len() + 1 <= MAX_RPC_FRAME_BYTES {
        return Ok(vec![format!("{json}\n")]);
    }
    if protocol_version < 2 {
        return Err("RPC frame exceeds the v1 transport limit".to_string());
    }
    let bytes = json.into_bytes();
    if bytes.len() > MAX_RPC_REASSEMBLED_BYTES {
        return Err("RPC frame exceeds the v2 reassembly limit".to_string());
    }
    let count = bytes.len().div_ceil(RPC_CHUNK_PAYLOAD_BYTES);
    let mut lines = Vec::with_capacity(count);
    for (index, offset) in (0..bytes.len()).step_by(RPC_CHUNK_PAYLOAD_BYTES).enumerate() {
        let end = (offset + RPC_CHUNK_PAYLOAD_BYTES).min(bytes.len());
        let line = serde_json::to_string(&json!({
            "type": "rpc_chunk",
            "chunkId": chunk_id,
            "index": index,
            "count": count,
            "byteLength": bytes.len(),
            "data": BASE64.encode(&bytes[offset..end]),
        }))
        .expect("chunk record serializes");
        if line.len() + 1 > MAX_RPC_FRAME_BYTES {
            return Err("RPC chunk exceeds the transport limit".to_string());
        }
        lines.push(format!("{line}\n"));
    }
    Ok(lines)
}
