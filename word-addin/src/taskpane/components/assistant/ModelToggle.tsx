import React, { useEffect, useMemo, useState } from "react";
import {
  ModelToggleUI,
  nearestReasoningLevelForModel,
  reasoningLevelsForModel,
  type ReasoningLevel,
} from "@varda/model-toggle-ui";
import { getOllamaModels, type ApiKeyStatus } from "../../api/vardaApi";
import {
  isModelAvailable,
  MODE_OPTIONS,
  modelDisplayName,
  openCodeGoModelOptions,
  openRouterModelOptions,
  vercelModelOptions,
  STATIC_MODELS,
  type ModelOption,
} from "../../lib/modelCatalog";

export function ModelToggle({
  value,
  onChange,
  keyStatus,
  keyStatusLoading = false,
  openRouterModels,
  vercelModels,
  openCodeGoModels,
  compact = false,
  onNoModelsClick,
  reasoningLevel,
  onReasoningChange,
  advancedModels = false,
}: {
  value: string;
  onChange: (model: string) => void;
  keyStatus: ApiKeyStatus | null;
  /** True while the key-status preflight is in flight: render a neutral
   *  disabled trigger instead of flashing "No Models". */
  keyStatusLoading?: boolean;
  openRouterModels: string[];
  vercelModels: string[];
  openCodeGoModels: string[];
  compact?: boolean;
  onNoModelsClick?: () => void;
  reasoningLevel?: ReasoningLevel;
  onReasoningChange?: (level: ReasoningLevel) => void;
  /** Named models appear under "Advanced models" only when true. */
  advancedModels?: boolean;
}): React.ReactElement {
  const [ollamaModels, setOllamaModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void getOllamaModels()
      .then((models) => {
        if (!cancelled) setOllamaModels(models);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const models = useMemo(() => {
    if (!advancedModels) return [];
    const openRouterOptions = openRouterModelOptions(openRouterModels);
    const vercelOptions = vercelModelOptions(vercelModels);
    const openCodeGoOptions = openCodeGoModelOptions(openCodeGoModels);
    const localOptions = ollamaModels.map((model) => ({
      ...model,
      label: modelDisplayName(model.id),
      source: "Local",
    }));
    return [
      ...STATIC_MODELS,
      ...openRouterOptions,
      ...vercelOptions,
      ...openCodeGoOptions,
      ...localOptions,
    ].filter(
      (model) =>
        model.group === "Local" || isModelAvailable(model.id, keyStatus),
    );
  }, [
    advancedModels,
    keyStatus,
    ollamaModels,
    openRouterModels,
    vercelModels,
    openCodeGoModels,
  ]);
  const selected = models.find((model) => model.id === value);
  const selectedMode = MODE_OPTIONS.find((mode) => mode.id === value);
  const supportedReasoningLevels = reasoningLevelsForModel(value);
  // A mode's tier sets its reasoning effort; the slider is for named models.
  const normalizedReasoningLevel =
    reasoningLevel && !selectedMode
      ? nearestReasoningLevelForModel(value, reasoningLevel)
      : undefined;

  useEffect(() => {
    if (
      reasoningLevel &&
      normalizedReasoningLevel &&
      normalizedReasoningLevel !== reasoningLevel &&
      onReasoningChange
    ) {
      onReasoningChange(normalizedReasoningLevel);
    }
  }, [normalizedReasoningLevel, onReasoningChange, reasoningLevel]);

  return (
    <ModelToggleUI
      value={value}
      onChange={onChange}
      models={models}
      selectedLabel={selectedMode?.label ?? selected?.label ?? "Select model"}
      selectedAvailable={selected !== undefined || selectedMode !== undefined}
      loading={keyStatusLoading}
      compact={compact}
      emptyLabel="No Models"
      onEmptyClick={onNoModelsClick}
      reasoningLevel={normalizedReasoningLevel}
      onReasoningChange={onReasoningChange}
      reasoningLevels={supportedReasoningLevels}
      modes={MODE_OPTIONS}
    />
  );
}
