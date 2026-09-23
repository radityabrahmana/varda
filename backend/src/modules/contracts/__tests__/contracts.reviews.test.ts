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
});

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
