/**
 * Thread event reads that stay inside bb's page limit.
 *
 * bb answers `HTTP 400: Thread event limit cannot exceed 100` to a larger
 * `limit`, and it fails the whole request rather than clamping. Every caller
 * asks for what it wants here and this module splits it into legal pages.
 */

/** The largest `limit` bb accepts on one thread events request. */
export const THREAD_EVENT_PAGE_SIZE = 100;

/** The cursor fields of a thread events request that paging moves. */
export interface EventPageArgs {
  afterSeq?: string;
  beforeSeq?: string;
  limit?: string;
  order?: "asc" | "desc";
}

/**
 * Reads up to `limit` events in `order`, one page of at most 100 at a time.
 * Ascending reads move `afterSeq` forward and descending reads move `beforeSeq`
 * back, so the rows come back exactly as one large request would have
 * returned them. A short page means the thread has nothing more.
 */
export async function listThreadEvents<Args extends EventPageArgs, Row extends { seq: number }>(
  list: (args: Args) => Promise<readonly Row[]>,
  args: Omit<Args, "limit"> & { limit: number },
): Promise<Row[]> {
  const { limit, ...rest } = args;
  const descending = rest.order === "desc";
  const rows: Row[] = [];
  let afterSeq = rest.afterSeq;
  let beforeSeq = rest.beforeSeq;

  while (rows.length < limit) {
    const size = Math.min(THREAD_EVENT_PAGE_SIZE, limit - rows.length);
    const page = await list({
      ...rest,
      limit: String(size),
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    } as unknown as Args);
    rows.push(...page);
    if (page.length < size) break;

    const edge = page[page.length - 1]!.seq;
    if (descending) {
      if (beforeSeq !== undefined && edge >= Number(beforeSeq)) throw new Error("event pagination made no progress");
      beforeSeq = String(edge);
    } else {
      if (afterSeq !== undefined && edge <= Number(afterSeq)) throw new Error("event pagination made no progress");
      afterSeq = String(edge);
    }
  }
  return rows;
}
