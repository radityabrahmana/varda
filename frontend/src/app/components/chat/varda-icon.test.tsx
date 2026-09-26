import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VardaIcon } from "./varda-icon";

function markFill(container: HTMLElement) {
    const path = container.querySelector("svg path") as SVGPathElement | null;
    return path?.style.fill.replace(/\s/g, "");
}

afterEach(() => {
    document.documentElement.classList.remove("dark");
});

describe("VardaIcon", () => {
    it("renders the brand-colored mark on the light theme", () => {
        const { container } = render(<VardaIcon />);

        expect(markFill(container)).toBe("rgb(96,0,255)");
    });

    it("renders the lighter mark when the document is in dark mode", () => {
        document.documentElement.classList.add("dark");
        const { container } = render(<VardaIcon />);

        expect(markFill(container)).toBe("rgb(139,92,255)");
    });

    it("swaps palettes when the theme class changes while mounted", async () => {
        const { container } = render(<VardaIcon />);
        expect(markFill(container)).toBe("rgb(96,0,255)");

        document.documentElement.classList.add("dark");

        await waitFor(() =>
            expect(markFill(container)).toBe("rgb(139,92,255)"),
        );
    });

    it("uses the error color over the theme color", () => {
        const { container } = render(<VardaIcon error />);

        expect(markFill(container)).toBe("rgb(248,113,113)");
    });

    it("keeps the status palettes in dark mode", () => {
        document.documentElement.classList.add("dark");
        const { container } = render(<VardaIcon done />);

        expect(markFill(container)).toBe("rgb(74,222,128)");
    });
});
