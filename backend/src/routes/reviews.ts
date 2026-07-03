import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

export const reviewsRouter = Router();

// Narrow list payload — the dashboard never needs contract_text/contract_html/ai_output,
// which are large. Keep this in sync with the columns the dashboard renders.
const LIST_COLUMNS =
  "id, user_id, title, client_name, document_type, risk_level, recommendation, status, created_at, expiry_date";

type ReviewListRow = {
  id: string;
  user_id: string | null;
  title: string | null;
  client_name: string | null;
  document_type: string | null;
  risk_level: string | null;
  recommendation: string | null;
  status: string | null;
  created_at: string;
  expiry_date: string | null;
};

async function callerIsAdmin(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
): Promise<boolean> {
  const { data } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return Boolean(data);
}

// GET /api/reviews — team-wide review list for the dashboard, enriched with the
// uploader email. reviews are team-wide (Janus is_team_member model); requireAuth
// gates access and the service-role client bypasses RLS, so we intentionally do
// NOT scope by user_id.
reviewsRouter.get("/", requireAuth, async (_req, res) => {
  const db = createServerSupabase();
  const { data, error } = await db
    .from("reviews")
    .select(LIST_COLUMNS)
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });

  const reviews = (data ?? []) as ReviewListRow[];

  // Resolve uploader emails via the auth admin API. NOTE: do NOT use the
  // get_user_emails RPC here — it is gated by is_team_member() which reads the
  // caller's JWT, and the service-role client has none, so it returns nothing.
  const userIds = [
    ...new Set(reviews.map((r) => r.user_id).filter((v): v is string => Boolean(v))),
  ];
  const emailByUserId: Record<string, string> = {};
  await Promise.all(
    userIds.map(async (id) => {
      const { data } = await db.auth.admin.getUserById(id);
      if (data?.user?.email) emailByUserId[id] = data.user.email;
    }),
  );

  res.json(
    reviews.map((r) => ({
      ...r,
      uploader_email: r.user_id ? emailByUserId[r.user_id] ?? null : null,
    })),
  );
});

// DELETE /api/reviews/:id — admin only (role-based, enforced server-side).
reviewsRouter.delete("/:id", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();

  if (!(await callerIsAdmin(db, userId))) {
    return void res.status(403).json({ detail: "Admin role required" });
  }

  const { error } = await db.from("reviews").delete().eq("id", req.params.id);
  if (error) return void res.status(500).json({ detail: error.message });

  res.status(204).send();
});
