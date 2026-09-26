import type { GoogleDriveStatus } from "./vardaApi";

/**
 * The browser side of connecting Google Drive: open a popup on the user's
 * click, send it to Google's consent page, and wait until the backend
 * reports the connection.
 *
 * Google serves its consent page with `Cross-Origin-Opener-Policy:
 * same-origin`, which severs `window.opener`: the callback page's
 * `postMessage` may never arrive and `popup.closed` can be unreadable. The
 * backend's status endpoint is therefore the source of truth and is polled;
 * a message that does get through only shortens the wait.
 */

export type GoogleDriveOAuthMessage = {
    type: "google_drive_oauth_result";
    success: boolean;
    detail?: string;
};

export type ConnectGoogleDriveDeps = {
    start: () => Promise<{ authorizationUrl: string; callbackOrigin: string }>;
    getStatus: () => Promise<GoogleDriveStatus>;
    /** Called synchronously first, while the click is still a user gesture. */
    openPopup: () => Window | null;
    /** Fallback when the popup is blocked: leave the app for Google. */
    navigate: (url: string) => void;
    signal?: AbortSignal;
    pollIntervalMs?: number;
    timeoutMs?: number;
    /** Where to listen for the callback page's message; defaults to `window`. */
    target?: Pick<Window, "addEventListener" | "removeEventListener">;
};

export const GOOGLE_DRIVE_POPUP_NAME = "varda_google_drive_oauth";
export const GOOGLE_DRIVE_POPUP_FEATURES =
    "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no";

const DEFAULT_POLL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class GoogleDriveConnectError extends Error {
    kind: "cancelled" | "timeout" | "failed";
    constructor(kind: "cancelled" | "timeout" | "failed", message: string) {
        super(message);
        this.name = "GoogleDriveConnectError";
        this.kind = kind;
    }
}

/**
 * Resolves with the connected status. Rejects with `GoogleDriveConnectError`
 * when the user cancels, the wait times out or Google reports a failure, and
 * with the start call's own error when the backend refuses to begin. When
 * the popup is blocked the current page navigates to Google instead and the
 * promise never settles.
 */
export async function connectGoogleDriveWithPopup(
    deps: ConnectGoogleDriveDeps,
): Promise<GoogleDriveStatus> {
    const popup = deps.openPopup();
    let started: Awaited<ReturnType<ConnectGoogleDriveDeps["start"]>>;
    try {
        started = await deps.start();
    } catch (error) {
        popup?.close();
        throw error;
    }
    if (!popup) {
        deps.navigate(started.authorizationUrl);
        return new Promise<GoogleDriveStatus>(() => {});
    }
    popup.location.href = started.authorizationUrl;

    const expectedOrigin = new URL(started.callbackOrigin).origin;
    const target = deps.target ?? window;
    const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = deps.signal;

    return new Promise<GoogleDriveStatus>((resolve, reject) => {
        let settled = false;
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let polling = false;
        const deadline = setTimeout(() => {
            finish(() =>
                reject(
                    new GoogleDriveConnectError(
                        "timeout",
                        "Google Drive authorization timed out. Try again.",
                    ),
                ),
            );
        }, timeoutMs);

        const cleanup = () => {
            clearTimeout(deadline);
            if (pollTimer) clearTimeout(pollTimer);
            target.removeEventListener("message", onMessage);
            signal?.removeEventListener("abort", onAbort);
        };
        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            try {
                popup.close();
            } catch {
                /* unreadable across COOP */
            }
            action();
        };

        const poll = async () => {
            if (settled || polling) return;
            polling = true;
            try {
                const status = await deps.getStatus();
                if (status.connected) {
                    finish(() => resolve(status));
                    return;
                }
            } catch {
                /* transient; keep polling */
            } finally {
                polling = false;
            }
            if (!settled) pollTimer = setTimeout(() => void poll(), pollMs);
        };

        const onMessage = (event: MessageEvent<GoogleDriveOAuthMessage>) => {
            if (event.origin !== expectedOrigin) return;
            if (event.data?.type !== "google_drive_oauth_result") return;
            if (event.data.success) {
                if (pollTimer) clearTimeout(pollTimer);
                pollTimer = null;
                void poll();
                return;
            }
            finish(() =>
                reject(
                    new GoogleDriveConnectError(
                        "failed",
                        event.data.detail ||
                            "Google Drive could not be connected.",
                    ),
                ),
            );
        };
        const onAbort = () => {
            finish(() =>
                reject(
                    new GoogleDriveConnectError(
                        "cancelled",
                        "Google Drive connection cancelled.",
                    ),
                ),
            );
        };

        target.addEventListener("message", onMessage as EventListener);
        signal?.addEventListener("abort", onAbort);
        if (signal?.aborted) {
            onAbort();
            return;
        }
        pollTimer = setTimeout(() => void poll(), pollMs);
    });
}
