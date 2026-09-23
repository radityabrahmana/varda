import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import {
  createPlaybookRule,
  listPlaybookRules,
  listPromptRules,
  normalizeRuleDocumentType,
  parseCreateRuleBody,
  parsePatchRuleBody,
  updatePlaybookRule,
} from "../playbook.rules";

const ROW = {
  id: "r1",
  rule_number: "RULE 1",
  title: "Liability cap",
  description: "≤ 10x delivery fee",
  thresholds: { max_multiple: 10 },
  severity: "CRITICAL",
  is_active: true,
  applies_to: null,
  created_at: "2026-09-21T00:00:00Z",
  updated_at: null,
};

describe("parseCreateRuleBody / parsePatchRuleBody", () => {
  it("applies defaults and rejects bad severities or empty patches", () => {
    const created = parseCreateRuleBody({ rule_number: " RULE 15 ", title: "T", description: "D" });
    expect(created).toEqual({ ok: true, data: { rule_number: "RULE 15", title: "T", description: "D", thresholds: {}, severity: "HIGH", is_active: true, applies_to: null } });
    expect(parseCreateRuleBody({ rule_number: "NDA 1", title: "T", description: "D", applies_to: ["NDA"] })).toMatchObject({ ok: true, data: { applies_to: ["NDA"] } });
    expect(parseCreateRuleBody({ rule_number: "NDA 1", title: "T", description: "D", applies_to: [] })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseCreateRuleBody({ rule_number: "NDA 1", title: "T", description: "D", applies_to: ["Kontrak"] })).toMatchObject({ ok: false, kind: "validation" });
    expect(parsePatchRuleBody({ applies_to: null })).toMatchObject({ ok: true, data: { applies_to: null } });
    expect(parseCreateRuleBody({ rule_number: "RULE 15", title: "T", description: "D", severity: "LOW" })).toMatchObject({ ok: false, kind: "validation" });
    expect(parseCreateRuleBody({ title: "T", description: "D" })).toMatchObject({ ok: false, kind: "validation", detail: expect.stringContaining("rule_number") });
    expect(parsePatchRuleBody({})).toMatchObject({ ok: false, kind: "validation" });
    expect(parsePatchRuleBody({ is_active: false })).toEqual({ ok: true, data: { is_active: false } });
    expect(parsePatchRuleBody({ thresholds: ["x"] })).toMatchObject({ ok: false, kind: "validation" });
  });
});

describe("listPlaybookRules / listPromptRules", () => {
  it("lists every rule ordered by rule_number", async () => {
    const { db, calls } = scriptedDb([{ table: "playbook_rules", data: [ROW] }]);
    expect(await listPlaybookRules(db)).toEqual({ ok: true, data: [ROW] });
    expect(calls[0].filters).toEqual([["order", "rule_number"]]);
  });

  it("prompt rules are the active subset with only the prompt fields requested", async () => {
    const { db, calls } = scriptedDb([{ table: "playbook_rules", data: [{ rule_number: "RULE 1", title: "t", description: "d", thresholds: {}, severity: "HIGH" }] }]);
    const rules = await listPromptRules(db);
    expect(rules).toHaveLength(1);
    expect(calls[0].filters).toEqual([["eq", "is_active", true], ["order", "rule_number"]]);
  });

  it("prompt rule loading throws so runReview fails loudly instead of reviewing against nothing", async () => {
    const { db } = scriptedDb([{ table: "playbook_rules", error: { message: "down" } }]);
    await expect(listPromptRules(db)).rejects.toThrow(/down/);
  });
});

describe("createPlaybookRule / updatePlaybookRule", () => {
  it("creates and maps a duplicate rule_number to a conflict", async () => {
    const input = { rule_number: "RULE 1", title: "t", description: "d", thresholds: {}, severity: "HIGH" as const, is_active: true, applies_to: null };
    const ok = scriptedDb([{ table: "playbook_rules", op: "insert", data: ROW }]);
    expect(await createPlaybookRule(ok.db, input)).toEqual({ ok: true, data: ROW });
    expect(ok.calls[0].payload).toEqual(input);

    const dup = scriptedDb([{ table: "playbook_rules", op: "insert", error: { code: "23505", message: "duplicate" } }]);
    expect(await createPlaybookRule(dup.db, input)).toMatchObject({ ok: false, kind: "conflict" });
  });

  it("updates by id and reports not_found for a missing rule", async () => {
    const hit = scriptedDb([{ table: "playbook_rules", op: "update", data: { ...ROW, is_active: false } }]);
    expect(await updatePlaybookRule(hit.db, "r1", { is_active: false })).toMatchObject({ ok: true, data: { is_active: false } });
    expect(hit.calls[0].filters).toEqual([["eq", "id", "r1"]]);
    expect(hit.calls[0].payload).toEqual({ is_active: false });

    const miss = scriptedDb([{ table: "playbook_rules", op: "update", data: null }]);
    expect(await updatePlaybookRule(miss.db, "nope", { title: "x" })).toMatchObject({ ok: false, kind: "not_found" });
  });
});

describe("document-type scoping", () => {
  it("normalises the Assistant's Bahasa labels and unknown values onto stored document types", () => {
    expect(normalizeRuleDocumentType("Template Klien")).toBe("Client Template");
    expect(normalizeRuleDocumentType("Lainnya")).toBe("Other");
    expect(normalizeRuleDocumentType("nda")).toBe("NDA");
    expect(normalizeRuleDocumentType("PKS")).toBe("PKS");
    expect(normalizeRuleDocumentType("Surat Aneh")).toBe("Other");
    expect(normalizeRuleDocumentType(null)).toBe("Other");
  });

  it("loads universal rules plus the rules scoped to the review's document type", async () => {
    const fake = scriptedDb([{ table: "playbook_rules", data: [ROW] }]);
    await listPromptRules(fake.db, "NDA");
    expect(fake.calls[0].filters).toEqual([
      ["eq", "is_active", true],
      ["or", 'applies_to.is.null,applies_to.cs.{"NDA"}'],
      ["order", "rule_number"],
    ]);
    const legacy = scriptedDb([{ table: "playbook_rules", data: [ROW] }]);
    await listPromptRules(legacy.db, "Template Klien");
    expect(legacy.calls[0].filters[1]).toEqual(["or", 'applies_to.is.null,applies_to.cs.{"Client Template"}']);
    const all = scriptedDb([{ table: "playbook_rules", data: [ROW] }]);
    await listPromptRules(all.db);
    expect(all.calls[0].filters.map((f) => f[0])).toEqual(["eq", "order"]);
  });
});
