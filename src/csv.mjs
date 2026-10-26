import { gzipSync } from "node:zlib";

export const UTF8_BOM = "\uFEFF";

/** سقف امن پیش‌فرض هر فایل ارسالی به API بله (۸ مگابایت) */
export const DEFAULT_MAX_BALE_DOCUMENT_BYTES = 8 * 1024 * 1024;

/**
 * آماده‌سازی فایل CSV برای ارسال از طریق `sendDocument` بله با رعایت محدودیت حجم:
 *   - اگر حجم فایل کمتر یا مساوی `maxBytes` باشد، همان فایل تکی ارسال می‌شود.
 *   - اگر بزرگ‌تر باشد، بدون حذف هیچ رکوردی به بخش‌های معتبر CSV (هر بخش دارای
 *     UTF-8 BOM، ردیف متادیتا و سرستون‌ها) تقسیم می‌شود.
 *   - اگر تعداد بخش‌ها بیش از ۸ فایل شود، کل فایل به‌صورت فشردهٔ بدون اتلاف (`.csv.gz`)
 *     بسته‌بندی می‌شود (و اگر باز هم بزرگ‌تر از سقف بود، بخش‌های فشرده ساخته می‌شوند).
 */
export function prepareCsvDocumentsForBale({
  filename,
  csvContent,
  totalRecords,
  maxBytes = DEFAULT_MAX_BALE_DOCUMENT_BYTES,
}) {
  const safeMaxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BALE_DOCUMENT_BYTES);
  const normalizedContent = csvContent.startsWith(UTF8_BOM)
    ? csvContent
    : `${UTF8_BOM}${csvContent}`;
  const fullBuffer = Buffer.from(normalizedContent, "utf8");

  if (fullBuffer.byteLength <= safeMaxBytes) {
    return [
      {
        filename,
        buffer: fullBuffer,
        mimeType: "text/csv; charset=utf-8",
        partIndex: 1,
        totalParts: 1,
        partRecords: totalRecords,
        totalRecords,
        compressed: false,
      },
    ];
  }

  const withoutBom = normalizedContent.slice(UTF8_BOM.length);
  const rawLines = withoutBom.split(/\r?\n/).filter((line) => line.length > 0);

  // ردیف اول متادیتای گزارش و ردیف دوم سرستون‌هاست (در صورت وجود متادیتا)
  const hasMetadataLine = rawLines.length >= 2 && rawLines[0].startsWith("نام فایل:");
  const preambleLines = hasMetadataLine ? rawLines.slice(0, 2) : rawLines.slice(0, 1);
  const dataLines = hasMetadataLine ? rawLines.slice(2) : rawLines.slice(1);

  const preambleText = `${UTF8_BOM}${preambleLines.join("\r\n")}\r\n`;
  const preambleBytes = Buffer.byteLength(preambleText, "utf8");

  const chunks = [];
  let currentLines = [];
  let currentBytes = preambleBytes;

  for (const line of dataLines) {
    const lineWithCrlf = `${line}\r\n`;
    const lineBytes = Buffer.byteLength(lineWithCrlf, "utf8");

    if (currentLines.length > 0 && currentBytes + lineBytes > safeMaxBytes) {
      chunks.push(currentLines);
      currentLines = [line];
      currentBytes = preambleBytes + lineBytes;
    } else {
      currentLines.push(line);
      currentBytes += lineBytes;
    }
  }

  if (currentLines.length > 0) {
    chunks.push(currentLines);
  }

  // اگر تعداد تکه‌ها بیش از ۸ فایل شد و نسخهٔ gzip تک‌فایل جا می‌شود، نسخهٔ فشرده بفرستیم
  if (chunks.length > 8) {
    const gzBuffer = gzipSync(fullBuffer, { level: 9 });
    if (gzBuffer.byteLength <= safeMaxBytes) {
      return [
        {
          filename: `${filename}.gz`,
          buffer: gzBuffer,
          mimeType: "application/gzip",
          partIndex: 1,
          totalParts: 1,
          partRecords: totalRecords,
          totalRecords,
          compressed: true,
        },
      ];
    }
  }

  const baseName = filename.replace(/\.csv$/i, "");
  const totalParts = chunks.length;

  return chunks.map((lines, idx) => {
    const partIndex = idx + 1;
    const partFilename = `${baseName}-part${partIndex}-of-${totalParts}.csv`;
    const partPreamble = [...preambleLines];
    if (hasMetadataLine && partPreamble[0]) {
      partPreamble[0] = `${partPreamble[0]},بخش ${partIndex} از ${totalParts} (${lines.length} رکورد در این فایل)`;
    }
    const partText = `${UTF8_BOM}${[...partPreamble, ...lines].join("\r\n")}\r\n`;
    return {
      filename: partFilename,
      buffer: Buffer.from(partText, "utf8"),
      mimeType: "text/csv; charset=utf-8",
      partIndex,
      totalParts,
      partRecords: lines.length,
      totalRecords,
      compressed: false,
    };
  });
}
