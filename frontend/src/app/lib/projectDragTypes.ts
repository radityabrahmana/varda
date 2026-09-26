type DragTypes = Pick<DataTransfer, "types">;

export function isDocumentViewerDrag(dataTransfer: DragTypes): boolean {
    return (
        isExternalFileDrag(dataTransfer) ||
        dataTransfer.types.includes("application/varda-doc") ||
        dataTransfer.types.includes("application/varda-docs")
    );
}

export function isProjectItemDrag({ types }: DragTypes): boolean {
    return (
        types.includes("application/varda-doc") ||
        types.includes("application/varda-folder")
    );
}

export function isExternalFileDrag({ types }: DragTypes): boolean {
    return types.includes("Files");
}

export function isChatAttachmentDrag(dataTransfer: DragTypes): boolean {
    return (
        isExternalFileDrag(dataTransfer) ||
        dataTransfer.types.includes("application/varda-doc")
    );
}
