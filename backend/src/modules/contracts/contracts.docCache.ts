// In-memory cache of contract DOCX bytes (original uploads and working redlines).
//
// Every suggestion, accept and reject re-reads the working DOCX, and the
// viewer then downloads it again and asks for its tracked-change ids — each a
// full object-storage round trip for a file that can be several MB (embedded
// fonts). All contract writes go through this backend, so bytes we just wrote
// or read are the current version: serve them from memory and only fall back
// to storage on a miss. Bounded LRU so a burst of large contracts cannot grow
// the heap without limit.
//
// Single-process assumption, like withReviewDocLock: a second backend
// instance writing the same key would make this cache stale.

import { extractTrackedChangeIds } from "../../lib/docxTrackedChanges";
import { downloadFile, uploadFile } from "../../lib/storage";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const MAX_ENTRIES = 16;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

type TrackedIds = { kind: "ins" | "del"; w_id: string }[];
type Entry = { bytes: Buffer; ids?: TrackedIds };

const entries = new Map<string, Entry>();
let totalBytes = 0;

function evict(): void {
  // Map iteration order is insertion order; the first entry is least recent.
  for (const [key, entry] of entries) {
    if (entries.size <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) return;
    entries.delete(key);
    totalBytes -= entry.bytes.byteLength;
  }
}

export function getCachedDocx(key: string): Buffer | null {
  const entry = entries.get(key);
  if (!entry) return null;
  // Refresh recency.
  entries.delete(key);
  entries.set(key, entry);
  return entry.bytes;
}

export function putCachedDocx(key: string, bytes: Buffer): void {
  invalidateCachedDocx(key);
  if (bytes.byteLength > MAX_TOTAL_BYTES) return;
  entries.set(key, { bytes });
  totalBytes += bytes.byteLength;
  evict();
}

export function invalidateCachedDocx(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  totalBytes -= entry.bytes.byteLength;
}

/** Tracked-change ids for cached bytes, computed once per version. */
export async function trackedIdsFor(key: string, bytes: Buffer): Promise<TrackedIds> {
  const entry = entries.get(key);
  if (entry && entry.bytes === bytes && entry.ids) return entry.ids;
  const ids = await extractTrackedChangeIds(bytes);
  if (entry && entry.bytes === bytes) entry.ids = ids;
  return ids;
}

/** Contract DOCX bytes, from memory when this process has the current version. */
export async function loadBytes(key: string): Promise<Buffer | null> {
  const cached = getCachedDocx(key);
  if (cached) return cached;
  const data = await downloadFile(key);
  if (!data) return null;
  const bytes = Buffer.from(data);
  putCachedDocx(key, bytes);
  return bytes;
}

export async function storeBytes(key: string, bytes: Buffer): Promise<void> {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  await uploadFile(key, ab, DOCX_MIME);
  // Only after the upload succeeded: the cache must never be ahead of storage.
  putCachedDocx(key, bytes);
}

/** Test hook. */
export function clearDocxCache(): void {
  entries.clear();
  totalBytes = 0;
}
