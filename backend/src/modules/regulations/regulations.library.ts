// Regulation library CRUD and ingestion.
//
// A regulation is created from metadata first, then a file is attached
// (PDF, DOCX or plain text). Attaching extracts the text, parses it into nodes
// (lib/regulationParse.ts), replaces the regulation's nodes and stores the
// original bytes so the parse can be redone after parser improvements.

import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { extractPdfText } from "../../lib/pdfText";
import { normalizeDocxZipPaths } from "../../lib/convert";
import { downloadFile, storageEnabled, uploadFile } from "../../lib/storage";
import { parseRegulationText, type ParsedRegulationNode } from "../../lib/regulationParse";
import {
  canSeeRegulation,
  REGULATION_NOT_FOUND,
  requireManage,
  visibleFilter,
} from "./regulations.access";
import {
  REGULATION_STATUSES,
  type RegulationMetaInput,
  type RegulationMetaPatch,
  type RegulationRow,
  type RegulationScope,
  type RegulationStatus,
} from "./regulations.types";

export const REGULATION_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const NODE_INSERT_BATCH = 400;
const ROW_COLUMNS =
  "id, org_id, created_by, regulation_type, issuer, number, year, title, short_name, status, source_url, notes, file_key, file_name, content_sha256, parse_status, node_count, pasal_count, parse_warnings, created_at, updated_at";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Validation ─────────────────────────────────────────────────────────────

function str(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

function optionalStr(value: unknown, max = 500): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return str(value, max);
}

function parseYear(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1800 && n <= 2200 ? n : undefined;
}

function isStatus(value: unknown): value is RegulationStatus {
  return typeof value === "string" && (REGULATION_STATUSES as string[]).includes(value);
}

export function parseRegulationMetaBody(body: unknown): ServiceResult<RegulationMetaInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const title = str(b.title, 500);
  const short_name = str(b.short_name, 120);
  const regulation_type = str(b.regulation_type, 40)?.toUpperCase() ?? null;
  if (!title) return failure("validation", "title wajib diisi.");
  if (!short_name) return failure("validation", "short_name wajib diisi (misalnya 'KUHPerdata' atau 'PM 60/2019').");
  if (!regulation_type) return failure("validation", "regulation_type wajib diisi (misalnya UU, PP, PERMEN, KUHPERDATA).");
  const year = parseYear(b.year);
  if (year === undefined && b.year !== undefined) return failure("validation", "year harus berupa tahun yang valid.");
  if (b.status !== undefined && !isStatus(b.status)) {
    return failure("validation", `status harus salah satu dari: ${REGULATION_STATUSES.join(", ")}.`);
  }
  if (b.scope !== undefined && b.scope !== "org" && b.scope !== "platform") {
    return failure("validation", "scope harus 'org' atau 'platform'.");
  }
  if (b.org_id !== undefined && b.org_id !== null && !(typeof b.org_id === "string" && UUID_RE.test(b.org_id))) {
    return failure("validation", "org_id tidak valid.");
  }
  return ok({
    scope: (b.scope as "org" | "platform" | undefined) ?? "org",
    org_id: (b.org_id as string | null | undefined) ?? undefined,
    regulation_type,
    issuer: optionalStr(b.issuer) ?? null,
    number: optionalStr(b.number, 60) ?? null,
    year: year ?? null,
    title,
    short_name,
    status: isStatus(b.status) ? b.status : "berlaku",
    source_url: optionalStr(b.source_url, 1000) ?? null,
    notes: optionalStr(b.notes, 4000) ?? null,
  });
}

export function parseRegulationPatchBody(body: unknown): ServiceResult<RegulationMetaPatch> {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: RegulationMetaPatch = {};
  if (b.title !== undefined) {
    const v = str(b.title, 500);
    if (!v) return failure("validation", "title tidak boleh kosong.");
    patch.title = v;
  }
  if (b.short_name !== undefined) {
    const v = str(b.short_name, 120);
    if (!v) return failure("validation", "short_name tidak boleh kosong.");
    patch.short_name = v;
  }
  if (b.regulation_type !== undefined) {
    const v = str(b.regulation_type, 40)?.toUpperCase();
    if (!v) return failure("validation", "regulation_type tidak boleh kosong.");
    patch.regulation_type = v;
  }
  if (b.status !== undefined) {
    if (!isStatus(b.status)) return failure("validation", `status harus salah satu dari: ${REGULATION_STATUSES.join(", ")}.`);
    patch.status = b.status;
  }
  if (b.year !== undefined) {
    const y = parseYear(b.year);
    if (y === undefined) return failure("validation", "year harus berupa tahun yang valid.");
    patch.year = y;
  }
  for (const key of ["issuer", "number", "source_url", "notes"] as const) {
    if (b[key] !== undefined) patch[key] = optionalStr(b[key], key === "notes" ? 4000 : 1000) ?? null;
  }
  if (Object.keys(patch).length === 0) return failure("validation", "Tidak ada perubahan.");
  return ok(patch);
}

/** Pick the org a new regulation belongs to, or null for platform-wide. */
export function resolveTargetOrg(scope: RegulationScope, meta: RegulationMetaInput): ServiceResult<string | null> {
  if (meta.scope === "platform") {
    return scope.platformAdmin ? ok(null) : failure("forbidden", "Hanya administrator Varda yang dapat menambah peraturan lintas organisasi.");
  }
  if (meta.org_id) {
    const check = requireManage(scope, meta.org_id);
    return check.ok ? ok(meta.org_id) : check;
  }
  if (scope.adminOrgIds.length === 1) return ok(scope.adminOrgIds[0]);
  if (scope.adminOrgIds.length === 0) {
    return failure("forbidden", "Hanya administrator organisasi yang dapat menambah peraturan.");
  }
  return failure("validation", "org_id wajib dipilih karena Anda mengelola lebih dari satu organisasi.");
}

// ── Queries ────────────────────────────────────────────────────────────────

function normalizeRow(row: Record<string, unknown>): RegulationRow {
  return {
    ...(row as RegulationRow),
    parse_warnings: Array.isArray(row.parse_warnings) ? (row.parse_warnings as string[]) : [],
  };
}

export async function listRegulations(db: Db, scope: RegulationScope): Promise<ServiceResult<RegulationRow[]>> {
  const { data, error } = await db
    .from("regulations")
    .select(ROW_COLUMNS)
    .or(visibleFilter(scope))
    .order("short_name", { ascending: true });
  if (error) return internalFailure(error);
  return ok(((data ?? []) as Record<string, unknown>[]).map(normalizeRow));
}

export async function getRegulation(db: Db, scope: RegulationScope, id: string): Promise<ServiceResult<RegulationRow>> {
  if (!UUID_RE.test(id)) return failure("not_found", REGULATION_NOT_FOUND);
  const { data, error } = await db.from("regulations").select(ROW_COLUMNS).eq("id", id).maybeSingle();
  if (error) return internalFailure(error);
  if (!data) return failure("not_found", REGULATION_NOT_FOUND);
  const row = normalizeRow(data as Record<string, unknown>);
  if (!canSeeRegulation(scope, row)) return failure("not_found", REGULATION_NOT_FOUND);
  return ok(row);
}

export async function createRegulation(
  db: Db,
  scope: RegulationScope,
  meta: RegulationMetaInput,
): Promise<ServiceResult<RegulationRow>> {
  const target = resolveTargetOrg(scope, meta);
  if (!target.ok) return target;
  const { data, error } = await db
    .from("regulations")
    .insert({
      org_id: target.data,
      created_by: scope.userId,
      regulation_type: meta.regulation_type,
      issuer: meta.issuer ?? null,
      number: meta.number ?? null,
      year: meta.year ?? null,
      title: meta.title,
      short_name: meta.short_name,
      status: meta.status ?? "berlaku",
      source_url: meta.source_url ?? null,
      notes: meta.notes ?? null,
    })
    .select(ROW_COLUMNS)
    .single();
  if (error) return internalFailure(error);
  return ok(normalizeRow(data as Record<string, unknown>));
}

export async function updateRegulation(
  db: Db,
  scope: RegulationScope,
  id: string,
  patch: RegulationMetaPatch,
): Promise<ServiceResult<RegulationRow>> {
  const existing = await getRegulation(db, scope, id);
  if (!existing.ok) return existing;
  const manage = requireManage(scope, existing.data.org_id);
  if (!manage.ok) return manage;
  const { data, error } = await db
    .from("regulations")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(ROW_COLUMNS)
    .single();
  if (error) return internalFailure(error);
  return ok(normalizeRow(data as Record<string, unknown>));
}

export async function deleteRegulation(db: Db, scope: RegulationScope, id: string): Promise<ServiceResult<{ id: string }>> {
  const existing = await getRegulation(db, scope, id);
  if (!existing.ok) return existing;
  const manage = requireManage(scope, existing.data.org_id);
  if (!manage.ok) return manage;
  const { error } = await db.from("regulations").delete().eq("id", id);
  if (error) return internalFailure(error);
  // The stored original is left in place; storage keys embed the regulation
  // id, so it is unreachable and cheap to sweep later.
  return ok({ id });
}

// ── Ingestion ──────────────────────────────────────────────────────────────

export type RegulationFile = { buffer: Buffer; filename: string };

export type IngestDeps = {
  extractText: (file: RegulationFile) => Promise<ServiceResult<string>>;
  storeOriginal: (key: string, file: RegulationFile) => Promise<string | null>;
  fetchOriginal: (key: string) => Promise<Buffer | null>;
};

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

export async function extractRegulationText(file: RegulationFile): Promise<ServiceResult<string>> {
  const ext = extname(file.filename).toLowerCase();
  if (file.buffer.byteLength === 0) return failure("validation", "File kosong.");
  if (file.buffer.byteLength > REGULATION_UPLOAD_MAX_BYTES) return failure("validation", "File terlalu besar. Maksimum 50MB.");
  try {
    if (ext === ".pdf") {
      const ab = file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength) as ArrayBuffer;
      const text = await extractPdfText(ab);
      if (!text.trim()) return failure("validation", "Teks tidak dapat diekstrak dari PDF (kemungkinan hasil scan tanpa OCR).");
      return ok(text);
    }
    if (ext === ".docx") {
      const normalized = await normalizeDocxZipPaths(file.buffer);
      const mammoth = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer: normalized });
      if (!value.trim()) return failure("validation", "Teks tidak dapat diekstrak dari DOCX.");
      return ok(value);
    }
    if (ext === ".txt" || ext === ".md") {
      const text = file.buffer.toString("utf8");
      if (!text.trim()) return failure("validation", "File teks kosong.");
      return ok(text);
    }
    return failure("validation", "Format tidak didukung. Unggah PDF, DOCX atau TXT.");
  } catch (err) {
    return internalFailure(err);
  }
}

async function storeOriginalInBucket(key: string, file: RegulationFile): Promise<string | null> {
  if (!storageEnabled) return null;
  const ext = extname(file.filename).toLowerCase();
  const ab = file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength) as ArrayBuffer;
  await uploadFile(key, ab, CONTENT_TYPES[ext] ?? "application/octet-stream");
  return key;
}

async function fetchOriginalFromBucket(key: string): Promise<Buffer | null> {
  if (!storageEnabled) return null;
  const ab = await downloadFile(key);
  return ab ? Buffer.from(ab) : null;
}

export const DEFAULT_INGEST_DEPS: IngestDeps = {
  extractText: extractRegulationText,
  storeOriginal: storeOriginalInBucket,
  fetchOriginal: fetchOriginalFromBucket,
};

export function regulationFileKey(id: string, filename: string): string {
  const ext = extname(filename).toLowerCase() || ".bin";
  return `regulations/${id}/source${ext}`;
}

async function replaceNodes(db: Db, regulationId: string, nodes: ParsedRegulationNode[]): Promise<ServiceResult<true>> {
  const del = await db.from("regulation_nodes").delete().eq("regulation_id", regulationId);
  if (del.error) return internalFailure(del.error);
  for (let i = 0; i < nodes.length; i += NODE_INSERT_BATCH) {
    const batch = nodes.slice(i, i + NODE_INSERT_BATCH).map((n) => ({ regulation_id: regulationId, ...n }));
    const ins = await db.from("regulation_nodes").insert(batch);
    if (ins.error) return internalFailure(ins.error);
  }
  return ok(true);
}

async function ingest(
  db: Db,
  row: RegulationRow,
  file: RegulationFile,
  fileKey: string | null,
  deps: IngestDeps,
): Promise<ServiceResult<RegulationRow>> {
  const extracted = await deps.extractText(file);
  if (!extracted.ok) {
    if (extracted.kind === "validation") return extracted;
    await db.from("regulations").update({ parse_status: "failed", updated_at: new Date().toISOString() }).eq("id", row.id);
    return extracted;
  }
  const parsed = parseRegulationText(extracted.data);
  const replaced = await replaceNodes(db, row.id, parsed.nodes);
  if (!replaced.ok) return replaced;
  const { data, error } = await db
    .from("regulations")
    .update({
      file_key: fileKey,
      file_name: file.filename,
      content_sha256: createHash("sha256").update(file.buffer).digest("hex"),
      parse_status: "parsed",
      node_count: parsed.nodes.length,
      pasal_count: parsed.stats.pasal,
      parse_warnings: parsed.warnings.slice(0, 200),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .select(ROW_COLUMNS)
    .single();
  if (error) return internalFailure(error);
  return ok(normalizeRow(data as Record<string, unknown>));
}

/** Attach (or replace) the source file of a regulation and parse it. */
export async function attachRegulationFile(
  db: Db,
  scope: RegulationScope,
  id: string,
  file: RegulationFile,
  deps: IngestDeps = DEFAULT_INGEST_DEPS,
): Promise<ServiceResult<RegulationRow>> {
  const existing = await getRegulation(db, scope, id);
  if (!existing.ok) return existing;
  const manage = requireManage(scope, existing.data.org_id);
  if (!manage.ok) return manage;
  if (!file.filename.trim()) return failure("validation", "Nama file wajib disertakan.");
  let fileKey: string | null = null;
  try {
    fileKey = await deps.storeOriginal(regulationFileKey(id, file.filename), file);
  } catch (err) {
    console.warn("[regulations] could not store the original file; continuing without it", err);
  }
  return ingest(db, existing.data, file, fileKey, deps);
}

/** Re-run extraction and parsing on the stored original (after parser changes). */
export async function reparseRegulation(
  db: Db,
  scope: RegulationScope,
  id: string,
  deps: IngestDeps = DEFAULT_INGEST_DEPS,
): Promise<ServiceResult<RegulationRow>> {
  const existing = await getRegulation(db, scope, id);
  if (!existing.ok) return existing;
  const manage = requireManage(scope, existing.data.org_id);
  if (!manage.ok) return manage;
  if (!existing.data.file_key || !existing.data.file_name) {
    return failure("conflict", "Peraturan ini belum memiliki file sumber.");
  }
  const buffer = await deps.fetchOriginal(existing.data.file_key);
  if (!buffer) return failure("unavailable", "File sumber tidak dapat diambil dari penyimpanan.");
  return ingest(db, existing.data, { buffer, filename: existing.data.file_name }, existing.data.file_key, deps);
}
