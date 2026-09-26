"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    GOOGLE_DRIVE_POPUP_FEATURES,
    GOOGLE_DRIVE_POPUP_NAME,
    GoogleDriveConnectError,
    connectGoogleDriveWithPopup,
} from "@/app/lib/googleDriveOAuth";
import { knownErrorCodeMessage, userFacingApiError } from "@/app/lib/userFacingError";
import {
    GOOGLE_DRIVE_NOT_CONFIGURED_CODE,
    disconnectGoogleDrive,
    getGoogleDriveStatus,
    isMfaRequiredError,
    startGoogleDriveOAuth,
    type GoogleDriveStatus,
} from "@/app/lib/vardaApi";

export const GOOGLE_DRIVE_NOT_CONFIGURED_MESSAGE =
    "Google Drive is not set up for this workspace yet. Ask an administrator to add the Google OAuth credentials.";

type PendingAction = "connect" | "disconnect";

/**
 * One connection state for every surface that offers Google Drive (the
 * composer's picker, Settings → Connectors): loads the status when
 * `enabled`, runs the popup flow, and routes an MFA challenge through the
 * caller's `MfaVerificationPopup` before retrying the same action.
 */
export function useGoogleDriveConnection({ enabled }: { enabled: boolean }) {
    const [status, setStatus] = useState<GoogleDriveStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState<PendingAction | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pendingMfa, setPendingMfa] = useState<PendingAction | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const loadedRef = useRef(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const next = await getGoogleDriveStatus();
            setStatus(next);
            setError(null);
            return next;
        } catch (err) {
            setError(
                userFacingApiError(
                    err,
                    "Google Drive status could not be loaded.",
                ),
            );
            return null;
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!enabled || loadedRef.current) return;
        loadedRef.current = true;
        void refresh();
    }, [enabled, refresh]);

    useEffect(() => () => abortRef.current?.abort(), []);

    const connect = useCallback(async () => {
        setError(null);
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy("connect");
        try {
            const next = await connectGoogleDriveWithPopup({
                openPopup: () =>
                    window.open(
                        "about:blank",
                        GOOGLE_DRIVE_POPUP_NAME,
                        GOOGLE_DRIVE_POPUP_FEATURES,
                    ),
                start: startGoogleDriveOAuth,
                getStatus: getGoogleDriveStatus,
                navigate: (url) => window.location.assign(url),
                signal: controller.signal,
            });
            setStatus(next);
            return next;
        } catch (err) {
            if (isMfaRequiredError(err)) {
                setPendingMfa("connect");
                return null;
            }
            if (
                err instanceof GoogleDriveConnectError &&
                err.kind === "cancelled"
            ) {
                return null;
            }
            setError(
                knownErrorCodeMessage(
                    err,
                    {
                        [GOOGLE_DRIVE_NOT_CONFIGURED_CODE]:
                            GOOGLE_DRIVE_NOT_CONFIGURED_MESSAGE,
                    },
                    err instanceof GoogleDriveConnectError
                        ? err.message
                        : userFacingApiError(
                              err,
                              "Google Drive could not be connected. Please try again.",
                          ),
                ),
            );
            return null;
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
            setBusy(null);
        }
    }, []);

    const cancelConnect = useCallback(() => {
        abortRef.current?.abort();
    }, []);

    const disconnect = useCallback(async () => {
        setError(null);
        setBusy("disconnect");
        try {
            const next = await disconnectGoogleDrive();
            setStatus(next);
            return next;
        } catch (err) {
            if (isMfaRequiredError(err)) {
                setPendingMfa("disconnect");
                return null;
            }
            setError(
                userFacingApiError(
                    err,
                    "Google Drive could not be disconnected. Please try again.",
                ),
            );
            return null;
        } finally {
            setBusy(null);
        }
    }, []);

    const onMfaVerified = useCallback(() => {
        const action = pendingMfa;
        setPendingMfa(null);
        if (action === "connect") void connect();
        if (action === "disconnect") void disconnect();
    }, [connect, disconnect, pendingMfa]);

    const onMfaCancel = useCallback(() => setPendingMfa(null), []);

    return {
        status,
        loading,
        busy,
        error,
        clearError: () => setError(null),
        refresh,
        connect,
        cancelConnect,
        disconnect,
        mfa: { open: pendingMfa !== null, onVerified: onMfaVerified, onCancel: onMfaCancel },
    };
}
