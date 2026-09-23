// Suggestion mode: a person proposes an edit directly in the contract DOCX.
//
// The workspace sends the selected text plus the paragraph text around it; we
// write ONE tracked change (w:del of the selection, w:ins of the replacement)
// into the working redline under the author's name — what Word shows in
// "Suggesting" mode. Nothing is removed until someone accepts: Accept keeps the
// new text, Reject restores the original. Pure deletions (empty replacement)
// and insertions (replacement = selection + added text, which the library's
// prefix/suffix diff turns into a lone w:ins) use the same path.
//
// Rows live in review_suggestions (janus-migrations/20260923_03). All writes to
// the working DOCX go through withReviewDocLock.

import type { Db } from "../../lib/supabase";
import { storageEnabled } from "../../lib/storage";
import { applyTrackedEdits, extractTrackedChangeIds, resolveTrackedChange } from "../../lib/docxTrackedChanges";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { withReviewDocLock } from "./contracts.docLock";
import { displayNameFromEmail } from "./contracts.feedback";
import { loadBytes, redlineDocxKey, storeBytes } from "./contracts.redline";

export interface SuggestionRow {
  id: string;
  review_id: string;
  author_user_id: string | null;
  author_email: string | null;
  author_name: string;
  original_text: string;
  suggested_text: string;
  note: string | null;
  change_id: string | null;
  del_w_id: string | null;
  ins_w_id: string | null;
  status: "pending" | "accepted" | "rejected";
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SuggestionInput {
  selected_text: string;
  replacement: string;
  context_before: string;
  context_after: string;
  note: string | null;
}

const MAX_SELECTION = 4000;
const MAX_REPLACEMENT = 8000;
const MAX_CONTEXT = 400;
const MAX_NOTE = 2000;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Validate the request body. Context is trimmed to the characters nearest the selection. */
export function parseSuggestionBody(body: unknown): ServiceResult<SuggestionInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const selected = str(b.selected_text);
  const replacement = str(b.replacement);
  const note = str(b.note).trim();
  if (!selected.trim()) return failure("validation", "Pilih teks di dokumen terlebih dahulu.");
  if (selected.length > MAX_SELECTION) return failure("validation", "Pilihan terlalu panjang. Sarankan per paragraf.");
  if (replacement.length > MAX_REPLACEMENT) return failure("validation", "Teks saran terlalu panjang.");
  if (replacement === selected) return failure("validation", "Teks saran sama dengan teks asli.");
  if (note.length > MAX_NOTE) return failure("validation", "Catatan terlalu panjang.");
  return ok({
    selected_text: selected,
    replacement,
    context_before: str(b.context_before).slice(-MAX_CONTEXT),
    context_after: str(b.context_after).slice(0, MAX_CONTEXT),
    note: note || null,
  });
}

export async function listSuggestions(db: Db, reviewId: string): Promise<ServiceResult<SuggestionRow[]>> {
  const { data, error } = await db
    .from("review_suggestions")
    .select("*")
    .eq("review_id", reviewId)
    .order("created_at", { ascending: true });
  if (error) return internalFailure(error);
  return ok((data ?? []) as unknown as SuggestionRow[]);
}

/** The name Word shows on the change: profile display name, else the email's local part. */
async function authorNameFor(db: Db, userId: string, email: string | null | undefined): Promise<string> {
  const { data } = await db.from("user_profiles").select("display_name").eq("user_id", userId).maybeSingle();
  const name = ((data as { display_name?: string | null } | null)?.display_name ?? "").trim();
  return name || displayNameFromEmail(email);
}

type WorkingDoc = { key: string; bytes: Buffer; isNewRedline: boolean };

async function loadWorkingDoc(db: Db, reviewId: string): Promise<ServiceResult<WorkingDoc>> {
  const { data, error } = await db
    .from("reviews")
    .select("id, contract_docx_path, contract_redline_path")
    .eq("id", reviewId)
    .maybeSingle();
  if (error) return internalFailure(error);
  const row = data as { contract_docx_path: string | null; contract_redline_path: string | null } | null;
  if (!row) return failure("not_found", "Tinjauan tidak ditemukan.");
  if (!row.contract_docx_path) {
    return failure("validation", "Saran langsung di dokumen membutuhkan DOCX asli. Unggah DOCX asli terlebih dahulu.");
  }
  const source = row.contract_redline_path ?? row.contract_docx_path;
  const bytes = await loadBytes(source);
  if (!bytes) return failure("not_found", "Berkas kontrak tidak dapat dibaca dari penyimpanan.");
  // The first human or AI change turns the untouched upload into a working copy.
  return ok({ key: row.contract_redline_path ?? redlineDocxKey(reviewId), bytes, isNewRedline: !row.contract_redline_path });
}

const idKey = (c: { kind: string; w_id: string }) => `${c.kind}:${c.w_id}`;

export function createSuggestion(
  db: Db,
  args: { reviewId: string; userId: string; userEmail?: string | null; input: SuggestionInput },
): Promise<ServiceResult<SuggestionRow>> {
  return withReviewDocLock(args.reviewId, () => createSuggestionUnlocked(db, args));
}

async function createSuggestionUnlocked(
  db: Db,
  args: { reviewId: string; userId: string; userEmail?: string | null; input: SuggestionInput },
): Promise<ServiceResult<SuggestionRow>> {
  if (!storageEnabled) return failure("unavailable", "Penyimpanan dokumen belum dikonfigurasi.");
  const doc = await loadWorkingDoc(db, args.reviewId);
  if (!doc.ok) return doc;
  const author = await authorNameFor(db, args.userId, args.userEmail);
  const { input } = args;

  let result;
  let before: { kind: "ins" | "del"; w_id: string }[];
  let after: { kind: "ins" | "del"; w_id: string }[];
  try {
    before = await extractTrackedChangeIds(doc.data.bytes);
    result = await applyTrackedEdits(
      doc.data.bytes,
      [
        {
          find: input.selected_text,
          replace: input.replacement,
          context_before: input.context_before,
          context_after: input.context_after,
          reason: input.note ?? undefined,
        },
      ],
      { author },
    );
    after = result.changes.length ? await extractTrackedChangeIds(result.bytes) : before;
  } catch (e) {
    return internalFailure(e);
  }
  if (result.errors.length || result.changes.length === 0) {
    return failure(
      "conflict",
      `Teks yang dipilih tidak dapat ditemukan tepat di dokumen (${result.errors[0]?.reason ?? "tidak ada perubahan"}). Pilih ulang teks dalam satu paragraf.`,
    );
  }
  // Editing on top of someone else's pending change would silently accept it
  // (the library unwraps it). Refuse instead of changing their suggestion.
  const afterKeys = new Set(after.map(idKey));
  if (before.some((c) => !afterKeys.has(idKey(c)))) {
    return failure("conflict", "Teks ini bertumpuk dengan perubahan lain yang belum diputuskan. Terima atau tolak perubahan itu dulu.");
  }

  const change = result.changes[0];
  try {
    await storeBytes(doc.data.key, result.bytes);
  } catch (e) {
    return internalFailure(e);
  }
  if (doc.data.isNewRedline) {
    const { error } = await db.from("reviews").update({ contract_redline_path: doc.data.key }).eq("id", args.reviewId);
    if (error) return internalFailure(error);
  }

  const { data, error } = await db
    .from("review_suggestions")
    .insert({
      review_id: args.reviewId,
      author_user_id: args.userId,
      author_email: args.userEmail ?? null,
      author_name: author,
      original_text: change.deletedText,
      suggested_text: change.insertedText,
      note: input.note,
      change_id: change.id,
      del_w_id: change.delId ?? null,
      ins_w_id: change.insId ?? null,
      status: "pending",
    })
    .select("*")
    .single();
  if (error || !data) return internalFailure(error ?? new Error("Gagal menyimpan saran."));
  return ok(data as unknown as SuggestionRow);
}

export function resolveSuggestion(
  db: Db,
  args: { reviewId: string; suggestionId: string; mode: "accept" | "reject"; userId: string },
): Promise<ServiceResult<SuggestionRow>> {
  return withReviewDocLock(args.reviewId, () => resolveSuggestionUnlocked(db, args));
}

async function resolveSuggestionUnlocked(
  db: Db,
  args: { reviewId: string; suggestionId: string; mode: "accept" | "reject"; userId: string },
): Promise<ServiceResult<SuggestionRow>> {
  const { data, error } = await db
    .from("review_suggestions")
    .select("*")
    .eq("id", args.suggestionId)
    .eq("review_id", args.reviewId)
    .maybeSingle();
  if (error) return internalFailure(error);
  const row = data as unknown as SuggestionRow | null;
  if (!row) return failure("not_found", "Saran tidak ditemukan.");
  if (row.status !== "pending") return failure("conflict", "Saran ini sudah diputuskan.");

  const doc = await loadWorkingDoc(db, args.reviewId);
  if (!doc.ok) return doc;
  const ids = [row.del_w_id, row.ins_w_id].filter((v): v is string => Boolean(v));
  try {
    const resolved = await resolveTrackedChange(doc.data.bytes, ids, args.mode);
    // Not found = the change is already gone from the file (resolved in an
    // exported copy that was re-uploaded, say); record the decision anyway.
    if (resolved.found) await storeBytes(doc.data.key, resolved.bytes);
  } catch (e) {
    return internalFailure(e);
  }

  const now = new Date().toISOString();
  const { data: updated, error: uErr } = await db
    .from("review_suggestions")
    .update({ status: args.mode === "accept" ? "accepted" : "rejected", resolved_by: args.userId, resolved_at: now, updated_at: now })
    .eq("id", row.id)
    .select("*")
    .single();
  if (uErr || !updated) return internalFailure(uErr ?? new Error("Gagal memperbarui saran."));
  return ok(updated as unknown as SuggestionRow);
}

/** Ordered w:ids of every tracked change in the working DOCX, for the viewer to tag rendered <ins>/<del>. */
export async function listTrackedChangeIds(
  db: Db,
  reviewId: string,
): Promise<ServiceResult<{ ids: { kind: "ins" | "del"; w_id: string }[] }>> {
  const { data, error } = await db
    .from("reviews")
    .select("contract_docx_path, contract_redline_path")
    .eq("id", reviewId)
    .maybeSingle();
  if (error) return internalFailure(error);
  const row = data as { contract_docx_path: string | null; contract_redline_path: string | null } | null;
  const key = row?.contract_redline_path ?? row?.contract_docx_path;
  if (!key) return ok({ ids: [] });
  try {
    const bytes = await loadBytes(key);
    return ok({ ids: bytes ? await extractTrackedChangeIds(bytes) : [] });
  } catch (e) {
    return internalFailure(e);
  }
}
