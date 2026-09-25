import type { ModelToggleMode } from "@/shared/ui/ModelToggleUI";

// Assistant modes: the chat stores the mode and the server picks a model for
// each turn (backend/src/lib/llm/router.ts). Kept in sync with the backend's
// MODE_MODEL_IDS and the Word add-in's modelCatalog.ts.
export const AUTO_MODE_ID = "varda/auto";
export const DEEP_MODE_ID = "varda/deep";
export const MODE_OPTIONS: readonly ModelToggleMode[] = [
  {
    id: AUTO_MODE_ID,
    label: "Auto",
    description: "Picks Fast or Deep for each question",
  },
  {
    id: "varda/fast",
    label: "Fast",
    description: "Quick answers, summaries and translation",
  },
  {
    id: DEEP_MODE_ID,
    label: "Deep",
    description: "Contract review, drafting and legal analysis",
  },
];
export const MODE_MODEL_IDS: ReadonlySet<string> = new Set(
  MODE_OPTIONS.map((mode) => mode.id),
);

export function isModeModelId(id: string | null | undefined): boolean {
  return MODE_MODEL_IDS.has(id ?? "");
}

/** Mode label for a mode id or a model_info `mode` value ("auto"). */
export function modeLabel(modeOrId: string): string | null {
  const id = modeOrId.includes("/") ? modeOrId : `varda/${modeOrId}`;
  return MODE_OPTIONS.find((mode) => mode.id === id)?.label ?? null;
}
