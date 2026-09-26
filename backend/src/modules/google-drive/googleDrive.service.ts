// Facade of the google-drive module (Google Drive as a document source).
// Import the module from outside only through this file.

import { ok, type ServiceResult } from "../../lib/serviceResult";
import type { Db } from "../../lib/supabase";
import { listDriveFiles } from "./googleDrive.api";
import { defaultOAuthDeps, getAccessToken, type OAuthDeps } from "./googleDrive.oauth";
import type { DriveFileSummary } from "./googleDrive.shared";

export {
  completeGoogleDriveOAuth,
  disconnectGoogleDrive,
  getAccessToken,
  getGoogleDriveStatus,
  GOOGLE_DRIVE_NOT_CONFIGURED_CODE,
  GOOGLE_DRIVE_NOT_CONNECTED_CODE,
  pruneExpiredOAuthStates,
  startGoogleDriveOAuth,
  type OAuthDeps,
} from "./googleDrive.oauth";
export {
  DOCUMENT_SOURCE_GOOGLE_DRIVE,
  importDriveFile,
  type ImportDriveFileArgs,
  type ImportedDocument,
} from "./googleDrive.import";
export {
  googleDriveCallbackUrl,
  googleDriveConfig,
  type DriveFileSummary,
  type GoogleDriveStatus,
} from "./googleDrive.shared";

/** The caller's importable Drive files, most recently used first. */
export async function listGoogleDriveFiles(
  db: Db,
  userId: string,
  args: { search: string; pageToken: string | null },
  deps: OAuthDeps = defaultOAuthDeps(),
): Promise<ServiceResult<{ files: DriveFileSummary[]; next_page_token: string | null }>> {
  const token = await getAccessToken(db, userId, deps);
  if (!token.ok) return token;
  const listed = await listDriveFiles(deps.fetch, token.data, args);
  if (!listed.ok) return listed;
  return ok(listed.data);
}
