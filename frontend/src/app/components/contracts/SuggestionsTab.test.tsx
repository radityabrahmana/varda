import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SuggestionRow } from "./reviewTypes";

const mocks = vi.hoisted(() => ({ resolveContractSuggestion: vi.fn(), postContractSuggestion: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    resolveContractSuggestion: mocks.resolveContractSuggestion,
    postContractSuggestion: mocks.postContractSuggestion,
}));

import { SuggestionsTab } from "./SuggestionsTab";
import { SuggestEditForm } from "./SuggestEditForm";
import { ReviewAccessProvider } from "./reviewAccess";

const row = (over: Partial<SuggestionRow> = {}): SuggestionRow => ({
    id: "s1",
    review_id: "r1",
    author_user_id: "u-robert",
    author_email: "robert@dashelectric.co",
    author_name: "Robert",
    original_text: "30",
    suggested_text: "14",
    note: "Sesuai standar Dash.",
    change_id: "c1",
    del_w_id: "7",
    ins_w_id: "8",
    status: "pending",
    resolved_by: null,
    resolved_at: null,
    created_at: "2026-09-23T10:00:00Z",
    updated_at: "2026-09-23T10:00:00Z",
    ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("SuggestionsTab", () => {
    it("shows each suggestion as strike + insertion with its author, and resolves it", async () => {
        const user = userEvent.setup();
        const onResolved = vi.fn();
        const onLocate = vi.fn();
        mocks.resolveContractSuggestion.mockResolvedValue(row({ status: "accepted" }));
        render(
            <SuggestionsTab
                reviewId="r1"
                suggestions={[row({ id: "s0", status: "rejected" }), row()]}
                hasDocx
                onLocate={onLocate}
                onResolved={onResolved}
            />,
        );
        expect(screen.getByText("1 saran menunggu keputusan")).toBeInTheDocument();
        const card = screen.getByTestId("suggestion-s1");
        expect(within(card).getByText("30").tagName).toBe("DEL");
        expect(within(card).getByText("14").tagName).toBe("INS");
        expect(within(card).getByText("Robert")).toBeInTheDocument();
        expect(within(card).getByText("Sesuai standar Dash.")).toBeInTheDocument();
        // Decided suggestions have no buttons.
        expect(within(screen.getByTestId("suggestion-s0")).queryByRole("button", { name: /Terima/ })).toBeNull();

        await user.click(within(card).getByRole("button", { name: /Lihat di dokumen/ }));
        expect(onLocate).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
        await user.click(within(card).getByRole("button", { name: /Terima/ }));
        await waitFor(() => expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ status: "accepted" })));
        expect(mocks.resolveContractSuggestion).toHaveBeenCalledWith("r1", "s1", "accept");
    });

    it("hides Terima/Tolak from viewers and explains the empty state", () => {
        const { rerender } = render(
            <ReviewAccessProvider role="viewer">
                <SuggestionsTab reviewId="r1" suggestions={[row()]} hasDocx onLocate={vi.fn()} onResolved={vi.fn()} />
            </ReviewAccessProvider>,
        );
        expect(screen.queryByRole("button", { name: /Terima/ })).toBeNull();
        expect(screen.getByRole("button", { name: /Lihat di dokumen/ })).toBeInTheDocument();

        rerender(<SuggestionsTab reviewId="r1" suggestions={[]} hasDocx={false} onLocate={vi.fn()} onResolved={vi.fn()} />);
        expect(screen.getByText(/membutuhkan DOCX asli/)).toBeInTheDocument();
    });

    it("surfaces a failed resolve", async () => {
        const user = userEvent.setup();
        mocks.resolveContractSuggestion.mockRejectedValue(new Error("boom"));
        render(<SuggestionsTab reviewId="r1" suggestions={[row()]} hasDocx onLocate={vi.fn()} onResolved={vi.fn()} />);
        await user.click(screen.getByRole("button", { name: /Tolak/ }));
        expect(await screen.findByText("Gagal menolak saran.")).toBeInTheDocument();
    });
});

describe("SuggestEditForm", () => {
    const base = { reviewId: "r1", selected: "30 hari", contextBefore: "dalam ", contextAfter: " setelah invoice" };

    it("sends a replacement with its anchor and optional note", async () => {
        const user = userEvent.setup();
        const onSaved = vi.fn();
        const onClose = vi.fn();
        mocks.postContractSuggestion.mockResolvedValue(row());
        render(<SuggestEditForm {...base} onSaved={onSaved} onClose={onClose} />);

        const saveBtn = screen.getByRole("button", { name: "Sarankan" });
        expect(saveBtn).toBeDisabled(); // unchanged text
        const field = screen.getByRole("textbox", { name: "Teks pengganti" });
        await user.clear(field);
        await user.type(field, "14 hari");
        await user.type(screen.getByRole("textbox", { name: "Catatan (opsional)" }), "Standar Dash");
        expect(screen.getByTestId("suggestion-preview")).toHaveTextContent("30 hari14 hari");
        await user.click(saveBtn);

        await waitFor(() =>
            expect(mocks.postContractSuggestion).toHaveBeenCalledWith("r1", {
                selected_text: "30 hari",
                replacement: "14 hari",
                context_before: "dalam ",
                context_after: " setelah invoice",
                note: "Standar Dash",
            }),
        );
        expect(onSaved).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it("deletes with an empty replacement and inserts after the selection", async () => {
        const user = userEvent.setup();
        mocks.postContractSuggestion.mockResolvedValue(row());
        render(<SuggestEditForm {...base} onSaved={vi.fn()} onClose={vi.fn()} />);

        await user.click(screen.getByRole("radio", { name: "Hapus" }));
        await user.click(screen.getByRole("button", { name: "Sarankan" }));
        await waitFor(() => expect(mocks.postContractSuggestion).toHaveBeenLastCalledWith("r1", expect.objectContaining({ replacement: "", note: null })));

        await user.click(screen.getByRole("radio", { name: "Sisipkan setelahnya" }));
        await user.type(screen.getByRole("textbox", { name: "Teks yang disisipkan" }), "kalender");
        await user.click(screen.getByRole("button", { name: "Sarankan" }));
        await waitFor(() => expect(mocks.postContractSuggestion).toHaveBeenLastCalledWith("r1", expect.objectContaining({ replacement: "30 hari kalender" })));
    });

    it("keeps the form open with the error when saving fails", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        mocks.postContractSuggestion.mockRejectedValue(new Error("x"));
        render(<SuggestEditForm {...base} onSaved={vi.fn()} onClose={onClose} />);
        await user.click(screen.getByRole("radio", { name: "Hapus" }));
        await user.click(screen.getByRole("button", { name: "Sarankan" }));
        expect(await screen.findByText("Saran gagal disimpan.")).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
    });
});
