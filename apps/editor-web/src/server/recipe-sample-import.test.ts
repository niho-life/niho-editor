import { describe, expect, it, vi } from "vitest";
import {
  importUploadedSample,
  importUrlSample,
  RecipeSampleImportError,
  RECIPE_SAMPLE_UPLOAD_MAX_BYTES,
} from "./recipe-sample-import";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const path = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    locals.push(local, path, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, path);
    offset += local.length + path.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

function pdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 20 200 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

const publicLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

describe("importUploadedSample", () => {
  it("reads Markdown and counts/truncates by Unicode code point", async () => {
    const plain = await importUploadedSample("meeting.md", Buffer.from("## 見出し\r\n本文\u0000"));
    expect(plain).toEqual({ text: "## 見出し\n本文", chars: 9 });
    const truncated = await importUploadedSample("long.txt", Buffer.from("猫".repeat(30_001)));
    expect(truncated.chars).toBe(30_000);
    expect(truncated.truncatedFrom).toBe(30_001);
  });

  it("extracts raw text from synthetic DOCX and PDF fixtures", async () => {
    const docx = zip({
      "[Content_Types].xml": "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
      "_rels/.rels": "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>",
      "word/document.xml": "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>Synthetic DOCX</w:t></w:r></w:p></w:body></w:document>",
    });
    expect((await importUploadedSample("sample.docx", docx)).text).toContain("Synthetic DOCX");
    expect((await importUploadedSample("sample.pdf", pdf("Synthetic PDF"))).text).toContain("Synthetic PDF");
  });

  it("rejects unsupported, invalid, and oversize input before extraction", async () => {
    await expect(importUploadedSample("sample.exe", Buffer.from("text"))).rejects.toMatchObject({ code: "unsupported_type" });
    await expect(importUploadedSample("sample.pdf", Buffer.from("not a PDF"))).rejects.toBeInstanceOf(RecipeSampleImportError);
    await expect(importUploadedSample("large.md", Buffer.alloc(RECIPE_SAMPLE_UPLOAD_MAX_BYTES + 1))).rejects.toMatchObject({ code: "too_large" });
  });
});

describe("importUrlSample (injected network only)", () => {
  it("pins only public DNS answers and strips query/fragment from stored source metadata", async () => {
    const request = vi.fn(async (url: URL) => ({ status: 200, headers: { "content-type": "text/markdown" }, body: Buffer.from("## Synthetic\nfixture") }));
    const result = await importUrlSample("https://example.test/sample.md?token=secret#part", { lookup: publicLookup, request });
    expect(result.text).toContain("## Synthetic");
    expect(result.sourceUrl).toBe("https://example.test/sample.md");
    expect(result.sourceUrl).not.toContain("secret");
    expect(request.mock.calls[0]?.[0].hostname).toBe("example.test");
  });

  it("rejects credentials, private DNS answers, and a redirect to an internal hostname without a second request", async () => {
    const request = vi.fn(async () => ({ status: 302, headers: { location: "https://redirect.example.test/latest" }, body: Buffer.alloc(0) }));
    await expect(importUrlSample("https://user:secret@example.test/a.md", { lookup: publicLookup, request })).rejects.toMatchObject({ code: "unsafe_url" });
    await expect(importUrlSample("https://example.test/a.md", { lookup: async () => [{ address: "10.0.0.8", family: 4 }], request })).rejects.toMatchObject({ code: "unsafe_url" });
    await expect(importUrlSample("https://example.test/a.md", { lookup: async () => [{ address: "2002:7f00:0001::1", family: 6 }], request })).rejects.toMatchObject({ code: "unsafe_url" });
    await expect(importUrlSample("https://example.test/a.md", {
      lookup: async (hostname) => hostname === "redirect.example.test" ? [{ address: "169.254.169.254", family: 4 }] : publicLookup(),
      request,
    })).rejects.toMatchObject({ code: "unsafe_url" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("times out an injected resolver without opening a network request", async () => {
    const request = vi.fn();
    await expect(importUrlSample("https://example.test/a.md", {
      lookup: () => new Promise(() => undefined),
      request,
      timeoutMs: 5,
    })).rejects.toMatchObject({ code: "timeout" });
    expect(request).not.toHaveBeenCalled();
  });
});
