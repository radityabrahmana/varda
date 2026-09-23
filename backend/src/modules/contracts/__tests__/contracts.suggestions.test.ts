import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

// Uses the REAL OOXML library on a small DOCX; storage is an in-memory map.
const files = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  storageEnabled: true,
  downloadFile: vi.fn(async (key: string) => {
    const f = files.get(key);
    return f ? (f.slice().buffer as ArrayBuffer) : null;
  }),
  uploadFile: vi.fn(async (key: string, body: ArrayBuffer) => {
    files.set(key, new Uint8Array(body));
  }),
}));

import { extractDocxBodyText, extractTrackedChangeIds } from "../../../lib/docxTrackedChanges";
import {
  createSuggestion,
  listTrackedChangeIds,
  parseSuggestionBody,
  resolveSuggestion,
  type SuggestionInput,
} from "../contracts.service";

const ORIGINAL = "contracts/r1/original.docx";
const REDLINE = "contracts/r1/redline.docx";

async function docx(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

const docText = async (key: string) => extractDocxBodyText(Buffer.from(files.get(key)!));
const input = (over: Partial<SuggestionInput> = {}): SuggestionInput => ({
  selected_text: "30 hari",
  replacement: "14 hari",
  context_before: "Pembayaran dilakukan dalam ",
  context_after: " setelah invoice diterima.",
  note: "Sesuai standar Dash.",
  ...over,
});
const REVIEW_ROW = { id: "r1", contract_docx_path: ORIGINAL, contract_redline_path: null };
const saved = (payload: unknown) => ({ id: "s1", status: "pending", ...(payload as object) });

beforeEach(async () => {
  files.clear();
  files.set(ORIGINAL, await docx(["Pembayaran dilakukan dalam 30 hari setelah invoice diterima.", "Denda keterlambatan 2% per bulan."]));
});

describe("parseSuggestionBody", () => {
  it("requires a selection and a different replacement, trims context to the nearest characters", () => {
    expect(parseSuggestionBody({ selected_text: " ", replacement: "x" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseSuggestionBody({ selected_text: "a", replacement: "a" })).toMatchObject({ ok: false, kind: "validation" });
    const r = parseSuggestionBody({ selected_text: "a", replacement: "", context_before: "x".repeat(500) + "END", note: "  " });
    expect(r).toMatchObject({ ok: true, data: { replacement: "", note: null } });
    if (r.ok) expect(r.data.context_before.endsWith("END")).toBe(true);
    if (r.ok) expect(r.data.context_before.length).toBe(400);
  });
});

describe("createSuggestion", () => {
  it("writes a tracked change under the author's name into a new working redline and records it", async () => {
    const fake = scriptedDb([
      { table: "reviews", data: REVIEW_ROW },
      { table: "user_profiles", data: { display_name: "Robert" } },
      { table: "reviews", op: "update", data: null },
      { table: "review_suggestions", op: "insert", data: saved({}) },
    ]);
    const r = await createSuggestion(fake.db, { reviewId: "r1", userId: "u-robert", userEmail: "robert@dashelectric.co", input: input() });
    expect(r.ok).toBe(true);
    fake.done();

    // Suggestion, not an edit: the upload is untouched, and the working copy
    // keeps the original words as deleted-text markup next to the insertion
    // until someone decides.
    expect(await docText(ORIGINAL)).toContain("30 hari");
    const xml = await (await JSZip.loadAsync(files.get(REDLINE)!)).file("word/document.xml")!.async("string");
    expect(xml).toMatch(/<w:del [^>]*w:author="Robert"/);
    expect(xml).toMatch(/<w:ins [^>]*w:author="Robert"/);
    expect(xml).toMatch(/<w:delText[^>]*>30<\/w:delText>/);
    expect(fake.calls[2].payload).toEqual({ contract_redline_path: REDLINE });
    expect(fake.calls[3].payload).toMatchObject({
      review_id: "r1",
      author_user_id: "u-robert",
      author_name: "Robert",
      original_text: "30",
      suggested_text: "14",
      note: "Sesuai standar Dash.",
      status: "pending",
    });
    const ids = await extractTrackedChangeIds(Buffer.from(files.get(REDLINE)!));
    expect(ids.map((i) => i.kind).sort()).toEqual(["del", "ins"]);
  });

  it("falls back to the email local part as author and records a pure insertion as a lone w:ins", async () => {
    files.set(REDLINE, files.get(ORIGINAL)!);
    const fake = scriptedDb([
      { table: "reviews", data: { ...REVIEW_ROW, contract_redline_path: REDLINE } },
      { table: "user_profiles", data: null },
      { table: "review_suggestions", op: "insert", data: saved({}) },
    ]);
    const r = await createSuggestion(fake.db, {
      reviewId: "r1",
      userId: "u1",
      userEmail: "donnie@dashelectric.co",
      input: input({ replacement: "30 hari kalender", context_after: " setelah invoice diterima." }),
    });
    expect(r.ok).toBe(true);
    expect(fake.calls[2].payload).toMatchObject({ author_name: "donnie", original_text: "", suggested_text: " kalender", del_w_id: null });
  });

  it("refuses text it cannot find exactly and leaves the document alone", async () => {
    const fake = scriptedDb([
      { table: "reviews", data: REVIEW_ROW },
      { table: "user_profiles", data: null },
    ]);
    const r = await createSuggestion(fake.db, {
      reviewId: "r1",
      userId: "u1",
      input: input({ selected_text: "60 hari", context_before: "", context_after: "" }),
    });
    expect(r).toMatchObject({ ok: false, kind: "conflict" });
    expect(files.has(REDLINE)).toBe(false);
  });

  it("refuses a suggestion on top of another pending change instead of silently accepting it", async () => {
    // First suggestion on "30 hari".
    await createSuggestion(
      scriptedDb([
        { table: "reviews", data: REVIEW_ROW },
        { table: "user_profiles", data: null },
        { table: "reviews", op: "update", data: null },
        { table: "review_suggestions", op: "insert", data: saved({}) },
      ]).db,
      { reviewId: "r1", userId: "u1", input: input() },
    );
    const before = Buffer.from(files.get(REDLINE)!);
    // Second one selects the (accepted-view) inserted text "14 hari".
    const fake = scriptedDb([
      { table: "reviews", data: { ...REVIEW_ROW, contract_redline_path: REDLINE } },
      { table: "user_profiles", data: null },
    ]);
    const r = await createSuggestion(fake.db, {
      reviewId: "r1",
      userId: "u2",
      input: input({ selected_text: "14 hari", replacement: "7 hari" }),
    });
    expect(r).toMatchObject({ ok: false, kind: "conflict" });
    expect(Buffer.from(files.get(REDLINE)!).equals(before)).toBe(true);
  });

  it("needs the original DOCX", async () => {
    const fake = scriptedDb([{ table: "reviews", data: { ...REVIEW_ROW, contract_docx_path: null } }]);
    expect(await createSuggestion(fake.db, { reviewId: "r1", userId: "u1", input: input() })).toMatchObject({ ok: false, kind: "validation" });
  });
});

async function suggestOnce(): Promise<{ del_w_id: string | null; ins_w_id: string | null }> {
  const fake = scriptedDb([
    { table: "reviews", data: REVIEW_ROW },
    { table: "user_profiles", data: null },
    { table: "reviews", op: "update", data: null },
    { table: "review_suggestions", op: "insert", data: saved({}) },
  ]);
  await createSuggestion(fake.db, { reviewId: "r1", userId: "u1", input: input() });
  return fake.calls[3].payload as { del_w_id: string | null; ins_w_id: string | null };
}

describe("createSuggestion — whole words", () => {
  it("records ~~11~~ 12 for a date change, not a one-letter splice", async () => {
    files.set(ORIGINAL, await docx(["Perjanjian ini dibuat pada 11 June 2026."]));
    const fake = scriptedDb([
      { table: "reviews", data: REVIEW_ROW },
      { table: "user_profiles", data: null },
      { table: "reviews", op: "update", data: null },
      { table: "review_suggestions", op: "insert", data: saved({}) },
    ]);
    const r = await createSuggestion(fake.db, {
      reviewId: "r1",
      userId: "u1",
      input: input({ selected_text: "11 June 2026", replacement: "12 June 2026", context_before: "Perjanjian ini dibuat pada ", context_after: "." }),
    });
    expect(r.ok).toBe(true);
    expect(fake.calls[3].payload).toMatchObject({ original_text: "11", suggested_text: "12" });
  });
});

describe("resolveSuggestion", () => {
  it("Accept replaces the text; Reject restores the original", async () => {
    for (const [mode, expected, gone] of [
      ["accept", "14 hari", "30 hari"],
      ["reject", "30 hari", "14 hari"],
    ] as const) {
      files.delete(REDLINE);
      const ids = await suggestOnce();
      const fake = scriptedDb([
        { table: "review_suggestions", data: { id: "s1", review_id: "r1", status: "pending", ...ids } },
        { table: "reviews", data: { ...REVIEW_ROW, contract_redline_path: REDLINE } },
        { table: "review_suggestions", op: "update", data: { id: "s1", status: mode === "accept" ? "accepted" : "rejected" } },
      ]);
      const r = await resolveSuggestion(fake.db, { reviewId: "r1", suggestionId: "s1", mode, userId: "u-owner" });
      expect(r.ok).toBe(true);
      const text = await docText(REDLINE);
      expect(text).toContain(expected);
      expect(text).not.toContain(gone);
      expect(await extractTrackedChangeIds(Buffer.from(files.get(REDLINE)!))).toEqual([]);
      expect(fake.calls[0].filters).toEqual([
        ["eq", "id", "s1"],
        ["eq", "review_id", "r1"],
      ]);
      expect(fake.calls[2].payload).toMatchObject({ resolved_by: "u-owner" });
    }
  });

  it("refuses to resolve twice and scopes the lookup to the review", async () => {
    const decided = scriptedDb([{ table: "review_suggestions", data: { id: "s1", review_id: "r1", status: "accepted" } }]);
    expect(await resolveSuggestion(decided.db, { reviewId: "r1", suggestionId: "s1", mode: "reject", userId: "u1" })).toMatchObject({
      ok: false,
      kind: "conflict",
    });
    const other = scriptedDb([{ table: "review_suggestions", data: null }]);
    expect(await resolveSuggestion(other.db, { reviewId: "r2", suggestionId: "s1", mode: "accept", userId: "u1" })).toMatchObject({
      ok: false,
      kind: "not_found",
    });
  });
});

describe("listTrackedChangeIds", () => {
  it("reads ids from the working redline, or returns none without a DOCX", async () => {
    await suggestOnce();
    const r = await listTrackedChangeIds(scriptedDb([{ table: "reviews", data: { contract_docx_path: ORIGINAL, contract_redline_path: REDLINE } }]).db, "r1");
    expect(r.ok && r.data.ids.length).toBe(2);
    const none = await listTrackedChangeIds(scriptedDb([{ table: "reviews", data: { contract_docx_path: null, contract_redline_path: null } }]).db, "r1");
    expect(none).toEqual({ ok: true, data: { ids: [] } });
  });
});

describe("withReviewDocLock", () => {
  it("serializes concurrent suggestions on one review so neither write is lost", async () => {
    files.set(REDLINE, files.get(ORIGINAL)!);
    const row = { ...REVIEW_ROW, contract_redline_path: REDLINE };
    const a = scriptedDb([
      { table: "reviews", data: row },
      { table: "user_profiles", data: null },
      { table: "review_suggestions", op: "insert", data: saved({}) },
    ]);
    const b = scriptedDb([
      { table: "reviews", data: row },
      { table: "user_profiles", data: null },
      { table: "review_suggestions", op: "insert", data: saved({}) },
    ]);
    const [ra, rb] = await Promise.all([
      createSuggestion(a.db, { reviewId: "r1", userId: "u1", input: input() }),
      createSuggestion(b.db, {
        reviewId: "r1",
        userId: "u2",
        input: input({ selected_text: "2%", replacement: "1%", context_before: "Denda keterlambatan ", context_after: " per bulan." }),
      }),
    ]);
    expect(ra.ok && rb.ok).toBe(true);
    const ids = await extractTrackedChangeIds(Buffer.from(files.get(REDLINE)!));
    expect(ids).toHaveLength(4);
  });
});

// Keep the Db import used for type-only helpers in future tests.
export type { Db };
