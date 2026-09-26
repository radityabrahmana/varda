import { describe, expect, it } from "vitest";
import {
    AUTO_MODE_ID,
    DEEP_MODE_ID,
    MODE_MODEL_IDS,
    MODE_OPTIONS,
    isModeModelId,
    modeLabel,
} from "./assistantModes";

describe("assistant modes", () => {
    it("lists Auto, Fast and Deep under the varda/ prefix", () => {
        expect(MODE_OPTIONS.map((mode) => mode.id)).toEqual([
            AUTO_MODE_ID,
            "varda/fast",
            DEEP_MODE_ID,
        ]);
        expect([...MODE_MODEL_IDS]).toEqual(MODE_OPTIONS.map((mode) => mode.id));
    });

    it("recognizes mode ids and nothing else", () => {
        expect(isModeModelId(AUTO_MODE_ID)).toBe(true);
        expect(isModeModelId("varda/fast")).toBe(true);
        expect(isModeModelId("openrouter/anthropic/claude-sonnet-5")).toBe(false);
        expect(isModeModelId(null)).toBe(false);
        expect(isModeModelId(undefined)).toBe(false);
    });

    it("labels a mode by id or by bare mode value", () => {
        expect(modeLabel(AUTO_MODE_ID)).toBe("Auto");
        expect(modeLabel("deep")).toBe("Deep");
        expect(modeLabel("fast")).toBe("Fast");
        expect(modeLabel("varda/unknown")).toBeNull();
        expect(modeLabel("gpt")).toBeNull();
    });
});
