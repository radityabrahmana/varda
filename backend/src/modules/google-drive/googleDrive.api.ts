// Thin Drive v3 client: list, inspect and fetch the bytes of one file.
// Every call takes the access token and a fetch so tests never touch the
// network. Hosts are fixed (googleapis.com), so no SSRF guard is needed.

import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import type { FetchLike } from "./googleDrive.oauth";
import {
  DRIVE_API_URL,
  MAX_DOWNLOAD_BYTES,
  MAX_EXPORT_BYTES,
  importPlanFor,
  importableMimeTypes,
  summarizeDriveFile,
  type DriveFile,
  type DriveFileSummary,
} from "./googleDrive.shared";

const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,webViewLink,headRevisionId,size,owners(emailAddress)";

export const LIST_PAGE_SIZE = 25;
export const MAX_QUERY_LENGTH = 200;

type RawDriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  headRevisionId?: string;
  size?: string;
  owners?: Array<{ emailAddress?: string }>;
};

function normalizeFile(raw: RawDriveFile): DriveFile {
  const size = raw.size ? Number.parseInt(raw.size, 10) : NaN;
  return {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    modifiedTime: raw.modifiedTime ?? null,
    webViewLink: raw.webViewLink ?? null,
    headRevisionId: raw.headRevisionId ?? null,
    size: Number.isFinite(size) ? size : null,
    ownerEmail: raw.owners?.[0]?.emailAddress ?? null,
  };
}

/** Drive query strings quote with single quotes; escape backslash and quote. */
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * The `q` parameter for the listing: not trashed, an importable type, and
 * optionally a name match. Drive's `contains` is a prefix-of-word match,
 * which is what a picker search expects.
 */
export function buildListQuery(search: string): string {
  const types = importableMimeTypes()
    .map((mime) => `mimeType = '${mime}'`)
    .join(" or ");
  const clauses = ["trashed = false", `(${types})`];
  const trimmed = search.trim().slice(0, MAX_QUERY_LENGTH);
  if (trimmed) clauses.push(`name contains '${escapeDriveQueryValue(trimmed)}'`);
  return clauses.join(" and ");
}

async function driveError(response: Response, what: string): Promise<ServiceResult<never>> {
  let message = "";
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    message = body.error?.message ?? "";
  } catch {
    /* non-JSON body */
  }
  console.error("[google-drive] request failed", { what, status: response.status, message });
  if (response.status === 401) {
    return failure("conflict", "Google rejected the connection. Connect Google Drive again.", "google_drive_not_connected");
  }
  if (response.status === 403) {
    return failure("forbidden", "Google Drive refused access to this file.");
  }
  if (response.status === 404) return failure("not_found", "File not found in Google Drive.");
  if (response.status === 429) return failure("unavailable", "Google Drive is rate limiting requests. Try again shortly.");
  return failure("unavailable", "Google Drive did not answer. Try again.");
}

export async function listDriveFiles(
  fetchImpl: FetchLike,
  accessToken: string,
  args: { search: string; pageToken?: string | null },
): Promise<ServiceResult<{ files: DriveFileSummary[]; next_page_token: string | null }>> {
  const url = new URL(`${DRIVE_API_URL}/files`);
  url.searchParams.set("q", buildListQuery(args.search));
  url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
  url.searchParams.set("pageSize", String(LIST_PAGE_SIZE));
  url.searchParams.set("orderBy", args.search.trim() ? "modifiedTime desc" : "viewedByMeTime desc,modifiedTime desc");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("corpora", "allDrives");
  if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    return internalFailure(error);
  }
  if (!response.ok) return driveError(response, "files.list");
  const body = (await response.json()) as { nextPageToken?: string; files?: RawDriveFile[] };
  const files = (body.files ?? [])
    .map((raw) => summarizeDriveFile(normalizeFile(raw)))
    .filter((file): file is DriveFileSummary => file !== null);
  return ok({ files, next_page_token: body.nextPageToken ?? null });
}

export async function getDriveFile(
  fetchImpl: FetchLike,
  accessToken: string,
  fileId: string,
): Promise<ServiceResult<DriveFile>> {
  const url = new URL(`${DRIVE_API_URL}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", FILE_FIELDS);
  url.searchParams.set("supportsAllDrives", "true");
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    return internalFailure(error);
  }
  if (!response.ok) return driveError(response, "files.get");
  return ok(normalizeFile((await response.json()) as RawDriveFile));
}

export type FetchedDriveContent = {
  buffer: Buffer;
  fileType: string;
  /** The stored filename: Drive name plus the exported extension. */
  filename: string;
};

/** The Drive name with the stored extension, without a doubled suffix. */
export function importedFilename(name: string, fileType: string): string {
  const trimmed = name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim() || "document";
  const suffix = `.${fileType}`;
  return trimmed.toLowerCase().endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
}

/**
 * Export a native Google file as its Office counterpart, or download a
 * stored Office/PDF file as-is. Sizes are capped before the body is read.
 */
export async function fetchDriveFileContent(
  fetchImpl: FetchLike,
  accessToken: string,
  file: DriveFile,
): Promise<ServiceResult<FetchedDriveContent>> {
  const plan = importPlanFor(file.mimeType);
  if (!plan) return failure("validation", "This Google Drive file type cannot be imported.");
  const id = encodeURIComponent(file.id);
  const url =
    plan.kind === "export"
      ? `${DRIVE_API_URL}/files/${id}/export?mimeType=${encodeURIComponent(plan.exportMime)}`
      : `${DRIVE_API_URL}/files/${id}?alt=media&supportsAllDrives=true`;
  const limit = plan.kind === "export" ? MAX_EXPORT_BYTES : MAX_DOWNLOAD_BYTES;
  if (plan.kind === "download" && file.size != null && file.size > limit) {
    return failure("validation", "This file is larger than Varda accepts (100 MB).");
  }
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (error) {
    return internalFailure(error);
  }
  if (!response.ok) return driveError(response, plan.kind === "export" ? "files.export" : "files.download");
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > limit) {
    return failure("validation", "This file is too large to import.");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > limit) return failure("validation", "This file is too large to import.");
  if (buffer.byteLength === 0) return failure("validation", "Google Drive returned an empty file.");
  return ok({ buffer, fileType: plan.fileType, filename: importedFilename(file.name, plan.fileType) });
}
