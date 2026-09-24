// Who may see and manage regulations.
//
//   scope             visible to                  managed by
//   ----------------- --------------------------- -----------------------------
//   platform (org_id  every signed-in user        Varda admins
//     null)                                         (user_roles.role = 'admin')
//   organization      the organization's members  its admins, and Varda admins
//
// A regulation the caller may not see answers not_found, never forbidden, so
// an id never confirms that another tenant holds a document.

import type { Db } from "../../lib/supabase";
import { isOrgRole, type OrgRole } from "../../lib/access";
import { failure, ok, type ServiceResult } from "../../lib/serviceResult";
import { callerIsAdmin } from "../contracts/contracts.service";
import type { RegulationRow, RegulationScope } from "./regulations.types";

export const REGULATION_NOT_FOUND = "Peraturan tidak ditemukan.";
const MANAGE_FORBIDDEN = "Hanya administrator organisasi yang dapat mengelola perpustakaan peraturan.";
const PLATFORM_FORBIDDEN = "Hanya administrator Varda yang dapat mengelola peraturan lintas organisasi.";

export async function resolveRegulationScope(db: Db, userId: string): Promise<RegulationScope> {
  const { data } = await db.from("org_members").select("org_id, role").eq("user_id", userId);
  const orgIds: string[] = [];
  const adminOrgIds: string[] = [];
  for (const row of (data ?? []) as { org_id?: string | null; role?: string }[]) {
    if (!row.org_id) continue;
    orgIds.push(row.org_id);
    if (isOrgRole(row.role) && (row.role as OrgRole) === "admin") adminOrgIds.push(row.org_id);
  }
  const platformAdmin = await callerIsAdmin(db, userId);
  return { userId, orgIds, adminOrgIds, platformAdmin };
}

export function canSeeRegulation(scope: RegulationScope, row: Pick<RegulationRow, "org_id">): boolean {
  return row.org_id === null || scope.orgIds.includes(row.org_id);
}

export function canManageScope(scope: RegulationScope, orgId: string | null): boolean {
  if (orgId === null) return scope.platformAdmin;
  return scope.platformAdmin || scope.adminOrgIds.includes(orgId);
}

/** Supabase `.or()` filter selecting the rows the caller may see. */
export function visibleFilter(scope: RegulationScope): string {
  if (scope.orgIds.length === 0) return "org_id.is.null";
  return `org_id.is.null,org_id.in.(${scope.orgIds.join(",")})`;
}

export function requireManage(scope: RegulationScope, orgId: string | null): ServiceResult<true> {
  if (canManageScope(scope, orgId)) return ok(true);
  return failure("forbidden", orgId === null ? PLATFORM_FORBIDDEN : MANAGE_FORBIDDEN);
}
