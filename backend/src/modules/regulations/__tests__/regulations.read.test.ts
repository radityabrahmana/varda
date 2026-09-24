import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { parseRegulationSelector, readRegulation, resolveRegulationRef, searchRegulationLibrary } from "../regulations.service";
import type { RegulationRow, RegulationScope } from "../regulations.types";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KUH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PM60 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const scope: RegulationScope = { userId: USER, orgIds: [ORG_A], adminOrgIds: [], platformAdmin: false };

const base = (over: Partial<RegulationRow>): RegulationRow => ({
  id: KUH,
  org_id: null,
  created_by: null,
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
  parse_status: "parsed",
  node_count: 5,
  pasal_count: 3,
  parse_warnings: [],
  created_at: "",
  updated_at: "",
  ...over,
});
const ROWS = [
  base({}),
  base({ id: PM60, org_id: ORG_A, regulation_type: "PERMEN", issuer: "Kementerian Perhubungan", number: "PM 60", year: 2019, title: "Penyelenggaraan Angkutan Barang dengan Kendaraan Bermotor di Jalan", short_name: "PM 60/2019" }),
];

describe("parseRegulationSelector", () => {
  it("understands articles, ranges, lists, chapters, elucidation, preamble and outline", () => {
    expect(parseRegulationSelector("pasal 1266")).toEqual({ kind: "pasal", numbers: ["1266"], ranges: [] });
    expect(parseRegulationSelector("Pasal 1266-1267")).toEqual({ kind: "pasal", numbers: [], ranges: [[1266, 1267]] });
    expect(parseRegulationSelector("pasal 5, 7-9, 12a")).toEqual({ kind: "pasal", numbers: ["5", "12A"], ranges: [[7, 9]] });
    expect(parseRegulationSelector("pasal 5 s.d. 9")).toEqual({ kind: "pasal", numbers: [], ranges: [[5, 9]] });
    expect(parseRegulationSelector("1266")).toEqual({ kind: "pasal", numbers: ["1266"], ranges: [] });
    expect(parseRegulationSelector("bab iii")).toEqual({ kind: "bab", number: "III" });
    expect(parseRegulationSelector("penjelasan pasal 5")).toEqual({ kind: "penjelasan", numbers: ["5"] });
    expect(parseRegulationSelector("penjelasan umum")).toEqual({ kind: "penjelasan", numbers: ["UMUM"] });
    expect(parseRegulationSelector("penjelasan")).toEqual({ kind: "penjelasan", numbers: null });
    expect(parseRegulationSelector("menimbang")).toEqual({ kind: "preamble" });
    expect(parseRegulationSelector("outline")).toEqual({ kind: "outline" });
    expect(parseRegulationSelector("all")).toEqual({ kind: "all" });
  });

  it("rejects nonsense and inverted ranges", () => {
    expect(parseRegulationSelector("")).toBeNull();
    expect(parseRegulationSelector("pasal sembilan")).toBeNull();
    expect(parseRegulationSelector("pasal 9-5")).toBeNull();
  });
});

describe("resolveRegulationRef", () => {
  it("matches id, exact short name, and loose spellings", async () => {
    for (const [ref, expectedId] of [[KUH, KUH], ["KUHPerdata", KUH], ["kuh perdata", KUH], ["PM 60 2019", PM60], ["pm 60/2019", PM60], ["angkutan barang", PM60]] as const) {
      const fake = scriptedDb([{ table: "regulations", data: ROWS }]);
      const r = await resolveRegulationRef(fake.db, scope, ref);
      expect(r.ok, ref).toBe(true);
      if (r.ok) expect(r.data.regulation.id).toBe(expectedId);
    }
  });

  it("reports candidates when nothing or several things match", async () => {
    const fake = scriptedDb([{ table: "regulations", data: ROWS }]);
    const r = await resolveRegulationRef(fake.db, scope, "UU Cipta Kerja");
    expect(r).toMatchObject({ ok: false, kind: "not_found" });
    if (!r.ok && r.kind !== "error") expect(JSON.parse(r.code ?? "[]")).toHaveLength(2);
  });
});

describe("searchRegulationLibrary", () => {
  it("runs the ranked search RPC in the caller's scope and attaches citations and the catalog", async () => {
    const fake = scriptedDb([
      {
        rpc: "search_regulation_nodes",
        data: [
          { node_id: 1, regulation_id: KUH, node_type: "pasal", number: "1266", heading: "Pasal 1266", context: "BUKU KETIGA › BAB IV", snippet: "Syarat yang <b>membatalkan</b>…", rank: 0.9, short_name: "KUHPerdata", title: "Kitab Undang-Undang Hukum Perdata", status: "berlaku", regulation_type: "KUHPERDATA", issuer: null },
        ],
      },
      { table: "regulations", data: ROWS },
    ]);
    const r = await searchRegulationLibrary(fake.db, scope, { query: "syarat batal", limit: 99 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.hits[0]).toMatchObject({ citation: "Pasal 1266 KUHPerdata", regulation: { short_name: "KUHPerdata", status: "berlaku" } });
    expect(Array.isArray(r.data.library) && r.data.library.map((l) => l.short_name)).toEqual(["KUHPerdata", "PM 60/2019"]);
    const rpcCall = fake.calls.find((c) => c.op === "rpc");
    expect(rpcCall?.args).toEqual({ p_org_ids: [ORG_A], p_query: "syarat batal", p_regulation_id: null, p_limit: 30 });
    fake.done();
  });

  it("requires a query", async () => {
    const fake = scriptedDb([]);
    expect(await searchRegulationLibrary(fake.db, scope, { query: "  " })).toMatchObject({ ok: false, kind: "validation" });
  });
});

describe("readRegulation", () => {
  const META = [
    { id: 10, node_type: "buku", number: "KETIGA", heading: "PERIKATAN", context: null, sort_order: 0 },
    { id: 11, node_type: "bab", number: "IV", heading: "HAPUSNYA PERIKATAN", context: "BUKU KETIGA PERIKATAN", sort_order: 1 },
    { id: 12, node_type: "pasal", number: "1266", heading: "Pasal 1266", context: "BUKU KETIGA PERIKATAN › BAB IV HAPUSNYA PERIKATAN", sort_order: 2 },
    { id: 13, node_type: "pasal", number: "1267", heading: "Pasal 1267", context: "BUKU KETIGA PERIKATAN › BAB IV HAPUSNYA PERIKATAN", sort_order: 3 },
    { id: 14, node_type: "pasal", number: "1268", heading: "Pasal 1268", context: null, sort_order: 4 },
  ];
  const content = (ids: number[]) => META.filter((m) => ids.includes(m.id)).map((m) => ({ ...m, regulation_id: KUH, content: `Isi ${m.heading}.` }));

  it("reads a range with citations and reports what was not found", async () => {
    const fake = scriptedDb([
      { table: "regulations", data: ROWS },
      { table: "regulation_nodes", data: META },
      { table: "regulation_nodes", data: content([12, 13]) },
    ]);
    const r = await readRegulation(fake.db, scope, { regulation: "KUHPerdata", selector: "pasal 1266-1267, 1300" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.sections.map((s) => s.citation)).toEqual(["Pasal 1266 KUHPerdata", "Pasal 1267 KUHPerdata"]);
    expect(r.data.sections[0].context).toContain("BAB IV");
    expect(r.data.missing).toEqual(["Pasal 1300"]);
    expect(r.data.truncated).toBe(false);
    const inFilter = fake.calls[2].filters.find((f) => f[0] === "in");
    expect(inFilter).toEqual(["in", "id", [12, 13]]);
    fake.done();
  });

  it("returns the outline with article ranges per heading", async () => {
    const fake = scriptedDb([
      { table: "regulations", data: ROWS },
      { table: "regulation_nodes", data: META },
    ]);
    const r = await readRegulation(fake.db, scope, { regulation: KUH, selector: "outline" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.outline).toEqual([
      { node_type: "buku", number: "KETIGA", heading: "PERIKATAN", context: null, pasal_from: null, pasal_to: null },
      { node_type: "bab", number: "IV", heading: "HAPUSNYA PERIKATAN", context: "BUKU KETIGA PERIKATAN", pasal_from: "1266", pasal_to: "1268" },
    ]);
    expect(r.data.note).toContain("3 pasal (Pasal 1266 – Pasal 1268)");
    fake.done();
  });

  it("reads a chapter and truncates to the character budget", async () => {
    const fake = scriptedDb([
      { table: "regulations", data: ROWS },
      { table: "regulation_nodes", data: META },
      { table: "regulation_nodes", data: content([12, 13, 14]).map((c) => ({ ...c, content: "x".repeat(700) })) },
    ]);
    const r = await readRegulation(fake.db, scope, { regulation: "KUHPerdata", selector: "bab IV", maxChars: 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.sections).toHaveLength(2);
    expect(r.data.sections[1].content.endsWith("…")).toBe(true);
    expect(r.data.truncated).toBe(true);
    expect(r.data.note).toContain("Dipotong");
    fake.done();
  });

  it("explains an unknown selector", async () => {
    const fake = scriptedDb([{ table: "regulations", data: ROWS }]);
    const r = await readRegulation(fake.db, scope, { regulation: "KUHPerdata", selector: "halaman 3" });
    expect(r).toMatchObject({ ok: false, kind: "validation" });
    fake.done();
  });
});
