import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync, deflateSync } from "node:zlib";

async function loadSubject() {
  return import("./chat-attachments.ts");
}

function textFile(name, type = "") {
  return { name, type };
}

function mockFile(name, type, buffer) {
  return {
    name,
    type,
    text: async () => new TextDecoder("utf-8").decode(buffer),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

function createZip(entries) {
  function crc32(buf) {
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return ~crc >>> 0;
  }

  const localHeaders = [];
  const cdHeaders = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf-8");
    const crc = crc32(dataBuf);
    const uncompressedSize = dataBuf.length;

    let method = 8;
    let compressedBuf = deflateRawSync(dataBuf);
    if (entry.store) {
      method = 0;
      compressedBuf = dataBuf;
    }
    const compressedSize = compressedBuf.length;

    const localHeader = Buffer.alloc(30 + nameBuf.length + compressedBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);
    compressedBuf.copy(localHeader, 30 + nameBuf.length);

    localHeaders.push(localHeader);

    const cdHeader = Buffer.alloc(46 + nameBuf.length);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0, 8);
    cdHeader.writeUInt16LE(method, 10);
    cdHeader.writeUInt16LE(0, 12);
    cdHeader.writeUInt16LE(0, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(compressedSize, 20);
    cdHeader.writeUInt32LE(uncompressedSize, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(0, 38);
    cdHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(cdHeader, 46);

    cdHeaders.push(cdHeader);
    offset += localHeader.length;
  }

  const cdOffset = offset;
  const cdSize = cdHeaders.reduce((sum, h) => sum + h.length, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...cdHeaders, eocd]);
}

function createPdf({ text = "", withToUnicode = false, useFlate = true, withLargeImageBeforeText = false } = {}) {
  const chunks = [];
  chunks.push(Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary"));

  const offsets = [];

  function addObj(num, headerStr, streamBuf = null) {
    offsets[num] = Buffer.concat(chunks).length;
    chunks.push(Buffer.from(`${num} 0 obj\n${headerStr}\n`, "binary"));
    if (streamBuf) {
      chunks.push(Buffer.from("stream\n", "binary"));
      chunks.push(streamBuf);
      chunks.push(Buffer.from("\nendstream\n", "binary"));
    }
    chunks.push(Buffer.from("endobj\n", "binary"));
  }

  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  addObj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);

  if (withLargeImageBeforeText) {
    // 18 MiB of zeros compresses to ~18 KB; if inflated, it would blow past the 16 MiB text budget.
    const bigImageRaw = deflateSync(Buffer.alloc(18 * 1024 * 1024));
    addObj(7, `<< /Type /XObject /Subtype /Image /Width 2000 /Height 3000 /BitsPerComponent 8 /Filter /FlateDecode /Length ${bigImageRaw.length} >>`, bigImageRaw);
    addObj(8, `<< /Length1 ${18 * 1024 * 1024} /Filter /FlateDecode /Length ${bigImageRaw.length} >>`, bigImageRaw);
  }

  let fontObj = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  if (withToUnicode) {
    fontObj = `<< /Type /Font /Subtype /Type0 /BaseFont /TestFont /Encoding /Identity-H /ToUnicode 5 0 R >>`;
  }
  addObj(4, fontObj);
  if (withToUnicode) {
    const cmapStream = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Custom-ToUnicode def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfchar
<0001> <4f60>
<0002> <597d>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
    const cmapBuf = Buffer.from(cmapStream, "utf-8");
    const cmapDeflated = useFlate ? deflateSync(cmapBuf) : cmapBuf;
    const filter = useFlate ? `/Filter /FlateDecode ` : "";
    addObj(5, `<< /Length ${cmapDeflated.length} ${filter}>>`, cmapDeflated);
  } else {
    addObj(5, `<< >>`);
  }

  addObj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>`);

  const contentText = text ? `BT\n/F1 12 Tf\n10 700 Td\n${text}\nET` : "";
  const contentBuf = Buffer.from(contentText, "utf-8");
  const compressedContent = useFlate && contentBuf.length > 0 ? deflateSync(contentBuf) : contentBuf;
  const filter = useFlate && contentBuf.length > 0 ? `/Filter /FlateDecode ` : "";
  addObj(6, `<< /Length ${compressedContent.length} ${filter}>>`, compressedContent);

  const startXref = Buffer.concat(chunks).length;
  let xref = `xref\n0 7\n0000000000 65535 f \n`;
  for (let i = 1; i <= 6; i++) {
    xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  xref += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "binary"));

  return Buffer.concat(chunks);
}

function createOleDoc(text) {
  const sectorSize = 512;
  const header = Buffer.alloc(512);
  header.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], 0);
  header.writeUInt16LE(0xFFFE, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44);
  header.writeInt32LE(1, 48);
  header.writeUInt32LE(0x1000, 56);
  header.writeInt32LE(-2, 60);
  header.writeUInt32LE(0, 64);
  header.writeInt32LE(-2, 68);
  header.writeUInt32LE(0, 72);
  header.writeInt32LE(0, 76);
  for (let i = 1; i < 109; i++) {
    header.writeInt32LE(-1, 76 + i * 4);
  }

  const textBuf = Buffer.from(text, "utf16le");
  const wordDocSize = 512 + textBuf.length;
  const wordDocBuf = Buffer.alloc(Math.ceil(wordDocSize / sectorSize) * sectorSize);
  wordDocBuf.writeUInt16LE(0xA5EC, 0);
  wordDocBuf.writeUInt16LE(0x0200, 0x000A);
  textBuf.copy(wordDocBuf, 0x200);

  const pcdBuf = Buffer.alloc(8);
  pcdBuf.writeUInt32LE(0x0200, 2);

  const clxPart = Buffer.alloc(1 + 4 + 4 * 2 + 8);
  clxPart[0] = 2;
  const pcdtSize = 4 * 2 + 8;
  clxPart.writeUInt32LE(pcdtSize, 1);
  clxPart.writeUInt32LE(0, 5);
  clxPart.writeUInt32LE(text.length, 9);
  pcdBuf.copy(clxPart, 13);

  const tableSize = clxPart.length;
  const tableBuf = Buffer.alloc(Math.ceil(tableSize / sectorSize) * sectorSize);
  clxPart.copy(tableBuf, 0);

  wordDocBuf.writeUInt32LE(0, 0x01A2);
  wordDocBuf.writeUInt32LE(clxPart.length, 0x01A6);

  const dirBuf = Buffer.alloc(sectorSize);
  function writeDirEntry(offset, name, type, startSect, size, childId = -1, leftId = -1, rightId = -1) {
    const nameBuf = Buffer.from(name, "utf16le");
    nameBuf.copy(dirBuf, offset);
    dirBuf.writeUInt16LE(nameBuf.length + 2, offset + 64);
    dirBuf.writeUInt8(type, offset + 66);
    dirBuf.writeUInt8(1, offset + 67);
    dirBuf.writeInt32LE(leftId, offset + 68);
    dirBuf.writeInt32LE(rightId, offset + 72);
    dirBuf.writeInt32LE(childId, offset + 76);
    dirBuf.writeInt32LE(startSect, offset + 116);
    dirBuf.writeUInt32LE(size, offset + 120);
  }

  writeDirEntry(0, "Root Entry", 5, -2, 0, 1);
  const wordDocSectCount = wordDocBuf.length / sectorSize;
  const tableSectCount = tableBuf.length / sectorSize;
  const wordDocStartSect = 2;
  const tableStartSect = wordDocStartSect + wordDocSectCount;

  writeDirEntry(128, "WordDocument", 2, wordDocStartSect, wordDocBuf.length, -1, -1, 2);
  writeDirEntry(256, "1Table", 2, tableStartSect, tableBuf.length, -1, -1, -1);

  const fatBuf = Buffer.alloc(sectorSize, 0xFF);
  fatBuf.writeInt32LE(-3, 0);
  fatBuf.writeInt32LE(-2, 4);
  for (let i = 0; i < wordDocSectCount; i++) {
    const sect = wordDocStartSect + i;
    const next = (i === wordDocSectCount - 1) ? -2 : sect + 1;
    fatBuf.writeInt32LE(next, sect * 4);
  }
  for (let i = 0; i < tableSectCount; i++) {
    const sect = tableStartSect + i;
    const next = (i === tableSectCount - 1) ? -2 : sect + 1;
    fatBuf.writeInt32LE(next, sect * 4);
  }

  return Buffer.concat([header, fatBuf, dirBuf, wordDocBuf, tableBuf]);
}

test("recognizes text and markdown attachments by mime or extension", async () => {
  const { isTextAttachmentFile } = await loadSubject();

  assert.equal(isTextAttachmentFile(textFile("notes.txt", "text/plain")), true);
  assert.equal(isTextAttachmentFile(textFile("README.md", "text/markdown")), true);
  assert.equal(isTextAttachmentFile(textFile("README.MD")), true);
  assert.equal(isTextAttachmentFile(textFile("doc.markdown")), true);
  assert.equal(isTextAttachmentFile(textFile("page.mdx")), true);
  assert.equal(isTextAttachmentFile(textFile("data.json", "application/json")), false);
  assert.equal(isTextAttachmentFile(textFile("image.png", "image/png")), false);
  assert.equal(isTextAttachmentFile(textFile("noextension")), false);
});

test("composes message with attachment blocks and escapes triple backticks", async () => {
  const { composeMessageWithTextAttachments } = await loadSubject();

  assert.equal(composeMessageWithTextAttachments("hello", []), "hello");

  const result = composeMessageWithTextAttachments("  ", [
    { name: "notes.txt", mimeType: "text/plain", content: "line one", size: 8 },
  ]);
  assert.equal(
    result,
    "Attached file: notes.txt\n```text\nline one\n```",
  );

  // Content containing ``` must not break the code fence — the fence grows.
  const backticks = composeMessageWithTextAttachments("", [
    { name: "README.md", mimeType: "text/markdown", content: "```js\ncode\n```", size: 15 },
  ]);
  assert.equal(
    backticks,
    "Attached file: README.md\n````markdown\n```js\ncode\n```\n````",
  );
});

test("keeps message text above attachment blocks", async () => {
  const { composeMessageWithTextAttachments } = await loadSubject();

  const result = composeMessageWithTextAttachments("Review this", [
    { name: "a.md", mimeType: "text/markdown", content: "A", size: 1 },
    { name: "b.txt", mimeType: "text/plain", content: "B", size: 1 },
  ]);

  assert.ok(result.startsWith("Review this\n\nAttached file: a.md"));
  assert.ok(result.includes("Attached file: b.md") === false);
  assert.ok(result.includes("Attached file: b.txt"));
});

test("selects attachments under the per-file and aggregate budgets", async () => {
  const { selectTextAttachments, MAX_ATTACHED_TEXT_BYTES, MAX_TOTAL_ATTACHED_TEXT_BYTES } = await loadSubject();
  const file = (name, size) => ({ name, size });

  // A lone file may fill the whole budget, and 8x the old 256 KB cap fits.
  const large = selectTextAttachments([file("big.log", 2 * 1024 * 1024)], { usedBytes: 0, usedSlots: 0 });
  assert.deepEqual(large.accepted.map((f) => f.name), ["big.log"]);
  assert.equal(large.tooLarge, 0);
  assert.equal(large.overBudget, 0);
  assert.equal(MAX_ATTACHED_TEXT_BYTES, MAX_TOTAL_ATTACHED_TEXT_BYTES);

  // Past the per-file cap the file is refused for its own size, not the budget.
  const oversized = selectTextAttachments([file("huge.log", MAX_ATTACHED_TEXT_BYTES + 1)], { usedBytes: 0, usedSlots: 0 });
  assert.deepEqual(oversized.accepted, []);
  assert.equal(oversized.tooLarge, 1);
  assert.equal(oversized.overBudget, 0);

  // The aggregate budget counts what the composer already holds, and files
  // that no longer fit are reported separately from oversized ones.
  const partial = selectTextAttachments(
    [file("fits.txt", 1024 * 1024), file("over.txt", 2 * 1024 * 1024), file("huge.log", MAX_ATTACHED_TEXT_BYTES + 1)],
    { usedBytes: 3 * 1024 * 1024, usedSlots: 1 },
  );
  assert.deepEqual(partial.accepted.map((f) => f.name), ["fits.txt"]);
  assert.equal(partial.tooLarge, 1);
  assert.equal(partial.overBudget, 1);

  // Remaining file slots cap the batch even when every file fits.
  const slots = selectTextAttachments([file("a.txt", 1), file("b.txt", 1)], { usedBytes: 0, usedSlots: 9 });
  assert.deepEqual(slots.accepted.map((f) => f.name), ["a.txt"]);
  assert.equal(slots.tooLarge, 0);
  assert.equal(slots.overBudget, 0);
});

test("skip banners name the limit the batch actually hit", async () => {
  const { describeTextAttachmentSkip, formatAttachmentBytes } = await loadSubject();

  assert.equal(formatAttachmentBytes(512 * 1024), "512 KB");
  assert.equal(formatAttachmentBytes(4 * 1024 * 1024), "4 MB");
  assert.equal(describeTextAttachmentSkip({ tooLarge: 0, overBudget: 0 }), null);
  assert.equal(
    describeTextAttachmentSkip({ tooLarge: 2, overBudget: 1 }),
    "2 file(s) skipped: files up to 4 MB are supported.",
  );
  assert.equal(
    describeTextAttachmentSkip({ tooLarge: 0, overBudget: 3 }),
    "3 file(s) skipped: attachments are limited to 4 MB per message.",
  );
});

test("isImageAttachmentFile and inferImageMimeType handle raster images and MIME inference", async () => {
  const { isImageAttachmentFile, inferImageMimeType } = await loadSubject();

  assert.equal(isImageAttachmentFile({ name: "photo.PNG", type: "" }), true);
  assert.equal(inferImageMimeType({ name: "photo.PNG", type: "" }), "image/png");

  assert.equal(isImageAttachmentFile({ name: "photo.jpg", type: "application/octet-stream" }), true);
  assert.equal(inferImageMimeType({ name: "photo.jpg", type: "application/octet-stream" }), "image/jpeg");

  assert.equal(isImageAttachmentFile({ name: "pic.webp", type: "image/webp" }), true);
  assert.equal(inferImageMimeType({ name: "pic.webp", type: "image/webp" }), "image/webp");

  assert.equal(isImageAttachmentFile({ name: "icon.svg", type: "" }), false);
  assert.equal(isImageAttachmentFile({ name: "icon.svg", type: "image/svg+xml" }), true);
  assert.equal(inferImageMimeType({ name: "icon.svg", type: "image/svg+xml" }), "image/svg+xml");

  assert.equal(isImageAttachmentFile({ name: "doc.pdf", type: "" }), false);
});

test("readAttachmentText decodes PDF with FlateDecode + ToUnicode CMap (including CJK) and handles empty/scanned PDF", async () => {
  const { readAttachmentText } = await loadSubject();

  const cjkPdf = createPdf({ text: "<00010002> Tj", withToUnicode: true, useFlate: true });
  const cjkResult = await readAttachmentText(mockFile("test-cjk.pdf", "application/pdf", cjkPdf));
  assert.equal(cjkResult, "你好");

  const pdfWithBigImageAndFont = createPdf({
    text: "<00010002> Tj",
    withToUnicode: true,
    useFlate: true,
    withLargeImageBeforeText: true,
  });
  const bigMediaResult = await readAttachmentText(mockFile("big-media.pdf", "application/pdf", pdfWithBigImageAndFont));
  assert.equal(bigMediaResult, "你好");

  const asciiPdf = createPdf({ text: "(Hello World) Tj", withToUnicode: false, useFlate: true });
  const asciiResult = await readAttachmentText(mockFile("test-ascii.pdf", "application/pdf", asciiPdf));
  assert.equal(asciiResult, "Hello World");

  const emptyPdf = createPdf({ text: "", withToUnicode: false, useFlate: true });
  const emptyResult = await readAttachmentText(mockFile("scanned.pdf", "application/pdf", emptyPdf));
  assert.equal(emptyResult, null);
});

test("readAttachmentText extracts docx paragraphs and tables", async () => {
  const { readAttachmentText } = await loadSubject();

  const docxZip = createZip([
    {
      name: "word/document.xml",
      data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Header Paragraph</w:t></w:r></w:p>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>Col 1</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>Col 2</w:t></w:r></w:p></w:tc>
            </w:tr>
            <w:tr>
              <w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:body>
      </w:document>`,
    },
  ]);

  const result = await readAttachmentText(mockFile("sample.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docxZip));
  assert.match(result, /Header Paragraph/);
  assert.match(result, /\| Col 1 \| Col 2 \|/);
  assert.match(result, /\| A \| B \|/);
});

test("readAttachmentText extracts xlsx with sharedStrings and worksheet into Markdown table", async () => {
  const { readAttachmentText } = await loadSubject();

  const xlsxZip = createZip([
    {
      name: "xl/sharedStrings.xml",
      data: `<sst><si><t>Item</t></si><si><t>Price</t></si><si><t>Apple</t></si></sst>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
        <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>10.5</v></c></row>
      </sheetData></worksheet>`,
    },
  ]);

  const result = await readAttachmentText(mockFile("book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsxZip));
  assert.match(result, /### Sales/);
  assert.match(result, /\| Item \| Price \|/);
  assert.match(result, /\| Apple \| 10\.5 \|/);
});

test("readAttachmentText extracts pptx with slides and speaker notes", async () => {
  const { readAttachmentText } = await loadSubject();

  const pptxZip = createZip([
    {
      name: "ppt/presentation.xml",
      data: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
    },
    {
      name: "ppt/slides/slide1.xml",
      data: `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
        <p:cSld><p:spTree><p:sp><p:txBody>
          <a:p><a:r><a:t>Slide 1 Title</a:t></a:r></a:p>
        </p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>`,
    },
    {
      name: "ppt/notesSlides/notesSlide1.xml",
      data: `<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
        <p:cSld><p:spTree><p:sp><p:txBody>
          <a:p><a:r><a:t>Speaker note for slide 1</a:t></a:r></a:p>
        </p:txBody></p:sp></p:spTree></p:cSld>
      </p:notes>`,
    },
  ]);

  const result = await readAttachmentText(mockFile("pres.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", pptxZip));
  assert.match(result, /### Slide 1/);
  assert.match(result, /Slide 1 Title/);
  assert.match(result, /Speaker note for slide 1/);
});

test("readAttachmentText extracts odt with paragraphs", async () => {
  const { readAttachmentText } = await loadSubject();

  const odtZip = createZip([
    {
      name: "content.xml",
      data: `<office:document-content xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
        <office:body>
          <text:h>ODT Heading</text:h>
          <text:p>ODT Paragraph text</text:p>
        </office:body>
      </office:document-content>`,
    },
  ]);

  const result = await readAttachmentText(mockFile("document.odt", "application/vnd.oasis.opendocument.text", odtZip));
  assert.match(result, /ODT Heading/);
  assert.match(result, /ODT Paragraph text/);
});

test("readAttachmentText extracts legacy Word 97-2003 .doc with UTF-16LE CJK text and guards against cyclic FAT", async () => {
  const { readAttachmentText } = await loadSubject();

  const oleDoc = createOleDoc("繁體中文 Word 97 測試 123");
  const result = await readAttachmentText(mockFile("legacy.doc", "application/msword", oleDoc));
  assert.equal(result, "繁體中文 Word 97 測試 123");

  // Self-referential FAT entry (sector 1 -> sector 1) must terminate cleanly without hanging.
  const cyclicDoc = Buffer.from(oleDoc);
  cyclicDoc.writeInt32LE(1, 512 + 4);
  const cyclicResult = await readAttachmentText(mockFile("cyclic.doc", "application/msword", cyclicDoc));
  assert.equal(cyclicResult, "繁體中文 Word 97 測試 123");
});

test("readAttachmentText decodes UTF-16LE and UTF-16BE BOM text files", async () => {
  const { readAttachmentText } = await loadSubject();

  const leBuf = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from("Hello UTF-16LE", "utf16le")]);
  const leResult = await readAttachmentText(mockFile("utf16le.txt", "text/plain", leBuf));
  assert.equal(leResult, "Hello UTF-16LE");

  const beBuf = Buffer.from([0xFE, 0xFF, 0x00, 0x48, 0x00, 0x69]); // "Hi"
  const beResult = await readAttachmentText(mockFile("utf16be.txt", "text/plain", beBuf));
  assert.equal(beResult, "Hi");
});

test("readAttachmentText returns null on raw binary files", async () => {
  const { readAttachmentText } = await loadSubject();

  const binBuf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
  const binResult = await readAttachmentText(mockFile("image.png", "image/png", binBuf));
  assert.equal(binResult, null);
});

test("decodeXmlEntities decodes entities in a single pass and supports astral numeric references", async () => {
  const { decodeXmlEntities } = await loadSubject();

  // Single-pass decoding: &amp;lt; preserves &lt;, never turns into <
  assert.equal(decodeXmlEntities("&amp;lt;"), "&lt;");
  assert.equal(decodeXmlEntities("&amp;gt;"), "&gt;");
  assert.equal(decodeXmlEntities("&amp;amp;"), "&amp;");
  assert.equal(decodeXmlEntities("&amp;quot;"), '&quot;');
  assert.equal(decodeXmlEntities("&amp;apos;"), "&apos;");

  // Decimal and hex astral numeric references above U+FFFF
  assert.equal(decodeXmlEntities("&#128512;"), "😀");
  assert.equal(decodeXmlEntities("&#x1F600;"), "😀");

  // Preserves invalid codepoints (surrogates and out-of-range)
  assert.equal(decodeXmlEntities("&#xD800;"), "&#xD800;");
  assert.equal(decodeXmlEntities("&#x110000;"), "&#x110000;");
});

test("readAttachmentText extracts epub and decodes XML entities", async () => {
  const { readAttachmentText } = await loadSubject();

  const epubZip = createZip([
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0"?>
        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles>
            <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
          </rootfiles>
        </container>`,
    },
    {
      name: "OEBPS/content.opf",
      data: `<?xml version="1.0" encoding="utf-8"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
          <manifest>
            <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine>
            <itemref idref="c1"/>
          </spine>
        </package>`,
    },
    {
      name: "OEBPS/ch1.xhtml",
      data: `<html><body><p>Chapter 1: &amp;lt;Escaped&amp;gt; &amp; &#128512;</p></body></html>`,
    },
  ]);

  const result = await readAttachmentText(mockFile("book.epub", "application/epub+zip", epubZip));
  assert.match(result, /Chapter 1: &lt;Escaped&gt; & 😀/);
});

test("readAttachmentText separates lines for PDF Td and positioning operators", async () => {
  const { readAttachmentText } = await loadSubject();

  const multiLinePdf = createPdf({
    text: "(First line) Tj 0 -15 Td (Second line) Tj T* (Third line) Tj",
    withToUnicode: false,
    useFlate: true,
  });
  const result = await readAttachmentText(mockFile("multiline.pdf", "application/pdf", multiLinePdf));
  assert.equal(result, "First line\nSecond line\nThird line");
});

test("readAttachmentText sorts out-of-order PDF table columns by (Y, X) and spaces TJ cells", async () => {
  const { readAttachmentText } = await loadSubject();

  // Simulate an Excel-exported PDF where ASCII columns are drawn first via TJ negative kerning
  // and a middle column (dates) is drawn in a subsequent BT...ET block at the same Y coordinates.
  const tablePdf = createPdf({
    text: [
      "1 0 0 1 20 700 Tm [(0653) -4500 (265W36507D) -1200 (S1-300) -20 (A)] TJ",
      "1 0 0 1 20 680 Tm [(0654) -4500 (264W365059) -1200 (S3-300)] TJ",
      "ET",
      "BT /F1 12 Tf",
      "1 0 0 1 55 700 Tm (10/08) Tj",
      "1 0 0 1 55 680 Tm (10/14) Tj",
    ].join("\n"),
    withToUnicode: false,
    useFlate: true,
  });
  const result = await readAttachmentText(mockFile("table.pdf", "application/pdf", tablePdf));
  assert.equal(result, "0653 10/08 265W36507D S1-300A\n0654 10/14 264W365059 S3-300");
});

test("readAttachmentText extracts xlsx with absolute relationship target path", async () => {
  const { readAttachmentText } = await loadSubject();

  const xlsxZip = createZip([
    {
      name: "xl/workbook.xml",
      data: `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<worksheet><sheetData>
        <row r="1"><c r="A1"><v>100</v></c><c r="B1"><v>200</v></c></row>
      </sheetData></worksheet>`,
    },
  ]);

  const result = await readAttachmentText(mockFile("absolute.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsxZip));
  assert.match(result, /### Data/);
  assert.match(result, /\| 100 \| 200 \|/);
});

test("readAttachmentText handles xlsx self-closing empty cells and rows without shifting columns", async () => {
  const { readAttachmentText } = await loadSubject();

  const xlsxZip = createZip([
    {
      name: "xl/workbook.xml",
      data: `<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<worksheet><sheetData>
        <row r="1">
          <c r="A1" s="1"/>
          <c r="B1"><v>42</v></c>
        </row>
        <row r="2"/>
        <row r="3">
          <c r="A3"><v>99</v></c>
        </row>
      </sheetData></worksheet>`,
    },
  ]);

  const result = await readAttachmentText(mockFile("sparse.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsxZip));
  assert.match(result, /### Sheet1/);
  assert.match(result, /\|\s*\|\s*42\s*\|/);
  assert.match(result, /\|\s*99\s*\|/);
});

test("readAttachmentText extracts odf tables with self-closing cells preserving column alignment", async () => {
  const { readAttachmentText } = await loadSubject();

  const odsZip = createZip([
    {
      name: "content.xml",
      data: `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
        <office:body>
          <office:spreadsheet>
            <table:table table:name="Sheet1">
              <table:table-row>
                <table:table-cell><text:p>ColA</text:p></table:table-cell>
                <table:table-cell><text:p>ColB</text:p></table:table-cell>
                <table:table-cell><text:p>ColC</text:p></table:table-cell>
              </table:table-row>
              <table:table-row>
                <table:table-cell><text:p>ValA</text:p></table:table-cell>
                <table:table-cell/>
                <table:table-cell><text:p>ValC</text:p></table:table-cell>
              </table:table-row>
            </table:table>
          </office:spreadsheet>
        </office:body>
      </office:document-content>`,
    },
  ]);

  const result = await readAttachmentText(mockFile("sheet.ods", "application/vnd.oasis.opendocument.spreadsheet", odsZip));
  assert.match(result, /\| ColA \| ColB \| ColC \|/);
  assert.match(result, /\| ValA \|\s*\| ValC \|/);
});

test("readAttachmentText extracts xlsx worksheet with attribute-less row elements", async () => {
  const { readAttachmentText } = await loadSubject();

  const xlsxZip = createZip([
    {
      name: "xl/workbook.xml",
      data: `<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>NoRowAttrs</t></is></c></row></sheetData></worksheet>`,
    },
  ]);

  const result = await readAttachmentText(mockFile("no-row-attrs.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsxZip));
  assert.match(result, /### Sheet1/);
  assert.match(result, /\| NoRowAttrs \|/);
});

test("readAttachmentText expands odf repeated columns and trims trailing empty cells", async () => {
  const { readAttachmentText } = await loadSubject();

  const odsZip = createZip([
    {
      name: "content.xml",
      data: `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
        <office:body>
          <office:spreadsheet>
            <table:table table:name="Sheet1">
              <table:table-row>
                <table:table-cell table:number-columns-repeated="2"/>
                <table:table-cell><text:p>Middle</text:p></table:table-cell>
                <table:table-cell table:number-columns-repeated="500"/>
              </table:table-row>
            </table:table>
          </office:spreadsheet>
        </office:body>
      </office:document-content>`,
    },
  ]);

  const result = await readAttachmentText(mockFile("repeated.ods", "application/vnd.oasis.opendocument.spreadsheet", odsZip));
  // Should have 3 columns total: 2 leading empty columns + "Middle" column. Trailing 500 empty columns trimmed.
  assert.match(result, /\|\s*\|\s*\|\s*Middle\s*\|/);
  assert.doesNotMatch(result, /\| Middle \|(?:\s*\|){5,}/);
});

test("readAttachmentText rejects odf spreadsheet exceeding output byte budget via repeated cells", async () => {
  const { readAttachmentText } = await loadSubject();

  // Each row has repeated cells with non-empty text, expanding beyond 4 MiB
  const cellText = "A".repeat(1000);
  const rowXml = `<table:table-row><table:table-cell table:number-columns-repeated="64"><text:p>${cellText}</text:p></table:table-cell></table:table-row>`;
  // 64 * 1003 bytes ~ 64 KB per row; 70 rows > 4.4 MB (> 4 MiB MAX_ATTACHED_TEXT_BYTES)
  const rowsXml = rowXml.repeat(70);

  const odsZip = createZip([
    {
      name: "content.xml",
      data: `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
        <office:body>
          <office:spreadsheet>
            <table:table table:name="Sheet1">
              ${rowsXml}
            </table:table>
          </office:spreadsheet>
        </office:body>
      </office:document-content>`,
    },
  ]);

  const result = await readAttachmentText(mockFile("huge-repeated.ods", "application/vnd.oasis.opendocument.spreadsheet", odsZip));
  assert.strictEqual(result, null);
});

test("readAttachmentText rejects xlsx exceeding output byte budget via repeated shared strings", async () => {
  const { readAttachmentText } = await loadSubject();

  const sharedString = "B".repeat(10000);
  // 500 rows referencing the 10KB shared string -> 5 MB (> 4 MiB MAX_ATTACHED_TEXT_BYTES)
  let rowsXml = "";
  for (let r = 1; r <= 500; r++) {
    rowsXml += `<row r="${r}"><c r="A${r}" t="s"><v>0</v></c></row>`;
  }

  const xlsxZip = createZip([
    {
      name: "xl/sharedStrings.xml",
      data: `<sst count="1" uniqueCount="1"><si><t>${sharedString}</t></si></sst>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<worksheet><sheetData>${rowsXml}</sheetData></worksheet>`,
    },
  ]);

  const result = await readAttachmentText(mockFile("huge-shared-strings.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsxZip));
  assert.strictEqual(result, null);
});

test("enforces text byte budget on extracted text byte length", async () => {
  const {
    selectTextAttachments,
    MAX_ATTACHED_TEXT_BYTES,
    MAX_TOTAL_ATTACHED_TEXT_BYTES,
    describeTextAttachmentSkip,
  } = await loadSubject();

  // Compressed file is small, but extracted content expands beyond MAX_ATTACHED_TEXT_BYTES
  const largeExtractedCandidate = {
    name: "expanded.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    content: "x".repeat(MAX_ATTACHED_TEXT_BYTES + 10),
    size: new TextEncoder().encode("x".repeat(MAX_ATTACHED_TEXT_BYTES + 10)).byteLength,
  };

  const selOversized = selectTextAttachments([largeExtractedCandidate], { usedBytes: 0, usedSlots: 0 });
  assert.equal(selOversized.accepted.length, 0);
  assert.equal(selOversized.tooLarge, 1);
  assert.equal(selOversized.overBudget, 0);
  assert.equal(
    describeTextAttachmentSkip(selOversized),
    "1 file(s) skipped: files up to 4 MB are supported.",
  );

  // Extracted content exceeds remaining aggregate budget
  const moderateExtractedCandidate = {
    name: "moderate.pdf",
    mimeType: "application/pdf",
    content: "x".repeat(1024 * 1024),
    size: new TextEncoder().encode("x".repeat(1024 * 1024)).byteLength,
  };

  const selOverBudget = selectTextAttachments([moderateExtractedCandidate], {
    usedBytes: MAX_TOTAL_ATTACHED_TEXT_BYTES - 512 * 1024,
    usedSlots: 1,
  });
  assert.equal(selOverBudget.accepted.length, 0);
  assert.equal(selOverBudget.tooLarge, 0);
  assert.equal(selOverBudget.overBudget, 1);
  assert.equal(
    describeTextAttachmentSkip(selOverBudget),
    "1 file(s) skipped: attachments are limited to 4 MB per message.",
  );
});
