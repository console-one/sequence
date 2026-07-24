# Pagination

Paginated data from an external source arrives one page at a time. Each page provides a cursor to the next. Traditional implementations use an imperative loop with manual cursor management. That is not reactive -- if conditions change mid-pagination (cancellation, error), the loop must be manually interrupted.

The right model: each unfetched page is a gap (obligation). The cursor is typed state. The fetch is a capability matched to the gap. Termination is a condition (hasMore = false or lifecycle break). Each fetch fulfills one obligation and, if more pages exist, creates the next. No loop. The chain emerges from obligation resolution.

## The Page Types

A page result has items, a cursor to the next page, and a flag indicating whether more pages exist:

```ft
PageResult = {
  items: string,
  nextCursor: string,
  hasMore: boolean
}

Pagination = {
  cursor: string,
  pages: PageResult,
  complete: boolean
}
```

Items within a page are written as named entries (e.g., `items.i0`, `items.i1`). Pages are written under `pages` with unique keys (e.g., `pages.p0`, `pages.p1`).

## The Fetch Capability

The fetch capability takes a cursor and returns a page result. It is the resolver for page gaps:

```ft
fetchPage = (cursor: string) -> PageResult
tool fetchPage
```

When a page gap exists and a cursor is available, the system matches the gap to this capability.

## Initial State and First Fetch

Pagination starts with a cursor and an unfilled page obligation:

```ft
paginator = Pagination
paginator << { cursor: "start", complete: false }
```

The page schema is declared but no data exists yet -- this surfaces as a gap. The gap matches `fetchPage` with the current cursor as input.

## Page Arrival and Cursor Advancement

When a page is fetched, the result is stored and the cursor advances:

```ft
-- first page fetched
paginator << { pages: { p0: { items: { i0: "a", i1: "b" }, nextCursor: "pg2", hasMore: true } } }
paginator << { cursor: "pg2" }
```

Because hasMore is true, a new page obligation is created. The cursor is now "pg2," so the next fetch uses that cursor. The chain continues.

## Termination

When a page returns hasMore = false, no new obligation is created:

```ft
-- final page fetched
paginator << { pages: { p1: { items: { i0: "c" }, nextCursor: "", hasMore: false } } }
paginator << { complete: true }
```

The pagination lifecycle ends. No further gaps surface.

## Lifecycle Control

Pagination can be conditioned on an external flag. Removing the flag terminates pagination regardless of hasMore:

```ft
paginator = Pagination while paginationActive EXISTS
```

Removing `paginationActive` breaks the while gate, killing the pagination even if the last page indicated more data. This handles user cancellation, timeout, and error cases.

## Reading Fetched Data

All fetched pages are retained and accessible:

```ft
-- after 3 pages fetched, all are readable
-- paginator.pages.p0.items, paginator.pages.p1.items, paginator.pages.p2.items
```

The consumer reads accumulated page data without managing cursors. Cursor management is entirely internal.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Unfetched page appears as gap | Page schema declared but unfilled surfaces in obligations |
| Fetch capability matched to gap | `fetchPage = (cursor) -> PageResult` with `cap fetchPage` |
| Cursor advances, new gap appears | `cursor: "pg2"` after fetch, new page obligation created |
| hasMore=false terminates pagination | `complete: true`, no new gaps |
| Lifecycle condition controls termination | `while paginationActive EXISTS` gate |
| All fetched pages accessible | `paginator.pages.p0`, `p1`, etc. retained |
