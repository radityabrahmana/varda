// The Google connection: OAuth authorization, token storage and refresh.
//
// Tokens are encrypted at rest with the same AES-256-GCM box the MCP
// connectors use (MCP_CONNECTORS_ENCRYPTION_SECRET, falling back to
// USER_API_KEYS_ENCRYPTION_SECRET). Google issues short-lived access tokens
// and a durable refresh token only when asked for offline access with a
// forced consent prompt, so the authorization URL always carries both.

import crypto from "crypto";
import { decryptString, encryptString } from "../../lib/mcp/client";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import type { Db } from "../../lib/supabase";
import {
  DRIVE_API_URL,
  GOOGLE_AUTH_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  OAUTH_STATE_TTL_MS,
  connectionStatus,
  googleDriveConfig,
  type GoogleDriveConfig,
  type GoogleDriveConnectionRow,
  type GoogleDriveStatus,
} from "./googleDrive.shared";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type OAuthDeps = {
  fetch: FetchLike;
  config: GoogleDriveConfig | null;
  now: () => number;
};

export function defaultOAuthDeps(): OAuthDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    config: googleDriveConfig(),
    now: () => Date.now(),
  };
}

const NOT_CONFIGURED =
  "Google Drive is not configured for this deployment. Ask an administrator to set GOOGLE_DRIVE_OAUTH_CLIENT_ID and GOOGLE_DRIVE_OAUTH_CLIENT_SECRET.";
const NOT_CONNECTED = "Connect Google Drive first.";

export const GOOGLE_DRIVE_NOT_CONFIGURED_CODE = "google_drive_not_configured";
export const GOOGLE_DRIVE_NOT_CONNECTED_CODE = "google_drive_not_connected";

function stateHash(state: string): string {
  return crypto.createHash("sha256").update(state).digest("hex");
}

// ---------------------------------------------------------------------------
// Connection rows

export async function loadConnection(
  db: Db,
  userId: string,
): Promise<ServiceResult<GoogleDriveConnectionRow | null>> {
  const { data, error } = await db
    .from("user_google_drive_connections")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return internalFailure(error);
  return ok((data as GoogleDriveConnectionRow | null) ?? null);
}

export async function getGoogleDriveStatus(
  db: Db,
  userId: string,
  deps: OAuthDeps = defaultOAuthDeps(),
): Promise<ServiceResult<GoogleDriveStatus>> {
  const row = await loadConnection(db, userId);
  if (!row.ok) return row;
  return ok(connectionStatus(!!deps.config, row.data));
}

type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
};

async function saveConnection(
  db: Db,
  userId: string,
  tokens: TokenSet,
  accountEmail: string | null,
  existing: GoogleDriveConnectionRow | null,
): Promise<ServiceResult<GoogleDriveConnectionRow>> {
  const access = encryptString(tokens.accessToken);
  // Google re-issues a refresh token only with prompt=consent; a refresh
  // response carries none, so keep the one already stored in that case.
  const refresh = tokens.refreshToken
    ? encryptString(tokens.refreshToken)
    : existing
      ? {
          encrypted: existing.encrypted_refresh_token,
          iv: existing.refresh_token_iv,
          tag: existing.refresh_token_tag,
        }
      : { encrypted: null, iv: null, tag: null };
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("user_google_drive_connections")
    .upsert(
      {
        user_id: userId,
        google_account_email: accountEmail ?? existing?.google_account_email ?? null,
        scope: tokens.scope,
        encrypted_access_token: access.encrypted,
        access_token_iv: access.iv,
        access_token_tag: access.tag,
        encrypted_refresh_token: refresh.encrypted,
        refresh_token_iv: refresh.iv,
        refresh_token_tag: refresh.tag,
        access_token_expires_at: new Date(tokens.expiresAt).toISOString(),
        updated_at: now,
      },
      { onConflict: "user_id" },
    )
    .select("*")
    .single();
  if (error || !data) return internalFailure(error ?? new Error("connection_upsert_returned_no_data"));
  return ok(data as GoogleDriveConnectionRow);
}

// ---------------------------------------------------------------------------
// Authorization

/**
 * Mint a single-use state and build the consent URL. Only the hash of the
 * state is stored, so a database read never yields a usable state.
 */
export async function startGoogleDriveOAuth(
  db: Db,
  userId: string,
  redirectUri: string,
  deps: OAuthDeps = defaultOAuthDeps(),
): Promise<ServiceResult<{ authorizationUrl: string }>> {
  if (!deps.config) return failure("unavailable", NOT_CONFIGURED, GOOGLE_DRIVE_NOT_CONFIGURED_CODE);
  const state = crypto.randomBytes(32).toString("base64url");
  const { error } = await db.from("google_drive_oauth_states").insert({
    state_hash: stateHash(state),
    user_id: userId,
    expires_at: new Date(deps.now() + OAUTH_STATE_TTL_MS).toISOString(),
  });
  if (error) return internalFailure(error);
  return ok({ authorizationUrl: buildAuthorizationUrl(deps.config, redirectUri, state) });
}

export function buildAuthorizationUrl(
  config: GoogleDriveConfig,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Consume the state (one use, then gone), exchange the code and store the
 * tokens. `sessionUserId` is the browser session that reached the callback,
 * when one is present: it must be the user who started the flow, so a
 * consent link crafted by someone else cannot attach their Google account
 * to this session.
 */
export async function completeGoogleDriveOAuth(
  db: Db,
  args: { state: string; code: string; redirectUri: string; sessionUserId?: string | null },
  deps: OAuthDeps = defaultOAuthDeps(),
): Promise<ServiceResult<GoogleDriveStatus>> {
  if (!deps.config) return failure("unavailable", NOT_CONFIGURED, GOOGLE_DRIVE_NOT_CONFIGURED_CODE);
  const hash = stateHash(args.state);
  const { data: stateRow, error: stateError } = await db
    .from("google_drive_oauth_states")
    .delete()
    .eq("state_hash", hash)
    .select("user_id, expires_at")
    .maybeSingle();
  if (stateError) return internalFailure(stateError);
  const row = stateRow as { user_id: string; expires_at: string } | null;
  if (!row) return failure("validation", "The authorization link is invalid or was already used.");
  if (new Date(row.expires_at).getTime() < deps.now()) {
    return failure("validation", "The authorization link expired. Start again from Varda.");
  }
  if (args.sessionUserId && args.sessionUserId !== row.user_id) {
    return failure("forbidden", "This authorization belongs to a different Varda session.");
  }
  const userId = row.user_id;

  const tokens = await exchangeCode(deps, args.code, args.redirectUri);
  if (!tokens.ok) return tokens;

  const existing = await loadConnection(db, userId);
  if (!existing.ok) return existing;
  const accountEmail = await fetchAccountEmail(deps.fetch, tokens.data.accessToken);
  const saved = await saveConnection(db, userId, tokens.data, accountEmail, existing.data);
  if (!saved.ok) return saved;
  return ok(connectionStatus(true, saved.data));
}

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function requestTokens(
  deps: OAuthDeps,
  params: Record<string, string>,
): Promise<ServiceResult<GoogleTokenResponse>> {
  const config = deps.config;
  if (!config) return failure("unavailable", NOT_CONFIGURED, GOOGLE_DRIVE_NOT_CONFIGURED_CODE);
  let response: Response;
  try {
    response = await deps.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...params,
      }).toString(),
    });
  } catch (error) {
    return internalFailure(error);
  }
  let body: GoogleTokenResponse = {};
  try {
    body = (await response.json()) as GoogleTokenResponse;
  } catch {
    body = {};
  }
  if (!response.ok || !body.access_token) {
    console.error("[google-drive] token request failed", {
      status: response.status,
      error: body.error,
      description: body.error_description,
      grant: params.grant_type,
    });
    if (body.error === "invalid_grant") {
      return failure("conflict", "Google no longer accepts this connection. Connect Google Drive again.", GOOGLE_DRIVE_NOT_CONNECTED_CODE);
    }
    return failure("unavailable", "Google did not accept the authorization. Try again.");
  }
  return ok(body);
}

async function exchangeCode(
  deps: OAuthDeps,
  code: string,
  redirectUri: string,
): Promise<ServiceResult<TokenSet>> {
  const result = await requestTokens(deps, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  if (!result.ok) return result;
  const body = result.data;
  return ok({
    accessToken: body.access_token!,
    refreshToken: body.refresh_token ?? null,
    expiresAt: deps.now() + Math.max(60, body.expires_in ?? 3600) * 1000,
    scope: body.scope ?? deps.config?.scope ?? "",
  });
}

async function fetchAccountEmail(
  fetchImpl: FetchLike,
  accessToken: string,
): Promise<string | null> {
  try {
    const response = await fetchImpl(
      `${DRIVE_API_URL}/about?fields=user(emailAddress)`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { user?: { emailAddress?: string } };
    return body.user?.emailAddress ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Access tokens for API calls

/** Refresh when fewer than this many ms remain, so a call in flight never expires. */
const REFRESH_MARGIN_MS = 60 * 1000;

/**
 * A usable access token for `userId`, refreshed and re-stored when the
 * cached one is about to expire.
 */
export async function getAccessToken(
  db: Db,
  userId: string,
  deps: OAuthDeps = defaultOAuthDeps(),
): Promise<ServiceResult<string>> {
  if (!deps.config) return failure("unavailable", NOT_CONFIGURED, GOOGLE_DRIVE_NOT_CONFIGURED_CODE);
  const loaded = await loadConnection(db, userId);
  if (!loaded.ok) return loaded;
  const row = loaded.data;
  if (!row) return failure("conflict", NOT_CONNECTED, GOOGLE_DRIVE_NOT_CONNECTED_CODE);

  const expiresAt = new Date(row.access_token_expires_at).getTime();
  const current = decryptString(row.encrypted_access_token, row.access_token_iv, row.access_token_tag);
  if (current && expiresAt - deps.now() > REFRESH_MARGIN_MS) return ok(current);

  const refreshToken = decryptString(
    row.encrypted_refresh_token,
    row.refresh_token_iv,
    row.refresh_token_tag,
  );
  if (!refreshToken) {
    return failure("conflict", "The Google Drive connection expired. Connect it again.", GOOGLE_DRIVE_NOT_CONNECTED_CODE);
  }
  const refreshed = await requestTokens(deps, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (!refreshed.ok) {
    // A revoked grant is permanent: drop the row so the UI offers a reconnect.
    if (refreshed.kind === "conflict") await deleteConnection(db, userId);
    return refreshed;
  }
  const body = refreshed.data;
  const saved = await saveConnection(
    db,
    userId,
    {
      accessToken: body.access_token!,
      refreshToken: body.refresh_token ?? null,
      expiresAt: deps.now() + Math.max(60, body.expires_in ?? 3600) * 1000,
      scope: body.scope ?? row.scope,
    },
    null,
    row,
  );
  if (!saved.ok) return saved;
  return ok(body.access_token!);
}

async function deleteConnection(db: Db, userId: string): Promise<ServiceResult<null>> {
  const { error } = await db
    .from("user_google_drive_connections")
    .delete()
    .eq("user_id", userId);
  if (error) return internalFailure(error);
  return ok(null);
}

/** Revoke the grant at Google (best effort) and forget the connection. */
export async function disconnectGoogleDrive(
  db: Db,
  userId: string,
  deps: OAuthDeps = defaultOAuthDeps(),
): Promise<ServiceResult<GoogleDriveStatus>> {
  const loaded = await loadConnection(db, userId);
  if (!loaded.ok) return loaded;
  const row = loaded.data;
  if (row) {
    const token =
      decryptString(row.encrypted_refresh_token, row.refresh_token_iv, row.refresh_token_tag) ??
      decryptString(row.encrypted_access_token, row.access_token_iv, row.access_token_tag);
    if (token) {
      try {
        await deps.fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
      } catch (error) {
        console.error("[google-drive] token revocation failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const deleted = await deleteConnection(db, userId);
    if (!deleted.ok) return deleted;
  }
  return ok(connectionStatus(!!deps.config, null));
}

/** Drop expired states; called opportunistically from the start route. */
export async function pruneExpiredOAuthStates(
  db: Db,
  now: () => number = () => Date.now(),
): Promise<void> {
  const { error } = await db
    .from("google_drive_oauth_states")
    .delete()
    .lt("expires_at", new Date(now()).toISOString());
  if (error) {
    console.error("[google-drive] oauth state prune failed", { error: error.message });
  }
}
