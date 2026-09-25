// Who may pick a named model in the Assistant instead of a mode.
//
// Members see only Auto/Fast/Deep; the full catalog ("Advanced models") is for
// people who administer something: an organization admin (generic, every
// tenant) or a deployment admin in `user_roles` (the Dash role that also sees
// every contract review, see contracts.access.ts callerIsAdmin). The flag
// shapes the picker; it is not an authorization boundary for requests.
import { type Db } from "./user.shared";

// user_roles ships in the Dash-only janus migrations. A deployment without it
// answers "not a deployment admin" instead of hiding the flag behind an error.
function isMissingTable(error: unknown, table: string): boolean {
    const record =
        error && typeof error === "object"
            ? (error as { code?: unknown; message?: unknown })
            : {};
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : "";
    return (code === "42P01" || code === "PGRST205") && message.includes(table);
}

async function hasRow(
    db: Db,
    table: "org_members" | "user_roles",
    userId: string,
): Promise<boolean> {
    let data: unknown;
    let error: unknown;
    try {
        ({ data, error } = await db
            .from(table)
            .select("user_id")
            .eq("user_id", userId)
            .eq("role", "admin")
            .limit(1));
    } catch (thrown) {
        // The flag only shapes a picker, so a lookup that cannot run hides
        // the advanced list rather than failing the whole profile response.
        error = thrown;
    }
    if (error) {
        if (!isMissingTable(error, table)) {
            console.warn("[user] admin lookup failed; hiding advanced models", {
                table,
                // The code only: a database message can echo query values.
                code: (error as { code?: unknown }).code ?? null,
            });
        }
        return false;
    }
    return Array.isArray(data) && data.length > 0;
}

export async function canUseAdvancedModels(
    db: Db,
    userId: string,
): Promise<boolean> {
    const [orgAdmin, deploymentAdmin] = await Promise.all([
        hasRow(db, "org_members", userId),
        hasRow(db, "user_roles", userId),
    ]);
    return orgAdmin || deploymentAdmin;
}
