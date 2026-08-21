/** Message text for anything thrown, without assuming it is an Error. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a thrown value means "this thing does not exist", as opposed to a
 * request that failed on its way.
 *
 * bb injects `bb.sdk` at runtime, so the error shape is not in the published
 * types; several shapes are checked. **Anything unrecognised counts as
 * transient**, because the caller uses this to decide whether to forget a
 * thread and delete its stored cursor, and losing a live thread's cursor is
 * far worse than retrying a lookup.
 */
export function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  if (candidate.status === 404 || candidate.statusCode === 404) return true;

  const code = typeof candidate.code === "string" ? candidate.code.toLowerCase() : null;
  if (code === "not_found" || code === "notfound" || code === "enoent") return true;

  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  return /\b404\b/.test(message) || message.includes("not found");
}
