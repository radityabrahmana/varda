// Serializes read-modify-write cycles on one review's working DOCX.
//
// Accept, reject, AI projection and human suggestions all download
// contracts/<id>/redline.docx, change it and upload it again. Two of those
// running at once would lose one write (the later upload overwrites the
// earlier one). The backend runs as a single process, so an in-memory chain
// per review id is enough; a multi-instance deployment would need a row lock.

const tails = new Map<string, Promise<unknown>>();

export async function withReviewDocLock<T>(reviewId: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(reviewId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(reviewId, tail);
  try {
    return await run;
  } finally {
    // Drop the entry once nothing newer is queued behind this call.
    if (tails.get(reviewId) === tail) tails.delete(reviewId);
  }
}
