// Who may see and act on a contract review.
//
// Reviews are PRIVATE: the uploader (reviews.user_id) is the owner; other people
// see a review only through a row in review_access_grants (by email, role
// owner/editor/viewer — the same ladder as assistant chats); Varda admins
// (user_roles.role = 'admin') see and manage every review. Anyone else gets a
// 404, never a 403, so a shared link does not confirm that a contract exists.
//
// Grants live in this module rather than in lib/contentAccess: that helper
// iterates every grant table on account deletion, and review_access_grants is
// a Janus-side table (janus-migrations/) that upstream's fresh install lacks.
//
// Capabilities reuse lib/permissions: project.view (read), content.edit
// (feedback, comments, redlines, status, memo), access.manage (sharing),
// container.delete (delete the review).

import type { Db } from "../../lib/supabase";
import { can, isProjectRole, type Capability, type ProjectRole } from "../../lib/permissions";
import { findProfileUserByEmail } from "../../lib/userLookup";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";

export const REVIEW_GRANTS_TABLE = "review_access_grants";

export type ReviewAccessVia = "creator" | "grant" | "admin";

export type ReviewAccess = {
  reviewId: string;
  ownerId: string | null;
  role: ProjectRole;
  via: ReviewAccessVia;
};

export type ReviewAccessGrant = {
  id: string;
  review_id: string;
  email: string;
  role: ProjectRole;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ReviewCaller = { userId: string; email?: string | null };

const NOT_FOUND = "Tinjauan tidak ditemukan.";

export function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = (email ?? "").trim().toLowerCase();
  return normalized || null;
}

export async function callerIsAdmin(db: Db, userId: string): Promise<boolean> {
  const { data } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return Boolean(data);
}

async function grantRoleFor(db: Db, reviewId: string, email: string | null): Promise<ProjectRole | null> {
  if (!email) return null;
  const { data, error } = await db
    .from(REVIEW_GRANTS_TABLE)
    .select("role")
    .eq("review_id", reviewId)
    .eq("email", email)
    .maybeSingle();
  if (error) throw error;
  const role = (data as { role?: unknown } | null)?.role;
  return isProjectRole(role) ? role : null;
}

/**
 * The caller's standing on one review, or not_found when the review does not
 * exist OR the caller may not see it (indistinguishable on purpose).
 * Precedence: creator > admin > direct grant, so an admin who was also shared
 * a review keeps full control.
 */
export async function resolveReviewAccess(
  db: Db,
  args: ReviewCaller & { reviewId: string },
): Promise<ServiceResult<ReviewAccess>> {
  const { data, error } = await db.from("reviews").select("id, user_id").eq("id", args.reviewId).maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", NOT_FOUND);
  const ownerId = (data as { user_id: string | null }).user_id;
  const base = { reviewId: args.reviewId, ownerId };

  if (ownerId && ownerId === args.userId) return ok({ ...base, role: "owner", via: "creator" });
  try {
    const [isAdmin, granted] = await Promise.all([
      callerIsAdmin(db, args.userId),
      grantRoleFor(db, args.reviewId, normalizeEmail(args.email)),
    ]);
    if (isAdmin) return ok({ ...base, role: "owner", via: "admin" });
    if (granted) return ok({ ...base, role: granted, via: "grant" });
  } catch (e) {
    return internalFailure(e);
  }
  return failure("not_found", NOT_FOUND);
}

const CAPABILITY_REFUSAL: Partial<Record<Capability, string>> = {
  "content.edit": "Anda hanya memiliki akses lihat untuk tinjauan ini.",
  "access.manage": "Hanya pemilik tinjauan atau admin yang dapat mengatur akses.",
  "container.delete": "Hanya pemilik tinjauan atau admin yang dapat menghapus tinjauan.",
};

/** forbidden when the resolved role lacks the capability (the caller can already see the review). */
export function requireReviewCapability(access: ReviewAccess, capability: Capability): ServiceResult<ReviewAccess> {
  if (can(access.role, capability)) return ok(access);
  return failure("forbidden", CAPABILITY_REFUSAL[capability] ?? "Akses ditolak.");
}

/**
 * Review ids visible to a non-admin caller through grants, with the granted
 * role. Admins and creators do not need this (see listReviews).
 */
export async function listGrantedReviewRoles(db: Db, email: string | null | undefined): Promise<Map<string, ProjectRole>> {
  const normalized = normalizeEmail(email);
  const roles = new Map<string, ProjectRole>();
  if (!normalized) return roles;
  const { data, error } = await db.from(REVIEW_GRANTS_TABLE).select("review_id, role").eq("email", normalized);
  if (error) throw error;
  for (const row of (data ?? []) as { review_id?: unknown; role?: unknown }[]) {
    if (typeof row.review_id === "string" && isProjectRole(row.role)) roles.set(row.review_id, row.role);
  }
  return roles;
}

export async function listReviewGrants(db: Db, reviewId: string): Promise<ServiceResult<ReviewAccessGrant[]>> {
  const { data, error } = await db
    .from(REVIEW_GRANTS_TABLE)
    .select("*")
    .eq("review_id", reviewId)
    .order("created_at", { ascending: true });
  if (error) return internalFailure(error);
  return ok((data ?? []) as ReviewAccessGrant[]);
}

type ProfileRow = { user_id: string; email: string | null; display_name: string | null };

export type ReviewPeople = {
  scope: "direct";
  owner: (ProfileRow & { role: "owner" }) | null;
  members: { user_id: string | null; email: string; display_name: string | null; role: ProjectRole }[];
};

/** Roster for the share dialog: the uploader plus every direct grant. */
export async function listReviewPeople(db: Db, access: ReviewAccess): Promise<ServiceResult<ReviewPeople>> {
  const grants = await listReviewGrants(db, access.reviewId);
  if (!grants.ok) return grants;
  const emails = grants.data.map((g) => g.email);
  const [byEmail, byId] = await Promise.all([
    emails.length
      ? db.from("user_profiles").select("user_id, email, display_name").in("email", emails)
      : Promise.resolve({ data: [], error: null }),
    access.ownerId
      ? db.from("user_profiles").select("user_id, email, display_name").eq("user_id", access.ownerId)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (byEmail.error || byId.error) return internalFailure(byEmail.error ?? byId.error);
  const profileByEmail = new Map(((byEmail.data ?? []) as ProfileRow[]).map((p) => [p.email, p]));
  const creator = ((byId.data ?? []) as ProfileRow[])[0] ?? null;
  return ok({
    scope: "direct",
    owner: creator ? { ...creator, role: "owner" } : null,
    members: grants.data.map((g) => ({
      user_id: profileByEmail.get(g.email)?.user_id ?? null,
      email: g.email,
      display_name: profileByEmail.get(g.email)?.display_name ?? null,
      role: g.role,
    })),
  });
}

/** Grant or re-role one recipient. The recipient must already have a Varda account. */
export async function grantReviewAccess(
  db: Db,
  args: { access: ReviewAccess; grantedBy: string; email: unknown; role: unknown },
): Promise<ServiceResult<ReviewAccessGrant>> {
  const email = typeof args.email === "string" ? normalizeEmail(args.email) : null;
  if (!email || !email.includes("@")) return failure("validation", "Alamat email tidak valid.");
  if (!isProjectRole(args.role)) return failure("validation", "Peran harus owner, editor, atau viewer.");

  let recipient: Awaited<ReturnType<typeof findProfileUserByEmail>>;
  try {
    recipient = await findProfileUserByEmail(db, email);
  } catch (e) {
    return internalFailure(e);
  }
  if (!recipient) return failure("validation", `${email} belum memiliki akun Varda.`);
  if (isCreator(args.access, recipient.id)) {
    return failure("validation", "Pengunggah tinjauan sudah menjadi pemilik.");
  }

  const { data, error } = await db
    .from(REVIEW_GRANTS_TABLE)
    .upsert(
      {
        review_id: args.access.reviewId,
        email,
        role: args.role,
        created_by: args.grantedBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "review_id,email" },
    )
    .select("*")
    .single();
  if (error || !data) return internalFailure(error ?? new Error("Gagal menyimpan akses."));
  return ok(data as ReviewAccessGrant);
}

function isCreator(access: ReviewAccess, userId: string): boolean {
  return Boolean(access.ownerId) && access.ownerId === userId;
}

export async function revokeReviewAccess(
  db: Db,
  args: { reviewId: string; email: string },
): Promise<ServiceResult<null>> {
  const email = normalizeEmail(args.email);
  if (!email) return failure("not_found", "Akses tidak ditemukan.");
  const { data, error } = await db
    .from(REVIEW_GRANTS_TABLE)
    .delete()
    .eq("review_id", args.reviewId)
    .eq("email", email)
    .select("id");
  if (error) return internalFailure(error);
  if (!((data ?? []) as unknown[]).length) return failure("not_found", "Akses tidak ditemukan.");
  return ok(null);
}
