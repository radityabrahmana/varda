// HTTP surface of the Google Drive source.
//   GET    /google-drive/status               configured? connected? as whom?
//   POST   /google-drive/oauth/start          { authorizationUrl, callbackOrigin }
//   GET    /google-drive/oauth/callback       Google redirects here; answers a popup page
//   DELETE /google-drive/connection           revoke + forget the connection
//   GET    /google-drive/files?q=&page_token= importable files, most recent first
//   POST   /google-drive/import               { file_id, project_id? } → the new Varda document
//
// Handlers parse, call the service and map ServiceResults onto status codes.
// Never query the database here.

import crypto from "crypto";
import { Router, type Request } from "express";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createRequestSupabase } from "../../lib/authSession";
import { sendServiceFailure } from "../../lib/serviceResult";
import { createServerSupabase } from "../../lib/supabase";
import {
  completeGoogleDriveOAuth,
  disconnectGoogleDrive,
  getGoogleDriveStatus,
  googleDriveCallbackUrl,
  importDriveFile,
  listGoogleDriveFiles,
  pruneExpiredOAuthStates,
  startGoogleDriveOAuth,
} from "./googleDrive.service";

export const googleDriveRouter = Router();

function queryString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function frontendUrl() {
  return (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * The page Google lands the popup on. It tells the opener how it went and
 * closes itself; strict identity providers sever `window.opener`, so the
 * opener also polls /status and this page falls back to a plain redirect.
 */
function popupHtml(payload: { success: boolean; detail?: string }, nonce: string) {
  const targetOrigin = new URL(frontendUrl()).origin;
  const message = JSON.stringify({ type: "google_drive_oauth_result", ...payload });
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Google Drive</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f9fafb; }
      main { max-width: 360px; padding: 24px; text-align: center; }
      p { color: #6b7280; }
    </style>
  </head>
  <body>
    <main>
      <h1>${payload.success ? "Google Drive connected" : "Connection failed"}</h1>
      <p>${payload.success ? "You can return to Varda." : "Return to Varda and try connecting again."}</p>
    </main>
    <script nonce="${nonce}">
      const message = ${message};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(message, ${JSON.stringify(targetOrigin)});
      }
      setTimeout(() => window.close(), ${payload.success ? 600 : 2500});
    </script>
  </body>
</html>`;
}

function popupCsp(nonce: string) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The browser session that reached the callback, if any (never throws). */
async function sessionUserId(req: Request, res: Parameters<typeof createRequestSupabase>[1]) {
  try {
    const { data } = await createRequestSupabase(req, res).auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

// The callback is the one route Google reaches without a Varda session.
googleDriveRouter.get("/oauth/callback", asyncRoute(async (req, res) => {
  const nonce = crypto.randomBytes(16).toString("base64");
  const state = queryString(req.query.state);
  const code = queryString(req.query.code);
  const error = queryString(req.query.error);
  const db = createServerSupabase();
  let success = false;
  if (!error && state && code) {
    const result = await completeGoogleDriveOAuth(db, {
      state,
      code,
      redirectUri: googleDriveCallbackUrl(),
      sessionUserId: await sessionUserId(req, res),
    });
    success = result.ok;
    if (!result.ok) {
      console.error("[google-drive] oauth callback failed", {
        kind: result.kind,
        detail: result.kind === "error" ? String(result.error) : result.detail,
      });
    }
  } else {
    console.error("[google-drive] oauth callback rejected", { error, hasState: !!state, hasCode: !!code });
  }
  res
    .status(success ? 200 : 400)
    .set("Content-Security-Policy", popupCsp(nonce))
    .type("html")
    .send(popupHtml({ success }, nonce));
}));

googleDriveRouter.use(requireAuth);

googleDriveRouter.get("/status", asyncRoute(async (_req, res) => {
  const result = await getGoogleDriveStatus(createServerSupabase(), res.locals.userId as string);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

googleDriveRouter.post("/oauth/start", requireMfaIfEnrolled, asyncRoute(async (_req, res) => {
  const db = createServerSupabase();
  await pruneExpiredOAuthStates(db);
  const redirectUri = googleDriveCallbackUrl();
  const result = await startGoogleDriveOAuth(db, res.locals.userId as string, redirectUri);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json({ ...result.data, callbackOrigin: new URL(redirectUri).origin });
}));

googleDriveRouter.delete("/connection", requireMfaIfEnrolled, asyncRoute(async (_req, res) => {
  const result = await disconnectGoogleDrive(createServerSupabase(), res.locals.userId as string);
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

googleDriveRouter.get("/files", asyncRoute(async (req, res) => {
  const result = await listGoogleDriveFiles(createServerSupabase(), res.locals.userId as string, {
    search: queryString(req.query.q),
    pageToken: queryString(req.query.page_token) || null,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.json(result.data);
}));

googleDriveRouter.post("/import", asyncRoute(async (req, res) => {
  const body = (req.body ?? {}) as { file_id?: unknown; project_id?: unknown };
  const result = await importDriveFile(createServerSupabase(), {
    userId: res.locals.userId as string,
    userEmail: (res.locals.userEmail as string | undefined) ?? null,
    fileId: typeof body.file_id === "string" ? body.file_id : "",
    projectId: typeof body.project_id === "string" && body.project_id ? body.project_id : null,
  });
  if (!result.ok) return void sendServiceFailure(res, result);
  res.status(201).json(result.data);
}));

googleDriveRouter.use(routerErrorHandler("[google-drive]"));
