import { describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { ok } from "../../../lib/serviceResult";
import {
  attachRegulationFile,
  extractRegulationText,
  parseRegulationMetaBody,
  parseRegulationPatchBody,
  regulationFileKey,
  type IngestDeps,
} from "../regulations.service";
import type { RegulationRow, RegulationScope } from "../regulations.types";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const adminScope: RegulationScope = { userId: USER, orgIds: [ORG_A], adminOrgIds: [ORG_A], platformAdmin: false };

const row = (over: Partial<RegulationRow> = {}): RegulationRow => ({
  id: REG,
  org_id: ORG_A,
  created_by: USER,
  regulation_type: "KUHPERDATA",
  issuer: null,
  number: null,
  year: 1847,
  title: "Kitab Undang-Undang Hukum Perdata",
  short_name: "KUHPerdata",
  status: "berlaku",
  source_url: null,
  notes: null,
  file_key: null,
  file_name: null,
  content_sha256: null,
  parse_status: "empty",
  node_count: 0,
  pasal_count: 0,
  parse_warnings: [],
  created_at: "2026-09-24T00:00:00Z",
  updated_at: "2026-09-24T00:00:00Z",
  ...over,
});

describe("parseRegulationMetaBody", () => {
  it("normalises a valid body", () => {
    const r = parseRegulationMetaBody({ title: " KUH Perdata ", short_name: "KUHPerdata", regulation_type: "kuhperdata", year: "1847", status: "berlaku" });
    expect(r).toEqual({
      ok: true,
      data: {
        scope: "org",
        org_id: undefined,
        regulation_type: "KUHPERDATA",
        issuer: null,
        number: null,
        year: 1847,
        title: "KUH Perdata",
        short_name: "KUHPerdata",
        status: "berlaku",
        source_url: null,
        notes: null,
      },
    });
  });

  it("rejects missing or malformed fields", () => {
    expect(parseRegulationMetaBody({ short_name: "x", regulation_type: "UU" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseRegulationMetaBody({ title: "t", short_name: "x", regulation_type: "UU", year: "abc" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseRegulationMetaBody({ title: "t", short_name: "x", regulation_type: "UU", status: "berlaku sekali" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseRegulationMetaBody({ title: "t", short_name: "x", regulation_type: "UU", org_id: "nope" })).toMatchObject({ ok: false, kind: "validation" });
  });

  it("parses a patch and refuses an empty one", () => {
    expect(parseRegulationPatchBody({ status: "dicabut", notes: "diganti PM 12/2024" })).toEqual({
      ok: true,
      data: { status: "dicabut", notes: "diganti PM 12/2024" },
    });
    expect(parseRegulationPatchBody({})).toMatchObject({ ok: false, kind: "validation" });
    expect(parseRegulationPatchBody({ title: "  " })).toMatchObject({ ok: false, kind: "validation" });
  });
});

describe("extractRegulationText", () => {
  it("reads plain text and refuses unknown formats and empty files", async () => {
    expect(await extractRegulationText({ buffer: Buffer.from("Pasal 1\nIsi."), filename: "se.txt" })).toEqual({ ok: true, data: "Pasal 1\nIsi." });
    expect(await extractRegulationText({ buffer: Buffer.from("x"), filename: "scan.jpg" })).toMatchObject({ ok: false, kind: "validation" });
    expect(await extractRegulationText({ buffer: Buffer.alloc(0), filename: "a.pdf" })).toMatchObject({ ok: false, kind: "validation" });
  });

  it("derives a stable storage key from the id and extension", () => {
    expect(regulationFileKey(REG, "KUHPerdata (2019).PDF")).toBe(`regulations/${REG}/source.pdf`);
    expect(regulationFileKey(REG, "noext")).toBe(`regulations/${REG}/source.bin`);
  });
});

describe("attachRegulationFile", () => {
  const TEXT = "BAB I\nUMUM\nPasal 1\nSatu.\nPasal 2\nDua.";

  function deps(over: Partial<IngestDeps> = {}): IngestDeps {
    return {
      extractText: vi.fn(async () => ok(TEXT)),
      storeOriginal: vi.fn(async (key: string) => key),
      fetchOriginal: vi.fn(async () => null),
      ...over,
    };
  }

  it("replaces the nodes, stores the original and records parse results", async () => {
    const fake = scriptedDb([
      { table: "regulations", data: row() },
      { table: "regulation_nodes", op: "delete", data: null },
      { table: "regulation_nodes", op: "insert", data: null },
      { table: "regulations", op: "update", data: row({ parse_status: "parsed", node_count: 3, pasal_count: 2, file_key: `regulations/${REG}/source.txt` }) },
    ]);
    const d = deps();
    const result = await attachRegulationFile(fake.db, adminScope, REG, { buffer: Buffer.from(TEXT), filename: "permen.txt" }, d);
    expect(result).toMatchObject({ ok: true, data: { parse_status: "parsed", pasal_count: 2 } });
    expect(d.storeOriginal).toHaveBeenCalledWith(`regulations/${REG}/source.txt`, expect.anything());
    const insert = fake.calls.find((c) => c.table === "regulation_nodes" && c.op === "insert");
    const rows = insert?.payload as { node_type: string; number: string | null; regulation_id: string }[];
    expect(rows.map((r) => `${r.node_type}:${r.number}`)).toEqual(["bab:I", "pasal:1", "pasal:2"]);
    expect(rows.every((r) => r.regulation_id === REG)).toBe(true);
    const update = fake.calls.find((c) => c.table === "regulations" && c.op === "update");
    expect(update?.payload).toMatchObject({ parse_status: "parsed", node_count: 3, pasal_count: 2, file_name: "permen.txt" });
    expect((update?.payload as { content_sha256: string }).content_sha256).toMatch(/^[0-9a-f]{64}$/);
    fake.done();
  });

  it("refuses members who cannot manage the org, without touching nodes", async () => {
    const fake = scriptedDb([{ table: "regulations", data: row() }]);
    const member: RegulationScope = { ...adminScope, adminOrgIds: [] };
    const result = await attachRegulationFile(fake.db, member, REG, { buffer: Buffer.from(TEXT), filename: "x.txt" }, deps());
    expect(result).toMatchObject({ ok: false, kind: "forbidden" });
    fake.done();
  });

  it("hides regulations of other organizations", async () => {
    const fake = scriptedDb([{ table: "regulations", data: row({ org_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }) }]);
    const result = await attachRegulationFile(fake.db, adminScope, REG, { buffer: Buffer.from(TEXT), filename: "x.txt" }, deps());
    expect(result).toMatchObject({ ok: false, kind: "not_found" });
    fake.done();
  });

  it("still parses when the object store is unavailable", async () => {
    const fake = scriptedDb([
      { table: "regulations", data: row() },
      { table: "regulation_nodes", op: "delete", data: null },
      { table: "regulation_nodes", op: "insert", data: null },
      { table: "regulations", op: "update", data: row({ parse_status: "parsed" }) },
    ]);
    const d = deps({ storeOriginal: vi.fn(async () => { throw new Error("no bucket"); }) });
    const result = await attachRegulationFile(fake.db, adminScope, REG, { buffer: Buffer.from(TEXT), filename: "x.txt" }, d);
    expect(result.ok).toBe(true);
    const update = fake.calls.find((c) => c.table === "regulations" && c.op === "update");
    expect((update?.payload as { file_key: string | null }).file_key).toBeNull();
    fake.done();
  });
});
