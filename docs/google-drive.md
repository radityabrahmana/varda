# Google Drive as a document source

The composer's **+ Sources** menu offers three places a document can come
from: the device (upload), the Varda library, and Google Drive. Picking a file
in Google Drive imports it as a normal Varda document and attaches it to the
message, so the Assistant's `read_document`, `edit_document` (tracked changes)
and `review_contract` tools work on it unchanged. The team no longer downloads
a Google Doc, uploads it, and re-uploads the result by hand.

| Drive file | Stored as |
| --- | --- |
| Google Doc | `.docx` (Drive export, 10 MB cap) |
| Google Sheet | `.xlsx` |
| Google Slides | `.pptx` |
| Word, Excel, PowerPoint or PDF file kept in Drive | copied as-is (100 MB cap) |

Each import is version 1 of a new document with `source = 'google_drive'`,
and `document_google_drive_links` remembers the Drive file id, name, head
revision and modified time. Writing an edited version back to the Google Doc
is a later step; the link row and the recorded scope (`can_write` in the
status) are its inputs.

## Connecting

One Google connection per user, made from the picker itself or from
Settings → Connectors. The flow is the same popup pattern as OAuth MCP
connectors: the popup opens on the click, the backend mints a single-use
state (only its hash is stored, ten-minute expiry) and builds the consent
URL with `access_type=offline` and `prompt=consent` so Google issues a
refresh token, and the browser polls `/google-drive/status` until the
backend has stored the tokens (Google's consent page severs `window.opener`,
so the callback page's `postMessage` is only an accelerator).

The callback also compares the Varda session that reached it with the user
who started the flow, when a session cookie is present, so a crafted consent
link cannot attach someone else's Google account to a session.

Tokens are encrypted at rest with AES-256-GCM using
`MCP_CONNECTORS_ENCRYPTION_SECRET` (falling back to
`USER_API_KEYS_ENCRYPTION_SECRET`). Access tokens are refreshed a minute
before expiry; a revoked grant (`invalid_grant`) deletes the connection so the
UI offers a reconnect. Disconnecting revokes the token at Google and deletes
the row. Connecting and disconnecting require MFA verification for enrolled
users, like the MCP connector mutations.

The default scope is `drive.readonly`, enough to list and export. Set
`GOOGLE_DRIVE_OAUTH_SCOPE=https://www.googleapis.com/auth/drive` before
write-back ships; users connected under the narrower scope reconnect once.

## Setup

1. In Google Cloud Console, create (or reuse the MCP connector's) OAuth
   client of type **Web application** and add the callback as an authorized
   redirect URI. It is derived from `API_PUBLIC_URL`:
   `https://<frontend host>/api/google-drive/oauth/callback`.
2. Enable the **Google Drive API** in the same project.
3. If the workspace is a Google Workspace domain, set the consent screen to
   **Internal**: no verification review is needed for the Drive scopes.
4. Set `GOOGLE_DRIVE_OAUTH_CLIENT_ID` and `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`
   on the backend (they fall back to `GOOGLE_MCP_OAUTH_CLIENT_ID` /
   `GOOGLE_MCP_OAUTH_CLIENT_SECRET`, so one client can serve both features).
5. Apply `backend/janus-migrations/20260926_01_google_drive.sql` in the
   Supabase SQL editor.

Until step 4 is done, `/google-drive/status` answers `configured: false` and
the picker explains that an administrator has to finish setup.

## Endpoints

All under `/google-drive`, module `backend/src/modules/google-drive/`.

| Route | Purpose |
| --- | --- |
| `GET /status` | `{ configured, connected, account_email, can_write }` |
| `POST /oauth/start` | `{ authorizationUrl, callbackOrigin }` (MFA-gated) |
| `GET /oauth/callback` | Google lands the popup here; answers a self-closing page |
| `DELETE /connection` | revoke and forget (MFA-gated) |
| `GET /files?q=&page_token=` | importable files, most recently viewed first; `q` is a name prefix match across My Drive and shared drives |
| `POST /import` `{ file_id, project_id? }` | the new document, in the same shape the upload protocol returns |

An import into a project requires `content.edit` on that project and stamps
the project's organization on the document, the same rule the upload session
protocol enforces.

## Frontend

- `components/assistant/SourcesMenu.tsx` — the composer control.
- `components/assistant/GoogleDrivePickerModal.tsx` — connect, search, pick.
- `components/settings/GoogleDriveConnectionCard.tsx` — Settings → Connectors.
- `hooks/useGoogleDriveConnection.ts` — status, connect (popup + MFA retry),
  disconnect, shared by both surfaces.
- `lib/googleDriveOAuth.ts` — the popup-and-poll flow, unit tested.
- `lib/vardaApi.ts` — `getGoogleDriveStatus`, `startGoogleDriveOAuth`,
  `disconnectGoogleDrive`, `listGoogleDriveFiles`, `importGoogleDriveFile`.
