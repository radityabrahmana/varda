// Prefixes buildMessages (contextBuilders.ts) puts on a user turn to tell the
// model about an applied workflow or attached documents. Kept in their own
// dependency-free file so the Assistant's router (routing.ts) reads exactly
// the shapes that are written, without importing the context builders.

export const WORKFLOW_MARKER_OPEN = "[Workflow: ";
export const WORKFLOW_MARKER_CLOSE = ")]\n\n";
export const ATTACHMENT_MARKER_OPEN =
  "[The user attached the following document(s) to this message:\n";
export const ATTACHMENT_MARKER_CLOSE = "]\n\n";
