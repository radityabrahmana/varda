import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent } from "../shared/types";

const reasoning = (text: string): AssistantEvent => ({
    type: "reasoning",
    text,
});

describe("AssistantMessage timeline", () => {
    it("folds a run of reasoning events into one thinking block", () => {
        render(
            <AssistantMessage
                events={[
                    reasoning("First I check the parties."),
                    reasoning("Then the termination clause."),
                    reasoning("Finally the governing law."),
                ]}
            />,
        );

        // One block, not three stacked on the timeline.
        const toggles = screen.getAllByRole("button", {
            name: /Thought process/,
        });
        expect(toggles).toHaveLength(1);

        fireEvent.click(toggles[0]);
        expect(screen.getByText(/First I check the parties/)).toBeVisible();
        expect(screen.getByText(/Then the termination clause/)).toBeVisible();
        expect(screen.getByText(/Finally the governing law/)).toBeVisible();
    });

    it("does not treat the answering model's record as a step", () => {
        render(
            <AssistantMessage
                events={[
                    reasoning("Before the fallback."),
                    { type: "model_info", model: "claude-sonnet-5", mode: "auto", tier: "deep", reason: "workflow" },
                    reasoning("After the fallback."),
                ]}
            />,
        );

        // model_info sits between the two, but it is metadata: the reasoning
        // still folds into one block and nothing else joins the timeline.
        expect(
            screen.getAllByRole("button", { name: /Thought process/ }),
        ).toHaveLength(1);
    });

    it("keeps reasoning separated by other work in its own blocks", () => {
        render(
            <AssistantMessage
                events={[
                    reasoning("Before the search."),
                    {
                        type: "doc_read",
                        filename: "lease.pdf",
                        document_id: "d1",
                        version_id: "v1",
                        version_number: 1,
                    },
                    reasoning("After the search."),
                ]}
            />,
        );

        expect(
            screen.getAllByRole("button", { name: /Thought process/ }),
        ).toHaveLength(2);
    });

    it("does not mark the response failed when a single tool call fails", () => {
        const { container } = render(
            <AssistantMessage
                events={[
                    {
                        type: "mcp_tool_call",
                        connector_id: "c1",
                        connector_name: "Drive",
                        tool_name: "search",
                        openai_tool_name: "drive_search",
                        status: "error",
                        error: "Connector unavailable",
                    },
                    { type: "content", text: "Here is what I found anyway." },
                ]}
            />,
        );

        // The response is not branded an error…
        expect(
            screen.queryByText("Sorry, something went wrong."),
        ).not.toBeInTheDocument();

        // …while the failed step still reports itself once the steps are open.
        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 1 step" }),
        );
        expect(container.querySelector(".bg-red-400")).not.toBeNull();
        expect(screen.getByText("Connector unavailable")).toBeInTheDocument();
    });

    it("marks the response failed for a top-level error event", () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "error",
                        message: "The response was interrupted.",
                        safe_to_display: true,
                    } as AssistantEvent,
                ]}
            />,
        );

        expect(
            screen.getByText("The response was interrupted."),
        ).toBeInTheDocument();
    });
});

describe("AssistantMessage answering model", () => {
    const fastAnswer: AssistantEvent[] = [
        { type: "model_info", model: "openrouter/google/gemini-3.8-flash", mode: "auto", tier: "fast", reason: "default" },
        { type: "content", text: "Force majeure is an unforeseeable event." },
    ];

    it("names the model and mode that answered", () => {
        render(<AssistantMessage events={fastAnswer} />);
        expect(screen.getByText("Answered by Gemini 3.8 Flash · Auto")).toBeInTheDocument();
    });

    it("offers Deep under a fast answer when the host allows it", () => {
        const onAskAgainDeep = vi.fn();
        render(<AssistantMessage events={fastAnswer} onAskAgainDeep={onAskAgainDeep} />);
        fireEvent.click(screen.getByRole("button", { name: "Ask again with Deep" }));
        expect(onAskAgainDeep).toHaveBeenCalledTimes(1);
    });

    it("does not offer Deep under a deep answer or while streaming", () => {
        const deepAnswer: AssistantEvent[] = [
            { type: "model_info", model: "claude-sonnet-5", mode: "auto", tier: "deep", reason: "workflow" },
            { type: "content", text: "Clause 4 shifts the risk." },
        ];
        const { rerender } = render(
            <AssistantMessage events={deepAnswer} onAskAgainDeep={vi.fn()} />,
        );
        expect(screen.getByText("Answered by Claude Sonnet 5 · Auto")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Ask again with Deep" })).not.toBeInTheDocument();

        rerender(<AssistantMessage events={fastAnswer} onAskAgainDeep={vi.fn()} isStreaming />);
        expect(screen.queryByRole("button", { name: "Ask again with Deep" })).not.toBeInTheDocument();
        expect(screen.queryByText(/Answered by/)).not.toBeInTheDocument();
    });
});
