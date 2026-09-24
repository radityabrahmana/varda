// Facade of the regulations module (the regulation library). Import the module
// from outside only through this file.

export {
  canManageScope,
  canSeeRegulation,
  REGULATION_NOT_FOUND,
  requireManage,
  resolveRegulationScope,
  visibleFilter,
} from "./regulations.access";
export {
  attachRegulationFile,
  createRegulation,
  DEFAULT_INGEST_DEPS,
  deleteRegulation,
  extractRegulationText,
  getRegulation,
  listRegulations,
  parseRegulationMetaBody,
  parseRegulationPatchBody,
  regulationFileKey,
  REGULATION_UPLOAD_MAX_BYTES,
  reparseRegulation,
  resolveTargetOrg,
  updateRegulation,
  type IngestDeps,
  type RegulationFile,
} from "./regulations.library";
export {
  CONTENT_BATCH_SIZE,
  detectRegulationMention,
  hasVisibleRegulations,
  matchRegulationRef,
  NODE_PAGE_SIZE,
  parseRegulationSelector,
  READ_DEFAULT_CHARS,
  READ_MAX_CHARS,
  readRegulation,
  resolveRegulationRef,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  searchRegulationLibrary,
  summarizeRegulation,
  type RegulationReadResult,
  type RegulationSearchHit,
  type RegulationSearchResult,
  type RegulationSelector,
} from "./regulations.read";
export type {
  RegulationMetaInput,
  RegulationMetaPatch,
  RegulationNodeRow,
  RegulationParseStatus,
  RegulationRow,
  RegulationScope,
  RegulationStatus,
  RegulationSummary,
} from "./regulations.types";
export { REGULATION_STATUSES } from "./regulations.types";
