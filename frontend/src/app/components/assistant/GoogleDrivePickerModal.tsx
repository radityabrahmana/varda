"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronRight, Loader2, X } from "lucide-react";
import { Modal } from "../modals/Modal";
import { EmptyState } from "@/app/components/ui/empty-state";
import { SearchBar } from "@/app/components/ui/search-bar";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { LIQUID_GLASS_MODAL_ROW_HOVER_CLASS } from "@/shared/ui/LiquidGlassUI";
import { MfaVerificationPopup } from "../popups/MfaVerificationPopup";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { GoogleDriveIcon } from "../shared/GoogleDriveIcon";
import {
    GOOGLE_DRIVE_NOT_CONFIGURED_MESSAGE,
    useGoogleDriveConnection,
} from "@/app/hooks/useGoogleDriveConnection";
import {
    GOOGLE_DRIVE_NOT_CONNECTED_CODE,
    importGoogleDriveFile,
    listGoogleDriveFiles,
    type GoogleDriveFile,
} from "@/app/lib/vardaApi";
import { knownErrorCodeMessage, userFacingApiError } from "@/app/lib/userFacingError";
import type { Document } from "../shared/types";
import { cn } from "@/app/lib/utils";

interface Props {
    open: boolean;
    onClose: () => void;
    /** Import into this project; omitted means the caller's standalone files. */
    projectId?: string;
    onImported: (document: Document) => void;
    breadcrumb: string[];
}

const SEARCH_DEBOUNCE_MS = 300;

function formatModified(iso: string | null): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

/**
 * Pick a file in the user's Google Drive and import it as a Varda document.
 * Google Docs, Sheets and Slides arrive as DOCX, XLSX and PPTX; Office and
 * PDF files stored in Drive are copied as they are.
 */
export function GoogleDrivePickerModal({
    open,
    onClose,
    projectId,
    onImported,
    breadcrumb,
}: Props) {
    const connection = useGoogleDriveConnection({ enabled: open });
    const [search, setSearch] = useState("");
    const [files, setFiles] = useState<GoogleDriveFile[]>([]);
    const [nextPageToken, setNextPageToken] = useState<string | null>(null);
    const [listLoading, setListLoading] = useState(false);
    const [listError, setListError] = useState<string | null>(null);
    const [importingId, setImportingId] = useState<string | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const requestRef = useRef(0);

    const connected = connection.status?.connected === true;

    const loadFiles = useCallback(
        async (query: string, pageToken: string | null) => {
            const requestId = ++requestRef.current;
            setListLoading(true);
            setListError(null);
            try {
                const page = await listGoogleDriveFiles({
                    search: query,
                    pageToken,
                });
                if (requestId !== requestRef.current) return;
                setFiles((current) =>
                    pageToken ? [...current, ...page.files] : page.files,
                );
                setNextPageToken(page.next_page_token);
            } catch (err) {
                if (requestId !== requestRef.current) return;
                setListError(
                    knownErrorCodeMessage(
                        err,
                        {
                            [GOOGLE_DRIVE_NOT_CONNECTED_CODE]:
                                "Google Drive needs to be connected again.",
                        },
                        userFacingApiError(
                            err,
                            "Google Drive files could not be loaded. Please try again.",
                        ),
                    ),
                );
            } finally {
                if (requestId === requestRef.current) setListLoading(false);
            }
        },
        [],
    );

    // A fresh listing whenever the picker opens on a connected account, and
    // a debounced one as the search changes.
    useEffect(() => {
        if (!open || !connected) return;
        const timer = setTimeout(
            () => void loadFiles(search, null),
            search ? SEARCH_DEBOUNCE_MS : 0,
        );
        return () => clearTimeout(timer);
    }, [open, connected, search, loadFiles]);

    useEffect(() => {
        if (!open) {
            setImportError(null);
            setListError(null);
        }
    }, [open]);

    const handleImport = async (file: GoogleDriveFile) => {
        if (importingId) return;
        setImportingId(file.id);
        setImportError(null);
        try {
            const document = await importGoogleDriveFile({
                fileId: file.id,
                projectId: projectId ?? null,
            });
            onImported(document);
            onClose();
        } catch (err) {
            setImportError(
                knownErrorCodeMessage(
                    err,
                    {
                        [GOOGLE_DRIVE_NOT_CONNECTED_CODE]:
                            "Google Drive needs to be connected again.",
                    },
                    userFacingApiError(
                        err,
                        `“${file.name}” could not be imported. Please try again.`,
                    ),
                ),
            );
        } finally {
            setImportingId(null);
        }
    };

    const warning = importError ?? listError ?? connection.error;

    let body: React.ReactNode;
    if (connection.loading && !connection.status) {
        body = (
            <div className="flex flex-1 items-center justify-center py-12 text-gray-400">
                <Loader2 className="h-5 w-5 animate-spin" />
            </div>
        );
    } else if (connection.status && !connection.status.configured) {
        body = (
            <EmptyState
                icon={<GoogleDriveIcon />}
                title="Google Drive is not set up"
                description={GOOGLE_DRIVE_NOT_CONFIGURED_MESSAGE}
                className="py-10"
            />
        );
    } else if (!connected) {
        body = (
            <EmptyState
                icon={<GoogleDriveIcon />}
                title="Connect Google Drive"
                description="Varda reads the Google Docs you choose and keeps a copy here to work on. You can disconnect at any time."
                action={
                    <div className="flex items-center gap-2">
                        <PillButtonUI
                            tone="black"
                            loading={connection.busy === "connect"}
                            disabled={connection.busy !== null}
                            onClick={() => void connection.connect()}
                        >
                            Connect Google Drive
                        </PillButtonUI>
                        {connection.busy === "connect" && (
                            <PillButtonUI
                                tone="white"
                                onClick={connection.cancelConnect}
                            >
                                Cancel
                            </PillButtonUI>
                        )}
                    </div>
                }
                className="py-10"
            />
        );
    } else {
        body = (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
                <div className="flex items-center gap-3">
                    <SearchBar
                        value={search}
                        onValueChange={setSearch}
                        placeholder="Search Google Drive"
                        label="Search Google Drive"
                        wrapperClassName="flex-1"
                        autoFocus
                    />
                    <span className="hidden truncate text-xs text-gray-500 sm:inline">
                        {connection.status?.account_email}
                    </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                    {files.length === 0 && !listLoading ? (
                        <p className="px-2 py-8 text-center text-sm text-gray-500">
                            {search
                                ? "No matching files in Google Drive."
                                : "No Google Docs, Sheets, Slides, Office or PDF files found."}
                        </p>
                    ) : (
                        <ul className="space-y-0.5">
                            {files.map((file) => {
                                const importing = importingId === file.id;
                                return (
                                    <li key={file.id}>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                void handleImport(file)
                                            }
                                            disabled={
                                                importingId !== null &&
                                                !importing
                                            }
                                            aria-busy={importing || undefined}
                                            className={cn(
                                                "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-60",
                                                LIQUID_GLASS_MODAL_ROW_HOVER_CLASS,
                                            )}
                                        >
                                            <FileTypeIcon
                                                fileType={file.file_type}
                                                className="h-4 w-4"
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm text-gray-900">
                                                    {file.name}
                                                </span>
                                                <span className="block truncate text-xs text-gray-500">
                                                    {[
                                                        formatModified(
                                                            file.modifiedTime,
                                                        ),
                                                        file.ownerEmail,
                                                    ]
                                                        .filter(Boolean)
                                                        .join(" · ")}
                                                </span>
                                            </span>
                                            {importing ? (
                                                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-gray-400" />
                                            ) : (
                                                <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" />
                                            )}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {listLoading && (
                        <div className="flex justify-center py-3 text-gray-400">
                            <Loader2 className="h-4 w-4 animate-spin" />
                        </div>
                    )}
                    {nextPageToken && !listLoading && (
                        <div className="flex justify-center py-2">
                            <PillButtonUI
                                tone="white"
                                size="sm"
                                onClick={() =>
                                    void loadFiles(search, nextPageToken)
                                }
                            >
                                Load more
                            </PillButtonUI>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <>
            <Modal
                open={open}
                onClose={onClose}
                breadcrumbs={breadcrumb}
                cancelAction={{ label: "Close" }}
                footerStatus={
                    connected ? (
                        <button
                            type="button"
                            onClick={() => void connection.disconnect()}
                            disabled={connection.busy !== null}
                            className="text-xs text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline disabled:opacity-60"
                        >
                            {connection.busy === "disconnect"
                                ? "Disconnecting…"
                                : "Disconnect Google Drive"}
                        </button>
                    ) : undefined
                }
            >
                {warning && (
                    <div className="mb-2 flex items-center gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-gray-900">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />
                        <span className="min-w-0 flex-1">{warning}</span>
                        <button
                            type="button"
                            onClick={() => {
                                setImportError(null);
                                setListError(null);
                                connection.clearError();
                            }}
                            className="shrink-0 rounded p-0.5 text-black hover:bg-gray-100"
                            aria-label="Dismiss warning"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                )}
                {body}
            </Modal>
            <MfaVerificationPopup
                open={connection.mfa.open}
                onCancel={connection.mfa.onCancel}
                onVerified={connection.mfa.onVerified}
            />
        </>
    );
}
