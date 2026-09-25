import { describe, expect, it, vi } from "vitest";
import { canUseAdvancedModels } from "../user.advancedModels";

type Result = { data?: unknown; error?: unknown; throws?: boolean };

// One query chain per table; `limit` resolves the chain.
function db(results: Partial<Record<"org_members" | "user_roles", Result>>) {
    return {
        from: vi.fn((table: "org_members" | "user_roles") => {
            const result = results[table] ?? { data: [], error: null };
            const chain: Record<string, unknown> = {};
            for (const method of ["select", "eq"]) chain[method] = vi.fn(() => chain);
            chain.limit = vi.fn(async () => {
                if (result.throws) throw new Error("network");
                return { data: result.data ?? null, error: result.error ?? null };
            });
            return chain;
        }),
    } as never;
}

describe("canUseAdvancedModels", () => {
    it("is true for an organization admin", async () => {
        await expect(
            canUseAdvancedModels(db({ org_members: { data: [{ user_id: "u" }] } }), "u"),
        ).resolves.toBe(true);
    });

    it("is true for a deployment admin", async () => {
        await expect(
            canUseAdvancedModels(db({ user_roles: { data: [{ user_id: "u" }] } }), "u"),
        ).resolves.toBe(true);
    });

    it("is false for a member", async () => {
        await expect(canUseAdvancedModels(db({}), "u")).resolves.toBe(false);
    });

    it("treats a deployment without user_roles as having no deployment admins", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await expect(
            canUseAdvancedModels(
                db({
                    user_roles: {
                        error: { code: "42P01", message: 'relation "user_roles" does not exist' },
                    },
                }),
                "u",
            ),
        ).resolves.toBe(false);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it("fails closed when a lookup cannot run", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await expect(
            canUseAdvancedModels(db({ org_members: { throws: true } }), "u"),
        ).resolves.toBe(false);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
