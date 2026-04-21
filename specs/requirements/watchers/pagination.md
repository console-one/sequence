# Pagination

## Problem Context

- **Actor(s)**: A data consumer (needs paginated results), an external data source (provides pages with cursors), a fetch mechanism (retrieves one page at a time), a lifecycle controller (can cancel pagination)
- **Domain**: Cursor-based pagination -- fetching data one page at a time from an external source, advancing cursors, and terminating when complete or cancelled
- **Core Tension**: Pagination must be reactive, not an imperative loop. If conditions change mid-pagination (cancellation, error), the process must respond immediately. Each unfetched page should be a visible, actionable item -- not hidden inside loop control flow.

## Requirements

**R1**: A page result SHALL contain the fetched items, a cursor pointing to the next page, and a flag indicating whether more pages exist.
- *Rationale*: These are the minimal fields for cursor-based pagination from any external source.
- *Verifiable by*: A fetched page contains items, a next cursor, and a hasMore flag.

**R2**: The pagination state SHALL track the current cursor, accumulated pages, and a completion flag.
- *Rationale*: The consumer needs to know where pagination is, what has been fetched, and whether it is done.
- *Verifiable by*: Querying the pagination state returns the current cursor, all fetched pages, and the completion status.

**R3**: Each unfetched page SHALL be represented as a visible, identifiable pending item that can be matched to the fetch mechanism.
- *Rationale*: Pending work must be visible, not hidden inside control flow. This enables inspection and debugging.
- *Verifiable by*: Before any fetch, the unfetched page is visible as a pending item with the current cursor.

**R4**: The fetch mechanism SHALL take a cursor as input and return a page result.
- *Rationale*: The fetch is a stateless function from cursor to page. Statefulness is managed by the pagination state.
- *Verifiable by*: Invoking the fetch with a cursor and receiving a page result.

**R5**: After a page is fetched, the result SHALL be stored and the cursor SHALL advance to the next page's cursor.
- *Rationale*: Each fetch fulfills one pending item and (if more pages exist) creates the next one.
- *Verifiable by*: After fetching a page, the result is stored and the cursor equals the returned nextCursor.

**R6**: When a fetched page indicates hasMore=true, a new pending item SHALL be created for the next page.
- *Rationale*: The chain of fetches emerges from successive pending items, not from loop control flow.
- *Verifiable by*: After a fetch returning hasMore=true, a new pending item exists for the next page.

**R7**: When a fetched page indicates hasMore=false, no new pending item SHALL be created and the pagination SHALL be marked complete.
- *Rationale*: Termination is a data condition, not a loop break.
- *Verifiable by*: After a fetch returning hasMore=false, no pending items exist and the completion flag is true.

**R8**: Pagination SHALL support an external lifecycle control that can terminate pagination regardless of the hasMore flag.
- *Rationale*: User cancellation, timeout, and error conditions must be able to stop pagination immediately.
- *Verifiable by*: Removing the lifecycle flag while hasMore=true and confirming pagination stops and no new pending items are created.

**R9**: All fetched pages SHALL be retained and accessible to the consumer. Cursor management SHALL be internal to the pagination state.
- *Rationale*: The consumer reads accumulated results without managing cursors. Cursor management is an implementation detail.
- *Verifiable by*: After 3 pages are fetched, all 3 are readable by the consumer without knowing any cursor values.

## Acceptance Criteria

**AC1** [R3]: Given initial cursor "start" and no pages fetched, when the pagination state is inspected, then an unfetched page is visible as a pending item.

**AC2** [R4, R5]: Given cursor "start", when the fetch mechanism runs, then a page result is returned, stored, and the cursor advances to the returned nextCursor.

**AC3** [R6]: Given a fetch returning hasMore=true with nextCursor="pg2", when the result is stored, then a new pending item exists for cursor "pg2".

**AC4** [R7]: Given a fetch returning hasMore=false, when the result is stored, then no pending items exist and the completion flag is true.

**AC5** [R8]: Given active pagination with hasMore=true, when the lifecycle control flag is removed, then pagination stops immediately and no new pending items are created.

**AC6** [R9]: Given 3 pages fetched (p0, p1, p2), when the consumer reads results, then all 3 pages and their items are accessible.

## Open Questions

- Should there be a maximum page count to prevent runaway pagination against misbehaving sources?
- What happens if a fetch fails? Is the pending item retried, failed permanently, or left as pending for manual resolution?
- Should fetched pages be evictable (for memory management) or always retained?
