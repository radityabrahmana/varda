import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { encryptString } from "../../../lib/mcp/client";
import {
  completeGoogleDriveOAuth,
  disconnectGoogleDrive,
  getAccessToken,
  startGoogleDriveOAuth,
  type FetchLike,
  type OAuthDeps,
} from "../googleDrive.oauth";
import type { GoogleDriveConnectionRow } from "../googleDrive.shared";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-09-26T10:00:00Z");
const REDIRECT = "https://varda.example/api/google-drive/oauth/callback";

const config = {
  clientId: "client-id",
  clientSecret: "client-secret",
  scope: "https://www.googleapis.com/auth/drive.readonly",
};

type Call = { url: string; init?: RequestInit };

function fakeFetch(handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const handler = handlers.shift();
    if (!handler) throw new Error(`Unexpected fetch ${url}`);
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deps(fetchImpl: FetchLike, over: Partial<OAuthDeps> = {}): OAuthDeps {
  return { fetch: fetchImpl, config, now: () => NOW, ...over };
}

function connectionRow(over: Partial<GoogleDriveConnectionRow> = {}): GoogleDriveConnectionRow {
  const access = encryptString("access-old");
  const refresh = encryptString("refresh-1");
  return {
    user_id: USER,
    google_account_email: "legal@dashelectric.co",
    scope: config.scope,
    encrypted_access_token: access.encrypted,
    access_token_iv: access.iv,
    access_token_tag: access.tag,
    encrypted_refresh_token: refresh.encrypted,
    refresh_token_iv: refresh.iv,
    refresh_token_tag: refresh.tag,
    access_token_expires_at: new Date(NOW + 30 * 60 * 1000).toISOString(),
    created_at: "",
    updated_at: "",
    ...over,
  };
}

beforeEach(() => {
  process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-secret";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
  vi.restoreAllMocks();
});

describe("startGoogleDriveOAuth", () => {
  it("refuses when the deployment has no Google client", async () => {
    const fake = scriptedDb([]);
    const result = await startGoogleDriveOAuth(fake.db, USER, REDIRECT, deps(fakeFetch([]).fetchImpl, { config: null }));
    expect(result).toMatchObject({ ok: false, kind: "unavailable", code: "google_drive_not_configured" });
    fake.done();
  });

  it("stores only a hash of the state and asks Google for offline access", async () => {
    const fake = scriptedDb([{ table: "google_drive_oauth_states", op: "insert" }]);
    const result = await startGoogleDriveOAuth(fake.db, USER, REDIRECT, deps(fakeFetch([]).fetchImpl));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.data.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(config.scope);
    const state = url.searchParams.get("state")!;
    const inserted = fake.calls[0].payload as { state_hash: string; user_id: string; expires_at: string };
    expect(inserted.user_id).toBe(USER);
    expect(inserted.state_hash).not.toBe(state);
    expect(inserted.state_hash).toHaveLength(64);
    expect(Date.parse(inserted.expires_at)).toBe(NOW + 10 * 60 * 1000);
    fake.done();
  });
});

describe("completeGoogleDriveOAuth", () => {
  it("consumes the state, exchanges the code and stores encrypted tokens", async () => {
    const fake = scriptedDb([
      { table: "google_drive_oauth_states", op: "delete", data: { user_id: USER, expires_at: new Date(NOW + 1000).toISOString() } },
      { table: "user_google_drive_connections", data: null },
      { table: "user_google_drive_connections", op: "upsert", data: connectionRow() },
    ]);
    const { fetchImpl, calls } = fakeFetch([
      () => json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3599, scope: config.scope }),
      () => json({ user: { emailAddress: "legal@dashelectric.co" } }),
    ]);
    const result = await completeGoogleDriveOAuth(
      fake.db,
      { state: "state-1", code: "code-1", redirectUri: REDIRECT, sessionUserId: USER },
      deps(fetchImpl),
    );
    expect(result).toEqual({
      ok: true,
      data: { configured: true, connected: true, account_email: "legal@dashelectric.co", can_write: false },
    });
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("redirect_uri")).toBe(REDIRECT);
    expect(body.get("client_secret")).toBe("client-secret");
    const upsert = fake.calls[2].payload as Record<string, string | null>;
    expect(upsert.user_id).toBe(USER);
    expect(upsert.google_account_email).toBe("legal@dashelectric.co");
    expect(upsert.encrypted_access_token).not.toContain("access-1");
    expect(upsert.encrypted_refresh_token).not.toContain("refresh-1");
    expect(Date.parse(upsert.access_token_expires_at!)).toBe(NOW + 3599 * 1000);
    fake.done();
  });

  it("rejects an unknown, expired or foreign-session state", async () => {
    const unknown = scriptedDb([{ table: "google_drive_oauth_states", op: "delete", data: null }]);
    expect(
      await completeGoogleDriveOAuth(unknown.db, { state: "s", code: "c", redirectUri: REDIRECT }, deps(fakeFetch([]).fetchImpl)),
    ).toMatchObject({ ok: false, kind: "validation" });

    const expired = scriptedDb([
      { table: "google_drive_oauth_states", op: "delete", data: { user_id: USER, expires_at: new Date(NOW - 1).toISOString() } },
    ]);
    expect(
      await completeGoogleDriveOAuth(expired.db, { state: "s", code: "c", redirectUri: REDIRECT }, deps(fakeFetch([]).fetchImpl)),
    ).toMatchObject({ ok: false, kind: "validation", detail: expect.stringContaining("expired") });

    const foreign = scriptedDb([
      { table: "google_drive_oauth_states", op: "delete", data: { user_id: USER, expires_at: new Date(NOW + 1000).toISOString() } },
    ]);
    expect(
      await completeGoogleDriveOAuth(
        foreign.db,
        { state: "s", code: "c", redirectUri: REDIRECT, sessionUserId: OTHER },
        deps(fakeFetch([]).fetchImpl),
      ),
    ).toMatchObject({ ok: false, kind: "forbidden" });
  });

  it("does not store anything when Google rejects the code", async () => {
    const fake = scriptedDb([
      { table: "google_drive_oauth_states", op: "delete", data: { user_id: USER, expires_at: new Date(NOW + 1000).toISOString() } },
    ]);
    const { fetchImpl } = fakeFetch([() => json({ error: "invalid_request" }, 400)]);
    const result = await completeGoogleDriveOAuth(fake.db, { state: "s", code: "c", redirectUri: REDIRECT }, deps(fetchImpl));
    expect(result).toMatchObject({ ok: false, kind: "unavailable" });
    fake.done();
  });
});

describe("getAccessToken", () => {
  it("returns the cached token while it is fresh", async () => {
    const fake = scriptedDb([{ table: "user_google_drive_connections", data: connectionRow() }]);
    const result = await getAccessToken(fake.db, USER, deps(fakeFetch([]).fetchImpl));
    expect(result).toEqual({ ok: true, data: "access-old" });
    fake.done();
  });

  it("refreshes an expiring token and keeps the stored refresh token", async () => {
    const row = connectionRow({ access_token_expires_at: new Date(NOW + 10_000).toISOString() });
    const fake = scriptedDb([
      { table: "user_google_drive_connections", data: row },
      { table: "user_google_drive_connections", op: "upsert", data: row },
    ]);
    const { fetchImpl, calls } = fakeFetch([() => json({ access_token: "access-new", expires_in: 3600 })]);
    const result = await getAccessToken(fake.db, USER, deps(fetchImpl));
    expect(result).toEqual({ ok: true, data: "access-new" });
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-1");
    const upsert = fake.calls[1].payload as Record<string, string | null>;
    expect(upsert.encrypted_refresh_token).toBe(row.encrypted_refresh_token);
    expect(upsert.encrypted_access_token).not.toBe(row.encrypted_access_token);
    fake.done();
  });

  it("forgets a revoked connection so the UI offers a reconnect", async () => {
    const row = connectionRow({ access_token_expires_at: new Date(NOW - 1).toISOString() });
    const fake = scriptedDb([
      { table: "user_google_drive_connections", data: row },
      { table: "user_google_drive_connections", op: "delete" },
    ]);
    const { fetchImpl } = fakeFetch([() => json({ error: "invalid_grant" }, 400)]);
    const result = await getAccessToken(fake.db, USER, deps(fetchImpl));
    expect(result).toMatchObject({ ok: false, kind: "conflict", code: "google_drive_not_connected" });
    expect(fake.calls[1].filters).toEqual([["eq", "user_id", USER]]);
    fake.done();
  });

  it("asks for a connection when there is none", async () => {
    const fake = scriptedDb([{ table: "user_google_drive_connections", data: null }]);
    const result = await getAccessToken(fake.db, USER, deps(fakeFetch([]).fetchImpl));
    expect(result).toMatchObject({ ok: false, kind: "conflict", code: "google_drive_not_connected" });
    fake.done();
  });
});

describe("disconnectGoogleDrive", () => {
  it("revokes the refresh token at Google and deletes the row", async () => {
    const fake = scriptedDb([
      { table: "user_google_drive_connections", data: connectionRow() },
      { table: "user_google_drive_connections", op: "delete" },
    ]);
    const { fetchImpl, calls } = fakeFetch([() => new Response("", { status: 200 })]);
    const result = await disconnectGoogleDrive(fake.db, USER, deps(fetchImpl));
    expect(result).toEqual({ ok: true, data: { configured: true, connected: false, account_email: null, can_write: false } });
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/revoke?token=refresh-1");
    fake.done();
  });

  it("is a no-op without a connection", async () => {
    const fake = scriptedDb([{ table: "user_google_drive_connections", data: null }]);
    const result = await disconnectGoogleDrive(fake.db, USER, deps(fakeFetch([]).fetchImpl));
    expect(result).toMatchObject({ ok: true, data: { connected: false } });
    fake.done();
  });
});
