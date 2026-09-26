// Shared vocabulary of the google-drive module: deployment configuration,
// the Drive file shapes the module reads, and the mapping between Google
// MIME types and the document types Varda stores.

import { configuredApiPublicUrl } from "../../lib/runtimeConfig";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const DRIVE_API_URL = "https://www.googleapis.com/drive/v3";

/**
 * Read-only access to the user's Drive listing plus the account email for
 * the connection card. Writing back to Drive (a later step) needs the full
 * `drive` scope; the stored `scope` column records what a connection was
 * granted so that step can ask for a reconnect instead of failing.
 */
export const DEFAULT_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";

export const DRIVE_WRITE_SCOPE = "https://www.googleapis.com/auth/drive";

/** Google Docs export caps at 10 MB; binary Drive files follow the upload ceiling. */
export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type GoogleDriveConfig = {
  clientId: string;
  clientSecret: string;
  scope: string;
};

/**
 * The OAuth client. `GOOGLE_DRIVE_OAUTH_*` wins; the MCP connector client
 * (`GOOGLE_MCP_OAUTH_*`) is the fallback so one Google Cloud OAuth client can
 * serve both features (each has its own redirect URI to register).
 */
export function googleDriveConfig(
  env: NodeJS.ProcessEnv = process.env,
): GoogleDriveConfig | null {
  const clientId =
    env.GOOGLE_DRIVE_OAUTH_CLIENT_ID?.trim() ||
    env.GOOGLE_MCP_OAUTH_CLIENT_ID?.trim() ||
    "";
  const clientSecret =
    env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET?.trim() ||
    env.GOOGLE_MCP_OAUTH_CLIENT_SECRET?.trim() ||
    "";
  if (!clientId || !clientSecret) return null;
  const scope = env.GOOGLE_DRIVE_OAUTH_SCOPE?.trim() || DEFAULT_SCOPE;
  return { clientId, clientSecret, scope };
}

/** Browser-reachable callback, derived from API_PUBLIC_URL like the MCP one. */
export function googleDriveCallbackUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = configuredApiPublicUrl(env);
  if (!configured && env.NODE_ENV === "production") {
    throw new Error("API_PUBLIC_URL is required for Google Drive OAuth");
  }
  const base = configured || `http://localhost:${env.PORT ?? "3001"}`;
  return `${base}/google-drive/oauth/callback`;
}

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
export const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";
export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";

const OFFICE_MIME_BY_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
};

const TYPE_BY_MIME = new Map(
  Object.entries(OFFICE_MIME_BY_TYPE).map(([type, mime]) => [mime, type]),
);

/** Native Google files and what Varda exports them as. */
const EXPORT_BY_GOOGLE_MIME: Record<string, { type: string; mime: string }> = {
  [GOOGLE_DOC_MIME]: { type: "docx", mime: OFFICE_MIME_BY_TYPE.docx },
  [GOOGLE_SHEET_MIME]: { type: "xlsx", mime: OFFICE_MIME_BY_TYPE.xlsx },
  [GOOGLE_SLIDES_MIME]: { type: "pptx", mime: OFFICE_MIME_BY_TYPE.pptx },
};

export type ImportPlan =
  | { kind: "export"; fileType: string; exportMime: string }
  | { kind: "download"; fileType: string };

/**
 * How a Drive file becomes a Varda document, or null when the type is not
 * one Varda stores (folders, images, Google Forms…).
 */
export function importPlanFor(mimeType: string): ImportPlan | null {
  const exported = EXPORT_BY_GOOGLE_MIME[mimeType];
  if (exported) {
    return { kind: "export", fileType: exported.type, exportMime: exported.mime };
  }
  const fileType = TYPE_BY_MIME.get(mimeType);
  return fileType ? { kind: "download", fileType } : null;
}

/** The MIME types the file listing asks Drive for. */
export function importableMimeTypes(): string[] {
  return [
    ...Object.keys(EXPORT_BY_GOOGLE_MIME),
    ...Object.values(OFFICE_MIME_BY_TYPE),
  ];
}

/** The file type Varda will store, for the listing UI. */
export function importedFileType(mimeType: string): string | null {
  return importPlanFor(mimeType)?.fileType ?? null;
}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  webViewLink: string | null;
  headRevisionId: string | null;
  size: number | null;
  ownerEmail: string | null;
};

export type DriveFileSummary = DriveFile & {
  /** The type the file would be stored as (docx for a Google Doc, …). */
  file_type: string;
};

export function summarizeDriveFile(file: DriveFile): DriveFileSummary | null {
  const fileType = importedFileType(file.mimeType);
  if (!fileType) return null;
  return { ...file, file_type: fileType };
}

export type GoogleDriveConnectionRow = {
  user_id: string;
  google_account_email: string | null;
  scope: string;
  encrypted_access_token: string;
  access_token_iv: string;
  access_token_tag: string;
  encrypted_refresh_token: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  access_token_expires_at: string;
  created_at: string;
  updated_at: string;
};

export type GoogleDriveStatus = {
  configured: boolean;
  connected: boolean;
  account_email: string | null;
  /** True when the granted scope allows writing files back to Drive. */
  can_write: boolean;
};

/** The public projection of a connection row. */
export function connectionStatus(
  configured: boolean,
  row: GoogleDriveConnectionRow | null,
): GoogleDriveStatus {
  return {
    configured,
    connected: !!row,
    account_email: row?.google_account_email ?? null,
    can_write: !!row && row.scope.split(/\s+/).includes(DRIVE_WRITE_SCOPE),
  };
}
