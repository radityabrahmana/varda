import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import {
  detectRegulationMention,
  NODE_PAGE_SIZE,
  parseRegulationSelector,
  readRegulation,
  resolveRegulationRef,
  searchRegulationLibrary,
} from "../regulations.service";
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

describe("detectRegulationMention", () => {
  it("spots a short name however it is typed and strips it from the query", () => {
    expect(detectRegulationMention(ROWS, "Pasal 1266 KUHPerdata")).toMatchObject({ regulation: { id: KUH }, rest: "Pasal 1266" });
    expect(detectRegulationMention(ROWS, "wanprestasi menurut kuh perdata")).toMatchObject({ regulation: { id: KUH }, rest: "wanprestasi menurut" });
    expect(detectRegulationMention(ROWS, "izin angkutan pm 60 2019")).toMatchObject({ regulation: { id: PM60 }, rest: "izin angkutan" });
    expect(detectRegulationMention(ROWS, "pembatalan perjanjian")).toBeNull();
    // A name inside a longer token is not a mention.
    expect(detectRegulationMention(ROWS, "xkuhperdatax")).toBeNull();
  });
});

const SEARCH_ROW = { node_id: 1, regulation_id: KUH, node_type: "pasal", number: "1266", heading: "Pasal 1266", context: "BUKU KETIGA › BAB IV", snippet: "Syarat yang <b>membatalkan</b>…", rank: 0.9, short_name: "KUHPerdata", title: "Kitab Undang-Undang Hukum Perdata", status: "berlaku", regulation_type: "KUHPERDATA", issuer: null };

describe("searchRegulationLibrary", () => {
  it("runs the ranked search RPC in the caller's scope and attaches citations and the catalog", async () => {
    const fake = scriptedDb([
      { table: "regulations", data: ROWS },
      { rpc: "search_regulation_nodes", data: [SEARCH_ROW] },
    ]);
    const r = await searchRegulationLibrary(fake.db, scope, { query: "syarat batal", limit: 99 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ match: "all", regulation_filter: null });
    expect(r.data.hits[0]).toMatchObject({ citation: "Pasal 1266 KUHPerdata", regulation: { short_name: "KUHPerdata", status: "berlaku" } });
    expect(Array.isArray(r.data.library) && r.data.library.map((l) => l.short_name)).toEqual(["KUHPerdata", "PM 60/2019"]);
    const rpcCall = fake.calls.find((c) => c.op === "rpc");
    expect(rpcCall?.args).toEqual({ p_org_ids: [ORG_A], p_query: "syarat batal", p_regulation_id: null, p_limit: 30 });
    fake.done();
  });

  it("answers an exact citation directly from the named regulation", async () => {
    const fake = scriptedDb([
      { table: "regulations", data: ROWS },
      { table: "regulation_nodes", data: { id: 7, regulation_id: KUH, node_type: "pasal", number: "1266", heading: "Pasal 1266", context: "BUKU KETIGA", content: "Syarat batal dianggap selalu dicantumkan." } },
    ]);
    const r = await searchRegulationLibrary(fake.db, scope, { query: "Pasal 1266 KUHPerdata" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ match: "citation", regulation_filter: "KUHPerdata" });
    expect(r.data.hits).toHaveLength(1);
    expect(r.data.hits[0]).toMatchObject({ citation: "Pasal 1266 KUHPerdata", snippet: "Syarat batal dianggap selalu dicantumkan." });
    expect(fake.calls[1].filters).toEqual(expect.arrayContaining([["eq", "regulation_id", KUH], ["eq", "number", "1266"]]));
    fake.done();
  });

  it("falls back to any-word matching, narrowed to the regulation the query names", async () => {
    const fake = scriptedDb([
      { table: "regulations", data: ROWS },
      { rpc: "search_regulation_nodes", data: [] },
      { rpc: "search_regulation_nodes", data: [SEARCH_ROW] },
    ]);
    const r = await searchRegulationLibrary(fake.db, scope, { query: "pembatalan perjanjian wanprestasi KUHPerdata" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ match: "any", regulation_filter: "KUHPerdata" });
    const rpcs = fake.calls.filter((c) => c.op === "rpc").map((c) => c.args as { p_query: string; p_regulation_id: string });
    expect(rpcs[0]).toMatchObject({ p_query: "pembatalan perjanjian wanprestasi", p_regulation_id: KUH });
    expect(rpcs[1]).toMatchObject({ p_query: "pembatalan or perjanjian or wanprestasi", p_regulation_id: KUH });
    fake.done();
  });

  it("reports no match without a second query for a single word", async () => {
    const fake = scriptedDb([
      { table: "regulations", data: ROWS },
      { rpc: "search_regulation_nodes", data: [] },
    ]);
    const r = await searchRegulationLibrary(fake.db, scope, { query: "wanprestasi" });
    expect(r).toMatchObject({ ok: true, data: { match: "none", hits: [] } });
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
      { node_type: "buku", number: "KETIGA", heading: "PERIKATAN", context: null, pasal_from: "1266", pasal_to: "1268" },
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

  it("pages node metadata past the API row cap", async () => {
    // Articles 1..1200 in two pages; article 1100 lives on the second page.
    const all = Array.from({ length: 1200 }, (_, i) => ({ id: 1000 + i, node_type: "pasal", number: String(i + 1), heading: `Pasal ${i + 1}`, context: null, sort_order: i }));
    const fake = scriptedDb([
      { table: "regulations", data: ROWS },
      { table: "regulation_nodes", data: all.slice(0, NODE_PAGE_SIZE) },
      { table: "regulation_nodes", data: all.slice(NODE_PAGE_SIZE) },
      { table: "regulation_nodes", data: [{ ...all[1099], regulation_id: KUH, content: "Isi Pasal 1100." }] },
    ]);
    const r = await readRegulation(fake.db, scope, { regulation: "KUHPerdata", selector: "pasal 1100" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.missing).toEqual([]);
    expect(r.data.sections.map((s) => s.citation)).toEqual(["Pasal 1100 KUHPerdata"]);
    expect(fake.calls[1].filters).toContainEqual(["range", 0, 999]);
    expect(fake.calls[2].filters).toContainEqual(["range", 1000, 1999]);
    fake.done();
  });

  it("gives a chapter the articles of its sections in the outline", async () => {
    const meta = [
      { id: 1, node_type: "bab", number: "I", heading: "KETENTUAN UMUM", context: null, sort_order: 0 },
      { id: 2, node_type: "pasal", number: "1", heading: "Pasal 1", context: null, sort_order: 1 },
      { id: 3, node_type: "bab", number: "II", heading: "ANGKUTAN BARANG", context: null, sort_order: 2 },
      { id: 4, node_type: "bagian", number: "Kesatu", heading: "Umum", context: null, sort_order: 3 },
      { id: 5, node_type: "pasal", number: "2", heading: "Pasal 2", context: null, sort_order: 4 },
      { id: 6, node_type: "bagian", number: "Kedua", heading: "Khusus", context: null, sort_order: 5 },
      { id: 7, node_type: "pasal", number: "3", heading: "Pasal 3", context: null, sort_order: 6 },
    ];
    const fake = scriptedDb([
      { table: "regulations", data: ROWS },
      { table: "regulation_nodes", data: meta },
    ]);
    const r = await readRegulation(fake.db, scope, { regulation: "PM 60/2019", selector: "outline" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.outline?.map((o) => `${o.node_type} ${o.number}: ${o.pasal_from}-${o.pasal_to}`)).toEqual([
      "bab I: 1-1",
      "bab II: 2-3",
      "bagian Kesatu: 2-2",
      "bagian Kedua: 3-3",
    ]);
    fake.done();
  });

  it("explains an unknown selector", async () => {
    const fake = scriptedDb([{ table: "regulations", data: ROWS }]);
    const r = await readRegulation(fake.db, scope, { regulation: "KUHPerdata", selector: "halaman 3" });
    expect(r).toMatchObject({ ok: false, kind: "validation" });
    fake.done();
  });
});
