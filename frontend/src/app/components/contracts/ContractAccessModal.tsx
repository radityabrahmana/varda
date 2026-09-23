"use client";

import { useCallback, useState } from "react";
import { Link2 } from "lucide-react";
import { AccessModal } from "@/app/components/modals/AccessModal";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    getContractAccess,
    getContractPeople,
    grantContractAccess,
    revokeContractAccess,
    type ContentAccess,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";

// Share dialog for one contract review (the "Bagikan" header action). Reviews
// are private: only the uploader, people added here, and Varda admins can open
// them — the copied link works only for those people.

interface Props {
    open: boolean;
    reviewId: string;
    title: string | null;
    ownerEmail?: string | null;
    /** Owner or admin: may add, re-role and remove people. */
    canManage: boolean;
    onClose: () => void;
}

export function ContractAccessModal({ open, reviewId, title, ownerEmail, canManage, onClose }: Props) {
    const { user } = useAuth();
    const [access, setAccess] = useState<{ reviewId: string; value: ContentAccess } | null>(null);
    const [accessError, setAccessError] = useState<string | null>(null);
    const [linkMessage, setLinkMessage] = useState<string | null>(null);
    const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
    const grants = access?.reviewId === reviewId ? access.value.grants : [];

    const refreshAccess = useCallback(async () => {
        const value = await getContractAccess(reviewId);
        setAccess({ reviewId, value });
    }, [reviewId]);

    // The roster loads on its own; a refused grants fetch only withdraws
    // management and says so (same contract as ChatAccessModal).
    const loadPeople = useCallback(
        async (id: string) => {
            const people = await getContractPeople(id);
            if (!canManage) {
                setAccessError(null);
                return people;
            }
            try {
                const value = await getContractAccess(id);
                setAccess({ reviewId: id, value });
                setAccessError(null);
            } catch (cause) {
                setAccessError(userFacingApiError(cause, "Detail akses tidak dapat dimuat, sehingga akses tidak dapat diubah di sini."));
            }
            return people;
        },
        [canManage],
    );

    const copyLink = async () => {
        const url = `${window.location.origin}/contracts/${reviewId}`;
        try {
            await navigator.clipboard.writeText(url);
            setFallbackUrl(null);
            setLinkMessage("Tautan disalin");
            window.setTimeout(() => setLinkMessage(null), 3000);
        } catch {
            // Embedded browsers and strict policies block the clipboard.
            setLinkMessage(null);
            setFallbackUrl(url);
        }
    };

    const headerAction = (
        <div className="flex items-center gap-2">
            {linkMessage ? <span className="text-xs text-gray-600" role="status">{linkMessage}</span> : null}
            {fallbackUrl ? (
                <input
                    readOnly
                    autoFocus
                    value={fallbackUrl}
                    aria-label="Tautan tinjauan"
                    onFocus={(e) => e.currentTarget.select()}
                    className="w-56 max-w-full rounded border border-gray-200 bg-white px-2 py-0.5 font-mono text-[11px] text-gray-800"
                />
            ) : null}
            <button
                type="button"
                onClick={() => void copyLink()}
                className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-800 hover:bg-gray-50"
                title="Tautan hanya bisa dibuka oleh orang yang memiliki akses"
            >
                <Link2 className="h-3 w-3" /> Salin tautan
            </button>
        </div>
    );

    return (
        <AccessModal
            open={open}
            onClose={onClose}
            resource={{ id: reviewId, owner_email: ownerEmail ?? null }}
            fetchAccess={loadPeople}
            currentUserEmail={user?.email ?? null}
            currentUserId={user?.id ?? null}
            breadcrumb={["Contracts", title?.trim() || "Tinjauan", "Access"]}
            headerAction={headerAction}
            access={{
                grants,
                orgId: null,
                inheritedFromProjectId: null,
                ownerLabel: "Pemilik",
                canManage: canManage && accessError === null,
                error: accessError,
                onGrant: async (email, role) => {
                    await grantContractAccess(reviewId, email, role);
                    await refreshAccess();
                },
                onRevoke: async (email) => {
                    await revokeContractAccess(reviewId, email);
                    await refreshAccess();
                },
            }}
        />
    );
}
