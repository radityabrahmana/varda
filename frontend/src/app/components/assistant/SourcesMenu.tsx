"use client";

import { FolderOpen, PlusIcon, Upload } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { GoogleDriveIcon } from "@/app/components/shared/GoogleDriveIcon";
import { cn } from "@/app/lib/utils";

interface Props {
    /** Upload files from the device. */
    onUpload: () => void;
    /** Browse the Varda library and project documents. */
    onBrowseAll: () => void;
    /** Pick a file from Google Drive. */
    onGoogleDrive: () => void;
    selectedDocIds?: string[];
    hideLabel?: boolean;
}

/**
 * The composer's "+ Sources" control: where a document can come from. The
 * count replaces the plus once something is attached, like the old
 * documents button did, so the chips row and this control agree.
 */
export function SourcesMenu({
    onUpload,
    onBrowseAll,
    onGoogleDrive,
    selectedDocIds = [],
    hideLabel = false,
}: Props) {
    const count = selectedDocIds.length;
    return (
        <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        "flex items-center gap-1 px-2 h-8 rounded-lg text-sm transition-colors cursor-pointer",
                        count > 0
                            ? "text-gray-700 hover:text-gray-900"
                            : "text-gray-400 hover:text-gray-700",
                    )}
                    title="Add sources"
                    aria-label="Add sources"
                >
                    {count > 0 ? (
                        <span className="font-medium tabular-nums">
                            {count}
                        </span>
                    ) : (
                        <PlusIcon className="h-4 w-4 shrink-0" />
                    )}
                    <span
                        className={hideLabel ? "hidden" : "hidden sm:inline"}
                    >
                        {count === 1 ? "Source" : "Sources"}
                    </span>
                </button>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                align="start"
                sideOffset={6}
                className="z-[130] w-52 p-1"
            >
                <LiquidDropdownItem
                    onSelect={onUpload}
                    className="gap-2.5 px-2.5 py-2 text-[13px]"
                >
                    <Upload className="h-4 w-4 shrink-0 text-gray-500" />
                    Upload files
                </LiquidDropdownItem>
                <LiquidDropdownItem
                    onSelect={onBrowseAll}
                    className="gap-2.5 px-2.5 py-2 text-[13px]"
                >
                    <FolderOpen className="h-4 w-4 shrink-0 text-gray-500" />
                    Varda library
                </LiquidDropdownItem>
                <LiquidDropdownItem
                    onSelect={onGoogleDrive}
                    className="gap-2.5 px-2.5 py-2 text-[13px]"
                >
                    <GoogleDriveIcon className="h-4 w-4 shrink-0" />
                    Google Drive
                </LiquidDropdownItem>
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}
