// Turn one Drive file into a Varda document: fetch the bytes (exporting a
// Google Doc as DOCX), store them like an upload, record version 1 and the
// link back to the Drive file. The result is the same document projection
// the upload protocol hands the browser, so the composer attaches it as-is.

import fs from "fs/promises";
import os from "os";
import path from "path";
import { can, checkProjectAccess, resolveContentOrgId } from "../../lib/access";
import { recordAudit } from "../../lib/audit";
import { convertedPdfKey, officeFileToPdf } from "../../lib/convert";
import { contentTypeForDocumentType, shouldConvertToPdf } from "../../lib/documentTypes";
import { contentSha256 } from "../../lib/documentVersions";
import { enqueueConversion } from "../../lib/queue/conversionQueue";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { deleteFile, storageEnabled, storageKey, uploadFile, uploadFileFromPath } from "../../lib/storage";
import type { Db } from "../../lib/supabase";
import { createDocumentVersion } from "../documents/documents.service";
import { fetchDriveFileContent, getDriveFile } from "./googleDrive.api";
import { defaultOAuthDeps, getAccessToken, type OAuthDeps } from "./googleDrive.oauth";
import type { DriveFile } from "./googleDrive.shared";

export const DOCUMENT_SOURCE_GOOGLE_DRIVE = "google_drive";

export type ImportDriveFileArgs = {
  userId: string;
  userEmail: string | null;
  fileId: string;
  /** Import into this project's documents; omitted means the caller's standalone files. */
  projectId?: string | null;
};

export type ImportedDocument = Record<string, unknown> & {
  id: string;
  filename: string;
  file_type: string;
  google_drive: {
    file_id: string;
    name: string;
    mime_type: string;
    web_view_link: string | null;
    modified_time: string | null;
  };
};

export type ImportDeps = OAuthDeps & {
  /** Sync PDF rendition; injected so tests skip LibreOffice. */
  renderPdf: (buffer: Buffer, fileType: string, documentId: string, userId: string) => Promise<string | null>;
};

export function defaultImportDeps(): ImportDeps {
  return { ...defaultOAuthDeps(), renderPdf: renderPdfWithLibreOffice };
}

async function renderPdfWithLibreOffice(
  buffer: Buffer,
  fileType: string,
  documentId: string,
  userId: string,
): Promise<string | null> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "varda-gdrive-"));
  try {
    const inputPath = path.join(directory, `source.${fileType}`);
    await fs.writeFile(inputPath, buffer);
    const pdfPath = await officeFileToPdf(inputPath, directory);
    const key = convertedPdfKey(userId, documentId);
    await uploadFileFromPath(key, pdfPath, "application/pdf");
    return key;
  } catch (error) {
    console.error("[google-drive] PDF rendition failed", {
      documentId,
      fileType,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function authorizeDestination(
  db: Db,
  args: ImportDriveFileArgs,
): Promise<ServiceResult<{ orgId: string | null }>> {
  if (!args.projectId) return ok({ orgId: null });
  const access = await checkProjectAccess(args.projectId, args.userId, args.userEmail, db);
  if (!access.ok) return failure("not_found", "Project not found");
  if (!can(access.projectRole, "content.edit")) {
    return failure("forbidden", "You do not have permission to write in this project.");
  }
  const org = await resolveContentOrgId(db, { projectId: args.projectId });
  if (!org.ok) return internalFailure(new Error(org.detail));
  return ok({ orgId: org.orgId });
}

export async function importDriveFile(
  db: Db,
  args: ImportDriveFileArgs,
  deps: ImportDeps = defaultImportDeps(),
): Promise<ServiceResult<ImportedDocument>> {
  if (!storageEnabled) return failure("unavailable", "Document storage is not configured.");
  const fileId = args.fileId.trim();
  if (!fileId || fileId.length > 256) return failure("validation", "file_id is required");

  const destination = await authorizeDestination(db, args);
  if (!destination.ok) return destination;

  const token = await getAccessToken(db, args.userId, deps);
  if (!token.ok) return token;

  const file = await getDriveFile(deps.fetch, token.data, fileId);
  if (!file.ok) return file;
  const content = await fetchDriveFileContent(deps.fetch, token.data, file.data);
  if (!content.ok) return content;
  const { buffer, fileType, filename } = content.data;

  const { data: docRow, error: docErr } = await db
    .from("documents")
    .insert({
      project_id: args.projectId ?? null,
      org_id: destination.data.orgId,
      user_id: args.userId,
      status: "processing",
      library_kind: "file",
    })
    .select("id")
    .single();
  if (docErr || !docRow) return internalFailure(docErr ?? new Error("document_insert_returned_no_data"));
  const documentId = (docRow as { id: string }).id;

  const sourcePath = storageKey(args.userId, documentId, filename);
  const rollback = async (error: unknown): Promise<ServiceResult<never>> => {
    await deleteFile(sourcePath).catch(() => {});
    await db.from("documents").delete().eq("id", documentId);
    return internalFailure(error);
  };

  try {
    await uploadFile(
      sourcePath,
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
      contentTypeForDocumentType(fileType),
    );
  } catch (error) {
    return rollback(error);
  }

  const deferRendition = shouldConvertToPdf(fileType) && process.env.ASYNC_DOCUMENT_CONVERSION === "true";
  let pdfStoragePath: string | null = null;
  if (fileType === "pdf") pdfStoragePath = sourcePath;
  else if (shouldConvertToPdf(fileType) && !deferRendition) {
    pdfStoragePath = await deps.renderPdf(buffer, fileType, documentId, args.userId);
  }

  const { data: version, error: versionError } = await createDocumentVersion(db, {
    document_id: documentId,
    storage_path: sourcePath,
    pdf_storage_path: pdfStoragePath,
    source: DOCUMENT_SOURCE_GOOGLE_DRIVE,
    version_number: 1,
    filename,
    file_type: fileType,
    size_bytes: buffer.byteLength,
    page_count: null,
    content_sha256: contentSha256(buffer),
  });
  if (versionError || !version) return rollback(versionError ?? new Error("version_insert_returned_no_data"));

  const { error: linkError } = await db.from("document_google_drive_links").insert({
    document_id: documentId,
    drive_file_id: file.data.id,
    drive_mime_type: file.data.mimeType,
    drive_name: file.data.name,
    drive_modified_time: file.data.modifiedTime,
    drive_head_revision_id: file.data.headRevisionId,
    drive_web_view_link: file.data.webViewLink,
    imported_by: args.userId,
  });
  if (linkError) return rollback(linkError);

  const { data: document, error: updateError } = await db
    .from("documents")
    .update({ status: "ready", updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .select("*")
    .single();
  if (updateError || !document) return rollback(updateError ?? new Error("document_update_returned_no_data"));

  if (deferRendition) {
    try {
      await enqueueConversion({
        documentId,
        versionId: version.id,
        userId: args.userId,
        storagePath: sourcePath,
        fileType,
        pdfKey: convertedPdfKey(args.userId, documentId),
        finalizeDocumentStatus: false,
      });
    } catch (error) {
      console.error("[google-drive] rendition enqueue failed", { documentId, error });
    }
  }

  await recordAudit(db, {
    userId: args.userId,
    userEmail: args.userEmail,
    action: "document.uploaded",
    title: filename,
    surface: args.projectId ? "project" : "assistant",
    projectId: args.projectId ?? null,
    documentId,
    detail: { source: DOCUMENT_SOURCE_GOOGLE_DRIVE, drive_file_id: file.data.id },
  });

  return ok({
    ...(document as Record<string, unknown>),
    id: documentId,
    filename,
    storage_path: sourcePath,
    pdf_storage_path: pdfStoragePath,
    folder_id: null,
    file_type: fileType,
    size_bytes: buffer.byteLength,
    page_count: null,
    active_version_number: 1,
    google_drive: driveLinkSummary(file.data),
  });
}

function driveLinkSummary(file: DriveFile) {
  return {
    file_id: file.id,
    name: file.name,
    mime_type: file.mimeType,
    web_view_link: file.webViewLink,
    modified_time: file.modifiedTime,
  };
}
