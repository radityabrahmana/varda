import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import {
  canManageScope,
  canSeeRegulation,
  requireManage,
  resolveRegulationScope,
  resolveTargetOrg,
  visibleFilter,
} from "../regulations.service";
import type { RegulationScope } from "../regulations.types";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const scope = (over: Partial<RegulationScope> = {}): RegulationScope => ({
  userId: USER,
  orgIds: [ORG_A],
  adminOrgIds: [],
  platformAdmin: false,
  ...over,
});

describe("resolveRegulationScope", () => {
  it("collects memberships, admin orgs and the Varda-admin flag", async () => {
    const fake = scriptedDb([
      { table: "org_members", data: [{ org_id: ORG_A, role: "admin" }, { org_id: ORG_B, role: "member" }] },
      { table: "user_roles", data: { role: "admin" } },
    ]);
    const s = await resolveRegulationScope(fake.db, USER);
    expect(s).toEqual({ userId: USER, orgIds: [ORG_A, ORG_B], adminOrgIds: [ORG_A], platformAdmin: true });
    fake.done();
  });
});

describe("visibility and management", () => {
  it("shows platform-wide rows to everyone and org rows to members", () => {
    expect(canSeeRegulation(scope(), { org_id: null })).toBe(true);
    expect(canSeeRegulation(scope(), { org_id: ORG_A })).toBe(true);
    expect(canSeeRegulation(scope(), { org_id: ORG_B })).toBe(false);
    expect(visibleFilter(scope({ orgIds: [] }))).toBe("org_id.is.null");
    expect(visibleFilter(scope({ orgIds: [ORG_A, ORG_B] }))).toBe(`org_id.is.null,org_id.in.(${ORG_A},${ORG_B})`);
  });

  it("lets org admins manage their org and only Varda admins manage platform rows", () => {
    expect(canManageScope(scope(), ORG_A)).toBe(false);
    expect(canManageScope(scope({ adminOrgIds: [ORG_A] }), ORG_A)).toBe(true);
    expect(canManageScope(scope({ adminOrgIds: [ORG_A] }), null)).toBe(false);
    expect(canManageScope(scope({ platformAdmin: true }), null)).toBe(true);
    expect(canManageScope(scope({ platformAdmin: true }), ORG_B)).toBe(true);
    expect(requireManage(scope(), ORG_A)).toMatchObject({ ok: false, kind: "forbidden" });
  });
});

describe("resolveTargetOrg", () => {
  const meta = { regulation_type: "UU", title: "t", short_name: "s" };

  it("defaults to the single org the caller administers", () => {
    expect(resolveTargetOrg(scope({ adminOrgIds: [ORG_A] }), meta)).toEqual({ ok: true, data: ORG_A });
  });

  it("requires an explicit org when the caller administers several", () => {
    expect(resolveTargetOrg(scope({ orgIds: [ORG_A, ORG_B], adminOrgIds: [ORG_A, ORG_B] }), meta)).toMatchObject({
      ok: false,
      kind: "validation",
    });
    expect(resolveTargetOrg(scope({ orgIds: [ORG_A, ORG_B], adminOrgIds: [ORG_A, ORG_B] }), { ...meta, org_id: ORG_B })).toEqual({
      ok: true,
      data: ORG_B,
    });
  });

  it("refuses members and foreign orgs", () => {
    expect(resolveTargetOrg(scope(), meta)).toMatchObject({ ok: false, kind: "forbidden" });
    expect(resolveTargetOrg(scope({ adminOrgIds: [ORG_A] }), { ...meta, org_id: ORG_B })).toMatchObject({ ok: false, kind: "forbidden" });
  });

  it("reserves platform scope for Varda admins", () => {
    expect(resolveTargetOrg(scope(), { ...meta, scope: "platform" })).toMatchObject({ ok: false, kind: "forbidden" });
    expect(resolveTargetOrg(scope({ platformAdmin: true }), { ...meta, scope: "platform" })).toEqual({ ok: true, data: null });
  });
});
