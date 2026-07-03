import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

export const meRouter = Router();

// GET /api/me — identity + role for client-side gating (the frontend has no role
// system of its own). Authorization for actions is still enforced server-side.
meRouter.get("/", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const email = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();

  const { data } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();

  res.json({ userId, email: email ?? null, isAdmin: Boolean(data) });
});
