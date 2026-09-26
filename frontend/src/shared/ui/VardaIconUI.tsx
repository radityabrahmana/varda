"use client";

import React, { useSyncExternalStore } from "react";

// The Varda mark: a four-point star whose upper-right quadrant is squared off.
// Drawn in the 480px artboard it was designed on; the viewBox crops to it.
export const VARDA_MARK_PATH =
    "M 233 94 L 247 94 L 247 232 L 385 232 L 385 247 C 290 252 252 290 247 385 L 233 385 C 228 290 190 252 95 247 L 94 247 L 94 233 C 190 228 228 190 233 94 Z";
export const VARDA_MARK_VIEWBOX = "94 94 292 292";

export const VARDA_BRAND_COLOR = "#6000ff";
// #6000ff is under 3:1 against the dark surfaces, so dark mode lightens it.
const DARK_THEME_COLOR = "#8b5cff";
const DONE_COLOR = "#4ade80";
const ERROR_COLOR = "#f87171";

const FILL_TRANSITION = "fill 220ms ease";

// The mark is inline SVG, so the neutral-palette dark remapping in
// globals.css cannot reach it; it watches the document theme class itself.
// One observer serves every icon on the page. Targets that never set the
// class (the Word add-in) always read false and keep the brand color.
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function subscribeToTheme(listener: () => void): () => void {
    themeListeners.add(listener);
    if (!themeObserver && typeof MutationObserver !== "undefined") {
        themeObserver = new MutationObserver(() => {
            themeListeners.forEach((notify) => notify());
        });
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class"],
        });
    }

    return () => {
        themeListeners.delete(listener);
        if (themeListeners.size === 0) {
            themeObserver?.disconnect();
            themeObserver = null;
        }
    };
}

function readDarkTheme(): boolean {
    return (
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark")
    );
}

function readDarkThemeOnServer(): boolean {
    return false;
}

function useDarkTheme(): boolean {
    return useSyncExternalStore(
        subscribeToTheme,
        readDarkTheme,
        readDarkThemeOnServer,
    );
}

export function VardaIcon({
    spin = false,
    done = false,
    error = false,
    varda = false,
    size = 24,
    style,
}: {
    spin?: boolean;
    done?: boolean;
    error?: boolean;
    varda?: boolean;
    size?: number;
    style?: React.CSSProperties;
}) {
    void varda;
    const darkTheme = useDarkTheme();
    const fill = error
        ? ERROR_COLOR
        : done
          ? DONE_COLOR
          : darkTheme
            ? DARK_THEME_COLOR
            : VARDA_BRAND_COLOR;

    return (
        <span
            className="shrink-0 inline-block animate-[spin_3s_linear_infinite]"
            style={{
                animationPlayState: spin ? "running" : "paused",
                ...style,
            }}
        >
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox={VARDA_MARK_VIEWBOX}
                width={size}
                height={size}
                style={{ display: "block" }}
                aria-hidden="true"
                data-varda-mark=""
            >
                <path
                    d={VARDA_MARK_PATH}
                    style={{ fill, transition: FILL_TRANSITION }}
                />
            </svg>
        </span>
    );
}
