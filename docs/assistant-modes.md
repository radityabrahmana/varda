# Assistant modes: Auto, Fast and Deep

A person picks what kind of answer they want instead of picking a model. The
chat stores the mode, and every turn is served by a concrete model from one of
two tiers:

| Mode | Stored as | Served by |
| --- | --- | --- |
| Auto (default) | `varda/auto` | Fast or Deep, chosen per turn by the router |
| Fast | `varda/fast` | the fast tier |
| Deep | `varda/deep` | the deep tier |

Named models (the full catalog) remain available and behave exactly as before.

## Where it lives

- `backend/src/lib/llm/models.ts` — mode ids, built-in tier lists
  (`DEFAULT_TIER_MODELS`) and each tier's reasoning effort (fast `low`, deep
  `high`).
- `backend/src/lib/llm/registry.ts` — the deployment's `tiers` block in
  `MIKE_MODEL_CONFIG_JSON` (see `docs/configured-models.md`).
- `backend/src/lib/llm/router.ts` — the rule table, pure and synchronous.
- `backend/src/lib/modelSelection.ts` — tier availability for a user's keys,
  mode-aware `resolveEffectiveChatModel`, and the concrete model background work
  (titles, memory curation) uses for a mode chat.
- `backend/src/modules/chat/engine/routing.ts` — reads routing signals from the
  turn's messages and plans the models to try.
- `backend/src/modules/chat/engine/streaming.ts` — runs the plan, records a
  `model_info` event, and falls back within the tier.

Because routing happens inside `runLLMStream`, every chat surface (Assistant,
project chat, Word add-in, tabular chat) supports modes without its own code,
and chats keep persisting whatever the person selected.

## Routing rules (Auto)

Auto sends a turn to the deep tier when the conversation has any of:

1. an applied workflow;
2. two or more distinct attached documents;
3. a message of 1,500 characters or more;
4. a request to review, analyse, draft, compare or assess risk, in Indonesian
   or English (`hasDeepIntent`).

Otherwise the fast tier answers. The signals cover the whole conversation, not
only the latest message, so a chat that reaches the deep tier stays there: the
provider's prompt cache stays warm and answers do not switch style mid-thread.

If the chosen tier has nothing the person can run, Auto borrows the other tier.
Fast and Deep never borrow.

## Fallback

A mode turn tries the tier's models in order. When a model fails with a
transient provider error (408, 429 or 5xx) before anything has streamed, the
next model in the tier takes the turn. Once text, reasoning or a tool call has
streamed, the failure is reported as usual. A named model never falls back.

## Transparency and logs

Every assistant turn, routed or not, carries one
`{ type: "model_info", model, mode?, tier?, reason?, fallback_from? }` event,
streamed and persisted, so the client can show which model answered.

Each routed turn logs one `[assistant/route]` line with the mode, tier, rule,
model and signal sizes. Prompt text is never logged.

## Not yet

- Mode picker, default-to-Auto, the "answered by" line and "Retry with Deep"
  in the web app and Word add-in; "Advanced models" limited to admins.
- Tuning the rules against the Dash evaluation set.
- Per-organization tier policy.
