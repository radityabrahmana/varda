// Wire types for the playbook admin (mirror of backend/src/modules/playbook).

export const RULE_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM"] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

/** Stored document_type values (mirror of backend RULE_DOCUMENT_TYPES) with their Bahasa labels. */
export const RULE_DOCUMENT_TYPES: { value: string; label: string }[] = [
    { value: "PKS", label: "PKS" },
    { value: "LOI", label: "LOI" },
    { value: "NDA", label: "NDA" },
    { value: "Client Template", label: "Template Klien" },
    { value: "Other", label: "Lainnya" },
];

export function documentTypeLabel(value: string): string {
    return RULE_DOCUMENT_TYPES.find((d) => d.value === value)?.label ?? value;
}

export interface PlaybookRule {
    id: string;
    rule_number: string;
    title: string;
    description: string;
    thresholds: Record<string, unknown>;
    severity: RuleSeverity;
    is_active: boolean;
    /** Document types the rule applies to; null = all. */
    applies_to: string[] | null;
    created_at: string;
    updated_at: string | null;
}

export interface PlaybookRuleInput {
    rule_number: string;
    title: string;
    description: string;
    thresholds: Record<string, unknown>;
    severity: RuleSeverity;
    is_active?: boolean;
    applies_to?: string[] | null;
}

export type PlaybookRulePatch = Partial<PlaybookRuleInput>;

export const SEVERITY_TONE: Record<string, { color: string; bg: string }> = {
    CRITICAL: { color: "#DC2626", bg: "#FEF2F2" },
    HIGH: { color: "#C2410C", bg: "#FFF7ED" },
    MEDIUM: { color: "#B45309", bg: "#FFFBEB" },
};

/** Parse the thresholds textarea; null when it is not a JSON object. */
export function parseThresholds(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    if (!trimmed) return {};
    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}
