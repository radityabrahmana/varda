import { describe, expect, it } from "vitest";
import {
  buildListQuery,
  escapeDriveQueryValue,
  importedFilename,
} from "../googleDrive.api";
import {
  connectionStatus,
  googleDriveCallbackUrl,
  googleDriveConfig,
  importPlanFor,
  summarizeDriveFile,
  type GoogleDriveConnectionRow,
} from "../googleDrive.shared";

describe("googleDriveConfig", () => {
  it("prefers the Drive client and falls back to the MCP client", () => {
    expect(googleDriveConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      googleDriveConfig({
        GOOGLE_MCP_OAUTH_CLIENT_ID: "mcp-id",
        GOOGLE_MCP_OAUTH_CLIENT_SECRET: "mcp-secret",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      clientId: "mcp-id",
      clientSecret: "mcp-secret",
      scope: "https://www.googleapis.com/auth/drive.readonly",
    });
    expect(
      googleDriveConfig({
        GOOGLE_DRIVE_OAUTH_CLIENT_ID: " drive-id ",
        GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: "drive-secret",
        GOOGLE_DRIVE_OAUTH_SCOPE: "https://www.googleapis.com/auth/drive",
        GOOGLE_MCP_OAUTH_CLIENT_ID: "mcp-id",
        GOOGLE_MCP_OAUTH_CLIENT_SECRET: "mcp-secret",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      clientId: "drive-id",
      clientSecret: "drive-secret",
      scope: "https://www.googleapis.com/auth/drive",
    });
  });

  it("derives the callback from API_PUBLIC_URL", () => {
    expect(
      googleDriveCallbackUrl({ API_PUBLIC_URL: "https://varda.example/api/" } as NodeJS.ProcessEnv),
    ).toBe("https://varda.example/api/google-drive/oauth/callback");
    expect(googleDriveCallbackUrl({ PORT: "4000" } as NodeJS.ProcessEnv)).toBe(
      "http://localhost:4000/google-drive/oauth/callback",
    );
    expect(() => googleDriveCallbackUrl({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      /API_PUBLIC_URL/,
    );
  });
});

describe("importPlanFor", () => {
  it("exports native Google files and downloads Office files as-is", () => {
    expect(importPlanFor("application/vnd.google-apps.document")).toEqual({
      kind: "export",
      fileType: "docx",
      exportMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(importPlanFor("application/vnd.google-apps.spreadsheet")).toMatchObject({ kind: "export", fileType: "xlsx" });
    expect(importPlanFor("application/vnd.google-apps.presentation")).toMatchObject({ kind: "export", fileType: "pptx" });
    expect(importPlanFor("application/pdf")).toEqual({ kind: "download", fileType: "pdf" });
    expect(importPlanFor("application/msword")).toEqual({ kind: "download", fileType: "doc" });
    expect(importPlanFor("application/vnd.google-apps.folder")).toBeNull();
    expect(importPlanFor("image/png")).toBeNull();
  });

  it("summarizes only importable files", () => {
    const base = { id: "f1", name: "Contract", modifiedTime: null, webViewLink: null, headRevisionId: null, size: null, ownerEmail: null };
    expect(summarizeDriveFile({ ...base, mimeType: "application/vnd.google-apps.document" })).toMatchObject({ file_type: "docx" });
    expect(summarizeDriveFile({ ...base, mimeType: "image/png" })).toBeNull();
  });
});

describe("Drive query building", () => {
  it("escapes quotes and backslashes in the search term", () => {
    expect(escapeDriveQueryValue(`O'Neil \\ Co`)).toBe(`O\\'Neil \\\\ Co`);
  });

  it("filters trash, restricts to importable types and adds the name match", () => {
    const query = buildListQuery("  PKS 2026 ");
    expect(query.startsWith("trashed = false and (mimeType = 'application/vnd.google-apps.document'")).toBe(true);
    expect(query.endsWith("and name contains 'PKS 2026'")).toBe(true);
    expect(buildListQuery("")).not.toContain("name contains");
    expect(buildListQuery("a".repeat(300))).toContain(`'${"a".repeat(200)}'`);
  });
});

describe("importedFilename", () => {
  it("appends the stored extension once and strips path characters", () => {
    expect(importedFilename("Perjanjian Kerja Sama", "docx")).toBe("Perjanjian Kerja Sama.docx");
    expect(importedFilename("scan.PDF", "pdf")).toBe("scan.PDF");
    expect(importedFilename("a/b:c*d", "docx")).toBe("a b c d.docx");
    expect(importedFilename("   ", "xlsx")).toBe("document.xlsx");
  });
});

describe("connectionStatus", () => {
  const row: GoogleDriveConnectionRow = {
    user_id: "u",
    google_account_email: "legal@dashelectric.co",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    encrypted_access_token: "x",
    access_token_iv: "x",
    access_token_tag: "x",
    encrypted_refresh_token: null,
    refresh_token_iv: null,
    refresh_token_tag: null,
    access_token_expires_at: "2026-01-01T00:00:00Z",
    created_at: "",
    updated_at: "",
  };

  it("reports configuration, connection and write capability", () => {
    expect(connectionStatus(false, null)).toEqual({ configured: false, connected: false, account_email: null, can_write: false });
    expect(connectionStatus(true, row)).toEqual({
      configured: true,
      connected: true,
      account_email: "legal@dashelectric.co",
      can_write: false,
    });
    expect(connectionStatus(true, { ...row, scope: "openid https://www.googleapis.com/auth/drive" }).can_write).toBe(true);
  });
});
