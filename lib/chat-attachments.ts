/**
 * Text-attachment budget.
 *
 * Nothing on the OMP side limits these: attached file contents are inlined
 * into the prompt as text, and OMP's RPC transport advertises (in its `ready`
 * frame) `maxFrameBytes` 1 MiB with chunked v2 frames reassembling up to
 * 64 MiB — omp/18.1.17 accepts a 3 MB logical command frame. The binding
 * ceilings are omp-web's own 8 MiB JSON request body
 * (`MAX_AGENT_COMMAND_REQUEST_BYTES`) and the model's context window, so the
 * budget is enforced on the aggregate rather than per file.
 */
export const MAX_TOTAL_ATTACHED_TEXT_BYTES = 4 * 1024 * 1024;
/** A lone file may fill the whole text budget. */
export const MAX_ATTACHED_TEXT_BYTES = MAX_TOTAL_ATTACHED_TEXT_BYTES;
export const MAX_ATTACHED_TEXT_FILES = 10;

const TEXT_FILE_EXTENSIONS: Record<string, true> = {
  txt: true,
  text: true,
  md: true,
  markdown: true,
  mdx: true,
};

export interface AttachedTextFileData {
  name: string;
  mimeType: string;
  content: string;
  size: number;
}

/** Extracts lowercased file extension without leading dot. */
function getFileExtension(name: string): string {
  return name.toLowerCase().replace(/\\/g, "/").split("/").pop()?.split(".").pop() ?? "";
}

/** Human-readable limit for the composer banners ("512 KB" / "4 MB"). */
export function formatAttachmentBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / (1024 * 1024))} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/** What the composer already holds (or has in flight) when a new batch lands. */
export interface TextAttachmentBudget {
  usedBytes: number;
  usedSlots: number;
}

export interface TextAttachmentSelection<T> {
  accepted: T[];
  /** Candidates dropped for exceeding the per-file cap. */
  tooLarge: number;
  /** Candidates dropped because the message's aggregate text budget was spent. */
  overBudget: number;
}

/**
 * Per-file, aggregate, and slot rules when adding text attachments. Persisted
 * drafts bypass picker budgets so recovery never silently drops saved files.
 * Candidates beyond remaining slots match the caller's count-cap handling;
 * a lone oversized candidate is reported before an aggregate-budget miss so
 * the banner names the limit the user actually hit.
 */
export function selectTextAttachments<T extends { size: number }>(
  candidates: readonly T[],
  budget: TextAttachmentBudget,
): TextAttachmentSelection<T> {
  const accepted: T[] = [];
  const remainingSlots = Math.max(0, MAX_ATTACHED_TEXT_FILES - budget.usedSlots);
  let totalBytes = budget.usedBytes;
  let tooLarge = 0;
  let overBudget = 0;
  for (const candidate of candidates) {
    if (accepted.length >= remainingSlots) break;
    if (!Number.isFinite(candidate.size) || candidate.size > MAX_ATTACHED_TEXT_BYTES) {
      tooLarge++;
      continue;
    }
    if (totalBytes + candidate.size > MAX_TOTAL_ATTACHED_TEXT_BYTES) {
      overBudget++;
      continue;
    }
    totalBytes += candidate.size;
    accepted.push(candidate);
  }
  return { accepted, tooLarge, overBudget };
}

/** Banner text for a batch that produced no usable attachments. */
export function describeTextAttachmentSkip(
  selection: Pick<TextAttachmentSelection<unknown>, "tooLarge" | "overBudget">,
): string | null {
  if (selection.tooLarge > 0) {
    return `${selection.tooLarge} file(s) skipped: files up to ${formatAttachmentBytes(MAX_ATTACHED_TEXT_BYTES)} are supported.`;
  }
  if (selection.overBudget > 0) {
    return `${selection.overBudget} file(s) skipped: attachments are limited to ${formatAttachmentBytes(MAX_TOTAL_ATTACHED_TEXT_BYTES)} per message.`;
  }
  return null;
}

/** Checks whether file is candidate for text attachment by MIME type or extension. */
export function isTextAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  return file.type === "text/plain"
    || file.type === "text/markdown"
    || TEXT_FILE_EXTENSIONS[getFileExtension(file.name)] === true;
}

const MARKDOWN_EXTENSIONS: Record<string, true> = {
  md: true,
  markdown: true,
  mdx: true,
  docx: true,
  xlsx: true,
  pptx: true,
  odt: true,
  ods: true,
  odp: true,
  epub: true,
};

const RASTER_IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
};

/** Checks whether file is candidate for image attachment by MIME type or extension. */
export function isImageAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  if (file.type && file.type.startsWith("image/")) {
    return true;
  }
  if (!file.type || file.type === "application/octet-stream") {
    const ext = getFileExtension(file.name);
    return Boolean(RASTER_IMAGE_EXTENSIONS[ext]);
  }
  return false;
}

/** Determines MIME type for image file from type property or extension fallback. */
export function inferImageMimeType(file: Pick<File, "name" | "type">): string {
  if (file.type && file.type.startsWith("image/")) {
    return file.type;
  }
  const ext = getFileExtension(file.name);
  return RASTER_IMAGE_EXTENSIONS[ext] || file.type || "application/octet-stream";
}

/** Maps file extension to composer markdown language identifier. */
function languageForFile(name: string): string {
  const extension = getFileExtension(name);
  if (MARKDOWN_EXTENSIONS[extension]) return "markdown";
  return "text";
}

/** Computes markdown code fence backtick count that safely encloses content. */
function fenceForContent(content: string): string {
  const longestRun = content.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** Add text-file contents to the prompt while keeping the attachment boundary clear. */
export function composeMessageWithTextAttachments(
  message: string,
  files: AttachedTextFileData[],
): string {
  if (files.length === 0) return message;
  const blocks = files.map((file) => {
    const fence = fenceForContent(file.content);
    return `Attached file: ${file.name}\n${fence}${languageForFile(file.name)}\n${file.content}\n${fence}`;
  });
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}

/** Decodes XML named and numeric character entities in a single pass. */
export function decodeXmlEntities(str: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00a0",
  };
  return str.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (whole, dec, hex, name) => {
    if (name) return named[name] ?? whole;
    const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
      ? String.fromCodePoint(cp)
      : whole;
  });
}

const MAX_DECOMPRESSED_BYTES = MAX_TOTAL_ATTACHED_TEXT_BYTES * 4;
const MAX_CMAP_ENTRIES = 262144;
const MAX_CMAP_RANGE_SPAN = 4096;

interface DecompressBudget {
  remaining: number;
}

/** Decompresses deflate data stream while enforcing byte budget. */
async function decompressDeflate(
  data: Uint8Array,
  format: "deflate" | "deflate-raw",
  budget: DecompressBudget,
): Promise<Uint8Array> {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  const writePromise = writer.write(new Uint8Array(data)).then(() => writer.close());
  writePromise.catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    budget.remaining -= value.length;
    if (total > MAX_DECOMPRESSED_BYTES || budget.remaining < 0) {
      await reader.cancel().catch(() => {});
      throw new Error("Decompressed stream exceeds maximum allowed size");
    }
    chunks.push(value);
  }
  await writePromise;
  const res = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    res.set(c, off);
    off += c.length;
  }
  return res;
}

/** Attempts deflate or deflate-raw decompression within budget. */
async function tryDecompress(data: Uint8Array, budget: DecompressBudget): Promise<Uint8Array | null> {
  if (data.length === 0) return new Uint8Array(0);
  if (budget.remaining <= 0) return null;
  const hasZlibHeader = data.length >= 2
    && (data[0] & 0x0f) === 8
    && (data[0] >> 4) <= 7
    && ((data[0] << 8) | data[1]) % 31 === 0;
  const primary: "deflate" | "deflate-raw" = hasZlibHeader ? "deflate" : "deflate-raw";
  const secondary: "deflate" | "deflate-raw" = hasZlibHeader ? "deflate-raw" : "deflate";
  try {
    return await decompressDeflate(data, primary, budget);
  } catch {
    if (budget.remaining <= 0) return null;
    try {
      return await decompressDeflate(data, secondary, budget);
    } catch {
      return null;
    }
  }
}

interface PdfCMap {
  map: Map<number, string>;
  codeBytes: 1 | 2;
}

/** Converts CMap hex destination sequence into a UTF-16 string. */
function decodeCMapTargetHex(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length === 2) {
    const cp = parseInt(clean, 16);
    return cp > 0 ? String.fromCodePoint(cp) : "";
  }
  let out = "";
  for (let i = 0; i < clean.length; i += 4) {
    const cp = parseInt(clean.slice(i, i + 4), 16);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 8 <= clean.length) {
      const low = parseInt(clean.slice(i + 4, i + 8), 16);
      if (low >= 0xdc00 && low <= 0xdfff) {
        out += String.fromCharCode(cp, low);
        i += 4;
        continue;
      }
    }
    if (cp > 0 && cp !== 0xffff) out += String.fromCodePoint(cp);
  }
  return out;
}

/** Parses a PDF ToUnicode CMap stream into a character mapping table. */
function parseCMap(cmapStr: string, cmapBudget: DecompressBudget): PdfCMap {
  const map = new Map<number, string>();
  let codeBytes: 1 | 2 = 1;
  const csRegex = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let match: RegExpExecArray | null;
  while ((match = csRegex.exec(cmapStr)) !== null) {
    const pairs = match[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g) ?? [];
    for (const pair of pairs) {
      const m = pair.match(/<([0-9a-fA-F]+)>/);
      if (m && m[1].length >= 4) codeBytes = 2;
    }
  }

  const bfcharRegex = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((match = bfcharRegex.exec(cmapStr)) !== null && cmapBudget.remaining > 0) {
    const pairRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let pm: RegExpExecArray | null;
    while ((pm = pairRegex.exec(match[1])) !== null && --cmapBudget.remaining >= 0) {
      if (pm[1].length >= 4) codeBytes = 2;
      map.set(parseInt(pm[1], 16), decodeCMapTargetHex(pm[2]));
    }
  }

  const bfrangeRegex = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((match = bfrangeRegex.exec(cmapStr)) !== null && cmapBudget.remaining > 0) {
    const rangeRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let rm: RegExpExecArray | null;
    while ((rm = rangeRegex.exec(match[1])) !== null && cmapBudget.remaining > 0) {
      if (rm[1].length >= 4) codeBytes = 2;
      const start = parseInt(rm[1], 16);
      const end = parseInt(rm[2], 16);
      if (end < start) continue;
      if (rm[3]) {
        const baseStr = decodeCMapTargetHex(rm[3]);
        if (!baseStr) continue;
        const prefix = baseStr.slice(0, -1);
        const lastUnit = baseStr.charCodeAt(baseStr.length - 1);
        const maxEnd = Math.min(end, start + MAX_CMAP_RANGE_SPAN - 1);
        for (let code = start; code <= maxEnd && --cmapBudget.remaining >= 0; code++) {
          const nextUnit = lastUnit + (code - start);
          if (nextUnit >= 0xffff) break;
          if (nextUnit > 0) {
            map.set(code, prefix + String.fromCharCode(nextUnit));
          }
        }
      } else if (rm[4]) {
        const items = rm[4].match(/<([0-9a-fA-F]+)>/g) ?? [];
        for (let i = 0; i < items.length && start + i <= end && --cmapBudget.remaining >= 0; i++) {
          map.set(start + i, decodeCMapTargetHex(items[i].slice(1, -1)));
        }
      }
    }
  }
  return { map, codeBytes };
}

/** Decodes PDF literal string escape sequences into raw byte values. */
function decodePdfLiteralBytes(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    if (ch === 0x5c && i + 1 < str.length) {
      const next = str[++i];
      if (next === "n") bytes.push(0x0a);
      else if (next === "r") bytes.push(0x0d);
      else if (next === "t") bytes.push(0x09);
      else if (next === "b") bytes.push(0x08);
      else if (next === "f") bytes.push(0x0c);
      else if (next === "(") bytes.push(0x28);
      else if (next === ")") bytes.push(0x29);
      else if (next === "\\") bytes.push(0x5c);
      else if (next === "\r") {
        if (str[i + 1] === "\n") i++;
      } else if (next === "\n") {
        // escaped line continuation
      } else if (next >= "0" && next <= "7") {
        let octal = next;
        if (i + 1 < str.length && str[i + 1] >= "0" && str[i + 1] <= "7") octal += str[++i];
        if (i + 1 < str.length && str[i + 1] >= "0" && str[i + 1] <= "7") octal += str[++i];
        bytes.push(parseInt(octal, 8) & 0xff);
      } else {
        bytes.push(next.charCodeAt(0) & 0xff);
      }
    } else {
      bytes.push(ch & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** Decodes PDF hex string into raw byte array. */
function decodePdfHexBytes(hexStr: string): Uint8Array {
  const clean = hexStr.replace(/\s+/g, "");
  if (clean.length === 0) return new Uint8Array(0);
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < padded.length; i += 2) {
    out[i / 2] = parseInt(padded.slice(i, i + 2), 16);
  }
  return out;
}

/** Maps decoded PDF bytes to text using font CMap or fallback encodings. */
function decodeBytesWithPdfCMap(bytes: Uint8Array, cmap: PdfCMap | undefined): string {
  if (!cmap || cmap.map.size === 0) {
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder("windows-1252").decode(bytes);
    }
  }
  let out = "";
  if (cmap.codeBytes === 2 && bytes.length >= 2) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      out += cmap.map.get(code) ?? (code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : "");
    }
  } else {
    for (const b of bytes) {
      out += cmap.map.get(b) ?? (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "");
    }
  }
  return out;
}

/** Converts byte array to binary Latin-1 string in bounded chunks. */
function bytesToBinaryString(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** Extracts text streams and character mappings from PDF file buffer. */
async function extractPdfText(buf: ArrayBuffer): Promise<string | null> {
  const budget: DecompressBudget = { remaining: MAX_DECOMPRESSED_BYTES };
  const latin1 = bytesToBinaryString(new Uint8Array(buf));
  const objHeaderRegex = /(\d+)\s+\d+\s+obj\b/g;
  const streamMarkerRe = />>\s*stream(?:\r?\n|\r)/g;
  const nonTextStreamRe = /\/Subtype\s*\/(?:Image|Type1C|CIDFontType0C|OpenType)\b|\/Length[123]\b|\/Type\s*\/(?:XRef|Metadata|EmbeddedFile)\b|\/BitsPerComponent\b/;
  const objects = new Map<number, { dict: string; streamText: string | null; body: string }>();
  let m: RegExpExecArray | null;
  while ((m = objHeaderRegex.exec(latin1)) !== null) {
    const id = parseInt(m[1], 10);
    const bodyStart = m.index + m[0].length;
    const endObjIdx = latin1.indexOf("endobj", bodyStart);
    if (endObjIdx === -1) break;
    objHeaderRegex.lastIndex = endObjIdx + 6;
    const body = latin1.slice(bodyStart, endObjIdx);
    const endStreamIdx = body.indexOf("endstream");
    const dictStart = endStreamIdx !== -1 ? body.indexOf("<<") : -1;
    let sMatch: RegExpExecArray | null = null;
    if (dictStart !== -1 && dictStart < endStreamIdx) {
      streamMarkerRe.lastIndex = dictStart + 2;
      const candidate = streamMarkerRe.exec(body);
      if (candidate && candidate.index < endStreamIdx) {
        sMatch = candidate;
      }
    }
    if (sMatch && endStreamIdx !== -1) {
      const dict = body.slice(dictStart + 2, sMatch.index);
      if (nonTextStreamRe.test(dict)) {
        objects.set(id, { dict, streamText: null, body });
        continue;
      }
      const streamStart = sMatch.index + sMatch[0].length;
      let streamEnd = endStreamIdx;
      if (body[streamEnd - 1] === "\n") streamEnd--;
      if (body[streamEnd - 1] === "\r") streamEnd--;
      const rawStream = streamEnd >= streamStart ? body.slice(streamStart, streamEnd) : "";
      let streamText: string | null = rawStream;
      if (/\/FlateDecode\b/.test(dict) && rawStream.length > 0) {
        if (budget.remaining <= 0) {
          streamText = null;
        } else {
          const rawBytes = Uint8Array.from(rawStream, (c) => c.charCodeAt(0) & 0xff);
          const decomp = await tryDecompress(rawBytes, budget);
          streamText = decomp ? bytesToBinaryString(decomp) : null;
        }
      }
      objects.set(id, { dict, streamText, body });
      if (streamText && /\/Type\s*\/ObjStm\b/.test(dict)) {
        const firstMatch = /\/First\s+(\d+)/.exec(dict);
        const countMatch = /\/N\s+(\d+)/.exec(dict);
        if (firstMatch && countMatch) {
          const first = parseInt(firstMatch[1], 10);
          const count = parseInt(countMatch[1], 10);
          const header = streamText.slice(0, first).trim().split(/\s+/).map(Number);
          const content = streamText.slice(first);
          for (let i = 0; i < count && i * 2 + 1 < header.length; i++) {
            const objNum = header[i * 2];
            const offset = header[i * 2 + 1];
            const nextOffset = i + 1 < count ? header[(i + 1) * 2 + 1] : content.length;
            const subBody = content.slice(offset, nextOffset);
            if (!objects.has(objNum)) {
              objects.set(objNum, { dict: subBody, streamText: null, body: subBody });
            }
          }
        }
      }
    } else {
      objects.set(id, { dict: body, streamText: null, body });
    }
  }

  const cmapBudget: DecompressBudget = { remaining: MAX_CMAP_ENTRIES };
  const cmapsByObj = new Map<number, PdfCMap>();
  for (const [id, obj] of objects) {
    if (cmapBudget.remaining <= 0) break;
    if (obj.streamText && (obj.streamText.includes("begincmap") || obj.streamText.includes("/CMapName"))) {
      cmapsByObj.set(id, parseCMap(obj.streamText, cmapBudget));
    }
  }
  const fontObjIds = new Set<number>();
  const fontObjToCMap = new Map<number, PdfCMap>();
  for (const [id, obj] of objects) {
    if (/\/Type\s*\/Font\b/.test(obj.body) || /\/Subtype\s*\/(?:Type0|Type1|TrueType|MMType1|Type3|CIDFontType[02])\b/.test(obj.body)) {
      fontObjIds.add(id);
    }
    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(obj.body);
    if (tu) {
      fontObjIds.add(id);
      const cmap = cmapsByObj.get(parseInt(tu[1], 10));
      if (cmap) fontObjToCMap.set(id, cmap);
    }
  }
  const knownFontNames = new Set<string>();
  const fontNameToCMap = new Map<string, PdfCMap>();
  for (const [, obj] of objects) {
    const fontRefRe = /\/([A-Za-z0-9_.-]+)\s+(\d+)\s+\d+\s+R/g;
    let fm: RegExpExecArray | null;
    while ((fm = fontRefRe.exec(obj.body)) !== null) {
      const targetId = parseInt(fm[2], 10);
      if (fontObjIds.has(targetId)) {
        knownFontNames.add(fm[1]);
      }
      const cmap = fontObjToCMap.get(targetId);
      if (cmap) fontNameToCMap.set(fm[1], cmap);
    }
  }
  const unifiedMap = new Map<number, string>();
  let unifiedCodeBytes: 1 | 2 = 1;
  for (const cmap of cmapsByObj.values()) {
    if (cmap.codeBytes === 2) unifiedCodeBytes = 2;
    for (const [k, v] of cmap.map) {
      if (unifiedMap.size >= MAX_CMAP_ENTRIES) break;
      unifiedMap.set(k, v);
    }
  }
  const fallbackCMap: PdfCMap | undefined = unifiedMap.size > 0 ? { map: unifiedMap, codeBytes: unifiedCodeBytes } : undefined;

  const resolveFontCMap = (fontName: string | null): PdfCMap | undefined => {
    if (fontName) {
      if (fontNameToCMap.has(fontName)) return fontNameToCMap.get(fontName);
      if (knownFontNames.has(fontName)) return undefined;
    }
    return fallbackCMap;
  };

  type Mat2D = [number, number, number, number, number, number];
  const mulMat = (m1: Mat2D, m2: Mat2D): Mat2D => [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
  const estimateTextAdvance = (
    str: string,
    fontSize: number,
    charSpacing: number,
    wordSpacing: number,
    horizScale: number,
  ): number => {
    let adv = 0;
    for (let i = 0; i < str.length; i++) {
      const cp = str.codePointAt(i)!;
      if (cp > 0xffff) i++;
      const glyphW = cp >= 0x2e80 ? 1.0 : 0.52;
      adv += (glyphW * fontSize + charSpacing + (cp === 0x20 ? wordSpacing : 0)) * horizScale;
    }
    return adv;
  };

  interface PdfTextRun {
    text: string;
    x: number;
    y: number;
    width: number;
    fontSize: number;
    btId: number;
    forcedSpace: boolean;
    seq: number;
  }

  const lines: string[] = [];
  let globalSeq = 0;
  let globalBtId = 0;
  const streamTokenRe =
    /\/([A-Za-z0-9_.-]+)|\((?:\\[\s\S]|[^\\()])*\)|<([0-9a-fA-F\s]+)>|(\[|\])|([-+]?(?:\d+\.?\d*|\.\d+))|(\b(?:BT|ET|Tf|Tm|Td|TD|TL|Tc|Tw|Tz|cm|q|Q|Tj|TJ)\b|\bT\*|['"])|\b([A-Za-z*]+)\b/g;

  for (const [, obj] of objects) {
    if (!obj.streamText || !obj.streamText.includes("BT") || obj.streamText.includes("begincmap")) continue;
    let ctm: Mat2D = [1, 0, 0, 1, 0, 0];
    const ctmStack: Mat2D[] = [];
    let tmMat: Mat2D = [1, 0, 0, 1, 0, 0];
    let tlmMat: Mat2D = [1, 0, 0, 1, 0, 0];
    let currentFont: string | null = null;
    let pendingName: string | null = null;
    let fontSize = 10;
    let leading = 0;
    let charSpacing = 0;
    let wordSpacing = 0;
    let horizScale = 1;
    let inText = false;
    let inTjArray = false;
    let currentBtId = 0;
    let nextForcedSpace = false;
    const numStack: number[] = [];
    const pageRuns: PdfTextRun[] = [];
    let activeRun: PdfTextRun | null = null;

    const flushRun = (): number | null => {
      if (activeRun) {
        const endX = activeRun.x + activeRun.width;
        if (activeRun.text) pageRuns.push(activeRun);
        activeRun = null;
        return endX;
      }
      return null;
    };

    const appendDecodedText = (decoded: string) => {
      if (!decoded) return;
      const dev = mulMat(tmMat, ctm);
      const effFontSize = Math.max(4, fontSize * (Math.hypot(dev[0], dev[1]) || Math.hypot(dev[2], dev[3]) || 1));
      const advText = estimateTextAdvance(decoded, fontSize, charSpacing, wordSpacing, horizScale);
      const advDev = advText * (Math.hypot(dev[0], dev[1]) || 1);
      if (!activeRun) {
        activeRun = {
          text: decoded,
          x: dev[4],
          y: dev[5],
          width: advDev,
          fontSize: effFontSize,
          btId: currentBtId,
          forcedSpace: nextForcedSpace,
          seq: globalSeq++,
        };
        nextForcedSpace = false;
      } else {
        activeRun.text += decoded;
        activeRun.width += advDev;
      }
      tmMat = mulMat([1, 0, 0, 1, advText, 0], tmMat);
    };

    streamTokenRe.lastIndex = 0;
    let tok: RegExpExecArray | null;
    while ((tok = streamTokenRe.exec(obj.streamText)) !== null) {
      if (tok[1] !== undefined) {
        pendingName = tok[1];
      } else if (tok[0].startsWith("(")) {
        if (inText) {
          const bytes = decodePdfLiteralBytes(tok[0].slice(1, -1));
          appendDecodedText(decodeBytesWithPdfCMap(bytes, resolveFontCMap(currentFont)));
        }
      } else if (tok[2] !== undefined) {
        if (inText) {
          const bytes = decodePdfHexBytes(tok[2]);
          appendDecodedText(decodeBytesWithPdfCMap(bytes, resolveFontCMap(currentFont)));
        }
      } else if (tok[3] !== undefined) {
        if (tok[3] === "[") {
          inTjArray = true;
          numStack.length = 0;
        } else {
          inTjArray = false;
          numStack.length = 0;
        }
      } else if (tok[4] !== undefined) {
        const num = parseFloat(tok[4]);
        if (Number.isFinite(num)) {
          if (inText && inTjArray) {
            if (num <= -150) {
              flushRun();
              nextForcedSpace = true;
            }
            tmMat = mulMat([1, 0, 0, 1, (-num / 1000) * fontSize * horizScale, 0], tmMat);
          } else {
            numStack.push(num);
            if (numStack.length > 6) numStack.shift();
          }
        }
      } else if (tok[5] !== undefined) {
        const op = tok[5];
        if (op === "BT") {
          flushRun();
          inText = true;
          inTjArray = false;
          currentBtId = ++globalBtId;
          nextForcedSpace = false;
          tmMat = [1, 0, 0, 1, 0, 0];
          tlmMat = [1, 0, 0, 1, 0, 0];
        } else if (op === "ET") {
          flushRun();
          inText = false;
          inTjArray = false;
        } else if (op === "Tf") {
          if (pendingName) currentFont = pendingName;
          const sz = numStack.pop();
          if (sz !== undefined && Number.isFinite(sz)) fontSize = Math.abs(sz) || 10;
        } else if (op === "Tm") {
          if (numStack.length >= 6) {
            const prevDevX = flushRun();
            const [a, b, c, d, e, f] = numStack.slice(-6);
            tlmMat = [a, b, c, d, e, f];
            tmMat = [a, b, c, d, e, f];
            const newDev = mulMat(tmMat, ctm);
            if (prevDevX === null || Math.abs(newDev[4] - prevDevX) > Math.max(1.5, fontSize * 0.12)) {
              nextForcedSpace = true;
            }
          }
        } else if (op === "Td" || op === "TD") {
          if (numStack.length >= 2) {
            const [tx, ty] = numStack.slice(-2);
            if (op === "TD") leading = -ty;
            const prevDevX = flushRun();
            tlmMat = mulMat([1, 0, 0, 1, tx, ty], tlmMat);
            tmMat = [...tlmMat] as Mat2D;
            const newDev = mulMat(tmMat, ctm);
            if (prevDevX === null || Math.abs(newDev[4] - prevDevX) > Math.max(1.5, fontSize * 0.12)) {
              nextForcedSpace = true;
            }
          }
        } else if (op === "T*" || op === "'" || op === '"') {
          flushRun();
          const dy = -(leading || fontSize * 1.2);
          tlmMat = mulMat([1, 0, 0, 1, 0, dy], tlmMat);
          tmMat = [...tlmMat] as Mat2D;
          nextForcedSpace = false;
        } else if (op === "TL") {
          const tl = numStack.pop();
          if (tl !== undefined) leading = tl;
        } else if (op === "Tc") {
          const tc = numStack.pop();
          if (tc !== undefined) charSpacing = tc;
        } else if (op === "Tw") {
          const tw = numStack.pop();
          if (tw !== undefined) wordSpacing = tw;
        } else if (op === "Tz") {
          const tz = numStack.pop();
          if (tz !== undefined) horizScale = (tz || 100) / 100;
        } else if (op === "cm") {
          if (numStack.length >= 6) {
            const [a, b, c, d, e, f] = numStack.slice(-6);
            ctm = mulMat([a, b, c, d, e, f], ctm);
          }
        } else if (op === "q") {
          ctmStack.push([...ctm] as Mat2D);
        } else if (op === "Q") {
          if (ctmStack.length > 0) ctm = ctmStack.pop()!;
        }
        numStack.length = 0;
        pendingName = null;
      } else if (tok[6] !== undefined) {
        numStack.length = 0;
        pendingName = null;
      }
    }
    flushRun();

    if (pageRuns.length > 0) {
      pageRuns.sort((a, b) => b.y - a.y || a.x - b.x || a.seq - b.seq);
      const rows: { y: number; fontSize: number; runs: PdfTextRun[] }[] = [];
      for (const run of pageRuns) {
        const lastRow = rows[rows.length - 1];
        const tol = lastRow ? Math.max(2.5, Math.min(lastRow.fontSize, run.fontSize) * 0.45) : 0;
        if (lastRow && Math.abs(run.y - lastRow.y) <= tol) {
          lastRow.runs.push(run);
        } else {
          rows.push({ y: run.y, fontSize: run.fontSize, runs: [run] });
        }
      }
      for (const row of rows) {
        row.runs.sort((a, b) => a.x - b.x || a.seq - b.seq);
        let rowText = "";
        let prevRun: PdfTextRun | null = null;
        for (const run of row.runs) {
          if (!run.text) continue;
          if (!prevRun) {
            rowText = run.text;
          } else {
            const gap = run.x - (prevRun.x + prevRun.width);
            const needSpace =
              !rowText.endsWith(" ") &&
              !run.text.startsWith(" ") &&
              (run.btId !== prevRun.btId || run.forcedSpace || gap > Math.max(1.5, prevRun.fontSize * 0.15));
            rowText += (needSpace ? " " : "") + run.text;
          }
          prevRun = run;
        }
        if (rowText.trim()) lines.push(rowText.trim());
      }
    }
  }
  const result = lines.join("\n").replace(/\u0000/g, "").trim();
  return result.length > 0 && !result.includes("\uFFFD") ? result : null;
}

/** Parses ZIP central directory and returns lazy decompression loaders. */
async function readZipEntries(buffer: ArrayBuffer): Promise<Map<string, () => Promise<Uint8Array>>> {
  const budget: DecompressBudget = { remaining: MAX_DECOMPRESSED_BYTES };
  const view = new DataView(buffer);
  const len = buffer.byteLength;
  let eocdOffset = -1;
  const maxSearch = Math.min(len, 65535 + 22);
  for (let i = len - 22; i >= len - maxSearch; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  const entries = new Map<string, () => Promise<Uint8Array>>();
  if (eocdOffset !== -1) {
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdCount = view.getUint16(eocdOffset + 10, true);
    let curr = cdOffset;
    for (let i = 0; i < cdCount && curr < eocdOffset; i++) {
      if (view.getUint32(curr, true) !== 0x02014b50) break;
      const method = view.getUint16(curr + 10, true);
      const compressedSize = view.getUint32(curr + 20, true);
      const nameLen = view.getUint16(curr + 28, true);
      const extraLen = view.getUint16(curr + 30, true);
      const commentLen = view.getUint16(curr + 32, true);
      const localOffset = view.getUint32(curr + 42, true);

      const nameBytes = new Uint8Array(buffer, curr + 46, nameLen);
      const name = new TextDecoder("utf-8").decode(nameBytes);

      if (view.getUint32(localOffset, true) === 0x04034b50) {
        const localNameLen = view.getUint16(localOffset + 26, true);
        const localExtraLen = view.getUint16(localOffset + 28, true);
        const dataOffset = localOffset + 30 + localNameLen + localExtraLen;
        const compressedData = new Uint8Array(buffer, dataOffset, compressedSize);

        entries.set(name, async () => {
          if (method === 0) {
            budget.remaining -= compressedData.byteLength;
            if (budget.remaining < 0) {
              throw new Error("Decompressed archive exceeds maximum allowed size");
            }
            return compressedData;
          }
          if (method === 8) return await decompressDeflate(compressedData, "deflate-raw", budget);
          throw new Error(`Unsupported method ${method}`);
        });
      }
      curr += 46 + nameLen + extraLen + commentLen;
    }
  }
  return entries;
}

/** Extracts plain text from DOCX run XML elements. */
function extractDocxRuns(containerXml: string): string {
  const elemRegex = /<w:t(?:[\s>][\s\S]*?<\/w:t>|\/>)|<w:br\b[^>]*\/>|<w:tab\b[^>]*\/>/g;
  let text = "";
  let m: RegExpExecArray | null;
  while ((m = elemRegex.exec(containerXml)) !== null) {
    const tag = m[0];
    if (tag.startsWith("<w:t")) {
      const content = tag.replace(/^<w:t[^>]*>/, "").replace(/<\/w:t>$/, "");
      text += decodeXmlEntities(content);
    } else if (tag.startsWith("<w:br")) {
      text += "\n";
    } else if (tag.startsWith("<w:tab")) {
      text += "\t";
    }
  }
  return text;
}

/** Extracts paragraphs and tables from OOXML DOCX document entries. */
async function extractDocx(entries: Map<string, () => Promise<Uint8Array>>): Promise<string | null> {
  const xmlNames = ["word/document.xml"];
  for (const name of entries.keys()) {
    if (/^word\/(?:header|footer)\d*\.xml$/.test(name)) {
      xmlNames.push(name);
    }
  }
  const parts: string[] = [];
  for (const name of xmlNames) {
    const fn = entries.get(name);
    if (!fn) continue;
    const buf = await fn();
    const xml = new TextDecoder("utf-8").decode(buf);
    const blockRegex = /<w:tbl[\s\S]*?<\/w:tbl>|<w:p[\s\S]*?<\/w:p>/g;
    let m: RegExpExecArray | null;
    while ((m = blockRegex.exec(xml)) !== null) {
      const block = m[0];
      if (block.startsWith("<w:tbl")) {
        const rows: string[][] = [];
        const trRegex = /<w:tr[\s\S]*?<\/w:tr>/g;
        let trMatch: RegExpExecArray | null;
        while ((trMatch = trRegex.exec(block)) !== null) {
          const tr = trMatch[0];
          const cells: string[] = [];
          const tcRegex = /<w:tc[\s\S]*?<\/w:tc>/g;
          let tcMatch: RegExpExecArray | null;
          while ((tcMatch = tcRegex.exec(tr)) !== null) {
            const tc = tcMatch[0];
            const text = extractDocxRuns(tc);
            cells.push(text.trim());
          }
          if (cells.length > 0) rows.push(cells);
        }
        if (rows.length > 0) {
          const maxCols = Math.max(...rows.map((r) => r.length));
          const formattedRows = rows.map((r) => {
            const padded = [...r];
            while (padded.length < maxCols) padded.push("");
            return "| " + padded.map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ") + " |";
          });
          const header = formattedRows[0];
          const separator = "| " + Array(maxCols).fill("---").join(" | ") + " |";
          parts.push([header, separator, ...formattedRows.slice(1)].join("\n"));
        }
      } else {
        const text = extractDocxRuns(block);
        if (text.trim()) parts.push(text.trim());
      }
    }
  }
  const res = parts.join("\n\n").trim();
  return res || null;
}

/** Extracts worksheets and shared strings from OOXML XLSX into Markdown tables. */
async function extractXlsx(entries: Map<string, () => Promise<Uint8Array>>): Promise<string | null> {
  const sharedStrings: string[] = [];
  const ssFn = entries.get("xl/sharedStrings.xml");
  if (ssFn) {
    const ssBuf = await ssFn();
    const ssXml = new TextDecoder("utf-8").decode(ssBuf);
    const siRegex = /<si[\s\S]*?<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = siRegex.exec(ssXml)) !== null) {
      const si = m[0];
      const tRegex = /<t[\s\S]*?<\/t>/g;
      let tMatch: RegExpExecArray | null;
      let text = "";
      while ((tMatch = tRegex.exec(si)) !== null) {
        text += tMatch[0].replace(/^<t[^>]*>/, "").replace(/<\/t>$/, "");
      }
      sharedStrings.push(decodeXmlEntities(text));
    }
  }

  const relsFn = entries.get("xl/_rels/workbook.xml.rels");
  const relMap = new Map<string, string>();
  if (relsFn) {
    const relBuf = await relsFn();
    const relXml = new TextDecoder("utf-8").decode(relBuf);
    const relRegex = /<Relationship\b([^>]*)\/>/g;
    let m: RegExpExecArray | null;
    while ((m = relRegex.exec(relXml)) !== null) {
      const idMatch = m[1].match(/\bId="([^"]+)"/);
      const targetMatch = m[1].match(/\bTarget="([^"]+)"/);
      if (idMatch && targetMatch) {
        const target = targetMatch[1];
        relMap.set(idMatch[1], target.startsWith("/") ? target.slice(1) : (target.startsWith("xl/") ? target : `xl/${target}`));
      }
    }
  }

  const wbFn = entries.get("xl/workbook.xml");
  const sheets: Array<{ name: string; target: string | null }> = [];
  if (wbFn) {
    const wbBuf = await wbFn();
    const wbXml = new TextDecoder("utf-8").decode(wbBuf);
    const sheetRegex = /<sheet\b([^>]*)\/>/g;
    let m: RegExpExecArray | null;
    while ((m = sheetRegex.exec(wbXml)) !== null) {
      const nameMatch = m[1].match(/\bname="([^"]+)"/);
      const rIdMatch = m[1].match(/\br:id="([^"]+)"/);
      const name = nameMatch ? decodeXmlEntities(nameMatch[1]) : "Sheet";
      const target = rIdMatch ? relMap.get(rIdMatch[1]) || null : null;
      sheets.push({ name, target });
    }
  }
  const sections: string[] = [];
  const visitedSheets = new Set<string>();
  const encoder = new TextEncoder();
  let projectedBytes = 0;
  for (let i = 0; i < sheets.length; i++) {
    const { name, target } = sheets[i];
    const path = target || `xl/worksheets/sheet${i + 1}.xml`;
    if (visitedSheets.has(path)) continue;
    visitedSheets.add(path);
    const sFn = entries.get(path);
    if (!sFn) continue;
    const sBuf = await sFn();
    const sXml = new TextDecoder("utf-8").decode(sBuf);
    const rows: string[][] = [];
    let rawCellBytes = 0;
    const rowRegex = /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = rowRegex.exec(sXml)) !== null) {
      const rowXml = rMatch[0];
      const cells = new Map<number, string>();
      let maxCol = 0;
      const cRegex = /<c\b([^>]*?)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cMatch: RegExpExecArray | null;
      while ((cMatch = cRegex.exec(rowXml)) !== null) {
        const attrs = cMatch[1] ?? cMatch[2] ?? "";
        const body = cMatch[3] || "";
        const rAttr = attrs.match(/\br="([A-Z]+)(\d+)"/);
        const tAttr = attrs.match(/\bt="([^"]+)"/);
        let colNum = cells.size + 1;
        if (rAttr) {
          const colStr = rAttr[1];
          let num = 0;
          for (let k = 0; k < colStr.length; k++) {
            num = num * 26 + (colStr.charCodeAt(k) - 64);
          }
          colNum = num;
        }
        maxCol = Math.max(maxCol, colNum);

        let val = "";
        const type = tAttr ? tAttr[1] : "";
        if (type === "s") {
          const vMatch = body.match(/<v>(\d+)<\/v>/);
          if (vMatch) val = sharedStrings[parseInt(vMatch[1], 10)] ?? "";
        } else if (type === "inlineStr") {
          const tMatch = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
          if (tMatch) val = decodeXmlEntities(tMatch[1]);
        } else if (type === "b") {
          const vMatch = body.match(/<v>([01])<\/v>/);
          if (vMatch) val = vMatch[1] === "1" ? "TRUE" : "FALSE";
        } else {
          const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
          if (vMatch) val = decodeXmlEntities(vMatch[1]);
        }
        const trimmed = val.trim();
        if (trimmed) {
          rawCellBytes += encoder.encode(trimmed).byteLength;
          if (projectedBytes + rawCellBytes > MAX_ATTACHED_TEXT_BYTES) return null;
        }
        cells.set(colNum, trimmed);
      }
      if (maxCol > 0) {
        const rowList: string[] = [];
        for (let c = 1; c <= maxCol; c++) {
          rowList.push(cells.get(c) || "");
        }
        rows.push(rowList);
      }
    }

    if (rows.length > 0) {
      const maxCols = Math.max(...rows.map((r) => r.length));
      // Heading: "### ${name}\n\n"
      let sheetBytes = encoder.encode(`### ${name}\n\n`).byteLength;
      // Separator row: "| --- | ... |" -> 2 + maxCols * 6 + 1 (\n)
      sheetBytes += 2 + maxCols * 6 + 1;
      // Format data rows and calculate byte size
      for (const r of rows) {
        let rowContentBytes = 0;
        for (const c of r) {
          const escaped = c.replace(/\|/g, "\\|").replace(/\n/g, " ");
          rowContentBytes += encoder.encode(escaped).byteLength;
        }
        // "| " + joined + " |\n" -> 2 + rowContentBytes + (r.length - 1) * 3 + (maxCols - r.length) * 3 + 2 + 1
        // = rowContentBytes + maxCols * 3 + 2 (outer pipes/spaces) + 1 (\n)
        sheetBytes += rowContentBytes + maxCols * 3 + 3;
      }
      const sectionSeparatorBytes = sections.length > 0 ? 2 : 0;
      if (projectedBytes + sectionSeparatorBytes + sheetBytes > MAX_ATTACHED_TEXT_BYTES) return null;
      projectedBytes += sectionSeparatorBytes + sheetBytes;
      const formattedRows = rows.map((r) => {
        const padded = [...r];
        while (padded.length < maxCols) padded.push("");
        return "| " + padded.map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ") + " |";
      });
      const header = formattedRows[0];
      const separator = "| " + Array(maxCols).fill("---").join(" | ") + " |";
      sections.push(`### ${name}\n\n` + [header, separator, ...formattedRows.slice(1)].join("\n"));
    }
  }

  const res = sections.join("\n\n").trim();
  return res || null;
}

/** Extracts slide text and speaker notes from OOXML PPTX presentation entries. */
async function extractPptx(entries: Map<string, () => Promise<Uint8Array>>): Promise<string | null> {
  const slideEntries: Array<{ num: number; name: string; isNote: boolean }> = [];
  for (const name of entries.keys()) {
    const m = name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (m) {
      slideEntries.push({ num: parseInt(m[1], 10), name, isNote: false });
    }
    const nm = name.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
    if (nm) {
      slideEntries.push({ num: parseInt(nm[1], 10), name, isNote: true });
    }
  }

  slideEntries.sort((a, b) => a.num - b.num || (a.isNote ? 1 : -1));

  const slidesMap = new Map<number, { text: string[]; notes: string[] }>();
  for (const item of slideEntries) {
    if (!slidesMap.has(item.num)) slidesMap.set(item.num, { text: [], notes: [] });
    const fn = entries.get(item.name);
    if (!fn) continue;
    const buf = await fn();
    const xml = new TextDecoder("utf-8").decode(buf);
    const pRegex = /<a:p[\s\S]*?<\/a:p>/g;
    let pMatch: RegExpExecArray | null;
    const pList: string[] = [];
    while ((pMatch = pRegex.exec(xml)) !== null) {
      const p = pMatch[0];
      const tRegex = /<a:t[\s\S]*?<\/a:t>/g;
      let tMatch: RegExpExecArray | null;
      let text = "";
      while ((tMatch = tRegex.exec(p)) !== null) {
        text += tMatch[0].replace(/^<a:t[^>]*>/, "").replace(/<\/a:t>$/, "");
      }
      if (text.trim()) pList.push(decodeXmlEntities(text.trim()));
    }
    if (item.isNote) {
      slidesMap.get(item.num)!.notes.push(...pList);
    } else {
      slidesMap.get(item.num)!.text.push(...pList);
    }
  }

  const sections: string[] = [];
  for (const [num, { text, notes }] of Array.from(slidesMap.entries()).sort(([a], [b]) => a - b)) {
    const parts: string[] = [];
    if (text.length > 0) parts.push(text.join("\n"));
    if (notes.length > 0) parts.push("Notes:\n" + notes.join("\n"));
    if (parts.length > 0) {
      sections.push(`### Slide ${num}\n${parts.join("\n\n")}`);
    }
  }

  const res = sections.join("\n\n").trim();
  return res || null;
}

/** Extracts paragraphs and tables from OpenDocument (ODT/ODS/ODP) content. */
async function extractOdf(entries: Map<string, () => Promise<Uint8Array>>): Promise<string | null> {
  const contentFn = entries.get("content.xml");
  if (!contentFn) return null;
  const buf = await contentFn();
  const xml = new TextDecoder("utf-8").decode(buf);

  const encoder = new TextEncoder();
  let outputBytes = 0;
  const parts: string[] = [];
  const blockRegex = /<table:table[\s\S]*?<\/table:table>|<text:h\b[\s\S]*?<\/text:h>|<text:p\b[\s\S]*?<\/text:p>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(xml)) !== null) {
    const block = m[0];
    if (block.startsWith("<table:table")) {
      const rows: string[][] = [];
      const trRegex = /<table:table-row[\s\S]*?<\/table:table-row>/g;
      let trMatch: RegExpExecArray | null;
      while ((trMatch = trRegex.exec(block)) !== null) {
        const tr = trMatch[0];
        const cells: string[] = [];
        const tcRegex = /<table:(?:covered-)?table-cell\b([^>]*?)\/>|<table:(?:covered-)?table-cell\b([^>]*)>([\s\S]*?)<\/table:(?:covered-)?table-cell>/g;
        let tcMatch: RegExpExecArray | null;
        while ((tcMatch = tcRegex.exec(tr)) !== null) {
          const attrs = tcMatch[1] ?? tcMatch[2] ?? "";
          const body = tcMatch[3] ?? "";
          const text = decodeXmlEntities(body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
          const repeat = Math.min(Math.max(Number(/table:number-columns-repeated="(\d+)"/.exec(attrs)?.[1] ?? 1), 1), 64);
          const escaped = text.replace(/\|/g, "\\|").replace(/\n/g, " ");
          if (escaped.length > 0) {
            const cellBytes = encoder.encode(escaped).byteLength + 3;
            outputBytes += repeat * cellBytes;
            if (outputBytes > MAX_ATTACHED_TEXT_BYTES) return null;
          }
          for (let i = 0; i < repeat; i++) cells.push(text);
        }
        while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
        if (cells.length > 0) {
          for (const c of cells) {
            if (c === "") outputBytes += 3;
          }
          outputBytes += 2;
          if (outputBytes > MAX_ATTACHED_TEXT_BYTES) return null;
          rows.push(cells);
        }
      }
      if (rows.length > 0) {
        const maxCols = Math.max(...rows.map((r) => r.length));
        outputBytes += 2 + maxCols * 6;
        for (const r of rows) {
          outputBytes += (maxCols - r.length) * 3;
        }
        if (outputBytes > MAX_ATTACHED_TEXT_BYTES) return null;
        const formattedRows = rows.map((r) => {
          const padded = [...r];
          while (padded.length < maxCols) padded.push("");
          return "| " + padded.map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ") + " |";
        });
        const header = formattedRows[0];
        const separator = "| " + Array(maxCols).fill("---").join(" | ") + " |";
        parts.push([header, separator, ...formattedRows.slice(1)].join("\n"));
      }
    } else {
      const text = block.replace(/<[^>]+>/g, "").trim();
      if (text) {
        const decoded = decodeXmlEntities(text);
        outputBytes += encoder.encode(decoded).byteLength + 2;
        if (outputBytes > MAX_ATTACHED_TEXT_BYTES) return null;
        parts.push(decoded);
      }
    }
  }
  const res = parts.join("\n\n").trim();
  return res || null;
}

/** Extracts chapter text from EPUB archive spine in reading order. */
async function extractEpub(entries: Map<string, () => Promise<Uint8Array>>): Promise<string | null> {
  let rootFile = "OEBPS/content.opf";
  const containerFn = entries.get("META-INF/container.xml");
  if (containerFn) {
    const cBuf = await containerFn();
    const cXml = new TextDecoder("utf-8").decode(cBuf);
    const m = cXml.match(/full-path="([^"]+)"/);
    if (m) rootFile = m[1];
  }

  const opfFn = entries.get(rootFile);
  if (!opfFn) return null;
  const opfBuf = await opfFn();
  const opfXml = new TextDecoder("utf-8").decode(opfBuf);
  const basePath = rootFile.includes("/") ? rootFile.replace(/\/[^/]*$/, "/") : "";

  const manifest = new Map<string, string>();
  const itemRegex = /<item\b([^>]*)\/>/g;
  let im: RegExpExecArray | null;
  while ((im = itemRegex.exec(opfXml)) !== null) {
    const idMatch = im[1].match(/\bid="([^"]+)"/);
    const hrefMatch = im[1].match(/\bhref="([^"]+)"/);
    if (idMatch && hrefMatch) {
      manifest.set(idMatch[1], hrefMatch[1]);
    }
  }

  const spine: string[] = [];
  const itemrefRegex = /<itemref\b([^>]*)\/>/g;
  let irMatch: RegExpExecArray | null;
  while ((irMatch = itemrefRegex.exec(opfXml)) !== null) {
    const idrefMatch = irMatch[1].match(/\bidref="([^"]+)"/);
    if (idrefMatch && manifest.has(idrefMatch[1])) {
      spine.push(manifest.get(idrefMatch[1])!);
    }
  }

  const chapters: string[] = [];
  const visitedChapters = new Set<string>();
  for (const href of spine) {
    const fullPath = (basePath + href).replace(/^\//, "");
    if (visitedChapters.has(fullPath)) continue;
    visitedChapters.add(fullPath);
    const fn = entries.get(fullPath);
    if (!fn) continue;
    const buf = await fn();
    const html = new TextDecoder("utf-8").decode(buf);
    const stripped = html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, "");
    const text = decodeXmlEntities(stripped)
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text) chapters.push(text);
  }

  const res = chapters.join("\n\n").trim();
  return res || null;
}

/** Extracts plain text from legacy Word 97-2003 OLE2 binary file buffer. */
function extractDocText(buffer: ArrayBuffer): string | null {
  const view = new DataView(buffer);
  if (view.byteLength < 512) return null;
  const m1 = view.getUint32(0, true);
  const m2 = view.getUint32(4, true);
  if (m1 !== 0xE011CFD0 || m2 !== 0xE11AB1A1) {
    return null;
  }

  const sectorShift = view.getUint16(30, true);
  if (sectorShift !== 9 && sectorShift !== 12) {
    return null;
  }
  const sectorSize = 1 << sectorShift;
  const maxSectors = Math.floor(buffer.byteLength / sectorSize);
  const numFatSectors = Math.min(view.getUint32(44, true), maxSectors);
  const firstDirSector = view.getInt32(48, true);
  const firstDifatSector = view.getInt32(68, true);
  const numDifatSectors = Math.min(view.getUint32(72, true), maxSectors);

  const fatSectorIndices: number[] = [];
  for (let i = 0; i < 109 && fatSectorIndices.length < numFatSectors; i++) {
    const s = view.getInt32(76 + i * 4, true);
    if (s >= 0 && s < maxSectors) fatSectorIndices.push(s);
  }

  let difatSect = firstDifatSector;
  const visitedDifat = new Set<number>();
  for (let i = 0; i < numDifatSectors && difatSect >= 0 && difatSect < maxSectors && !visitedDifat.has(difatSect); i++) {
    visitedDifat.add(difatSect);
    const offset = (difatSect + 1) * sectorSize;
    if (offset + sectorSize > buffer.byteLength) break;
    for (let j = 0; j < (sectorSize / 4) - 1 && fatSectorIndices.length < numFatSectors; j++) {
      const s = view.getInt32(offset + j * 4, true);
      if (s >= 0 && s < maxSectors) fatSectorIndices.push(s);
    }
    difatSect = view.getInt32(offset + sectorSize - 4, true);
  }

  const fat: number[] = [];
  for (const sIndex of fatSectorIndices) {
    const offset = (sIndex + 1) * sectorSize;
    if (offset + sectorSize > buffer.byteLength) break;
    for (let j = 0; j < sectorSize / 4; j++) {
      fat.push(view.getInt32(offset + j * 4, true));
    }
  }

  function getChain(startSector: number): number[] {
    const chain: number[] = [];
    const visited = new Set<number>();
    let curr = startSector;
    while (curr >= 0 && curr < fat.length && curr < maxSectors && chain.length < maxSectors && !visited.has(curr)) {
      visited.add(curr);
      chain.push(curr);
      curr = fat[curr];
      if (curr === -2) break;
    }
    return chain;
  }

  function readStream(startSector: number, size: number): Uint8Array {
    const chain = getChain(startSector);
    const safeSize = Math.min(size, chain.length * sectorSize, MAX_DECOMPRESSED_BYTES);
    const result = new Uint8Array(safeSize);
    let written = 0;
    for (const sect of chain) {
      const offset = (sect + 1) * sectorSize;
      const toRead = Math.min(sectorSize, safeSize - written);
      if (toRead <= 0 || offset + toRead > buffer.byteLength) break;
      result.set(new Uint8Array(buffer, offset, toRead), written);
      written += toRead;
    }
    return result;
  }
  const dirChain = getChain(firstDirSector);
  const dirBytes = new Uint8Array(dirChain.length * sectorSize);
  let dOff = 0;
  for (const sect of dirChain) {
    const offset = (sect + 1) * sectorSize;
    dirBytes.set(new Uint8Array(buffer, offset, sectorSize), dOff);
    dOff += sectorSize;
  }

  const dirView = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const numEntries = dirBytes.byteLength / 128;
  const entries = new Map<string, { startSect: number; size: number }>();

  for (let i = 0; i < numEntries; i++) {
    const entryOffset = i * 128;
    const nameLen = dirView.getUint16(entryOffset + 64, true);
    if (nameLen === 0) continue;
    const actualLen = Math.max(0, nameLen - 2);
    const name = new TextDecoder("utf-16le").decode(new Uint8Array(dirBytes.buffer, entryOffset, actualLen));
    const startSect = dirView.getInt32(entryOffset + 116, true);
    const size = dirView.getUint32(entryOffset + 120, true);
    entries.set(name, { startSect, size });
  }

  const wordDocEntry = entries.get("WordDocument");
  if (!wordDocEntry) return null;

  const wordDocStream = readStream(wordDocEntry.startSect, wordDocEntry.size);
  const wordDocView = new DataView(wordDocStream.buffer, wordDocStream.byteOffset, wordDocStream.byteLength);

  const flags = wordDocView.getUint16(0x000A, true);
  const fWhichTblStm = (flags & 0x0200) !== 0;
  const tableEntryName = fWhichTblStm ? "1Table" : "0Table";
  const tableEntry = entries.get(tableEntryName);
  if (!tableEntry) return null;

  const tableStream = readStream(tableEntry.startSect, tableEntry.size);
  const tableView = new DataView(tableStream.buffer, tableStream.byteOffset, tableStream.byteLength);

  const fcClx = wordDocView.getUint32(0x01A2, true);
  const lcbClx = wordDocView.getUint32(0x01A6, true);
  if (fcClx + lcbClx > tableStream.byteLength) return null;

  let currClx = fcClx;
  const clxEnd = fcClx + lcbClx;
  let pcdtOffset = -1;

  while (currClx < clxEnd) {
    const clxt = tableView.getUint8(currClx);
    if (clxt === 1) {
      const cb = tableView.getUint16(currClx + 1, true);
      currClx += 3 + cb;
    } else if (clxt === 2) {
      pcdtOffset = currClx;
      break;
    } else {
      break;
    }
  }

  if (pcdtOffset === -1) return null;

  const lcbPcdt = tableView.getUint32(pcdtOffset + 1, true);
  const plcfpcdOffset = pcdtOffset + 5;
  const numPieces = Math.floor((lcbPcdt - 4) / 12);
  const cpOffset = plcfpcdOffset;
  const pcdOffset = plcfpcdOffset + (numPieces + 1) * 4;

  let fullText = "";
  for (let i = 0; i < numPieces; i++) {
    if (fullText.length >= MAX_DECOMPRESSED_BYTES) break;
    const cpStart = tableView.getUint32(cpOffset + i * 4, true);
    const cpEnd = tableView.getUint32(cpOffset + (i + 1) * 4, true);
    const charCount = cpEnd - cpStart;
    if (charCount <= 0 || charCount > MAX_DECOMPRESSED_BYTES) continue;

    const thisPcdOffset = pcdOffset + i * 8;
    const fcValue = tableView.getUint32(thisPcdOffset + 2, true);

    const isCompressed = (fcValue & 0x40000000) !== 0;
    const actualFc = fcValue & ~0x40000000;

    if (isCompressed) {
      const fileOffset = actualFc / 2;
      const byteLen = charCount;
      if (fileOffset + byteLen <= wordDocStream.byteLength) {
        const pieceBytes = new Uint8Array(wordDocStream.buffer, wordDocStream.byteOffset + fileOffset, byteLen);
        fullText += new TextDecoder("windows-1252").decode(pieceBytes);
      }
    } else {
      const fileOffset = actualFc;
      const byteLen = charCount * 2;
      if (fileOffset + byteLen <= wordDocStream.byteLength) {
        const pieceBytes = new Uint8Array(wordDocStream.buffer, wordDocStream.byteOffset + fileOffset, byteLen);
        fullText += new TextDecoder("utf-16le").decode(pieceBytes);
      }
    }
  }

  const cleaned = fullText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x07\x0B]/g, "\n")
    .replace(/[\x00-\x08\x0E-\x1F]/g, "");

  return cleaned.trim() || null;
}

const DOCUMENT_ATTACHMENT_EXTENSIONS: Record<string, true> = {
  pdf: true,
  docx: true,
  xlsx: true,
  pptx: true,
  odt: true,
  ods: true,
  odp: true,
  epub: true,
  doc: true,
};

const DOCUMENT_ATTACHMENT_MIMES: Record<string, true> = {
  "application/pdf": true,
  "application/msword": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
  "application/vnd.oasis.opendocument.text": true,
  "application/vnd.oasis.opendocument.spreadsheet": true,
  "application/vnd.oasis.opendocument.presentation": true,
  "application/epub+zip": true,
};

/** Reads and decodes text content from text files or supported document formats. */
export async function readAttachmentText(file: {
  name: string;
  type?: string;
  text: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}): Promise<string | null> {
  const ext = getFileExtension(file.name);
  const isKnownDocument = DOCUMENT_ATTACHMENT_EXTENSIONS[ext] === true
    || Boolean(file.type && DOCUMENT_ATTACHMENT_MIMES[file.type] === true);

  // Start non-document reads with file.text() synchronously so callers and
  // tests that hold/intercept File.prototype.text observe the read immediately,
  // and ordinary UTF-8 files avoid a second buffer allocation.
  let fallbackText: string | null = null;
  if (!isKnownDocument && typeof file.text === "function") {
    const text = await file.text();
    if (!text.includes("\u0000") && !text.includes("\uFFFD")) {
      return text;
    }
    fallbackText = text;
  }

  let buffer: ArrayBuffer | null = null;
  if (typeof file.arrayBuffer === "function") {
    buffer = await file.arrayBuffer();
  }
  if (buffer) {
    const bytes = new Uint8Array(buffer);

    // a) PDF (%PDF- magic or .pdf or application/pdf)
    const isPdfMagic = bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D;
    if (isPdfMagic || ext === "pdf" || file.type === "application/pdf") {
      try {
        return await extractPdfText(buffer);
      } catch {
        return null;
      }
    }

    // b) ZIP-based documents (PK\x03\x04 magic)
    const isZipMagic = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (isZipMagic) {
      try {
        const entries = await readZipEntries(buffer);
        if (ext === "docx" || entries.has("word/document.xml")) {
          return await extractDocx(entries);
        }
        if (ext === "xlsx" || entries.has("xl/workbook.xml")) {
          return await extractXlsx(entries);
        }
        if (ext === "pptx" || entries.has("ppt/presentation.xml")) {
          return await extractPptx(entries);
        }
        if (ext === "odt" || ext === "ods" || ext === "odp" || entries.has("content.xml")) {
          return await extractOdf(entries);
        }
        if (ext === "epub" || entries.has("META-INF/container.xml")) {
          return await extractEpub(entries);
        }
      } catch {
        return null;
      }
    }

    // c) Legacy Word 97-2003 .doc (OLE2 magic: D0 CF 11 E0 A1 B1 1A E1)
    const isOleMagic = bytes.length >= 8
      && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0
      && bytes[4] === 0xA1 && bytes[5] === 0xB1 && bytes[6] === 0x1A && bytes[7] === 0xE1;
    if (isOleMagic || ext === "doc") {
      try {
        return extractDocText(buffer);
      } catch {
        return null;
      }
    }

    // d) UTF-16 BOM & UTF-8
    if (bytes.length >= 2) {
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        try {
          const text = new TextDecoder("utf-16le", { fatal: true }).decode(new Uint8Array(buffer, 2));
          if (text.includes("\u0000") || text.includes("\uFFFD")) return null;
          return text;
        } catch {
          return null;
        }
      }
      if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        try {
          const text = new TextDecoder("utf-16be", { fatal: true }).decode(new Uint8Array(buffer, 2));
          if (text.includes("\u0000") || text.includes("\uFFFD")) return null;
          return text;
        } catch {
          return null;
        }
      }
    }

    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\u0000") || text.includes("\uFFFD")) return null;
      return text;
    } catch {
      return null;
    }
  }

  if (fallbackText !== null) {
    return null;
  }
  const text = await file.text();
  if (text.includes("\u0000") || text.includes("\uFFFD")) return null;
  return text;
}
