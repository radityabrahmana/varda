"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ReviewAccessRole } from "./reviewTypes";

// The caller's standing on the open review (from GET /contracts/:id → access).
// The backend enforces every write; this only hides controls a viewer cannot
// use. Defaults to full access so components rendered outside a workspace
// (tests, previews) behave as before.

export interface ReviewAccessValue {
    role: ReviewAccessRole;
    /** Feedback, comments, redlines, status, memo. */
    canEdit: boolean;
    /** Sharing and delete (owner or admin). */
    canManage: boolean;
}

const FULL_ACCESS: ReviewAccessValue = { role: "owner", canEdit: true, canManage: true };

const ReviewAccessContext = createContext<ReviewAccessValue>(FULL_ACCESS);

export function reviewAccessFor(role: ReviewAccessRole | null | undefined): ReviewAccessValue {
    const r = role ?? "owner";
    return { role: r, canEdit: r !== "viewer", canManage: r === "owner" };
}

export function ReviewAccessProvider({ role, children }: { role: ReviewAccessRole | null | undefined; children: ReactNode }) {
    return <ReviewAccessContext.Provider value={reviewAccessFor(role)}>{children}</ReviewAccessContext.Provider>;
}

export function useReviewAccess(): ReviewAccessValue {
    return useContext(ReviewAccessContext);
}
