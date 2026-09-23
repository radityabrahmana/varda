import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

import {
  grantReviewAccess,
  listReviewPeople,
  listReviews,
  requireReviewCapability,
  resolveReviewAccess,
  revokeReviewAccess,
  type ReviewAccess,
} from "../contracts.service";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const R1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const R2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const access = (over: Partial<ReviewAccess> = {}): ReviewAccess => ({
  reviewId: R1,
  ownerId: OWNER,
  role: "owner",
  via: "creator",
  ...over,
});

describe("resolveReviewAccess", () => {
  it("treats the uploader as owner without consulting roles or grants", async () => {
    const fake = scriptedDb([{ table: "reviews", data: { id: R1, user_id: OWNER } }]);
    const r = await resolveReviewAccess(fake.db, { reviewId: R1, userId: OWNER, email: "o@dashelectric.co" });
    expect(r).toEqual({ ok: true, data: { reviewId: R1, ownerId: OWNER, role: "owner", via: "creator" } });
    fake.done();
  });

  it("gives an admin owner standing on someone else's review", async () => {
    const fake = scriptedDb([
      { table: "reviews", data: { id: R1, user_id: OWNER } },
      { table: "user_roles", data: { role: "admin" } },
      { table: "review_access_grants", data: null },
    ]);
    const r = await resolveReviewAccess(fake.db, { reviewId: R1, userId: OTHER, email: "admin@dashelectric.co" });
    expect(r).toMatchObject({ ok: true, data: { role: "owner", via: "admin" } });
    fake.done();
  });

  it("uses the direct grant for a shared recipient, matched by lowercased email", async () => {
    const fake = scriptedDb([
      { table: "reviews", data: { id: R1, user_id: OWNER } },
      { table: "user_roles", data: null },
      { table: "review_access_grants", data: { role: "viewer" } },
    ]);
    const r = await resolveReviewAccess(fake.db, { reviewId: R1, userId: OTHER, email: " Donnie@DashElectric.co " });
    expect(r).toMatchObject({ ok: true, data: { role: "viewer", via: "grant" } });
    expect(fake.calls[2].filters).toEqual([
      ["eq", "review_id", R1],
      ["eq", "email", "donnie@dashelectric.co"],
    ]);
  });

  it("answers not_found for a teammate without a grant, same as a missing review", async () => {
    const hidden = scriptedDb([
      { table: "reviews", data: { id: R1, user_id: OWNER } },
      { table: "user_roles", data: null },
      { table: "review_access_grants", data: null },
    ]);
    const missing = scriptedDb([{ table: "reviews", data: null }]);
    const a = await resolveReviewAccess(hidden.db, { reviewId: R1, userId: OTHER, email: "x@dashelectric.co" });
    const b = await resolveReviewAccess(missing.db, { reviewId: R1, userId: OTHER, email: "x@dashelectric.co" });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("does not look up a grant when the caller has no email", async () => {
    const fake = scriptedDb([
      { table: "reviews", data: { id: R1, user_id: OWNER } },
      { table: "user_roles", data: null },
    ]);
    const r = await resolveReviewAccess(fake.db, { reviewId: R1, userId: OTHER, email: null });
    expect(r).toMatchObject({ ok: false, kind: "not_found" });
    fake.done();
  });

  it("surfaces a grant lookup failure as an internal error, not as no access", async () => {
    const fake = scriptedDb([
      { table: "reviews", data: { id: R1, user_id: OWNER } },
      { table: "user_roles", data: null },
      { table: "review_access_grants", error: { message: "boom" } },
    ]);
    const r = await resolveReviewAccess(fake.db, { reviewId: R1, userId: OTHER, email: "x@dashelectric.co" });
    expect(r).toMatchObject({ ok: false, kind: "error" });
  });
});

describe("requireReviewCapability", () => {
  it("lets a viewer read but not edit, share or delete", () => {
    const viewer = access({ role: "viewer", via: "grant" });
    expect(requireReviewCapability(viewer, "project.view")).toMatchObject({ ok: true });
    expect(requireReviewCapability(viewer, "content.edit")).toMatchObject({ ok: false, kind: "forbidden" });
    expect(requireReviewCapability(viewer, "access.manage")).toMatchObject({ ok: false, kind: "forbidden" });
    expect(requireReviewCapability(viewer, "container.delete")).toMatchObject({ ok: false, kind: "forbidden" });
  });

  it("lets an editor edit but not share or delete; owners and admins do everything", () => {
    const editor = access({ role: "editor", via: "grant" });
    expect(requireReviewCapability(editor, "content.edit")).toMatchObject({ ok: true });
    expect(requireReviewCapability(editor, "access.manage")).toMatchObject({ ok: false, kind: "forbidden" });
    for (const a of [access(), access({ via: "admin" })]) {
      expect(requireReviewCapability(a, "access.manage")).toMatchObject({ ok: true });
      expect(requireReviewCapability(a, "container.delete")).toMatchObject({ ok: true });
    }
  });
});

function withAuth(db: Db, emails: Record<string, string>): Db {
  const getUserById = vi.fn(async (id: string) => ({ data: { user: emails[id] ? { email: emails[id] } : null } }));
  return { ...db, auth: { admin: { getUserById } } } as unknown as Db;
}

describe("listReviews", () => {
  const row = (id: string, user_id: string) => ({ id, user_id, title: "PKS", created_at: "2026-09-23T00:00:00Z" });

  it("returns everything for an admin with owner role on each row", async () => {
    const fake = scriptedDb([
      { table: "user_roles", data: { role: "admin" } },
      { table: "review_access_grants", data: [] },
      { table: "reviews", data: [row(R1, OWNER)] },
    ]);
    const r = await listReviews(withAuth(fake.db, { [OWNER]: "o@dashelectric.co" }), { userId: OTHER, email: "a@dashelectric.co" });
    expect(r).toMatchObject({ ok: true, data: [{ id: R1, uploader_email: "o@dashelectric.co", access_role: "owner" }] });
    expect(fake.calls[2].filters.filter(([f]) => f !== "order")).toEqual([]);
  });

  it("scopes a member to own uploads when nothing is shared with them", async () => {
    const fake = scriptedDb([
      { table: "user_roles", data: null },
      { table: "review_access_grants", data: [] },
      { table: "reviews", data: [row(R1, OWNER)] },
    ]);
    const r = await listReviews(withAuth(fake.db, {}), { userId: OWNER, email: "o@dashelectric.co" });
    expect(r).toMatchObject({ ok: true, data: [{ id: R1, access_role: "owner" }] });
    expect(fake.calls[2].filters).toContainEqual(["eq", "user_id", OWNER]);
  });

  it("adds reviews shared with the member and reports the granted role", async () => {
    const fake = scriptedDb([
      { table: "user_roles", data: null },
      { table: "review_access_grants", data: [{ review_id: R2, role: "editor" }, { review_id: "not-a-uuid", role: "viewer" }] },
      { table: "reviews", data: [row(R2, OTHER)] },
    ]);
    const r = await listReviews(withAuth(fake.db, {}), { userId: OWNER, email: "O@dashelectric.co" });
    expect(r).toMatchObject({ ok: true, data: [{ id: R2, access_role: "editor" }] });
    expect(fake.calls[1].filters).toEqual([["eq", "email", "o@dashelectric.co"]]);
    expect(fake.calls[2].filters).toContainEqual(["or", `user_id.eq.${OWNER},id.in.(${R2})`]);
  });
});

describe("listReviewPeople", () => {
  it("lists the uploader as owner and each grant with its profile", async () => {
    const fake = scriptedDb([
      { table: "review_access_grants", data: [{ email: "d@dashelectric.co", role: "viewer" }] },
      { table: "user_profiles", data: [{ user_id: OTHER, email: "d@dashelectric.co", display_name: "Donnie" }] },
      { table: "user_profiles", data: [{ user_id: OWNER, email: "o@dashelectric.co", display_name: "Aditya" }] },
    ]);
    const r = await listReviewPeople(fake.db, access());
    expect(r).toEqual({
      ok: true,
      data: {
        scope: "direct",
        owner: { user_id: OWNER, email: "o@dashelectric.co", display_name: "Aditya", role: "owner" },
        members: [{ user_id: OTHER, email: "d@dashelectric.co", display_name: "Donnie", role: "viewer" }],
      },
    });
  });
});

describe("grantReviewAccess", () => {
  it("rejects an invalid email or role before any lookup", async () => {
    const fake = scriptedDb([]);
    expect(await grantReviewAccess(fake.db, { access: access(), grantedBy: OWNER, email: "nope", role: "viewer" })).toMatchObject({
      ok: false,
      kind: "validation",
    });
    expect(
      await grantReviewAccess(fake.db, { access: access(), grantedBy: OWNER, email: "d@dashelectric.co", role: "deny" }),
    ).toMatchObject({ ok: false, kind: "validation" });
    fake.done();
  });

  it("refuses someone without a Varda account and the uploader themselves", async () => {
    const unknown = scriptedDb([{ table: "user_profiles", data: null }]);
    expect(
      await grantReviewAccess(unknown.db, { access: access(), grantedBy: OWNER, email: "new@dashelectric.co", role: "viewer" }),
    ).toMatchObject({ ok: false, kind: "validation", detail: "new@dashelectric.co belum memiliki akun Varda." });

    const uploader = scriptedDb([{ table: "user_profiles", data: { user_id: OWNER, email: "o@dashelectric.co", display_name: null } }]);
    expect(
      await grantReviewAccess(uploader.db, { access: access({ via: "admin" }), grantedBy: OTHER, email: "o@dashelectric.co", role: "viewer" }),
    ).toMatchObject({ ok: false, kind: "validation" });
  });

  it("upserts one row per (review, email) with the lowercased email", async () => {
    const saved = { id: "g1", review_id: R1, email: "d@dashelectric.co", role: "editor" };
    const fake = scriptedDb([
      { table: "user_profiles", data: { user_id: OTHER, email: "d@dashelectric.co", display_name: "Donnie" } },
      { table: "review_access_grants", op: "upsert", data: saved },
    ]);
    const r = await grantReviewAccess(fake.db, { access: access(), grantedBy: OWNER, email: "D@DashElectric.co", role: "editor" });
    expect(r).toEqual({ ok: true, data: saved });
    expect(fake.calls[1].payload).toMatchObject({ review_id: R1, email: "d@dashelectric.co", role: "editor", created_by: OWNER });
  });
});

describe("revokeReviewAccess", () => {
  it("deletes the grant and reports not_found when there was none", async () => {
    const removed = scriptedDb([{ table: "review_access_grants", op: "delete", data: [{ id: "g1" }] }]);
    expect(await revokeReviewAccess(removed.db, { reviewId: R1, email: "D@dashelectric.co" })).toEqual({ ok: true, data: null });
    expect(removed.calls[0].filters).toEqual([
      ["eq", "review_id", R1],
      ["eq", "email", "d@dashelectric.co"],
    ]);

    const none = scriptedDb([{ table: "review_access_grants", op: "delete", data: [] }]);
    expect(await revokeReviewAccess(none.db, { reviewId: R1, email: "x@dashelectric.co" })).toMatchObject({ ok: false, kind: "not_found" });
  });
});
