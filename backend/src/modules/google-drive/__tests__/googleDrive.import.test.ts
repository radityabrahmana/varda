import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { encryptString } from "../../../lib/mcp/client";
import type { FetchLike } from "../googleDrive.oauth";

vi.mock("../../../lib/storage", () => ({
  storageEnabled: true,
  storageKey: (userId: string, docId: string, filename: string) =>
    `documents/${userId}/${docId}/source.${filename.split(".").pop()}`,
  uploadFile: vi.fn(async () => undefined),
  uploadFileFromPath: vi.fn(async () => undefined),
  deleteFile: vi.fn(async () => undefined),
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("../../../lib/queue/conversionQueue", () => ({ enqueueConversion: vi.fn(async () => undefined) }));
vi.mock("../../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/access")>()),
  checkProjectAccess: vi.fn(),
}));
vi.mock("../../documents/documents.service", () => ({
  createDocumentVersion: vi.fn(),
}));

import { checkProjectAccess } from "../../../lib/access";
import { recordAudit } from "../../../lib/audit";
import { deleteFile, uploadFile } from "../../../lib/storage";
import { createDocumentVersion } from "../../documents/documents.service";
import { importDriveFile, type ImportDeps } from "../googleDrive.import";

const USER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const ORG = "44444444-4444-4444-8444-444444444444";
const DOC = "55555555-5555-4555-8555-555555555555";
const NOW = Date.parse("2026-09-26T10:00:00Z");
const DOC_MIME = "application/vnd.google-apps.document";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function connectionRow() {
  const access = encryptString("access-1");
  return {
    user_id: USER,
    google_account_email: "legal@dashelectric.co",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    encrypted_access_token: access.encrypted,
    access_token_iv: access.iv,
    access_token_tag: access.tag,
    encrypted_refresh_token: null,
    refresh_token_iv: null,
    refresh_token_tag: null,
    access_token_expires_at: new Date(NOW + 60 * 60 * 1000).toISOString(),
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const driveFile = {
  id: "file-1",
  name: "Perjanjian Kerja Sama",
  mimeType: DOC_MIME,
  modifiedTime: "2026-09-25T08:00:00Z",
  webViewLink: "https://docs.google.com/document/d/file-1/edit",
  headRevisionId: "rev-9",
};

function driveFetch(bytes = "PK-docx-bytes") {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    if (url.includes("/files/file-1/export")) return new Response(bytes, { status: 200 });
    if (url.includes("/files/file-1")) return json(driveFile);
    throw new Error(`Unexpected fetch ${url}`);
  };
  return { fetchImpl, calls };
}

function deps(fetchImpl: FetchLike, over: Partial<ImportDeps> = {}): ImportDeps {
  return {
    fetch: fetchImpl,
    config: { clientId: "id", clientSecret: "secret", scope: "https://www.googleapis.com/auth/drive.readonly" },
    now: () => NOW,
    renderPdf: vi.fn(async () => `converted-pdfs/${USER}/${DOC}.pdf`),
    ...over,
  };
}

beforeEach(() => {
  process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-secret";
  vi.mocked(createDocumentVersion).mockResolvedValue({
    data: {
      id: "ver-1",
      document_id: DOC,
      version_number: 1,
      storage_path: "",
      source: "upload",
      filename: "",
      created_at: "2026-09-26T10:00:00Z",
      deleted_at: null,
    },
    error: null,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("importDriveFile", () => {
  it("exports a Google Doc as DOCX into the caller's standalone files", async () => {
    const fake = scriptedDb([
      { table: "user_google_drive_connections", data: connectionRow() },
      { table: "documents", op: "insert", data: { id: DOC } },
      { table: "document_google_drive_links", op: "insert" },
      { table: "documents", op: "update", data: { id: DOC, project_id: null, org_id: null, user_id: USER, status: "ready", current_version_id: "ver-1" } },
    ]);
    const { fetchImpl, calls } = driveFetch();
    const importDeps = deps(fetchImpl);
    const result = await importDriveFile(fake.db, { userId: USER, userEmail: "a@b.co", fileId: "file-1" }, importDeps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      id: DOC,
      filename: "Perjanjian Kerja Sama.docx",
      file_type: "docx",
      status: "ready",
      current_version_id: "ver-1",
      active_version_number: 1,
      storage_path: `documents/${USER}/${DOC}/source.docx`,
      pdf_storage_path: `converted-pdfs/${USER}/${DOC}.pdf`,
      google_drive: { file_id: "file-1", name: "Perjanjian Kerja Sama", mime_type: DOC_MIME, web_view_link: driveFile.webViewLink },
    });
    expect(calls[1]).toContain(`export?mimeType=${encodeURIComponent(DOCX_MIME)}`);
    expect(vi.mocked(uploadFile).mock.calls[0][0]).toBe(`documents/${USER}/${DOC}/source.docx`);
    // Recorded as an upload: that is the vocabulary the source check
    // constraint and the version-numbering function accept.
    expect(vi.mocked(createDocumentVersion).mock.calls[0][1]).toMatchObject({
      document_id: DOC,
      source: "upload",
      version_number: 1,
      file_type: "docx",
      size_bytes: "PK-docx-bytes".length,
    });
    const inserted = fake.calls[1].payload as Record<string, unknown>;
    expect(inserted).toMatchObject({ project_id: null, org_id: null, user_id: USER, library_kind: "file" });
    const link = fake.calls[2].payload as Record<string, unknown>;
    expect(link).toMatchObject({ document_id: DOC, drive_file_id: "file-1", drive_head_revision_id: "rev-9", imported_by: USER });
    expect(vi.mocked(recordAudit).mock.calls[0][1]).toMatchObject({
      action: "document.uploaded",
      documentId: DOC,
      surface: "assistant",
      detail: { source: "google_drive", drive_file_id: "file-1" },
    });
    fake.done();
  });

  it("files a project import under the project's organization", async () => {
    vi.mocked(checkProjectAccess).mockResolvedValue({
      ok: true,
      isCreator: false,
      orgRole: "member",
      projectRole: "editor",
      project: { id: PROJECT, user_id: null, org_id: ORG },
    });
    const fake = scriptedDb([
      { table: "projects", data: { org_id: ORG } },
      { table: "user_google_drive_connections", data: connectionRow() },
      { table: "documents", op: "insert", data: { id: DOC } },
      { table: "document_google_drive_links", op: "insert" },
      { table: "documents", op: "update", data: { id: DOC, project_id: PROJECT, org_id: ORG, status: "ready" } },
    ]);
    const result = await importDriveFile(
      fake.db,
      { userId: USER, userEmail: "a@b.co", fileId: "file-1", projectId: PROJECT },
      deps(driveFetch().fetchImpl),
    );
    expect(result.ok).toBe(true);
    expect(fake.calls[2].payload).toMatchObject({ project_id: PROJECT, org_id: ORG });
    expect(vi.mocked(recordAudit).mock.calls[0][1]).toMatchObject({ surface: "project", projectId: PROJECT });
    fake.done();
  });

  it("refuses a project the caller can only view, before touching Google", async () => {
    vi.mocked(checkProjectAccess).mockResolvedValue({
      ok: true,
      isCreator: false,
      orgRole: null,
      projectRole: "viewer",
      project: { id: PROJECT, user_id: null, org_id: null },
    });
    const fake = scriptedDb([]);
    const { fetchImpl, calls } = driveFetch();
    const result = await importDriveFile(
      fake.db,
      { userId: USER, userEmail: null, fileId: "file-1", projectId: PROJECT },
      deps(fetchImpl),
    );
    expect(result).toMatchObject({ ok: false, kind: "forbidden" });
    expect(calls).toEqual([]);
    fake.done();
  });

  it("requires a Google connection", async () => {
    const fake = scriptedDb([{ table: "user_google_drive_connections", data: null }]);
    const result = await importDriveFile(fake.db, { userId: USER, userEmail: null, fileId: "file-1" }, deps(driveFetch().fetchImpl));
    expect(result).toMatchObject({ ok: false, kind: "conflict", code: "google_drive_not_connected" });
    fake.done();
  });

  it("rejects files Varda cannot store and empty exports", async () => {
    const image = scriptedDb([{ table: "user_google_drive_connections", data: connectionRow() }]);
    const imageFetch: FetchLike = async () => json({ ...driveFile, mimeType: "image/png" });
    expect(
      await importDriveFile(image.db, { userId: USER, userEmail: null, fileId: "file-1" }, deps(imageFetch)),
    ).toMatchObject({ ok: false, kind: "validation" });

    const empty = scriptedDb([{ table: "user_google_drive_connections", data: connectionRow() }]);
    expect(
      await importDriveFile(empty.db, { userId: USER, userEmail: null, fileId: "file-1" }, deps(driveFetch("").fetchImpl)),
    ).toMatchObject({ ok: false, kind: "validation", detail: expect.stringContaining("empty") });
  });

  it("removes the document row and bytes when the version cannot be recorded", async () => {
    vi.mocked(createDocumentVersion).mockResolvedValue({
      data: null,
      error: { message: "rpc failed", details: "", hint: "", code: "P0001", name: "PostgrestError" } as unknown as NonNullable<
        Awaited<ReturnType<typeof createDocumentVersion>>["error"]
      >,
    });
    const fake = scriptedDb([
      { table: "user_google_drive_connections", data: connectionRow() },
      { table: "documents", op: "insert", data: { id: DOC } },
      { table: "documents", op: "delete" },
    ]);
    const result = await importDriveFile(fake.db, { userId: USER, userEmail: null, fileId: "file-1" }, deps(driveFetch().fetchImpl));
    expect(result).toMatchObject({ ok: false, kind: "error" });
    expect(vi.mocked(deleteFile)).toHaveBeenCalledWith(`documents/${USER}/${DOC}/source.docx`);
    expect(vi.mocked(deleteFile)).toHaveBeenCalledWith(`converted-pdfs/${USER}/${DOC}.pdf`);
    expect(fake.calls[2].filters).toEqual([["eq", "id", DOC]]);
    fake.done();
  });
});
