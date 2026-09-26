import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const storageMocks = vi.hoisted(() => ({
  headFile: vi.fn(async (): Promise<{ size: number; etag: string | null; contentType: string | null } | null> => null),
}));
vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  storageEnabled: true,
  headFile: storageMocks.headFile,
}));

import {
  deleteReview,
  extractContract,
  getReviewDetail,
  getReviewStatus,
  isReviewOutput,
  parseCreateReviewBody,
} from "../contracts.service";

describe("parseCreateReviewBody", () => {
  it("rejects a missing client name and empty contract text", () => {
    expect(parseCreateReviewBody({ contract_text: "x" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseCreateReviewBody({ client_name: "A", contract_text: "   " })).toMatchObject({ ok: false, kind: "validation" });
  });

  it("defaults document_type to Other, derives the title, and drops non-string focus entries", () => {
    const r = parseCreateReviewBody({ client_name: " PT A ", contract_text: "body", review_focus: ["payment", 3, null] });
    expect(r).toMatchObject({
      ok: true,
      data: { client_name: "PT A", document_type: "Other", title: "Other — PT A", review_focus: ["payment"], contract_html: null },
    });
  });
});

describe("isReviewOutput", () => {
  it("accepts a ReviewOutput and rejects error passthroughs or shapeless objects", () => {
    expect(isReviewOutput({ risk_level: "HIGH" })).toBe(true);
    expect(isReviewOutput({ overall_recommendation: "DO_NOT_SIGN" })).toBe(true);
    expect(isReviewOutput({ error: "boom", risk_level: "HIGH" })).toBe(false);
    expect(isReviewOutput({ executive_summary: "only" })).toBe(false);
    expect(isReviewOutput(null)).toBe(false);
  });
});

describe("extractContract", () => {
  it("rejects non-DOCX filenames, empty bodies, and oversized files without touching mammoth", async () => {
    const small = Buffer.from("PK");
    expect(await extractContract({ buffer: small, filename: "contract.pdf" })).toMatchObject({ ok: false, kind: "validation" });
    expect(await extractContract({ buffer: Buffer.alloc(0), filename: "contract.docx" })).toMatchObject({ ok: false, kind: "validation" });
    expect(await extractContract({ buffer: Buffer.alloc(25 * 1024 * 1024 + 1), filename: "c.docx" })).toMatchObject({
      ok: false,
      kind: "validation",
      detail: "File terlalu besar. Maksimum 25MB.",
    });
  });

  it("returns an extraction failure for bytes that are not a DOCX", async () => {
    const r = await extractContract({ buffer: Buffer.from("not a zip"), filename: "c.docx" });
    expect(r.ok).toBe(false);
  });

  it("extracts contract_text with Word's automatic clause numbers and contract_html from mammoth", async () => {
    const r = await extractContract({ buffer: await minimalNumberedDocx(), filename: "pks.docx" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.contract_text).toBe("1. Liability\n1.1. Dash shall only be liable for claims.\nSigned by the Parties.");
    expect(r.data.contract_html).toContain("Dash shall only be liable for claims.");
    expect(r.data.filename).toBe("pks.docx");
  });
});

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function minimalNumberedDocx(): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
      `</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
      `</Relationships>`,
  );
  zip.file(
    "word/numbering.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W_NS}>` +
      `<w:abstractNum w:abstractNumId="0">` +
      `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>` +
      `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2."/></w:lvl>` +
      `</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
  );
  const numbered = (text: string, ilvl: number) =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body>` +
      numbered("Liability", 0) +
      numbered("Dash shall only be liable for claims.", 1) +
      `<w:p><w:r><w:t>Signed by the Parties.</w:t></w:r></w:p>` +
      `</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("getReviewStatus", () => {
  it("maps a missing row to not_found", async () => {
    const fake = scriptedDb([{ table: "reviews", data: null }]);
    const r = await getReviewStatus(fake.db as unknown as Db, "missing");
    expect(r).toMatchObject({ ok: false, kind: "not_found" });
  });
});

describe("deleteReview", () => {
  it("deletes by id (the route has already checked container.delete)", async () => {
    const fake = scriptedDb([{ table: "reviews", op: "delete", data: null }]);
    const r = await deleteReview(fake.db as unknown as Db, { reviewId: "r1" });
    expect(r).toMatchObject({ ok: true });
    expect(fake.calls[0].filters).toEqual([["eq", "id", "r1"]]);
    fake.done();
  });
});

describe("getReviewDetail", () => {
  it("maps a missing review to not_found without loading feedback or comments", async () => {
    const fake = scriptedDb([{ table: "reviews", data: null }]);
    const r = await getReviewDetail(fake.db as unknown as Db, "missing");
    expect(r).toMatchObject({ ok: false, kind: "not_found" });
    expect(fake.calls.map((c) => c.table)).toEqual(["reviews"]);
  });

  it("returns the row with its feedback and comments scoped to the review", async () => {
    const fake = scriptedDb([
      { table: "reviews", data: { id: "r1", title: "PKS — A", ai_output: { risk_level: "HIGH" } } },
      { table: "review_feedback", data: [{ id: "f1", finding_type: "red_flag", finding_id: "RF-001", action: "valid" }] },
      { table: "manual_comments", data: [{ id: "c1", comment_text: "note" }] },
      { table: "review_revision_edits", data: [{ id: "e1", revision_id: "REV-001" }] },
      { table: "negotiation_points", data: [] },
      { table: "review_suggestions", data: [] },
    ]);
    const r = await getReviewDetail(fake.db as unknown as Db, "r1");
    expect(r).toMatchObject({
      ok: true,
      data: { review: { id: "r1" }, feedback: [{ finding_id: "RF-001" }], comments: [{ id: "c1" }], revisionEdits: [{ revision_id: "REV-001" }] },
    });
    expect(fake.calls[1].filters).toContainEqual(["eq", "review_id", "r1"]);
    expect(fake.calls[2].filters).toContainEqual(["eq", "review_id", "r1"]);
  });

  it("presents a review whose DOCX object is missing from storage as HTML-only", async () => {
    storageMocks.headFile.mockResolvedValueOnce(null);
    const fake = scriptedDb([
      { table: "reviews", data: { id: "r1", contract_docx_path: "fcc26ed8/legacy.docx", contract_redline_path: "fcc26ed8/redline.docx", ai_output: {} } },
      { table: "review_feedback", data: [] },
      { table: "manual_comments", data: [] },
      { table: "review_revision_edits", data: [] },
      { table: "negotiation_points", data: [] },
      { table: "review_suggestions", data: [] },
    ]);
    const r = await getReviewDetail(fake.db as unknown as Db, "r1");
    expect(r).toMatchObject({ ok: true, data: { review: { contract_docx_path: null, contract_redline_path: null } } });
    expect(storageMocks.headFile).toHaveBeenCalledWith("fcc26ed8/legacy.docx");
  });

  it("keeps the DOCX paths when the object exists", async () => {
    storageMocks.headFile.mockResolvedValueOnce({ size: 5, etag: null, contentType: null });
    const fake = scriptedDb([
      { table: "reviews", data: { id: "r1", contract_docx_path: "contracts/r1/original.docx", contract_redline_path: null, ai_output: {} } },
      { table: "review_feedback", data: [] },
      { table: "manual_comments", data: [] },
      { table: "review_revision_edits", data: [] },
      { table: "negotiation_points", data: [] },
      { table: "review_suggestions", data: [] },
    ]);
    const r = await getReviewDetail(fake.db as unknown as Db, "r1");
    expect(r).toMatchObject({ ok: true, data: { review: { contract_docx_path: "contracts/r1/original.docx" } } });
  });
});
