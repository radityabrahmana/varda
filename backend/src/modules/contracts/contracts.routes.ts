// HTTP layer for the contracts module (Janus contract review inside Varda):
//   GET    /contracts               reviews the caller can see (own + shared; all for admins)
//   GET    /contracts/me            caller identity + admin flag (client-side gating)
//   GET    /contracts/:id           full review + feedback + comments (workspace)
//   GET    /contracts/:id/file      stream the working redline DOCX (or ?variant=original; ?download=1)
//   POST   /contracts/:id/redline/project           project AI revisions into tracked changes (idempotent)
//   POST   /contracts/:id/revisions/:rev/accept|reject|edit  resolve a tracked change + feedback row
//   POST   /contracts/:id/memo                       generate the negotiation memo (janus-tools proxy)
//   PUT    /contracts/:id/negotiation-points/:pointId  BD status per memo point
//   POST   /contracts/upload        raw DOCX bytes → extracted text + HTML
//   POST   /contracts               create a review row and start the async AI review
//   GET    /contracts/:id/status    poll review processing state
//   DELETE /contracts/:id           owner or admin
//   GET    /contracts/:id/people    share-dialog roster (uploader + grants)
//   GET    /contracts/:id/access    direct grants (owner or admin)
//   POST   /contracts/:id/access    grant / re-role one recipient { email, role }
//   DELETE /contracts/:id/access/:email  revoke one recipient
//   PATCH  /contracts/:id           status / lifecycle_stage (+status sync) / dates / COO override
//   POST   /contracts/:id/feedback  one review_feedback row (the moat); /feedback/bulk for many
//   POST   /contracts/:id/comments  manual comment or reply (parent_comment_id)
//   POST   /contracts/:id/missed-clause  "AI melewatkan klausul ini" training signal
//   POST   /contracts/:id/clauses   save an approved wording to clause_library
//
// Handlers parse the request, call contracts.service, and map ServiceResults
// onto status codes. Never query the database here.
//
// Access: every /:id route first resolves the caller's standing on the review
// (router.param below → res.locals.reviewAccess; 404 when they may not see it),
// then declares the capability it needs with `allowed(res, …)`.
//
// The upload endpoint takes the file as a raw body (Content-Type
// application/octet-stream, filename in `?filename=` or `x-filename`) instead of
// multipart: the multipart helper left the kernel when uploads moved to the
// object-storage session protocol, and a 25MB in-memory DOCX needs no session.

import express, { Router } from "express";
import { pipeline } from "node:stream/promises";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { buildContentDisposition, createFileReadStream } from "../../lib/storage";
import { sendServiceFailure } from "../../lib/serviceResult";
import type { Capability } from "../../lib/permissions";
import {
  CONTRACT_UPLOAD_MAX_BYTES,
  DOCX_MIME,
  attachDocxToReview,
  attachDocxUploadToReview,
  createComment,
  createFeedback,
  createFeedbackBulk,
  createMissedClauseSignal,
  createReview,
  deleteReview,
  editRevision,
  generateNegotiationMemo,
  extractContract,
  getCallerIdentity,
  getReviewDetail,
  getReviewFileSource,
  getReviewStatus,
  grantReviewAccess,
  listReviewGrants,
  listReviewPeople,
  listReviews,
  requireReviewCapability,
  resolveReviewAccess,
  revokeReviewAccess,
  type ReviewAccess,
  parseClauseBody,
  parseCommentBody,
  parseCreateReviewBody,
  parseFeedbackBody,
  parseFeedbackBulkBody,
  parseMissedClauseBody,
  parsePointStatusBody,
  parseReviewPatch,
  projectRevisions,
  resolveRevision,
  runReview,
  saveClauseToLibrary,
  stashUploadedDocx,
  updateReviewMeta,
  upsertNegotiationPoint,
} from "./contracts.service";

export const contractsRouter = Router();
contractsRouter.use(requireAuth);

contractsRouter.param("id", (req, res, next, id: string) => {
  resolveReviewAccess(createServerSupabase(), {
    reviewId: id,
    userId: res.locals.userId as string,
    email: res.locals.userEmail as string | undefined,
  })
    .then((access) => {
      if (!access.ok) return void sendServiceFailure(res, access);
      res.locals.reviewAccess = access.data;
      next();
    })
    .catch(next);
});

function reviewAccess(res: express.Response): ReviewAccess {
  return res.locals.reviewAccess as ReviewAccess;
}

/** Sends 403 and returns false when the caller's role on the review lacks `capability`. */
function allowed(res: express.Response, capability: Capability): boolean {
  const check = requireReviewCapability(reviewAccess(res), capability);
  if (check.ok) return true;
  sendServiceFailure(res, check);
  return false;
}

contractsRouter.get("/", asyncRoute(async (_req, res) => {
  const result = await listReviews(createServerSupabase(), {
    userId: res.locals.userId as string,
    email: res.locals.userEmail as string | undefined,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

contractsRouter.get("/me", asyncRoute(async (_req, res) => {
  const result = await getCallerIdentity(createServerSupabase(), {
    userId: res.locals.userId as string,
    email: res.locals.userEmail as string | undefined,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

// Query values can arrive as arrays or objects (`?filename[]=`), so only a plain
// string is accepted; anything else is treated as absent.
function uploadFilename(req: express.Request): string {
  const fromQuery: unknown = req.query.filename;
  const fromHeader: unknown = req.get("x-filename");
  const raw = typeof fromQuery === "string" && fromQuery ? fromQuery : typeof fromHeader === "string" ? fromHeader : "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

contractsRouter.post(
  "/upload",
  express.raw({ type: () => true, limit: CONTRACT_UPLOAD_MAX_BYTES }),
  asyncRoute(async (req, res) => {
    // Copy into a fresh Buffer so downstream code never handles the raw request
    // body object (which could be an array/string if a different parser ran).
    const buffer = Buffer.isBuffer(req.body) ? Buffer.from(req.body) : Buffer.alloc(0);
    const result = await extractContract({ buffer, filename: uploadFilename(req) });
    if (!result.ok) return void sendServiceFailure(res, result);
    // Keep the original bytes (when storage is configured) so the workspace can
    // render the real DOCX and project tracked changes onto it.
    let docx_key: string | null = null;
    try {
      docx_key = await stashUploadedDocx(buffer);
    } catch (e) {
      console.warn("[contracts] could not stash uploaded DOCX; continuing in HTML-only mode", e);
    }
    res.json({ ...result.data, docx_key });
  }),
);

contractsRouter.post("/", asyncRoute(async (req, res) => {
  const parsed = parseCreateReviewBody(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);

  const db = createServerSupabase();
  const created = await createReview(db, { userId: res.locals.userId as string, input: parsed.data });
  if (!created.ok) return void sendServiceFailure(res, created);

  if (parsed.data.contract_docx_path) {
    const attached = await attachDocxToReview(db, { reviewId: created.data.id, stashedKey: parsed.data.contract_docx_path });
    if (!attached.ok) console.warn(`[contracts] could not attach DOCX to ${created.data.id}:`, attached);
  }

  // Detached: the AI review runs ~30-60s. runReview handles its own errors and
  // flips the row to "failed"; .catch is a backstop against a crashed promise.
  void runReview(db, created.data.id, parsed.data).catch((err) =>
    console.error(`[contracts] runReview crashed for ${created.data.id}:`, err),
  );

  res.status(201).json(created.data);
}));

contractsRouter.get("/:id", asyncRoute(async (req, res) => {
  const result = await getReviewDetail(createServerSupabase(), req.params.id);
  if (!result.ok) return void sendServiceFailure(res, result);
  const access = reviewAccess(res);
  res.json({ ...result.data, access: { role: access.role, via: access.via } });
}));

contractsRouter.get("/:id/file", asyncRoute(async (req, res) => {
  const variant = req.query.variant === "original" ? "original" : "current";
  const result = await getReviewFileSource(createServerSupabase(), req.params.id, variant);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.setHeader("Content-Type", DOCX_MIME);
  if (result.data.size) res.setHeader("Content-Length", result.data.size);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(req.query.download === "1" ? "attachment" : "inline", result.data.filename),
  );
  const source = createFileReadStream(result.data.key);
  try {
    await pipeline(source, res);
  } catch (error) {
    source.destroy();
    if (!res.headersSent && !res.destroyed) res.status(500).end();
    else console.error("[contracts] file stream failed", error);
  }
}));

// Repair path for a review whose DOCX was never persisted: accept the original
// again, then project the AI revisions onto it so the redline appears.
contractsRouter.post(
  "/:id/docx",
  express.raw({ type: () => true, limit: CONTRACT_UPLOAD_MAX_BYTES }),
  asyncRoute(async (req, res) => {
    if (!allowed(res, "content.edit")) return;
    const buffer = Buffer.isBuffer(req.body) ? Buffer.from(req.body) : Buffer.alloc(0);
    const db = createServerSupabase();
    const attached = await attachDocxUploadToReview(db, { reviewId: req.params.id, buffer, filename: uploadFilename(req) });
    if (!attached.ok) return void sendServiceFailure(res, attached);
    const projection = await projectRevisions(db, { reviewId: req.params.id });
    res.json({ ...attached.data, projection: projection.ok ? projection.data : null });
  }),
);

contractsRouter.post("/:id/redline/project", asyncRoute(async (req, res) => {
  if (!allowed(res, "content.edit")) return;
  const result = await projectRevisions(createServerSupabase(), { reviewId: req.params.id });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

contractsRouter.post("/:id/revisions/:revisionId/:verb", asyncRoute(async (req, res) => {
  if (!allowed(res, "content.edit")) return;
  const { id, revisionId, verb } = req.params;
  const body = (req.body ?? {}) as { rationale?: unknown; edited_text?: unknown };
  const rationale = typeof body.rationale === "string" ? body.rationale.trim() : "";
  const db = createServerSupabase();
  const userId = res.locals.userId as string;
  if (verb === "accept" || verb === "reject") {
    if (verb === "reject" && !rationale) {
      return void res.status(400).json({ detail: "Alasan wajib diisi untuk tindakan ini." });
    }
    const result = await resolveRevision(db, { reviewId: id, revisionId, mode: verb, userId, rationale: rationale || null });
    if (!result.ok) return void sendServiceFailure(res, result);
    return void res.json(result.data);
  }
  if (verb === "edit") {
    const editedText = typeof body.edited_text === "string" ? body.edited_text : "";
    const result = await editRevision(db, {
      reviewId: id,
      revisionId,
      editedText,
      userId,
      userEmail: res.locals.userEmail as string | undefined,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    return void res.json(result.data);
  }
  res.status(404).json({ detail: "Aksi tidak dikenal." });
}));

contractsRouter.post("/:id/memo", asyncRoute(async (req, res) => {
  if (!allowed(res, "content.edit")) return;
  const result = await generateNegotiationMemo(createServerSupabase(), { reviewId: req.params.id });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

contractsRouter.put("/:id/negotiation-points/:pointId", asyncRoute(async (req, res) => {
  if (!allowed(res, "content.edit")) return;
  const parsed = parsePointStatusBody(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);
  const result = await upsertNegotiationPoint(createServerSupabase(), {
    reviewId: req.params.id,
    pointId: req.params.pointId,
    userId: res.locals.userId as string,
    status: parsed.data.status,
    clientResponse: parsed.data.client_response ?? null,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

contractsRouter.get("/:id/status", asyncRoute(async (req, res) => {
  const result = await getReviewStatus(createServerSupabase(), req.params.id);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

contractsRouter.patch("/:id", asyncRoute(async (req, res) => {
  if (!allowed(res, "content.edit")) return;
  const parsed = parseReviewPatch(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);
  const result = await updateReviewMeta(createServerSupabase(), { reviewId: req.params.id, patch: parsed.data });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

contractsRouter.post("/:id/feedback", asyncRoute(async (req, res) => {
  if (!allowed(res, "content.edit")) return;
  const parsed = parseFeedbackBody(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);
  const result = await createFeedback(createServerSupabase(), {
    reviewId: req.params.id,
    userId: res.locals.userId as string,
    input: parsed.data,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(201).json(result.data);
}));

contractsRouter.post("/:id/feedback/bulk", asyncRoute(async (req, res) => {
  if (!allowed(res, "content.edit")) return;
  const parsed = parseFeedbackBulkBody(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);
  const result = await createFeedbackBulk(createServerSupabase(), {
    reviewId: req.params.id,
    userId: res.locals.userId as string,
    inputs: parsed.data,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(201).json(result.data);
}));

contractsRouter.post("/:id/comments", asyncRoute(async (req, res) => {
  if (!allowed(res, "content.edit")) return;
  const parsed = parseCommentBody(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);
  const result = await createComment(createServerSupabase(), {
    reviewId: req.params.id,
    userId: res.locals.userId as string,
    userEmail: res.locals.userEmail as string | undefined,
    input: parsed.data,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(201).json(result.data);
}));

contractsRouter.post("/:id/missed-clause", asyncRoute(async (req, res) => {
  if (!allowed(res, "content.edit")) return;
  const parsed = parseMissedClauseBody(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);
  const result = await createMissedClauseSignal(createServerSupabase(), {
    reviewId: req.params.id,
    userId: res.locals.userId as string,
    input: parsed.data,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(201).json(result.data);
}));

contractsRouter.post("/:id/clauses", asyncRoute(async (req, res) => {
  if (!allowed(res, "content.edit")) return;
  const parsed = parseClauseBody(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);
  const result = await saveClauseToLibrary(createServerSupabase(), {
    reviewId: req.params.id,
    userId: res.locals.userId as string,
    input: parsed.data,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(201).json(result.data);
}));

contractsRouter.delete("/:id", asyncRoute(async (req, res) => {
  if (!allowed(res, "container.delete")) return;
  const result = await deleteReview(createServerSupabase(), { reviewId: req.params.id });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(204).send();
}));

// --- Sharing (mirrors /chat/:chatId/people|access) ---------------------------

contractsRouter.get("/:id/people", asyncRoute(async (_req, res) => {
  const result = await listReviewPeople(createServerSupabase(), reviewAccess(res));
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

contractsRouter.get("/:id/access", asyncRoute(async (req, res) => {
  if (!allowed(res, "access.manage")) return;
  const result = await listReviewGrants(createServerSupabase(), req.params.id);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json({ scope: "direct", org_id: null, access_role: reviewAccess(res).role, grants: result.data });
}));

contractsRouter.post("/:id/access", asyncRoute(async (req, res) => {
  if (!allowed(res, "access.manage")) return;
  const body = (req.body ?? {}) as { email?: unknown; role?: unknown };
  const callerEmail = ((res.locals.userEmail as string | undefined) ?? "").trim().toLowerCase();
  if (typeof body.email === "string" && callerEmail && body.email.trim().toLowerCase() === callerEmail) {
    return void res.status(400).json({ detail: "Anda tidak dapat membagikan tinjauan kepada diri sendiri." });
  }
  const result = await grantReviewAccess(createServerSupabase(), {
    access: reviewAccess(res),
    grantedBy: res.locals.userId as string,
    email: body.email,
    role: body.role,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(201).json(result.data);
}));

contractsRouter.delete("/:id/access/:email", asyncRoute(async (req, res) => {
  if (!allowed(res, "access.manage")) return;
  const result = await revokeReviewAccess(createServerSupabase(), {
    reviewId: req.params.id,
    email: decodeURIComponent(req.params.email),
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(204).send();
}));

contractsRouter.use(routerErrorHandler("[contracts]"));
