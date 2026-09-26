import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VardaApiError } from "@/app/lib/vardaApi";
import { ReviewWorkspace } from "./ReviewWorkspace";
import type { ContractReviewDetail } from "./reviewTypes";

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    getContract: vi.fn(),
    postContractFeedback: vi.fn(),
    patchContract: vi.fn(),
    resolveContractRevision: vi.fn(),
    generateContractMemo: vi.fn(),
    setNegotiationPointStatus: vi.fn(),
    postContractFeedbackBulk: vi.fn(),
    postContractComment: vi.fn(),
    attachContractDocx: vi.fn(),
    getContractPeople: vi.fn(),
    getContractAccess: vi.fn(),
    grantContractAccess: vi.fn(),
    revokeContractAccess: vi.fn(),
    postContractSuggestion: vi.fn(),
    resolveContractSuggestion: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u1" }, isAuthenticated: true, authLoading: false }),
}));
vi.mock("@/app/components/shared/views/DocxView", () => ({
    DocxView: (props: {
        documentId: string;
        displayUrl?: string | null;
        quotes?: { quote: string }[];
        trackedChangeIdsUrl?: string;
        highlightEdit?: { ins_w_id?: string | null } | null;
    }) => (
        <div
            data-testid="docx-view"
            data-url={props.displayUrl}
            data-quote={props.quotes?.[0]?.quote ?? ""}
            data-ids-url={props.trackedChangeIdsUrl ?? ""}
            data-highlight={props.highlightEdit?.ins_w_id ?? ""}
        >
            <p>Pembayaran dilakukan dalam 30 hari setelah invoice diterima.</p>
        </div>
    ),
}));
vi.mock("@/app/lib/vardaApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/vardaApi")>()),
    getContract: mocks.getContract,
    postContractFeedback: mocks.postContractFeedback,
    patchContract: mocks.patchContract,
    resolveContractRevision: mocks.resolveContractRevision,
    generateContractMemo: mocks.generateContractMemo,
    setNegotiationPointStatus: mocks.setNegotiationPointStatus,
    postContractFeedbackBulk: mocks.postContractFeedbackBulk,
    postContractComment: mocks.postContractComment,
    attachContractDocx: mocks.attachContractDocx,
    getContractPeople: mocks.getContractPeople,
    getContractAccess: mocks.getContractAccess,
    grantContractAccess: mocks.grantContractAccess,
    revokeContractAccess: mocks.revokeContractAccess,
    postContractSuggestion: mocks.postContractSuggestion,
    resolveContractSuggestion: mocks.resolveContractSuggestion,
}));

const DETAIL: ContractReviewDetail = {
    review: {
        id: "r1",
        user_id: "u1",
        title: "PKS — Markas Daging",
        client_name: "Markas Daging",
        document_type: "PKS",
        contract_filename: "a.docx",
        contract_text: "Logistics Services Agreement",
        contract_html: '<table style="width:100%"><tr><td>English</td><td onclick="x()">Indonesia</td></tr></table>',
        contract_docx_path: null,
        contract_redline_path: null,
        contract_pdf_path: null,
        project_context: null,
        review_focus: [],
        ai_output: {
            executive_summary: "Perjanjian ini memiliki beberapa risiko KRITIS.",
            client_name: "Markas Daging",
            contract_type: "PKS",
            template_used: "Client Template",
            overall_recommendation: "NEEDS_REVISIONS",
            risk_level: "CRITICAL",
            red_flags: [
                {
                    id: "RF-001",
                    severity: "CRITICAL",
                    clause: "Pasal 1",
                    title: "Klien Bukan Merupakan Badan Usaha",
                    issue: "Klien adalah perorangan.",
                    business_impact: "Risiko penagihan.",
                    action: "Minta akta perusahaan.",
                    playbook_rule: "RULE 19",
                    requires_approval: "COO",
                },
            ],
            revisions: [
                {
                    id: "REV-001",
                    clause: "Pasal 9",
                    original_text: "Rp 50.000.000",
                    suggested_text: "Rp 10.000.000",
                    rationale: "Sesuai playbook.",
                    priority: "MUST_CHANGE",
                    from_clause_library: false,
                    clause_library_source: null,
                },
            ],
            clarifications: [],
            financial_review: [],
            missing_clauses: [
                {
                    clause_name: "Force Majeure",
                    description: "Tidak ada klausul keadaan kahar.",
                    suggested_wording: "Para Pihak dibebaskan...",
                    importance: "HIGH",
                    from_clause_library: false,
                    clause_library_source: null,
                },
            ],
            yellow_flags: [],
            positive_findings: [],
            section_risks: [],
            playbook_compliance: {
                liability_cap: { status: "non_compliant", assessment: "Batas terlalu tinggi." },
            },
        },
        risk_level: "CRITICAL",
        recommendation: "NEEDS_REVISIONS",
        coo_recommendation_override: null,
        coo_override_rationale: null,
        status: "ai_reviewed",
        lifecycle_stage: "ai_review",
        signing_date: null,
        expiry_date: null,
        renewal_date: null,
        negotiation_memo: null,
        negotiation_memo_generated_at: null,
        created_at: "2026-09-20T10:00:00.000Z",
        updated_at: null,
    },
    feedback: [],
    comments: [],
    revisionEdits: [],
    negotiationPoints: [],
};

beforeEach(() => {
    vi.clearAllMocks();
    // PageHeader collapses breadcrumbs via a media query; jsdom has no matchMedia.
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
        }),
    });
});

describe("ReviewWorkspace", () => {
    it("renders the header pills, the sanitized contract, and the Draf sections", async () => {
        mocks.getContract.mockResolvedValue(DETAIL);

        render(<ReviewWorkspace reviewId="r1" />);

        expect(await screen.findByRole("heading", { name: "PKS — Markas Daging" })).toBeInTheDocument();
        expect(screen.getByText("Risiko Kritis")).toBeInTheDocument();
        expect(screen.getByText("PERLU REVISI")).toBeInTheDocument();

        const html = screen.getByTestId("contract-html");
        expect(html.querySelector("table")).not.toBeNull();
        expect(html.innerHTML).not.toContain("onclick");
        expect(html.innerHTML).not.toContain("style=");

        expect(screen.getByText("Ringkasan Eksekutif")).toBeInTheDocument();
        expect(screen.getByText("Kepatuhan Playbook")).toBeInTheDocument();
        expect(screen.getByText("Batas Tanggung Jawab")).toBeInTheDocument();
        expect(screen.getByText("Tidak Sesuai")).toBeInTheDocument();
        expect(screen.getByText("Klien Bukan Merupakan Badan Usaha")).toBeInTheDocument();
        expect(screen.getByText("Rp 10.000.000")).toBeInTheDocument();
        expect(screen.getByText("Force Majeure")).toBeInTheDocument();
        expect(mocks.getContract).toHaveBeenCalledWith("r1");
    });

    const PEOPLE = {
        scope: "direct" as const,
        owner: { user_id: "u1", email: "aditya@dashelectric.co", display_name: "Aditya", role: "owner" as const },
        members: [{ user_id: "u2", email: "donnie@dashelectric.co", display_name: "Donnie", role: "viewer" as const }],
    };

    it("opens the share dialog from the top-right Bagikan action and copies a link from it", async () => {
        mocks.getContract.mockResolvedValue({ ...DETAIL, access: { role: "owner", via: "creator" } });
        mocks.getContractPeople.mockResolvedValue(PEOPLE);
        mocks.getContractAccess.mockResolvedValue({
            scope: "direct",
            org_id: null,
            access_role: "owner",
            grants: [{ email: "donnie@dashelectric.co", role: "viewer" }],
        });
        // user-event installs its own clipboard stub during setup; spy on that one.
        const user = userEvent.setup();
        const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
        render(<ReviewWorkspace reviewId="r1" />);

        await user.click(await screen.findByRole("button", { name: /Bagikan/ }));
        expect(await screen.findByText("donnie@dashelectric.co")).toBeInTheDocument();
        expect(mocks.getContractPeople).toHaveBeenCalledWith("r1");
        await waitFor(() => expect(mocks.getContractAccess).toHaveBeenCalledWith("r1"));

        await user.click(screen.getByRole("button", { name: /Salin tautan/ }));
        expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/contracts/r1`);
        expect(await screen.findByText("Tautan disalin")).toBeInTheDocument();
    });

    it("falls back to a selectable link in the share dialog when the clipboard is blocked", async () => {
        mocks.getContract.mockResolvedValue(DETAIL);
        mocks.getContractPeople.mockResolvedValue(PEOPLE);
        mocks.getContractAccess.mockResolvedValue({ scope: "direct", org_id: null, access_role: "owner", grants: [] });
        const user = userEvent.setup();
        vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Write permission denied"));
        render(<ReviewWorkspace reviewId="r1" />);

        await user.click(await screen.findByRole("button", { name: /Bagikan/ }));
        await user.click(await screen.findByRole("button", { name: /Salin tautan/ }));

        const field = await screen.findByRole("textbox", { name: "Tautan tinjauan" });
        expect(field).toHaveValue(`${window.location.origin}/contracts/r1`);
        expect(screen.queryByText("Tautan disalin")).not.toBeInTheDocument();
    });

    it("shows a viewer the review read-only: no feedback, gate, redline or stage controls", async () => {
        mocks.getContract.mockResolvedValue({ ...DETAIL, access: { role: "viewer", via: "grant" } });
        mocks.getContractPeople.mockResolvedValue(PEOPLE);
        const user = userEvent.setup();
        render(<ReviewWorkspace reviewId="r1" />);
        await screen.findByRole("heading", { name: "PKS — Markas Daging" });

        expect(screen.getByText("Akses lihat")).toBeInTheDocument();
        expect(screen.getByTestId("progress-label")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Tandai Sudah Ditinjau C-Level" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Setuju" })).toBeNull();
        expect(screen.queryByRole("button", { name: /Abaikan/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /Unggah DOCX asli/ })).toBeNull();
        expect(screen.getByRole("button", { name: "Tahap kontrak" })).toBeDisabled();
        // Locating findings still works.
        expect(screen.getAllByRole("button", { name: /Lihat di dokumen/ }).length).toBeGreaterThan(0);

        // The share dialog opens as a roster only: no grants fetch, no add field.
        await user.click(screen.getByRole("button", { name: /Bagikan/ }));
        expect(await screen.findByText("donnie@dashelectric.co")).toBeInTheDocument();
        expect(mocks.getContractAccess).not.toHaveBeenCalled();
    });

    it("offers to re-upload the original DOCX when none was persisted and reloads after attaching", async () => {
        mocks.getContract.mockResolvedValueOnce(DETAIL).mockResolvedValueOnce({
            ...DETAIL,
            review: { ...DETAIL.review, contract_docx_path: "contracts/r1/original.docx" },
        });
        mocks.attachContractDocx.mockResolvedValue({ contract_docx_path: "contracts/r1/original.docx", projection: { projected: 2, failed: 0, skipped: 0 } });
        const user = userEvent.setup();
        render(<ReviewWorkspace reviewId="r1" />);

        expect(await screen.findByRole("button", { name: /Unggah DOCX asli/ })).toBeInTheDocument();
        const file = new File(["PK"], "Draft PKS.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
        await user.upload(screen.getByLabelText("Pilih file DOCX asli"), file);

        await waitFor(() => expect(mocks.attachContractDocx).toHaveBeenCalledWith("r1", file));
        expect(await screen.findByText("DOCX tersimpan; 2 revisi dipetakan ke dokumen.")).toBeInTheDocument();
        expect(mocks.getContract).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("button", { name: /Unggah DOCX asli/ })).not.toBeInTheDocument();
    });

    it("shows the not-found message on a 404", async () => {
        mocks.getContract.mockRejectedValue(new VardaApiError({ message: "nf", status: 404 }));

        render(<ReviewWorkspace reviewId="missing" />);

        expect(await screen.findByText("Tinjauan tidak ditemukan")).toBeInTheDocument();
    });

    it("shows the processing message while ai_output is empty", async () => {
        mocks.getContract.mockResolvedValue({
            ...DETAIL,
            review: { ...DETAIL.review, ai_output: null, status: "processing" },
        });

        render(<ReviewWorkspace reviewId="r1" />);

        await waitFor(() => expect(screen.getByText("Tinjauan masih diproses...")).toBeInTheDocument());
    });

    it("counts distinct reviewed findings, hides a widget once feedback exists, and gates the C-Level button", async () => {
        const existing = {
            id: "f0",
            review_id: "r1",
            user_id: "u1",
            finding_type: "red_flag",
            finding_id: "RF-001",
            action: "dismiss",
            original_severity: "CRITICAL",
            adjusted_severity: null,
            original_text: null,
            edited_text: null,
            rationale: "Sudah dicek",
            created_at: "2026-09-20T10:00:00.000Z",
        };
        mocks.getContract.mockResolvedValue({ ...DETAIL, feedback: [existing, existing] });
        mocks.postContractFeedback.mockImplementation(async (_id: string, input: { finding_type: string; finding_id: string; action: string }) => ({
            ...existing,
            id: "f-new",
            finding_type: input.finding_type,
            finding_id: input.finding_id,
            action: input.action,
            rationale: null,
        }));
        const user = userEvent.setup();

        render(<ReviewWorkspace reviewId="r1" />);
        await screen.findByRole("heading", { name: "PKS — Markas Daging" });

        // 1 executive + 1 playbook + 1 red flag + 1 revision + 1 missing clause = 5; duplicates count once.
        expect(screen.getByTestId("progress-label")).toHaveTextContent("1 dari 5 temuan ditinjau");
        const rfCard = screen.getByText("Klien Bukan Merupakan Badan Usaha").closest("div.rounded-xl") as HTMLElement;
        expect(within(rfCard).getByText("Diabaikan")).toBeInTheDocument();
        expect(within(rfCard).queryByRole("button", { name: /Abaikan/ })).toBeNull();
        expect(screen.getByRole("button", { name: "Tandai Sudah Ditinjau C-Level" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Terima" }));
        await waitFor(() => expect(mocks.postContractFeedback).toHaveBeenCalledWith("r1", expect.objectContaining({
            finding_type: "revision",
            finding_id: "REV-001",
            action: "accept",
            original_text: "Rp 10.000.000",
            edited_text: null,
        })));
        expect(await screen.findByText("Diterima")).toBeInTheDocument();
        expect(screen.getByTestId("progress-label")).toHaveTextContent("2 dari 5 temuan ditinjau");
    });

    it("requires a rationale before Abaikan can be saved and posts it", async () => {
        mocks.getContract.mockResolvedValue(DETAIL);
        mocks.postContractFeedback.mockResolvedValue({
            id: "f1", review_id: "r1", user_id: "u1", finding_type: "red_flag", finding_id: "RF-001", action: "dismiss",
            original_severity: "CRITICAL", adjusted_severity: null, original_text: null, edited_text: null, rationale: "Bukan risiko", created_at: "",
        });
        const user = userEvent.setup();
        render(<ReviewWorkspace reviewId="r1" />);
        const card = (await screen.findByText("Klien Bukan Merupakan Badan Usaha")).closest("div.rounded-xl") as HTMLElement;

        await user.click(within(card).getByRole("button", { name: /Abaikan/ }));
        expect(within(card).getByRole("button", { name: /Simpan/ })).toBeDisabled();
        await user.type(within(card).getByPlaceholderText("Tambahkan alasan..."), "Bukan risiko");
        const save = within(card).getByRole("button", { name: /Simpan/ });
        expect(save).toBeEnabled();
        await user.click(save);

        await waitFor(() => expect(mocks.postContractFeedback).toHaveBeenCalledWith("r1", expect.objectContaining({
            finding_type: "red_flag", finding_id: "RF-001", action: "dismiss", rationale: "Bukan risiko", original_severity: "CRITICAL",
        })));
        expect(await within(card).findByText("Umpan balik tercatat")).toBeInTheDocument();
    });

    it("renders the DOCX through Varda's viewer when an original is persisted and locates findings in it", async () => {
        const detailWithDocx = {
            ...DETAIL,
            review: {
                ...DETAIL.review,
                contract_docx_path: "contracts/r1/original.docx",
                ai_output: {
                    ...DETAIL.review.ai_output!,
                    red_flags: [{ ...DETAIL.review.ai_output!.red_flags[0], highlight_text: "Bagoes Andy Saputro" }],
                },
            },
        };
        mocks.getContract.mockResolvedValue(detailWithDocx);
        const user = userEvent.setup();

        render(<ReviewWorkspace reviewId="r1" />);
        const view = await screen.findByTestId("docx-view");
        expect(view.getAttribute("data-url")).toBe("/api/contracts/r1/file");
        expect(screen.queryByTestId("contract-html")).toBeNull();
        // The viewer only scrolls internally as a height-constrained flex item;
        // a plain block pane clips multi-page contracts with no way to scroll.
        expect(screen.getByTestId("document-pane")).toHaveClass("lg:flex", "flex-col", "min-h-0", "overflow-hidden");

        await user.click(screen.getAllByRole("button", { name: /Lihat di dokumen/ })[0]);
        expect(screen.getByTestId("docx-view").getAttribute("data-quote")).toBe("Bagoes Andy Saputro");
    });

    it("resolves a projected revision through the document and refreshes the viewer", async () => {
        const editRow = {
            id: "e1", review_id: "r1", revision_id: "REV-001", change_id: "c1", del_w_id: "7", ins_w_id: "8",
            deleted_text: "Rp 50.000.000", inserted_text: "Rp 10.000.000", author: "Tinjau (AI Suggestion)",
            status: "pending" as const, error: null, created_at: "", updated_at: "",
        };
        mocks.getContract.mockResolvedValue({
            ...DETAIL,
            review: { ...DETAIL.review, contract_docx_path: "contracts/r1/original.docx", contract_redline_path: "contracts/r1/redline.docx" },
            revisionEdits: [editRow],
        });
        mocks.resolveContractRevision.mockResolvedValue({
            edit: { ...editRow, status: "accepted" },
            feedback: {
                id: "f9", review_id: "r1", user_id: "u1", finding_type: "revision", finding_id: "REV-001", action: "accept",
                original_severity: null, adjusted_severity: null, original_text: "Rp 10.000.000", edited_text: null, rationale: null, created_at: "",
            },
        });
        const user = userEvent.setup();

        render(<ReviewWorkspace reviewId="r1" />);
        await screen.findByTestId("docx-view");
        expect(screen.getByText("Perubahan terlacak di dokumen")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /Ekspor/ })).toHaveAttribute("href", "/api/contracts/r1/file?download=1");

        await user.click(screen.getByRole("button", { name: "Terima" }));

        await waitFor(() => expect(mocks.resolveContractRevision).toHaveBeenCalledWith("r1", "REV-001", "accept", { rationale: undefined, edited_text: undefined }));
        expect(await screen.findByText(/Perubahan diterapkan di dokumen/)).toBeInTheDocument();
        expect(screen.getByText("Diterima")).toBeInTheDocument();
        expect(mocks.postContractFeedback).not.toHaveBeenCalled();
    });

    it("keeps Negosiasi locked until the C-Level gate generates the memo, then shows it with point statuses", async () => {
        const memo = {
            memo_title: "Memo Negosiasi: Markas Daging — PKS",
            overall_tone_recommendation: "firm" as const,
            tone_explanation: "Klien perorangan.",
            opening_statement: "Terima kasih atas waktunya.",
            must_change: [{ id: "NEG-MC-001", title: "Batas tanggung jawab", clause_reference: "Pasal 9", what_to_ask: "Turunkan ke Rp 10 juta", business_impact: "Risiko", ideal_position: "Rp 10 juta", fallback_position: "Rp 20 juta", talking_script: "Kami mengusulkan...", source_finding_ids: ["REV-001"] }],
            should_change: [],
            nice_to_discuss: [],
            do_not_raise: [],
            closing_guidance: "Tutup dengan positif.",
            red_lines: [],
        };
        const allDone = ["executive_summary:overall_recommendation", "playbook_rule:liability_cap", "red_flag:RF-001", "revision:REV-001", "missing_clause:MC-0"].map((k, i) => {
            const [finding_type, finding_id] = k.split(":");
            return { id: `f${i}`, review_id: "r1", user_id: "u1", finding_type, finding_id, action: "valid", original_severity: null, adjusted_severity: null, original_text: null, edited_text: null, rationale: null, created_at: "" };
        });
        mocks.getContract.mockResolvedValue({ ...DETAIL, feedback: allDone });
        mocks.patchContract.mockResolvedValue({ id: "r1", status: "clevel_reviewed", lifecycle_stage: "clevel_review" });
        mocks.generateContractMemo.mockResolvedValue({ memo, generated_at: "2026-09-20T12:00:00.000Z" });
        mocks.setNegotiationPointStatus.mockResolvedValue({ id: "p1", review_id: "r1", point_id: "NEG-MC-001", status: "agreed", client_response: null, updated_by: "u1", updated_at: "" });
        const user = userEvent.setup();

        render(<ReviewWorkspace reviewId="r1" />);
        await screen.findByRole("heading", { name: "PKS — Markas Daging" });
        expect(screen.getByRole("tab", { name: "Negosiasi" })).toBeDisabled();
        expect(screen.getByTestId("progress-label")).toHaveTextContent("5 dari 5 temuan ditinjau");

        await user.click(screen.getByRole("button", { name: "Tandai Sudah Ditinjau C-Level" }));

        await waitFor(() => expect(mocks.patchContract).toHaveBeenCalledWith("r1", { status: "clevel_reviewed", lifecycle_stage: "clevel_review" }));
        await waitFor(() => expect(mocks.generateContractMemo).toHaveBeenCalledWith("r1"));
        expect(await screen.findByText("Memo Negosiasi: Markas Daging — PKS")).toBeInTheDocument();
        expect(screen.getByText("WAJIB DIUBAH")).toBeInTheDocument();
        expect(screen.getByText("0 dari 1 poin sudah dibahas")).toBeInTheDocument();

        await user.selectOptions(screen.getByLabelText("Status NEG-MC-001"), "agreed");
        await waitFor(() => expect(mocks.setNegotiationPointStatus).toHaveBeenCalledWith("r1", "NEG-MC-001", "agreed"));
        expect(await screen.findByText("1 dari 1 poin sudah dibahas")).toBeInTheDocument();
    });

    it("lists every finding on the Tabel tab and folds bulk feedback into the progress footer", async () => {
        const user = userEvent.setup();
        mocks.getContract.mockResolvedValue(DETAIL);
        mocks.postContractFeedbackBulk.mockResolvedValue([
            { id: "f1", review_id: "r1", finding_type: "red_flag", finding_id: "RF-001", action: "valid" },
            { id: "f2", review_id: "r1", finding_type: "revision", finding_id: "REV-001", action: "accept" },
        ]);
        render(<ReviewWorkspace reviewId="r1" />);
        await screen.findByTestId("progress-label");
        await user.click(screen.getByRole("tab", { name: "Tabel" }));
        expect(screen.getByTestId("row-red_flag:RF-001")).toBeInTheDocument();
        expect(screen.getByTestId("row-revision:REV-001")).toBeInTheDocument();
        // The gate footer stays visible on Tabel.
        expect(screen.getByTestId("progress-label")).toHaveTextContent("0 dari 5 temuan ditinjau");

        await user.click(screen.getByLabelText("Pilih semua temuan yang masih bisa ditindaklanjuti"));
        await user.click(screen.getByRole("button", { name: /Tandai valid/ }));
        await waitFor(() => expect(screen.getByTestId("progress-label")).toHaveTextContent("2 dari 5 temuan ditinjau"));
        expect(screen.getByTestId("row-red_flag:RF-001")).toHaveTextContent("Ditinjau");
    });

    it("opens the comment popover on a document selection and lists the saved comment on Komentar", async () => {
        const user = userEvent.setup();
        mocks.getContract.mockResolvedValue(DETAIL);
        mocks.postContractComment.mockResolvedValue({
            id: "c1", review_id: "r1", user_id: "u1", user_name: "aditya", comment_type: "question",
            highlight_text: "Logistics Services", highlight_start: 0, highlight_end: 19,
            comment_text: "Perlu definisi?", suggested_text: null, parent_comment_id: null, created_at: "2026-09-20T11:00:00Z",
        });
        render(<ReviewWorkspace reviewId="r1" />);
        const pane = await screen.findByTestId("document-pane");
        const textNode = within(pane).getByText("English").firstChild;
        const selection = vi.spyOn(window, "getSelection").mockReturnValue({
            isCollapsed: false,
            rangeCount: 1,
            anchorNode: textNode,
            focusNode: textNode,
            toString: () => "Logistics Services",
            getRangeAt: () => ({ getBoundingClientRect: () => ({ bottom: 120, left: 40, top: 100, right: 200 }) }),
        } as unknown as Selection);

        await user.pointer({ keys: "[MouseLeft>]", target: pane });
        await user.pointer({ keys: "[/MouseLeft]", target: pane });
        const dialog = await screen.findByRole("dialog", { name: "Tambah Komentar" });
        expect(within(dialog).getByText(/Logistics Services/)).toBeInTheDocument();

        await user.selectOptions(within(dialog).getByLabelText("Jenis komentar"), "question");
        await user.type(within(dialog).getByLabelText("Komentar"), "Perlu definisi?");
        await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
        await waitFor(() => expect(mocks.postContractComment).toHaveBeenCalledTimes(1));
        expect(mocks.postContractComment.mock.calls[0][1]).toEqual(
            expect.objectContaining({ comment_type: "question", highlight_text: "Logistics Services", highlight_start: 0, highlight_end: 18 }),
        );
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(screen.getByRole("status")).toHaveTextContent("Komentar tersimpan");

        await user.click(screen.getByRole("tab", { name: "Komentar (1)" }));
        expect(screen.getByTestId("comment-c1")).toHaveTextContent("Perlu definisi?");
        selection.mockRestore();
    });

    it("shows one pane at a time below lg and switches to the document on Lihat di dokumen", async () => {
        const user = userEvent.setup();
        mocks.getContract.mockResolvedValue(DETAIL);
        render(<ReviewWorkspace reviewId="r1" />);
        const docPane = await screen.findByTestId("document-pane");
        const findingsPane = screen.getByTestId("findings-pane");
        const views = screen.getByRole("tablist", { name: "Tampilan" });

        // The heading carries the full title on its own line; the page-header crumb
        // shows a short label on phones instead of repeating it.
        const heading = screen.getByRole("heading", { level: 1 });
        expect(heading).toHaveClass("line-clamp-2", "sm:line-clamp-1");
        expect(heading.parentElement).toHaveClass("basis-full", "sm:basis-auto");
        // (PageHeader also renders hidden measurement copies of each crumb.)
        for (const crumb of screen.getAllByText("Tinjauan", { selector: "span" })) expect(crumb).toHaveClass("sm:hidden");

        // Findings first on a phone; both panes are restored side by side at lg.
        expect(within(views).getByRole("tab", { name: "Temuan" })).toHaveAttribute("aria-selected", "true");
        expect(docPane).toHaveClass("hidden", "lg:block");
        expect(findingsPane).toHaveClass("flex", "flex-1", "lg:flex", "lg:flex-none");

        await user.click(within(views).getByRole("tab", { name: "Dokumen" }));
        expect(docPane).not.toHaveClass("hidden");
        expect(findingsPane).toHaveClass("hidden", "lg:flex");

        await user.click(within(views).getByRole("tab", { name: "Temuan" }));
        await user.click(screen.getAllByRole("button", { name: /Lihat di dokumen/ })[0]);
        expect(within(views).getByRole("tab", { name: "Dokumen" })).toHaveAttribute("aria-selected", "true");
        expect(docPane).not.toHaveClass("hidden");
    });

    it("suggests an edit from a DOCX selection, lists it on Saran, and locates it in the document", async () => {
        const user = userEvent.setup();
        const existing = {
            id: "s0", review_id: "r1", author_user_id: "u2", author_email: "robert@dashelectric.co", author_name: "Robert",
            original_text: "2%", suggested_text: "1%", note: null, change_id: "c0", del_w_id: "3", ins_w_id: "4",
            status: "pending" as const, resolved_by: null, resolved_at: null, created_at: "2026-09-23T09:00:00Z", updated_at: "2026-09-23T09:00:00Z",
        };
        mocks.getContract.mockResolvedValue({
            ...DETAIL,
            review: { ...DETAIL.review, contract_docx_path: "contracts/r1/original.docx" },
            suggestions: [existing],
        });
        mocks.postContractSuggestion.mockResolvedValue({ ...existing, id: "s1", original_text: "30", suggested_text: "14", ins_w_id: "8" });
        render(<ReviewWorkspace reviewId="r1" />);

        const view = await screen.findByTestId("docx-view");
        expect(view.getAttribute("data-ids-url")).toBe("/api/contracts/r1/tracked-change-ids");
        expect(screen.getByRole("tab", { name: "Saran (1)" })).toBeInTheDocument();

        // Select "30 hari" inside the rendered paragraph.
        const textNode = within(view).getByText(/Pembayaran dilakukan/).firstChild!;
        const range = document.createRange();
        range.setStart(textNode, 27);
        range.setEnd(textNode, 34);
        // jsdom ranges have no layout.
        range.getBoundingClientRect = () => ({ bottom: 120, left: 40, top: 100, right: 200 }) as DOMRect;
        vi.spyOn(window, "getSelection").mockReturnValue({
            isCollapsed: false,
            rangeCount: 1,
            anchorNode: textNode,
            focusNode: textNode,
            toString: () => "30 hari",
            getRangeAt: () => range,
        } as unknown as Selection);
        const pane = screen.getByTestId("document-pane");
        await user.pointer({ keys: "[MouseLeft>]", target: pane });
        await user.pointer({ keys: "[/MouseLeft]", target: pane });

        const dialog = await screen.findByRole("dialog", { name: "Sarankan perubahan" });
        const field = within(dialog).getByRole("textbox", { name: "Teks pengganti" });
        await user.clear(field);
        await user.type(field, "14 hari");
        await user.click(within(dialog).getByRole("button", { name: "Sarankan" }));

        await waitFor(() =>
            expect(mocks.postContractSuggestion).toHaveBeenCalledWith("r1", {
                selected_text: "30 hari",
                replacement: "14 hari",
                context_before: "Pembayaran dilakukan dalam ",
                context_after: " setelah invoice diterima.",
                note: null,
            }),
        );
        expect(await screen.findByRole("tab", { name: "Saran (2)" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByText(/Saran tersimpan sebagai perubahan terlacak/)).toBeInTheDocument();

        await user.click(within(screen.getByTestId("suggestion-s1")).getByRole("button", { name: /Lihat di dokumen/ }));
        expect(screen.getByTestId("docx-view").getAttribute("data-highlight")).toBe("8");
    });

    it("keeps the comment-only popover for reviews without the original DOCX", async () => {
        mocks.getContract.mockResolvedValue(DETAIL);
        render(<ReviewWorkspace reviewId="r1" />);
        await screen.findByRole("heading", { name: "PKS — Markas Daging" });
        await userEvent.setup().click(screen.getByRole("tab", { name: "Saran" }));
        expect(screen.getByText(/membutuhkan DOCX asli/)).toBeInTheDocument();
    });
});
