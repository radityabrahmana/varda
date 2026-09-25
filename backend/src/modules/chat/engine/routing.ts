import {
  isModeModelId,
  modeForModelId,
  normalizeReasoningLevelForModel,
  TIER_REASONING_LEVEL,
  type AssistantMode,
  type LlmMessage,
  type ModelTier,
  type ReasoningLevel,
  type UserApiKeys,
} from "../../../lib/llm";
import {
  routeTurn,
  type RouteReason,
  type TurnSignals,
} from "../../../lib/llm/router";
import { servingModelsForMode } from "../../../lib/modelSelection";
import { UserFacingError } from "../../../lib/userFacingError";
import {
  ATTACHMENT_MARKER_CLOSE,
  ATTACHMENT_MARKER_OPEN,
  WORKFLOW_MARKER_CLOSE,
  WORKFLOW_MARKER_OPEN,
} from "./messageMarkers";

type ParsedUserTurn = {
  text: string;
  workflow: boolean;
  documents: string[];
};

/**
 * Split the markers buildMessages prepends (attachment list, applied
 * workflow) from what the person actually wrote. A turn from a surface that
 * does not add markers (Word, tabular) is returned as plain text.
 */
export function parseUserTurn(content: string): ParsedUserTurn {
  let rest = content;
  let workflow = false;
  const documents: string[] = [];
  for (;;) {
    if (rest.startsWith(ATTACHMENT_MARKER_OPEN)) {
      const end = rest.indexOf(ATTACHMENT_MARKER_CLOSE);
      if (end < 0) break;
      const block = rest.slice(ATTACHMENT_MARKER_OPEN.length, end);
      for (const line of block.split("\n")) {
        if (line.startsWith("- ")) documents.push(line.slice(2).trim());
      }
      rest = rest.slice(end + ATTACHMENT_MARKER_CLOSE.length);
      continue;
    }
    if (rest.startsWith(WORKFLOW_MARKER_OPEN)) {
      const end = rest.indexOf(WORKFLOW_MARKER_CLOSE);
      if (end < 0) break;
      workflow = true;
      rest = rest.slice(end + WORKFLOW_MARKER_CLOSE.length);
      continue;
    }
    break;
  }
  return { text: rest.trim(), workflow, documents };
}

/** Routing signals over every user turn of the conversation sent this turn. */
export function turnSignalsFromMessages(messages: LlmMessage[]): TurnSignals {
  const userTexts: string[] = [];
  const documents = new Set<string>();
  let workflowApplied = false;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const turn = parseUserTurn(message.content);
    if (turn.text) userTexts.push(turn.text);
    if (turn.workflow) workflowApplied = true;
    for (const document of turn.documents) documents.add(document);
  }
  return {
    userTexts,
    workflowApplied,
    attachedDocumentCount: documents.size,
  };
}

export type TurnModelPlan = {
  /** Models to try, in order. A named model is the only entry. */
  models: string[];
  /** How a mode chose the tier; null when the person named a model. */
  route: { mode: AssistantMode; tier: ModelTier; reason: RouteReason } | null;
  /** Per-model reasoning effort; undefined keeps the caller's level. */
  reasoning?: (ReasoningLevel | undefined)[];
};

const MODE_LABELS: Record<AssistantMode, string> = {
  auto: "Auto",
  fast: "Fast",
  deep: "Deep",
};

/**
 * Decide which model(s) serve this turn. A named model goes through the
 * caller's usual validation; a mode is routed to a tier and expanded to that
 * tier's serving models, each run at the tier's reasoning effort.
 */
export async function planTurnModels(args: {
  model: string | undefined;
  messages: LlmMessage[];
  apiKeys: UserApiKeys;
  resolveNamedModel: (model: string) => Promise<string>;
}): Promise<TurnModelPlan> {
  if (!isModeModelId(args.model)) {
    return {
      models: [await args.resolveNamedModel(args.model ?? "")],
      route: null,
    };
  }
  const mode = modeForModelId(args.model);
  const signals = turnSignalsFromMessages(args.messages);
  const decision = routeTurn(mode, signals);
  const serving = servingModelsForMode(mode, decision.tier, args.apiKeys);
  if (serving.models.length === 0) {
    throw new UserFacingError(
      `No model is available for ${MODE_LABELS[mode]} mode with the current API keys. Add a key or ask an administrator to configure one.`,
    );
  }
  const route = { mode, tier: serving.tier, reason: decision.reason };
  // Content-free on purpose: the rule that fired and the sizes it saw are
  // enough to tune the router, and nothing the person wrote is logged.
  console.info("[assistant/route]", {
    ...route,
    model: serving.models[0],
    candidates: serving.models.length,
    userTurns: signals.userTexts.length,
    documents: signals.attachedDocumentCount,
    workflow: signals.workflowApplied,
  });
  return {
    models: serving.models,
    route,
    reasoning: serving.models.map((model) =>
      normalizeReasoningLevelForModel(model, TIER_REASONING_LEVEL[serving.tier]),
    ),
  };
}
