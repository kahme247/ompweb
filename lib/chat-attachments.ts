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
  uploadId?: string;
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

export const MAX_XML_TAGS = 250_000;
export const MAX_TABLE_COLS = 512;
export const MAX_TABLE_ROWS = 10_000;
export const MAX_TABLE_CELLS = 100_000;
export const MAX_PDF_OBJECTS = 8_192;
export const MAX_OBJSTM_OBJECTS = 2_048;
export const MAX_PDF_STREAM_TOKENS = 200_000;

const MAX_DECOMPRESSED_BYTES = MAX_TOTAL_ATTACHED_TEXT_BYTES * 4;
const MAX_CMAP_ENTRIES = 262144;
const MAX_CMAP_RANGE_SPAN = 4096;

export interface XmlTagBudget {
  tags: number;
  maxTags: number;
}

/** Formats a 2D string array as Markdown table with bounds checking. */
export function formatMarkdownTable(rows: string[][]): string | null {
  if (rows.length === 0) return "";
  if (rows.length > MAX_TABLE_ROWS) return null;
  let maxCols = 0;
  for (const r of rows) {
    if (r.length > MAX_TABLE_COLS) return null;
    if (r.length > maxCols) maxCols = r.length;
  }
  if (maxCols > MAX_TABLE_COLS) return null;
  if (rows.length * maxCols > MAX_TABLE_CELLS) return null;

  const formattedRows = rows.map((r) => {
    const padded = [...r];
    while (padded.length < maxCols) padded.push("");
    return "| " + padded.map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ") + " |";
  });
  const header = formattedRows[0];
  const separator = "| " + Array(maxCols).fill("---").join(" | ") + " |";
  return [header, separator, ...formattedRows.slice(1)].join("\n");
}

/**
 * Linear O(N) XML scanner using indexOf("<") and indexOf(">").
 * Enforces shared per-document tag budget.
 */
export function walkXml(
  xml: string,
  budget: XmlTagBudget,
  onTag: (name: string, isClose: boolean, selfClosing: boolean, attrs: string) => boolean | void,
  onText?: (text: string) => boolean | void,
): boolean {
  let pos = 0;
  const len = xml.length;

  while (pos < len) {
    const lt = xml.indexOf("<", pos);
    if (lt === -1) {
      if (onText && pos < len) {
        onText(xml.slice(pos));
      }
      break;
    }

    if (onText && lt > pos) {
      if (onText(xml.slice(pos, lt)) === false) return false;
    }

    if (xml.startsWith("<!--", lt)) {
      const endComment = xml.indexOf("-->", lt + 4);
      if (endComment === -1) break;
      pos = endComment + 3;
      continue;
    }

    if (xml.startsWith("<![CDATA[", lt)) {
      const endCdata = xml.indexOf("]]>", lt + 9);
      if (endCdata === -1) break;
      if (onText) {
        if (onText(xml.slice(lt + 9, endCdata)) === false) return false;
      }
      pos = endCdata + 3;
      continue;
    }

    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const gt = xml.indexOf(">", lt + 2);
      if (gt === -1) break;
      pos = gt + 1;
      continue;
    }

    const gt = xml.indexOf(">", lt + 1);
    if (gt === -1) break;

    budget.tags++;
    if (budget.tags > budget.maxTags) {
      return false;
    }

    let rawTag = xml.slice(lt + 1, gt).trim();
    const isClose = rawTag.startsWith("/");
    if (isClose) {
      rawTag = rawTag.slice(1).trim();
    }
    const selfClosing = !isClose && rawTag.endsWith("/");
    if (selfClosing) {
      rawTag = rawTag.slice(0, -1).trim();
    }

    let name = rawTag;
    let attrs = "";
    const spaceIdx = rawTag.search(/\s/);
    if (spaceIdx !== -1) {
      name = rawTag.slice(0, spaceIdx);
      attrs = rawTag.slice(spaceIdx + 1).trim();
    }

    if (onTag(name, isClose, selfClosing, attrs) === false) {
      return false;
    }

    pos = gt + 1;
  }

  return true;
}

/** Strips <style> and <script> blocks using case-insensitive linear indexOf. */
export function stripStyleAndScriptTags(html: string): string {
  const lower = html.toLowerCase();
  let result = "";
  let pos = 0;
  while (pos < html.length) {
    const nextStyle = lower.indexOf("<style", pos);
    const nextScript = lower.indexOf("<script", pos);
    let target = -1;
    let closeTag = "";
    if (nextStyle !== -1 && (nextScript === -1 || nextStyle < nextScript)) {
      target = nextStyle;
      closeTag = "</style>";
    } else if (nextScript !== -1) {
      target = nextScript;
      closeTag = "</script>";
    } else {
      result += html.slice(pos);
      break;
    }

    result += html.slice(pos, target);
    const closeIdx = lower.indexOf(closeTag, target);
    if (closeIdx === -1) {
      break;
    }
    pos = closeIdx + closeTag.length;
  }
  return result;
}
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
  const MAX_CMAP_ITERATIONS = 65_536;
  let totalEntries = 0;

  let pos = 0;
  while (pos < cmapStr.length) {
    const startIdx = cmapStr.indexOf("begincodespacerange", pos);
    if (startIdx === -1) break;
    const contentStart = startIdx + "begincodespacerange".length;
    const endIdx = cmapStr.indexOf("endcodespacerange", contentStart);
    if (endIdx === -1) break;
    const block = cmapStr.slice(contentStart, endIdx);
    pos = endIdx + "endcodespacerange".length;

    const pairRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let pm: RegExpExecArray | null;
    while ((pm = pairRegex.exec(block)) !== null) {
      if (pm[1].length >= 4) codeBytes = 2;
    }
  }

  pos = 0;
  while (pos < cmapStr.length && cmapBudget.remaining > 0 && totalEntries < MAX_CMAP_ITERATIONS) {
    const startIdx = cmapStr.indexOf("beginbfchar", pos);
    if (startIdx === -1) break;
    const contentStart = startIdx + "beginbfchar".length;
    const endIdx = cmapStr.indexOf("endbfchar", contentStart);
    if (endIdx === -1) break;
    const block = cmapStr.slice(contentStart, endIdx);
    pos = endIdx + "endbfchar".length;

    const pairRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let pm: RegExpExecArray | null;
    while ((pm = pairRegex.exec(block)) !== null && --cmapBudget.remaining >= 0 && ++totalEntries <= MAX_CMAP_ITERATIONS) {
      if (pm[1].length >= 4) codeBytes = 2;
      map.set(parseInt(pm[1], 16), decodeCMapTargetHex(pm[2]));
    }
  }

  pos = 0;
  while (pos < cmapStr.length && cmapBudget.remaining > 0 && totalEntries < MAX_CMAP_ITERATIONS) {
    const startIdx = cmapStr.indexOf("beginbfrange", pos);
    if (startIdx === -1) break;
    const contentStart = startIdx + "beginbfrange".length;
    const endIdx = cmapStr.indexOf("endbfrange", contentStart);
    if (endIdx === -1) break;
    const block = cmapStr.slice(contentStart, endIdx);
    pos = endIdx + "endbfrange".length;

    let bPos = 0;
    while (bPos < block.length && cmapBudget.remaining > 0 && totalEntries < MAX_CMAP_ITERATIONS) {
      const lt1 = block.indexOf("<", bPos);
      if (lt1 === -1) break;
      const gt1 = block.indexOf(">", lt1 + 1);
      if (gt1 === -1) break;
      const startHex = block.slice(lt1 + 1, gt1);

      const lt2 = block.indexOf("<", gt1 + 1);
      if (lt2 === -1) break;
      const gt2 = block.indexOf(">", lt2 + 1);
      if (gt2 === -1) break;
      const endHex = block.slice(lt2 + 1, gt2);

      if (startHex.length >= 4) codeBytes = 2;
      const start = parseInt(startHex, 16);
      const end = parseInt(endHex, 16);
      if (end < start) {
        bPos = gt2 + 1;
        continue;
      }

      let cur = gt2 + 1;
      while (cur < block.length && /\s/.test(block[cur])) cur++;
      if (cur >= block.length) break;

      if (block[cur] === "<") {
        const gt3 = block.indexOf(">", cur + 1);
        if (gt3 === -1) break;
        const destHex = block.slice(cur + 1, gt3);
        bPos = gt3 + 1;
        const baseStr = decodeCMapTargetHex(destHex);
        if (!baseStr) continue;
        const prefix = baseStr.slice(0, -1);
        const lastUnit = baseStr.charCodeAt(baseStr.length - 1);
        const maxEnd = Math.min(end, start + MAX_CMAP_RANGE_SPAN - 1);
        for (let code = start; code <= maxEnd && --cmapBudget.remaining >= 0 && ++totalEntries <= MAX_CMAP_ITERATIONS; code++) {
          const nextUnit = lastUnit + (code - start);
          if (nextUnit >= 0xffff) break;
          if (nextUnit > 0) {
            map.set(code, prefix + String.fromCharCode(nextUnit));
          }
        }
      } else if (block[cur] === "[") {
        const closeBracket = block.indexOf("]", cur + 1);
        if (closeBracket === -1) break;
        const arrayContent = block.slice(cur + 1, closeBracket);
        bPos = closeBracket + 1;
        const items = arrayContent.match(/<([0-9a-fA-F]+)>/g) ?? [];
        for (let i = 0; i < items.length && start + i <= end && --cmapBudget.remaining >= 0 && ++totalEntries <= MAX_CMAP_ITERATIONS; i++) {
          map.set(start + i, decodeCMapTargetHex(items[i].slice(1, -1)));
        }
      } else {
        bPos = cur + 1;
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
  let totalObjStmBytes = 0;
  let m: RegExpExecArray | null;
  while ((m = objHeaderRegex.exec(latin1)) !== null) {
    if (objects.size >= MAX_PDF_OBJECTS) break;
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
          if (first < 0 || first > streamText.length || count < 0 || count > MAX_OBJSTM_OBJECTS) {
            return null;
          }
          const headerStr = streamText.slice(0, first).trim();
          const headerNumbers = headerStr ? headerStr.split(/\s+/).map(Number) : [];
          if (headerNumbers.length < count * 2) {
            return null;
          }
          const content = streamText.slice(first);
          for (let i = 0; i < count; i++) {
            const objNum = headerNumbers[i * 2];
            const offset = headerNumbers[i * 2 + 1];
            const nextOffset = i + 1 < count ? headerNumbers[(i + 1) * 2 + 1] : content.length;
            if (!Number.isInteger(objNum) || objNum <= 0) return null;
            if (!Number.isInteger(offset) || !Number.isInteger(nextOffset)) return null;
            if (!(0 <= offset && offset <= nextOffset && nextOffset <= content.length)) {
              return null;
            }
            const subBody = content.slice(offset, nextOffset);
            totalObjStmBytes += subBody.length;
            if (totalObjStmBytes > MAX_DECOMPRESSED_BYTES) return null;
            if (objects.size < MAX_PDF_OBJECTS && !objects.has(objNum)) {
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
    const dictSlice = obj.dict.slice(0, 4096);
    if (/\/Type\s*\/Font\b/.test(dictSlice) || /\/Subtype\s*\/(?:Type0|Type1|TrueType|MMType1|Type3|CIDFontType[02])\b/.test(dictSlice)) {
      fontObjIds.add(id);
    }
    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(dictSlice);
    if (tu) {
      fontObjIds.add(id);
      const cmap = cmapsByObj.get(parseInt(tu[1], 10));
      if (cmap) fontObjToCMap.set(id, cmap);
    }
  }
  const knownFontNames = new Set<string>();
  const fontNameToCMap = new Map<string, PdfCMap>();
  for (const [, obj] of objects) {
    const dictSlice = obj.dict.slice(0, 4096);
    const fontRefRe = /\/([A-Za-z0-9_.-]+)\s+(\d+)\s+\d+\s+R/g;
    let fm: RegExpExecArray | null;
    while ((fm = fontRefRe.exec(dictSlice)) !== null) {
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

  let totalStreamTokens = 0;
  for (const [, obj] of objects) {
    if (totalStreamTokens >= MAX_PDF_STREAM_TOKENS) break;
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
      if (++totalStreamTokens > MAX_PDF_STREAM_TOKENS) break;
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

/** Extracts paragraphs and tables from OOXML DOCX document entries. */
async function extractDocx(entries: Map<string, () => Promise<Uint8Array>>): Promise<string | null> {
  const xmlNames = ["word/document.xml"];
  for (const name of entries.keys()) {
    if (/^word\/(?:header|footer)\d*\.xml$/.test(name)) {
      xmlNames.push(name);
    }
  }

  const tagBudget: XmlTagBudget = { tags: 0, maxTags: MAX_XML_TAGS };
  const parts: string[] = [];

  for (const name of xmlNames) {
    const fn = entries.get(name);
    if (!fn) continue;
    const buf = await fn();
    const xml = new TextDecoder("utf-8").decode(buf);

    let inTable = false;
    let tableRows: string[][] = [];
    let currentRow: string[] = [];
    let inCell = false;
    let cellText = "";
    let inPara = false;
    let paraText = "";
    let inT = false;
    let totalCellsInTable = 0;

    const ok = walkXml(
      xml,
      tagBudget,
      (tagName, isClose, selfClosing) => {
        if (tagName === "w:tbl") {
          if (!isClose) {
            inTable = true;
            tableRows = [];
            totalCellsInTable = 0;
          } else {
            inTable = false;
            const tableMd = formatMarkdownTable(tableRows);
            if (tableMd === null) return false;
            if (tableMd) parts.push(tableMd);
            tableRows = [];
          }
        } else if (tagName === "w:tr") {
          if (!isClose) {
            if (tableRows.length + 1 > MAX_TABLE_ROWS) return false;
            currentRow = [];
          } else {
            if (currentRow.length > 0) {
              tableRows.push(currentRow);
            }
          }
        } else if (tagName === "w:tc") {
          if (!isClose) {
            if (currentRow.length + 1 > MAX_TABLE_COLS) return false;
            if (totalCellsInTable + 1 > MAX_TABLE_CELLS) return false;
            totalCellsInTable++;
            inCell = true;
            cellText = "";
          } else {
            inCell = false;
            currentRow.push(cellText.trim());
            cellText = "";
          }
        } else if (tagName === "w:p") {
          if (!isClose) {
            if (inPara && !inCell) {
              const trimmed = paraText.trim();
              if (trimmed) parts.push(trimmed);
            }
            inPara = true;
            if (!inCell) {
              paraText = "";
            }
          } else {
            inPara = false;
            if (!inCell) {
              const trimmed = paraText.trim();
              if (trimmed) parts.push(trimmed);
              paraText = "";
            } else {
              if (cellText && !cellText.endsWith("\n")) {
                cellText += " ";
              }
            }
          }
        } else if (tagName === "w:t") {
          if (!isClose && !selfClosing) {
            inT = true;
          } else {
            inT = false;
          }
        } else if (tagName === "w:br") {
          if (inCell) cellText += "\n";
          else if (inPara) paraText += "\n";
        } else if (tagName === "w:tab") {
          if (inCell) cellText += "\t";
          else if (inPara) paraText += "\t";
        }
      },
      (text) => {
        if (inT) {
          const decoded = decodeXmlEntities(text);
          if (inCell) {
            cellText += decoded;
          } else if (inPara) {
            paraText += decoded;
          }
        }
      },
    );
    if (inPara && !inCell) {
      const trimmed = paraText.trim();
      if (trimmed) parts.push(trimmed);
    }

    if (!ok) return null;
  }

  const res = parts.join("\n\n").trim();
  return res || null;
}

/** Extracts worksheets and shared strings from OOXML XLSX into Markdown tables. */
async function extractXlsx(entries: Map<string, () => Promise<Uint8Array>>): Promise<string | null> {
  const sharedStrings: string[] = [];
  const tagBudget: XmlTagBudget = { tags: 0, maxTags: MAX_XML_TAGS };

  const ssFn = entries.get("xl/sharedStrings.xml");
  if (ssFn) {
    const ssBuf = await ssFn();
    const ssXml = new TextDecoder("utf-8").decode(ssBuf);
    let inSi = false;
    let inT = false;
    let siText = "";

    const ok = walkXml(
      ssXml,
      tagBudget,
      (tagName, isClose, selfClosing) => {
        if (tagName === "si") {
          if (!isClose) {
            inSi = true;
            siText = "";
          } else {
            inSi = false;
            sharedStrings.push(decodeXmlEntities(siText));
            siText = "";
          }
        } else if (tagName === "t") {
          if (!isClose && !selfClosing) inT = true;
          else inT = false;
        }
      },
      (text) => {
        if (inSi && inT) {
          siText += text;
        }
      },
    );
    if (!ok) return null;
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
  let totalCellsAcrossWorkbook = 0;

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
    let inRow = false;
    let rowCells = new Map<number, string>();
    let rowMaxCol = 0;
    let sheetMaxCol = 0;
    let rowCount = 0;
    let inCell = false;
    let cellColNum = 0;
    let cellType = "";
    let inV = false;
    let inT = false;
    let cellRawText = "";

    const ok = walkXml(
      sXml,
      tagBudget,
      (tagName, isClose, selfClosing, attrs) => {
        if (tagName === "row") {
          if (!isClose) {
            rowCount++;
            if (rowCount > MAX_TABLE_ROWS) return false;
            inRow = true;
            rowCells = new Map<number, string>();
            rowMaxCol = 0;
            if (selfClosing) {
              inRow = false;
            }
          } else {
            inRow = false;
            if (rowCount > MAX_TABLE_ROWS || sheetMaxCol > MAX_TABLE_COLS || rowCount * sheetMaxCol > MAX_TABLE_CELLS) {
              return false;
            }
            if (rowMaxCol > 0) {
              const rowList: string[] = [];
              for (let c = 1; c <= rowMaxCol; c++) {
                rowList.push(rowCells.get(c) || "");
              }
              rows.push(rowList);
              totalCellsAcrossWorkbook += rowMaxCol;
              if (totalCellsAcrossWorkbook > MAX_TABLE_CELLS) return false;
            }
          }
        } else if (tagName === "c") {
          if (!isClose) {
            inCell = true;
            cellRawText = "";
            const rMatch = attrs.match(/\br="([A-Za-z]+)(\d+)"/);
            const tMatch = attrs.match(/\bt="([^"]+)"/);
            cellType = tMatch ? tMatch[1] : "";

            let colNum: number;
            if (rMatch) {
              const colStr = rMatch[1].toUpperCase();
              if (colStr.length < 1 || colStr.length > 3) return false;
              let num = 0;
              for (let k = 0; k < colStr.length; k++) {
                num = num * 26 + (colStr.charCodeAt(k) - 64);
              }
              colNum = num;
              if (colNum < 1 || colNum > MAX_TABLE_COLS) return false;
            } else {
              colNum = rowCells.size + 1;
              if (colNum > MAX_TABLE_COLS) return false;
            }

            cellColNum = colNum;
            rowMaxCol = Math.max(rowMaxCol, colNum);
            sheetMaxCol = Math.max(sheetMaxCol, rowMaxCol);

            if (rowCount > MAX_TABLE_ROWS || sheetMaxCol > MAX_TABLE_COLS || rowCount * sheetMaxCol > MAX_TABLE_CELLS) {
              return false;
            }

            if (selfClosing) {
              inCell = false;
              rowCells.set(cellColNum, "");
            }
          } else {
            if (inCell) {
              inCell = false;
              let val = "";
              if (cellType === "s") {
                const idx = parseInt(cellRawText.trim(), 10);
                val = Number.isFinite(idx) ? sharedStrings[idx] ?? "" : "";
              } else if (cellType === "inlineStr") {
                val = decodeXmlEntities(cellRawText);
              } else if (cellType === "b") {
                val = cellRawText.trim() === "1" ? "TRUE" : "FALSE";
              } else {
                val = decodeXmlEntities(cellRawText);
              }
              const trimmed = val.trim();
              if (trimmed) {
                rawCellBytes += encoder.encode(trimmed).byteLength;
                if (projectedBytes + rawCellBytes > MAX_ATTACHED_TEXT_BYTES) return false;
              }
              rowCells.set(cellColNum, trimmed);
            }
          }
        } else if (tagName === "v") {
          if (!isClose && !selfClosing) inV = true;
          else inV = false;
        } else if (tagName === "t") {
          if (!isClose && !selfClosing) inT = true;
          else inT = false;
        }
      },
      (text) => {
        if (inCell && (inV || inT)) {
          cellRawText += text;
        }
      },
    );

    if (!ok) return null;

    if (rows.length > 0) {
      const tableMd = formatMarkdownTable(rows);
      if (tableMd === null) return null;
      const heading = `### ${name}\n\n`;
      const sheetBytes = encoder.encode(heading).byteLength + encoder.encode(tableMd).byteLength;
      const sectionSeparatorBytes = sections.length > 0 ? 2 : 0;
      if (projectedBytes + sectionSeparatorBytes + sheetBytes > MAX_ATTACHED_TEXT_BYTES) return null;
      projectedBytes += sectionSeparatorBytes + sheetBytes;
      sections.push(heading + tableMd);
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

  const tagBudget: XmlTagBudget = { tags: 0, maxTags: MAX_XML_TAGS };
  const slidesMap = new Map<number, { text: string[]; notes: string[] }>();
  for (const item of slideEntries) {
    if (!slidesMap.has(item.num)) slidesMap.set(item.num, { text: [], notes: [] });
    const fn = entries.get(item.name);
    if (!fn) continue;
    const buf = await fn();
    const xml = new TextDecoder("utf-8").decode(buf);

    let inP = false;
    let inT = false;
    let pText = "";
    const pList: string[] = [];

    const ok = walkXml(
      xml,
      tagBudget,
      (tagName, isClose, selfClosing) => {
        if (tagName === "a:p") {
          if (!isClose) {
            inP = true;
            pText = "";
          } else {
            inP = false;
            const trimmed = pText.trim();
            if (trimmed) pList.push(decodeXmlEntities(trimmed));
            pText = "";
          }
        } else if (tagName === "a:t") {
          if (!isClose && !selfClosing) inT = true;
          else inT = false;
        } else if (tagName === "a:br") {
          if (inP) pText += "\n";
        }
      },
      (text) => {
        if (inP && inT) {
          pText += text;
        }
      },
    );
    if (!ok) return null;

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

  const tagBudget: XmlTagBudget = { tags: 0, maxTags: MAX_XML_TAGS };
  const encoder = new TextEncoder();
  let outputBytes = 0;
  const parts: string[] = [];

  let inTable = false;
  let tableRows: string[][] = [];
  let currentRow: string[] = [];
  let inCell = false;
  let cellText = "";
  let cellRepeat = 1;
  let totalCellsInTable = 0;

  let inPara = false;
  let paraText = "";

  const ok = walkXml(
    xml,
    tagBudget,
    (tagName, isClose, selfClosing, attrs) => {
      if (tagName === "table:table") {
        if (!isClose) {
          inTable = true;
          tableRows = [];
          totalCellsInTable = 0;
        } else {
          inTable = false;
          if (tableRows.length > 0) {
            const tableMd = formatMarkdownTable(tableRows);
            if (tableMd === null) return false;
            outputBytes += encoder.encode(tableMd).byteLength + 2;
            if (outputBytes > MAX_ATTACHED_TEXT_BYTES) return false;
            parts.push(tableMd);
          }
          tableRows = [];
        }
      } else if (tagName === "table:table-row") {
        if (!isClose) {
          if (tableRows.length + 1 > MAX_TABLE_ROWS) return false;
          currentRow = [];
        } else {
          while (currentRow.length > 0 && currentRow[currentRow.length - 1] === "") {
            currentRow.pop();
          }
          if (currentRow.length > 0) {
            tableRows.push(currentRow);
          }
        }
      } else if (tagName === "table:table-cell" || tagName === "table:covered-table-cell") {
        if (!isClose) {
          const repMatch = attrs.match(/\btable:number-columns-repeated="(\d+)"/);
          const repeat = repMatch ? Number(repMatch[1]) : 1;
          if (repeat > MAX_TABLE_COLS || currentRow.length + repeat > MAX_TABLE_COLS) {
            return false;
          }
          if (totalCellsInTable + repeat > MAX_TABLE_CELLS) {
            return false;
          }
          totalCellsInTable += repeat;
          cellRepeat = repeat;
          inCell = true;
          cellText = "";
          if (selfClosing) {
            for (let i = 0; i < cellRepeat; i++) currentRow.push("");
            inCell = false;
          }
        } else {
          inCell = false;
          const trimmed = decodeXmlEntities(cellText.trim());
          const escaped = trimmed.replace(/\|/g, "\\|").replace(/\n/g, " ");
          for (let i = 0; i < cellRepeat; i++) {
            currentRow.push(escaped);
          }
          cellText = "";
        }
      } else if (tagName.startsWith("text:h") || tagName.startsWith("text:p")) {
        if (!isClose) {
          if (!inTable) {
            inPara = true;
            paraText = "";
          }
        } else {
          if (!inTable && inPara) {
            inPara = false;
            const trimmed = decodeXmlEntities(paraText.trim());
            if (trimmed) {
              outputBytes += encoder.encode(trimmed).byteLength + 2;
              if (outputBytes > MAX_ATTACHED_TEXT_BYTES) return false;
              parts.push(trimmed);
            }
            paraText = "";
          }
        }
      }
    },
    (text) => {
      if (inCell) {
        cellText += (cellText ? " " : "") + text;
      } else if (inPara) {
        paraText += (paraText ? " " : "") + text;
      }
    },
  );

  if (!ok) return null;
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

  const tagBudget: XmlTagBudget = { tags: 0, maxTags: MAX_XML_TAGS };
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
    const strippedHtml = stripStyleAndScriptTags(html);

    let chapterText = "";
    const ok = walkXml(
      strippedHtml,
      tagBudget,
      (tagName, isClose, selfClosing) => {
        const lowerName = tagName.toLowerCase();
        if (lowerName === "br") {
          chapterText += "\n";
        } else if (isClose && lowerName === "p") {
          chapterText += "\n\n";
        } else if (isClose && /^h[1-6]$/.test(lowerName)) {
          chapterText += "\n\n";
        } else if (isClose && lowerName === "div") {
          chapterText += "\n";
        }
      },
      (text) => {
        chapterText += text;
      },
    );
    if (!ok) return null;

    const text = decodeXmlEntities(chapterText)
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

export function isKnownBinaryDocumentMeta(file: { name: string; type?: string }): boolean {
  const ext = getFileExtension(file.name);
  if (DOCUMENT_ATTACHMENT_EXTENSIONS[ext] === true) return true;
  if (file.type && DOCUMENT_ATTACHMENT_MIMES[file.type] === true) return true;
  return false;
}

export async function isBinaryDocumentAttachment(file: {
  name: string;
  type?: string;
  slice?: (start?: number, end?: number) => Blob;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  text?: () => Promise<string>;
}): Promise<boolean> {
  if (isKnownBinaryDocumentMeta(file)) return true;
  try {
    let headerBytes: Uint8Array | null = null;
    if (typeof file.slice === "function") {
      const slice = file.slice(0, 8);
      if (slice && typeof slice.arrayBuffer === "function") {
        const sliceBuf = await slice.arrayBuffer();
        headerBytes = new Uint8Array(sliceBuf);
      }
    }
    if (!headerBytes && typeof file.arrayBuffer === "function") {
      const buf = await file.arrayBuffer();
      headerBytes = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
    } else if (!headerBytes && typeof file.text === "function") {
      const head = await file.text();
      if (head.startsWith("%PDF-") || head.startsWith("PK\u0003\u0004") || head.startsWith("\u00d0\u00cf\u0011\u00e0")) {
        return true;
      }
    }
    if (headerBytes && headerBytes.length >= 4) {
      if (headerBytes.length >= 5 && headerBytes[0] === 0x25 && headerBytes[1] === 0x50 && headerBytes[2] === 0x44 && headerBytes[3] === 0x46 && headerBytes[4] === 0x2d) {
        return true;
      }
      if (headerBytes[0] === 0x50 && headerBytes[1] === 0x4b && headerBytes[2] === 0x03 && headerBytes[3] === 0x04) {
        return true;
      }
      if (headerBytes[0] === 0xd0 && headerBytes[1] === 0xcf && headerBytes[2] === 0x11 && headerBytes[3] === 0xe0) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** Reads and decodes text content from text files or supported document formats. */
export async function readAttachmentText(file: {
  name: string;
  type?: string;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  slice?: (start?: number, end?: number) => Blob;
}): Promise<string | null> {
  const ext = getFileExtension(file.name);
  const isKnownDocument = isKnownBinaryDocumentMeta(file);

  let fallbackText: string | null = null;
  if (!isKnownDocument && typeof file.text === "function") {
    const text = await file.text();
    if (text.startsWith("%PDF-") || text.startsWith("PK\u0003\u0004") || text.startsWith("\u00d0\u00cf\u0011\u00e0")) {
      fallbackText = text;
    } else if (!text.includes("\u0000") && !text.includes("\uFFFD")) {
      return text;
    } else {
      fallbackText = text;
    }
  }

  let buffer: ArrayBuffer | null = null;
  if (typeof file.arrayBuffer === "function") {
    buffer = await file.arrayBuffer();
  } else if (fallbackText !== null && (fallbackText.startsWith("%PDF-") || fallbackText.startsWith("PK\u0003\u0004") || fallbackText.startsWith("\u00d0\u00cf\u0011\u00e0"))) {
    buffer = Uint8Array.from(fallbackText, (c) => c.charCodeAt(0) & 0xff).buffer;
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
  if (typeof file.text === "function") {
    const text = await file.text();
    if (text.includes("\u0000") || text.includes("\uFFFD")) return null;
    return text;
  }
  return null;
}
