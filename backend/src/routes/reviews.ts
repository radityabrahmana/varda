import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { singleFileUpload } from "../lib/upload";
import { normalizeDocxZipPaths } from "../lib/convert";
import { buildReviewContextFor } from "../lib/reviewContext";
import { callJanusTool } from "../lib/janusTools";

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

const DOCX_EXT = /\.(docx|doc)$/i;

// POST /api/reviews/upload — extract text + HTML from an uploaded DOCX (in memory).
// Returns the extracted content; the client then POSTs it to create the review.
reviewsRouter.post("/upload", requireAuth, singleFileUpload("file"), async (req, res) => {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });
  if (!DOCX_EXT.test(file.originalname)) {
    return void res.status(400).json({ detail: "Hanya file DOCX yang diperbolehkan." });
  }
  if (file.size > 25 * 1024 * 1024) {
    return void res.status(413).json({ detail: "File terlalu besar. Maksimum 25MB." });
  }
  try {
    const normalized = await normalizeDocxZipPaths(file.buffer);
    const mammoth = await import("mammoth");
    const [{ value: contract_text }, { value: rawHtml }] = await Promise.all([
      mammoth.extractRawText({ buffer: normalized }),
      mammoth.convertToHtml(
        { buffer: normalized },
        { styleMap: ["b => strong", "i => em", "u => u", "strike => s", "highlight => mark"] },
      ),
    ]);
    // Match Janus's HTML post-processing so the viewer renders identically.
    const contract_html = rawHtml
      .replace(/<table>/g, '<table style="width:100%">')
      .replace(/<p>\s*<\/p>/g, "")
      .replace(/(<br\s*\/?>\s*){3,}/g, '<hr style="border:none;border-top:1px dashed #ccc;margin:32px 0;">');

    if (!contract_text || contract_text.trim().length === 0) {
      return void res.status(422).json({ detail: "Ekstraksi gagal — dokumen kosong atau tidak terbaca." });
    }
    res.json({ contract_text, contract_html, filename: file.originalname });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ detail: `Ekstraksi gagal: ${message}` });
  }
});

// Runs the AI review in the background and writes the result to the row.
// Detached from the HTTP response; must catch its own errors (uncaught rejection
// would crash the process) and flip the row to "failed" on any failure.
async function runReview(
  reviewId: string,
  input: {
    contract_text: string;
    client_name: string;
    document_type: string;
    project_context: string;
    review_focus: string[];
  },
): Promise<void> {
  const db = createServerSupabase();
  try {
    const ctx = await buildReviewContextFor(db, input.client_name, input.document_type);
    const text = await callJanusTool("run_contract_review", {
      contract_text: input.contract_text,
      client_name: input.client_name,
      document_type: input.document_type,
      project_context: input.project_context,
      review_focus: input.review_focus,
      clause_library_context: ctx.clauseLibraryContext,
      past_feedback_context: ctx.pastFeedbackContext,
    });
    const ai = JSON.parse(text) as Record<string, unknown>;
    // Guard against a parseable-but-invalid payload (e.g. an {error} passthrough or
    // truncated object) being stored as a completed review. Require a real ReviewOutput.
    if (
      typeof ai !== "object" ||
      ai === null ||
      "error" in ai ||
      (!ai.risk_level && !ai.overall_recommendation)
    ) {
      throw new Error(`review-contract returned invalid output: ${text.slice(0, 300)}`);
    }
    await db
      .from("reviews")
      .update({
        ai_output: ai,
        risk_level: (ai.risk_level as string | undefined) ?? null,
        recommendation: (ai.overall_recommendation as string | undefined) ?? null,
        status: "ai_reviewed",
      })
      .eq("id", reviewId);
  } catch (e) {
    console.error(`[reviews] runReview failed for ${reviewId}:`, e);
    // The failure-update must not itself throw (would escape as an unhandled
    // rejection on this detached promise and could crash the process).
    try {
      await db.from("reviews").update({ status: "failed" }).eq("id", reviewId);
    } catch (e2) {
      console.error(`[reviews] failed to mark ${reviewId} failed:`, e2);
    }
  }
}

// POST /api/reviews — create a review from already-extracted content and kick off
// the async AI review. Responds immediately with the id; client polls /:id/status.
reviewsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const b = req.body ?? {};
  const clientName = typeof b.client_name === "string" ? b.client_name.trim() : "";
  const contractText = typeof b.contract_text === "string" ? b.contract_text : "";
  const documentType = typeof b.document_type === "string" && b.document_type.trim() ? b.document_type.trim() : "Other";
  const projectContext = typeof b.project_context === "string" ? b.project_context : "";
  const reviewFocus = Array.isArray(b.review_focus) ? (b.review_focus as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const contractHtml = typeof b.contract_html === "string" ? b.contract_html : null;
  const contractFilename = typeof b.contract_filename === "string" ? b.contract_filename : null;
  const title = typeof b.title === "string" && b.title.trim() ? b.title.trim() : `${documentType} — ${clientName}`;

  if (!clientName) return void res.status(400).json({ detail: "client_name wajib diisi." });
  if (!contractText.trim()) return void res.status(400).json({ detail: "contract_text wajib diisi." });

  const db = createServerSupabase();
  const { data: review, error } = await db
    .from("reviews")
    .insert({
      user_id: userId,
      title,
      client_name: clientName,
      document_type: documentType,
      contract_filename: contractFilename,
      contract_text: contractText,
      contract_html: contractHtml,
      project_context: projectContext,
      review_focus: reviewFocus,
      status: "processing",
    })
    .select("id")
    .single();
  if (error || !review) return void res.status(500).json({ detail: error?.message ?? "Gagal membuat tinjauan." });

  await db.from("clients").upsert({ name: clientName }, { onConflict: "name" });

  const reviewId = (review as { id: string }).id;
  // Detached: do NOT await — the review runs ~30-60s in the background.
  // .catch is a backstop; runReview already handles its own errors internally.
  void runReview(reviewId, {
    contract_text: contractText,
    client_name: clientName,
    document_type: documentType,
    project_context: projectContext,
    review_focus: reviewFocus,
  }).catch((err) => console.error(`[reviews] runReview crashed for ${reviewId}:`, err));

  res.status(201).json({ id: reviewId, status: "processing" });
});

// GET /api/reviews/:id/status — poll review processing state.
reviewsRouter.get("/:id/status", requireAuth, async (req, res) => {
  const db = createServerSupabase();
  const { data, error } = await db
    .from("reviews")
    .select("id, status, risk_level, recommendation")
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return void res.status(500).json({ detail: error.message });
  if (!data) return void res.status(404).json({ detail: "Tinjauan tidak ditemukan." });
  res.json(data);
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
