import { describe, expect, it } from "vitest";
import {
    isChatAttachmentDrag,
    isExternalFileDrag,
    isDocumentViewerDrag,
    isProjectItemDrag,
} from "./projectDragTypes";

describe("project drag types", () => {
    it.each([
        [["Files"], true],
        [["application/varda-doc"], true],
        [["application/varda-docs"], true],
        [["application/varda-folder"], false],
        [["application/varda-project-tab"], false],
        [["text/plain"], false],
    ])("recognizes viewer drops %j", (types, accepted) => {
        expect(isDocumentViewerDrag({ types: types as string[] })).toBe(
            accepted,
        );
    });
    it.each([
        [[], false, false, false],
        [["text/plain"], false, false, false],
        [["Files"], true, true, false],
        [["application/varda-doc"], true, false, true],
        [["application/varda-folder"], false, false, true],
        [["application/varda-doc", "Files"], true, true, true],
    ])("recognizes %j", (types, attachment, files, projectItem) => {
        const transfer = { types: types as string[] };
        expect(isChatAttachmentDrag(transfer)).toBe(attachment);
        expect(isExternalFileDrag(transfer)).toBe(files);
        expect(isProjectItemDrag(transfer)).toBe(projectItem);
    });
});
