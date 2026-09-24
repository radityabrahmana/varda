// Shared types for the regulation library module.

export type RegulationStatus = "berlaku" | "diubah" | "dicabut" | "tidak_berlaku" | "unknown";
export const REGULATION_STATUSES: RegulationStatus[] = ["berlaku", "diubah", "dicabut", "tidak_berlaku", "unknown"];

export type RegulationParseStatus = "empty" | "parsed" | "failed";

export type RegulationRow = {
  id: string;
  /** null = platform-wide (visible to every organization). */
  org_id: string | null;
  created_by: string | null;
  regulation_type: string;
  issuer: string | null;
  number: string | null;
  year: number | null;
  title: string;
  short_name: string;
  status: RegulationStatus;
  source_url: string | null;
  notes: string | null;
  file_key: string | null;
  file_name: string | null;
  content_sha256: string | null;
  parse_status: RegulationParseStatus;
  node_count: number;
  pasal_count: number;
  parse_warnings: string[];
  created_at: string;
  updated_at: string;
};

export type RegulationNodeRow = {
  id: number;
  regulation_id: string;
  node_type: string;
  number: string | null;
  heading: string | null;
  context: string | null;
  content: string;
  sort_order: number;
};

/** What the caller may see and manage. Resolved once per request. */
export type RegulationScope = {
  userId: string;
  /** Organizations the caller belongs to (any role). */
  orgIds: string[];
  /** Organizations the caller administers. */
  adminOrgIds: string[];
  /** Varda administrator (user_roles.role = 'admin'): manages platform-wide rows. */
  platformAdmin: boolean;
};

export type RegulationMetaInput = {
  /** "platform" for a platform-wide row (Varda admins only); default "org". */
  scope?: "org" | "platform";
  org_id?: string | null;
  regulation_type: string;
  issuer?: string | null;
  number?: string | null;
  year?: number | null;
  title: string;
  short_name: string;
  status?: RegulationStatus;
  source_url?: string | null;
  notes?: string | null;
};

export type RegulationMetaPatch = Partial<Omit<RegulationMetaInput, "scope" | "org_id">>;

export type RegulationSummary = Pick<
  RegulationRow,
  "id" | "org_id" | "regulation_type" | "issuer" | "number" | "year" | "title" | "short_name" | "status" | "source_url" | "parse_status" | "pasal_count" | "node_count"
>;
