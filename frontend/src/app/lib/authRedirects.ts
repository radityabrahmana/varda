const AUTH_REDIRECT_PATHS = new Set([
    "/assistant",
    "/login",
    "/reset-password",
    "/settings",
    "/onboarding/profile",
    "/onboarding/practice",
]);

// Deep-linkable app sections: a shared link such as /contracts/<id> must
// survive the login round-trip so the recipient lands on that contract.
const AUTH_REDIRECT_PREFIXES = ["/contracts", "/playbook"];

function isAllowedAuthPath(pathname: string): boolean {
    if (AUTH_REDIRECT_PATHS.has(pathname)) return true;
    return AUTH_REDIRECT_PREFIXES.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
}

/**
 * Where an unauthenticated visitor should be sent to log in, remembering the
 * page they asked for when it is a safe internal destination.
 */
export function loginUrlForCurrentLocation(): string {
    if (typeof window === "undefined") return "/login";
    const here = `${window.location.pathname}${window.location.search}`;
    const next = safeAuthNext(here, "");
    return next ? `/login?next=${encodeURIComponent(next)}` : "/login";
}

/** The `next` carried on the current auth page URL, or the fallback. */
export function requestedAuthNext(fallback: string): string {
    if (typeof window === "undefined") return fallback;
    const next = new URLSearchParams(window.location.search).get("next");
    return safeAuthNext(next, fallback);
}

export function safeAuthNext(
    candidate: string | null | undefined,
    fallback = "/assistant",
): string {
    if (
        !candidate ||
        !candidate.startsWith("/") ||
        candidate.startsWith("//")
    ) {
        return fallback;
    }
    if (candidate.includes("\\") || /[\u0000-\u001f\u007f]/.test(candidate)) {
        return fallback;
    }

    const base = new URL("https://auth.mike.local");
    const resolved = new URL(candidate, base);
    if (
        resolved.origin !== base.origin ||
        !isAllowedAuthPath(resolved.pathname)
    ) {
        return fallback;
    }
    return `${resolved.pathname}${resolved.search}`;
}

export function authCallbackUrl(origin: string, next: string): string {
    const callback = new URL("/auth/callback", origin);
    callback.searchParams.set("next", safeAuthNext(next));
    return callback.toString();
}

export function browserAuthCallbackUrl(next: string): string | undefined {
    if (typeof window === "undefined") return undefined;
    return authCallbackUrl(window.location.origin, next);
}

export function authErrorDescription(
    search: string,
    hash: string,
): string | null {
    const query = new URLSearchParams(search);
    const fragment = new URLSearchParams(hash.replace(/^#/, ""));
    const error = (
        query.get("error_description") ||
        query.get("error") ||
        fragment.get("error_description") ||
        fragment.get("error")
    );
    if (!error) return null;
    if (/expired|invalid/i.test(error)) {
        return "This confirmation link is invalid or has expired.";
    }
    if (/access.denied|cancel/i.test(error)) {
        return "Authentication was cancelled or denied.";
    }
    return "Authentication could not be completed. Please try again.";
}
