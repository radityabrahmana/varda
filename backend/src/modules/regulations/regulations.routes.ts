// HTTP surface of the regulation library.
//   GET    /regulations                   visible regulations + the caller's scope
//   POST   /regulations                   create from metadata (org admin; platform scope for Varda admins)
//   GET    /regulations/:id               one regulation + its outline
//   PATCH  /regulations/:id               edit metadata / status
//   DELETE /regulations/:id
//   PUT    /regulations/:id/file          attach the source file (raw body; ?filename= or x-filename) and parse it
//   POST   /regulations/:id/reparse       re-run extraction + parsing on the stored original
//   GET    /regulations/:id/read?selector=pasal 1266-1267   article text (same as the Assistant's read tool)
//   GET    /regulations/search?q=…&regulation=…              ranked full-text search
//   GET    /regulations/:id/file          download the stored original
//
// Handlers parse, resolve the caller's scope once, call the service and map
// ServiceResults onto status codes. Never query the database here.

import express, { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { buildContentDisposition, createFileReadStream, storageEnabled } from "../../lib/storage";
import { failure, sendServiceFailure } from "../../lib/serviceResult";
import {
  attachRegulationFile,
  createRegulation,
  deleteRegulation,
  getRegulation,
  listRegulations,
  parseRegulationMetaBody,
  parseRegulationPatchBody,
  readRegulation,
  REGULATION_UPLOAD_MAX_BYTES,
  reparseRegulation,
  resolveRegulationScope,
  searchRegulationLibrary,
  summarizeRegulation,
  updateRegulation,
} from "./regulations.service";

export const regulationsRouter = Router();
regulationsRouter.use(requireAuth);

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

function queryString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

regulationsRouter.get("/", asyncRoute(async (_req, res) => {
  const db = createServerSupabase();
  const scope = await resolveRegulationScope(db, res.locals.userId as string);
  const result = await listRegulations(db, scope);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json({
    regulations: result.data.map((r) => ({ ...summarizeRegulation(r), parse_warnings: r.parse_warnings, file_name: r.file_name, updated_at: r.updated_at })),
    scope: { orgIds: scope.orgIds, adminOrgIds: scope.adminOrgIds, platformAdmin: scope.platformAdmin },
  });
}));

regulationsRouter.get("/search", asyncRoute(async (req, res) => {
  const db = createServerSupabase();
  const scope = await resolveRegulationScope(db, res.locals.userId as string);
  const result = await searchRegulationLibrary(db, scope, {
    query: queryString(req.query.q),
    regulation: queryString(req.query.regulation) || undefined,
    limit: Number(req.query.limit) || undefined,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

regulationsRouter.post("/", asyncRoute(async (req, res) => {
  const db = createServerSupabase();
  const scope = await resolveRegulationScope(db, res.locals.userId as string);
  const parsed = parseRegulationMetaBody(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);
  const result = await createRegulation(db, scope, parsed.data);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(201).json(result.data);
}));

regulationsRouter.get("/:id", asyncRoute(async (req, res) => {
  const db = createServerSupabase();
  const scope = await resolveRegulationScope(db, res.locals.userId as string);
  const regulation = await getRegulation(db, scope, req.params.id);
  if (!regulation.ok) return void sendServiceFailure(res, regulation);
  const outline = await readRegulation(db, scope, { regulation: regulation.data.id, selector: "outline" });
  res.json({ regulation: regulation.data, outline: outline.ok ? outline.data.outline : [], note: outline.ok ? outline.data.note : null });
}));

regulationsRouter.patch("/:id", asyncRoute(async (req, res) => {
  const db = createServerSupabase();
  const scope = await resolveRegulationScope(db, res.locals.userId as string);
  const parsed = parseRegulationPatchBody(req.body);
  if (!parsed.ok) return void sendServiceFailure(res, parsed);
  const result = await updateRegulation(db, scope, req.params.id, parsed.data);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

regulationsRouter.delete("/:id", asyncRoute(async (req, res) => {
  const db = createServerSupabase();
  const scope = await resolveRegulationScope(db, res.locals.userId as string);
  const result = await deleteRegulation(db, scope, req.params.id);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(204).end();
}));

regulationsRouter.put(
  "/:id/file",
  express.raw({ type: () => true, limit: REGULATION_UPLOAD_MAX_BYTES }),
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const scope = await resolveRegulationScope(db, res.locals.userId as string);
    const buffer = Buffer.isBuffer(req.body) ? Buffer.from(req.body) : Buffer.alloc(0);
    const result = await attachRegulationFile(db, scope, req.params.id, { buffer, filename: uploadFilename(req) });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

regulationsRouter.post("/:id/reparse", asyncRoute(async (req, res) => {
  const db = createServerSupabase();
  const scope = await resolveRegulationScope(db, res.locals.userId as string);
  const result = await reparseRegulation(db, scope, req.params.id);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

regulationsRouter.get("/:id/read", asyncRoute(async (req, res) => {
  const db = createServerSupabase();
  const scope = await resolveRegulationScope(db, res.locals.userId as string);
  const result = await readRegulation(db, scope, {
    regulation: req.params.id,
    selector: queryString(req.query.selector) || "outline",
    maxChars: Number(req.query.max_chars) || undefined,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

regulationsRouter.get("/:id/file", asyncRoute(async (req, res) => {
  const db = createServerSupabase();
  const scope = await resolveRegulationScope(db, res.locals.userId as string);
  const regulation = await getRegulation(db, scope, req.params.id);
  if (!regulation.ok) return void sendServiceFailure(res, regulation);
  const { file_key, file_name } = regulation.data;
  if (!file_key || !file_name || !storageEnabled) {
    return void sendServiceFailure(res, failure("not_found", "File sumber tidak tersedia."));
  }
  res.setHeader("Content-Disposition", buildContentDisposition("attachment", file_name));
  createFileReadStream(file_key).on("error", (err) => {
    console.error("[regulations] file stream failed", err);
    if (!res.headersSent) res.status(500).end();
  }).pipe(res);
}));

regulationsRouter.use(routerErrorHandler("[regulations]"));
