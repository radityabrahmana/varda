"use client";

import { Loader2 } from "lucide-react";
import { SettingsCard } from "./SettingsCard";
import { SettingsDescription, SettingsLabel } from "./SettingsText";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { MfaVerificationPopup } from "../popups/MfaVerificationPopup";
import { GoogleDriveIcon } from "../shared/GoogleDriveIcon";
import {
    GOOGLE_DRIVE_NOT_CONFIGURED_MESSAGE,
    useGoogleDriveConnection,
} from "@/app/hooks/useGoogleDriveConnection";

/**
 * Settings → Connectors: the state of the caller's Google Drive connection
 * with connect / disconnect. The same connection feeds the composer's
 * "Sources → Google Drive" picker.
 */
export function GoogleDriveConnectionCard() {
    const connection = useGoogleDriveConnection({ enabled: true });
    const status = connection.status;
    const connected = status?.connected === true;

    let description: string;
    if (!status) description = "Checking the connection…";
    else if (!status.configured) description = GOOGLE_DRIVE_NOT_CONFIGURED_MESSAGE;
    else if (connected)
        description = `Connected as ${status.account_email ?? "your Google account"}. Google Docs you pick from the composer are imported as Word documents.`;
    else
        description =
            "Attach Google Docs, Sheets and Slides straight from the composer. Varda keeps a copy to work on.";

    return (
        <>
            <SettingsCard>
                <div className="flex items-center gap-4 p-4">
                    <GoogleDriveIcon className="h-7 w-7 shrink-0" />
                    <div className="min-w-0 flex-1">
                        <SettingsLabel>Google Drive</SettingsLabel>
                        <SettingsDescription>{description}</SettingsDescription>
                        {connection.error && (
                            <p className="mt-1 text-xs text-red-600" role="alert">
                                {connection.error}
                            </p>
                        )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        {connection.loading && !status ? (
                            <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                        ) : connected ? (
                            <PillButtonUI
                                tone="white"
                                size="sm"
                                loading={connection.busy === "disconnect"}
                                disabled={connection.busy !== null}
                                onClick={() => void connection.disconnect()}
                            >
                                Disconnect
                            </PillButtonUI>
                        ) : status?.configured ? (
                            <>
                                {connection.busy === "connect" && (
                                    <PillButtonUI
                                        tone="white"
                                        size="sm"
                                        onClick={connection.cancelConnect}
                                    >
                                        Cancel
                                    </PillButtonUI>
                                )}
                                <PillButtonUI
                                    tone="black"
                                    size="sm"
                                    loading={connection.busy === "connect"}
                                    disabled={connection.busy !== null}
                                    onClick={() => void connection.connect()}
                                >
                                    Connect
                                </PillButtonUI>
                            </>
                        ) : null}
                    </div>
                </div>
            </SettingsCard>
            <MfaVerificationPopup
                open={connection.mfa.open}
                onCancel={connection.mfa.onCancel}
                onVerified={connection.mfa.onVerified}
            />
        </>
    );
}
