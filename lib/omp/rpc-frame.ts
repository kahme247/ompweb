/**
 * Framing for OMP's NDJSON RPC transport.
 *
 * Protocol-v2 chunking is an OUTBOUND encoding (omp -> host): OMP splits a
 * logical frame larger than `maxFrameBytes` into `rpc_chunk` records and
 * `RpcFrameDecoder` reassembles them. The host's own commands are never
 * chunked — OMP's stdin reader parses one JSONL object per line and never runs
 * the chunk decoder, so a chunked command is answered `success:false,
 * error:"Unknown command: rpc_chunk"` with no id to correlate and the prompt
 * never acks (issue #105).
 */
import { isRecord } from "../type-guards";
/** Largest logical frame OMP emits before it chunks (also the protocol-v1 write cap). */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
/**
 * Largest command omp-web writes to OMP's stdin as one JSONL object. Command
 * bodies are already capped at 8 MiB by the agent routes
 * (`MAX_AGENT_COMMAND_REQUEST_BYTES`); this bound only turns a pathological
 * command into a clear error instead of an unbounded pipe write.
 */
export const MAX_INBOUND_COMMAND_BYTES = 32 * 1024 * 1024;
const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

export type RpcProtocolVersion = 1 | 2;
export type RpcFrameRecord = { type: string; [key: string]: unknown };

interface PendingChunks {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  chunks: Buffer[];
  receivedBytes: number;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function decodeBase64(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) throw new Error("invalid RPC chunk data");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("invalid RPC chunk data");
  return bytes;
}

/** Decodes complete logical frames from parsed JSONL records. */
export class RpcFrameDecoder {
  private pending: PendingChunks | undefined;

  push(value: unknown): RpcFrameRecord | undefined {
    if (!isRecord(value) || value.type !== "rpc_chunk") {
      if (this.pending) throw new Error("RPC chunk sequence interrupted");
      if (!isRecord(value) || typeof value.type !== "string") throw new Error("RPC frame must be an object");
      return value as RpcFrameRecord;
    }
    const { chunkId, index, count, byteLength } = value;
    if (
      typeof chunkId !== "string" || chunkId.length === 0 || chunkId.length > 128 ||
      !isSafeInteger(index) || !isSafeInteger(count) || !isSafeInteger(byteLength) ||
      index < 0 || count < 2 || count > Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES) ||
      index >= count || byteLength < MAX_RPC_FRAME_BYTES || byteLength > MAX_RPC_REASSEMBLED_BYTES
    ) throw new Error("invalid RPC chunk metadata");

    const bytes = decodeBase64(value.data);
    if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) throw new Error("RPC chunk payload exceeds the transport limit");
    if (!this.pending) {
      if (index !== 0) throw new Error("RPC chunk sequence must start at index 0");
      this.pending = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
    }
    const pending = this.pending!;
    if (pending.chunkId !== chunkId || pending.count !== count || pending.byteLength !== byteLength || pending.nextIndex !== index) {
      throw new Error("RPC chunk sequence mismatch");
    }
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex++;
    if (pending.receivedBytes > pending.byteLength) throw new Error("RPC chunk sequence exceeds declared length");
    if (pending.nextIndex < pending.count) return undefined;
    if (pending.receivedBytes !== pending.byteLength) throw new Error("RPC chunk sequence length mismatch");

    this.pending = undefined;
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
    const frame: unknown = JSON.parse(json);
    if (!isRecord(frame) || typeof frame.type !== "string") throw new Error("RPC frame must be an object");
    return frame as RpcFrameRecord;
  }
}

/**
 * Physical JSONL record for one command on OMP's stdin.
 *
 * Always a single unchunked line, however large: `maxFrameBytes` bounds omp's
 * outbound physical frames, not the host's commands (see the file header and
 * issue #105). Base64 attachment payloads routinely exceed 1 MiB and used to be
 * split into `rpc_chunk` records that OMP rejected.
 */
export function encodeRpcCommand(frame: RpcFrameRecord): string {
  const json = JSON.stringify(frame);
  const byteLength = Buffer.byteLength(json, "utf8") + 1;
  if (byteLength > MAX_INBOUND_COMMAND_BYTES) {
    throw new Error(`RPC command exceeds the ${MAX_INBOUND_COMMAND_BYTES}-byte inbound transport limit`);
  }
  return `${json}\n`;
}
