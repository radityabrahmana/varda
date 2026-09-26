// DOCX → contract_text + contract_html extraction for the contracts module.
//
// Pure with respect to the database: takes the uploaded bytes and filename,
// returns the extracted content or a typed failure. The HTML post-processing
// mirrors Janus's NewReview page so the viewer renders identically.
//
// contract_text comes from Varda's own OOXML walker, the same flattening the
// redline anchor matcher runs against, with Word's automatic clause numbers
// rendered in front of each paragraph. The model therefore quotes text that
// the matcher can find and cites the clause numbers the reader sees; mammoth
// (which drops automatic numbering) remains the fallback and the HTML source.

import { normalizeDocxZipPaths } from "../../lib/convert";
import { extractDocxBodyText } from "../../lib/docxTrackedChanges";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";

export const CONTRACT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const DOCX_EXT = /\.(docx|doc)$/i;

export type ExtractedContract = {
  contract_text: string;
  contract_html: string;
  filename: string;
};

export async function extractContract(
  file: { buffer: Buffer; filename: unknown },
): Promise<ServiceResult<ExtractedContract>> {
  const filename = typeof file.filename === "string" ? file.filename.trim() : "";
  if (!filename) return failure("validation", "filename is required");
  if (!DOCX_EXT.test(filename)) {
    return failure("validation", "Hanya file DOCX yang diperbolehkan.");
  }
  const size = file.buffer.byteLength;
  if (size === 0) return failure("validation", "file is required");
  if (size > CONTRACT_UPLOAD_MAX_BYTES) {
    return failure("validation", "File terlalu besar. Maksimum 25MB.");
  }

  try {
    const normalized = await normalizeDocxZipPaths(file.buffer);
    const mammoth = await import("mammoth");
    const [numberedText, { value: rawHtml }] = await Promise.all([
      extractDocxBodyText(normalized, { numbering: true }).catch(() => ""),
      mammoth.convertToHtml(
        { buffer: normalized },
        { styleMap: ["b => strong", "i => em", "u => u", "strike => s", "highlight => mark"] },
      ),
    ]);
    const contract_text = numberedText.trim()
      ? numberedText
      : (await mammoth.extractRawText({ buffer: normalized })).value;
    const contract_html = rawHtml
      .replace(/<table>/g, '<table style="width:100%">')
      .replace(/<p>\s*<\/p>/g, "")
      .replace(/(<br\s*\/?>\s*){3,}/g, '<hr style="border:none;border-top:1px dashed #ccc;margin:32px 0;">');

    if (!contract_text || contract_text.trim().length === 0) {
      return failure("validation", "Ekstraksi gagal — dokumen kosong atau tidak terbaca.");
    }
    return ok({ contract_text, contract_html, filename });
  } catch (e) {
    return internalFailure(e instanceof Error ? e : new Error(`Ekstraksi gagal: ${String(e)}`));
  }
}
