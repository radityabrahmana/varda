import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    GoogleDriveConnectError,
    connectGoogleDriveWithPopup,
} from "./googleDriveOAuth";
import type { GoogleDriveStatus } from "./vardaApi";

const disconnected: GoogleDriveStatus = {
    configured: true,
    connected: false,
    account_email: null,
    can_write: false,
};
const connected: GoogleDriveStatus = {
    ...disconnected,
    connected: true,
    account_email: "legal@dashelectric.co",
};

function fakePopup() {
    return {
        location: { href: "about:blank" },
        close: vi.fn(),
    } as unknown as Window & { location: { href: string }; close: () => void };
}

function fakeTarget() {
    const listeners = new Set<EventListener>();
    return {
        addEventListener: (_type: string, listener: EventListener) => {
            listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: EventListener) => {
            listeners.delete(listener);
        },
        emit: (event: Partial<MessageEvent>) => {
            for (const listener of Array.from(listeners)) listener(event as Event);
        },
        size: () => listeners.size,
    };
}

const started = {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    callbackOrigin: "https://varda.example",
};

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("connectGoogleDriveWithPopup", () => {
    it("opens the popup before the start call and resolves once status reports connected", async () => {
        const popup = fakePopup();
        const order: string[] = [];
        const getStatus = vi
            .fn<() => Promise<GoogleDriveStatus>>()
            .mockResolvedValueOnce(disconnected)
            .mockResolvedValueOnce(connected);
        const target = fakeTarget();
        const promise = connectGoogleDriveWithPopup({
            openPopup: () => {
                order.push("popup");
                return popup;
            },
            start: async () => {
                order.push("start");
                return started;
            },
            getStatus,
            navigate: vi.fn(),
            target,
            pollIntervalMs: 100,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual(["popup", "start"]);
        expect(popup.location.href).toBe(started.authorizationUrl);

        await vi.advanceTimersByTimeAsync(100);
        expect(getStatus).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(100);
        await expect(promise).resolves.toEqual(connected);
        expect(popup.close).toHaveBeenCalled();
        expect(target.size()).toBe(0);
    });

    it("closes the popup and rethrows when the backend refuses to start", async () => {
        const popup = fakePopup();
        const failure = new Error("google_drive_not_configured");
        await expect(
            connectGoogleDriveWithPopup({
                openPopup: () => popup,
                start: async () => {
                    throw failure;
                },
                getStatus: vi.fn(),
                navigate: vi.fn(),
                target: fakeTarget(),
            }),
        ).rejects.toBe(failure);
        expect(popup.close).toHaveBeenCalled();
    });

    it("navigates the page when the popup is blocked", async () => {
        const navigate = vi.fn();
        void connectGoogleDriveWithPopup({
            openPopup: () => null,
            start: async () => started,
            getStatus: vi.fn(),
            navigate,
            target: fakeTarget(),
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(navigate).toHaveBeenCalledWith(started.authorizationUrl);
    });

    it("checks status right away on a success message and ignores other origins", async () => {
        const popup = fakePopup();
        const getStatus = vi.fn<() => Promise<GoogleDriveStatus>>().mockResolvedValue(connected);
        const target = fakeTarget();
        const promise = connectGoogleDriveWithPopup({
            openPopup: () => popup,
            start: async () => started,
            getStatus,
            navigate: vi.fn(),
            target,
            pollIntervalMs: 10_000,
        });
        await vi.advanceTimersByTimeAsync(0);
        target.emit({
            origin: "https://evil.example",
            data: { type: "google_drive_oauth_result", success: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(getStatus).not.toHaveBeenCalled();
        target.emit({
            origin: "https://varda.example",
            data: { type: "google_drive_oauth_result", success: true },
        });
        await vi.advanceTimersByTimeAsync(0);
        await expect(promise).resolves.toEqual(connected);
    });

    it("rejects on a failure message, on abort and on timeout", async () => {
        const target = fakeTarget();
        const failed = connectGoogleDriveWithPopup({
            openPopup: fakePopup,
            start: async () => started,
            getStatus: vi.fn().mockResolvedValue(disconnected),
            navigate: vi.fn(),
            target,
        });
        // Attach the expectations before the rejection fires so the runtime
        // never sees an unhandled rejection.
        const failedRejects = expect(failed).rejects.toMatchObject({ kind: "failed", message: "denied" });
        await vi.advanceTimersByTimeAsync(0);
        target.emit({
            origin: "https://varda.example",
            data: { type: "google_drive_oauth_result", success: false, detail: "denied" },
        });
        await failedRejects;

        const controller = new AbortController();
        const aborted = connectGoogleDriveWithPopup({
            openPopup: fakePopup,
            start: async () => started,
            getStatus: vi.fn().mockResolvedValue(disconnected),
            navigate: vi.fn(),
            target: fakeTarget(),
            signal: controller.signal,
        });
        const abortedRejects = expect(aborted).rejects.toSatisfy(
            (error) => error instanceof GoogleDriveConnectError && error.kind === "cancelled",
        );
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await abortedRejects;

        const timedOut = connectGoogleDriveWithPopup({
            openPopup: fakePopup,
            start: async () => started,
            getStatus: vi.fn().mockResolvedValue(disconnected),
            navigate: vi.fn(),
            target: fakeTarget(),
            pollIntervalMs: 50,
            timeoutMs: 120,
        });
        const timedOutRejects = expect(timedOut).rejects.toMatchObject({ kind: "timeout" });
        await vi.advanceTimersByTimeAsync(130);
        await timedOutRejects;
    });

    it("ignores unrelated messages, tolerates a poll in flight, and uses the default failure text", async () => {
        let resolveStatus: (status: GoogleDriveStatus) => void = () => {};
        const getStatus = vi.fn(
            () =>
                new Promise<GoogleDriveStatus>((resolve) => {
                    resolveStatus = resolve;
                }),
        );
        const target = fakeTarget();
        const promise = connectGoogleDriveWithPopup({
            openPopup: fakePopup,
            start: async () => started,
            getStatus,
            navigate: vi.fn(),
            target,
            pollIntervalMs: 100,
        });
        const rejects = expect(promise).rejects.toMatchObject({
            kind: "failed",
            message: "Google Drive could not be connected.",
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(getStatus).toHaveBeenCalledTimes(1);

        // Wrong message type from the right origin: nothing happens.
        target.emit({ origin: "https://varda.example", data: { type: "other" } });
        // Two success messages while that poll is still pending: neither
        // starts a second request.
        target.emit({ origin: "https://varda.example", data: { type: "google_drive_oauth_result", success: true } });
        target.emit({ origin: "https://varda.example", data: { type: "google_drive_oauth_result", success: true } });
        await vi.advanceTimersByTimeAsync(0);
        expect(getStatus).toHaveBeenCalledTimes(1);

        // A failure without detail settles with the generic text…
        target.emit({ origin: "https://varda.example", data: { type: "google_drive_oauth_result", success: false } });
        await rejects;
        // …and the poll that was in flight cannot resolve it afterwards.
        resolveStatus(connected);
        await vi.advanceTimersByTimeAsync(200);
        expect(getStatus).toHaveBeenCalledTimes(1);
    });

    it("rejects at once when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const getStatus = vi.fn();
        await expect(
            connectGoogleDriveWithPopup({
                openPopup: fakePopup,
                start: async () => started,
                getStatus,
                navigate: vi.fn(),
                target: fakeTarget(),
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ kind: "cancelled" });
        expect(getStatus).not.toHaveBeenCalled();
    });

    it("listens on the window by default", async () => {
        const getStatus = vi.fn<() => Promise<GoogleDriveStatus>>().mockResolvedValue(connected);
        const promise = connectGoogleDriveWithPopup({
            openPopup: fakePopup,
            start: async () => started,
            getStatus,
            navigate: vi.fn(),
            pollIntervalMs: 10_000,
        });
        await vi.advanceTimersByTimeAsync(0);
        window.dispatchEvent(
            new MessageEvent("message", {
                origin: "https://varda.example",
                data: { type: "google_drive_oauth_result", success: true },
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        await expect(promise).resolves.toEqual(connected);
    });
});
