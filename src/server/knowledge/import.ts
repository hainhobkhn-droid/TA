import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { inflateRawSync } from "node:zlib";
import { AppError } from "../errors.js";
// Validate expanded ZIP entries before ExcelJS allocates the workbook.
export function validateXlsxZip(b: Buffer) {
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0 || b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6))
    throw new AppError(400, "INVALID_XLSX_ARCHIVE");
  const count = b.readUInt16LE(end + 10);
  let offset = b.readUInt32LE(end + 16),
    total = 0;
  if (count > 2000) throw new AppError(413, "XLSX_EXPANDED_LIMIT");
  try {
    for (let i = 0; i < count; i++) {
      if (b.readUInt32LE(offset) !== 0x02014b50) throw Error();
      const flags = b.readUInt16LE(offset + 8),
        method = b.readUInt16LE(offset + 10),
        compressed = b.readUInt32LE(offset + 20),
        size = b.readUInt32LE(offset + 24),
        local = b.readUInt32LE(offset + 42);
      total += size;
      if (
        flags & 1 ||
        ![0, 8].includes(method) ||
        total > 20000000 ||
        compressed > 5000000 ||
        size > 10000000 ||
        b.readUInt32LE(local) !== 0x04034b50
      )
        throw Error();
      const start =
        local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      if (start + compressed > b.length) throw Error();
      const data = b.subarray(start, start + compressed);
      const expanded =
        method === 8
          ? inflateRawSync(data, { maxOutputLength: Math.max(1, size) })
          : data;
      if (expanded.length !== size) throw Error();
      offset +=
        46 +
        b.readUInt16LE(offset + 28) +
        b.readUInt16LE(offset + 30) +
        b.readUInt16LE(offset + 32);
    }
  } catch {
    throw new AppError(400, "XLSX_INVALID_OR_EXPANDED_LIMIT");
  }
}
export async function parseUpload(content: string, format: "csv" | "xlsx") {
  if (Buffer.byteLength(content) > 7000000)
    throw new AppError(413, "IMPORT_TOO_LARGE");
  if (format === "csv") {
    const rows = parse(content, {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      max_record_size: 64000,
      relax_column_count: false,
    });
    if (rows.length > 10000) throw new AppError(400, "TOO_MANY_ROWS");
    return rows as Record<string, unknown>[];
  }
  const buffer = Buffer.from(content, "base64");
  validateXlsxZip(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount > 10001 || sheet.columnCount > 100)
    throw new AppError(400, "XLSX_SHAPE_LIMIT");
  const headers: string[] = [];
  sheet
    .getRow(1)
    .eachCell(
      { includeEmpty: true },
      (c, i) => (headers[i - 1] = c.text.trim()),
    );
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length)
    throw new AppError(400, "INVALID_COLUMNS");
  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((r, i) => {
    if (i === 1) return;
    const obj: Record<string, unknown> = {};
    headers.forEach((h, j) => {
      const v = r.getCell(j + 1).value;
      if (v instanceof Date) obj[h] = v.toISOString();
      else if (v && typeof v === "object")
        throw new AppError(400, "XLSX_FORMULA_OR_RICH_VALUE_REJECTED");
      else obj[h] = v;
    });
    rows.push(obj);
  });
  return rows;
}
export async function googleCsv(url: string, fetcher: typeof fetch = fetch) {
  let u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "docs.google.com" ||
    !u.pathname.startsWith("/spreadsheets/d/e/") ||
    u.searchParams.get("output") !== "csv" ||
    u.username ||
    u.password
  )
    throw new AppError(400, "PUBLISHED_GOOGLE_CSV_REQUIRED");
  const signal = AbortSignal.timeout(15000);
  for (let i = 0; i < 4; i++) {
    const r = await fetcher(u, { redirect: "manual", signal });
    if (r.status >= 300 && r.status < 400) {
      const next = new URL(r.headers.get("location") ?? "", u);
      if (
        next.protocol !== "https:" ||
        next.username ||
        next.password ||
        next.port ||
        !(
          next.hostname === "docs.google.com" ||
          next.hostname.endsWith(".googleusercontent.com")
        )
      )
        throw new AppError(400, "GOOGLE_CSV_REDIRECT_REJECTED");
      await r.body?.cancel();
      u = next;
      continue;
    }
    if (!r.ok || !r.body) throw new AppError(502, "SOURCE_FETCH_FAILED");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const b of r.body) {
      size += b.byteLength;
      if (size > 5000000) throw new AppError(413, "IMPORT_TOO_LARGE");
      chunks.push(b);
    }
    return parseUpload(Buffer.concat(chunks).toString("utf8"), "csv");
  }
  throw new AppError(502, "SOURCE_REDIRECT_LIMIT");
}
