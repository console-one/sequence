# Incremental Resolution

A value starts as a declared shape with no data -- a gap. Partial contributions arrive over time. The system tracks what is still missing automatically, and dependent operations unblock as resolution progresses. The critical distinction: "no data yet" vs "data present but incomplete" vs "data fully resolved." Dependent operations can wait on specific subsets (just the email field) rather than requiring full resolution.

There is no special "partial write" mode. Data is written via the same mechanism as complete data. Obligations are derived automatically from schemas and current values -- never manually maintained.

## The Schema-as-Gap

Declaring a schema at a path before any value exists creates a gap -- a known shape with no data. The obligations list includes every path where a schema exists but the value does not fully satisfy it:

```ft
Profile = {
  name: string,
  email: string,
  bio?: string
}

profile = Profile
```

At this point, `profile` is a gap. The obligations list includes `profile` because required fields `name` and `email` have no values. The optional field `bio` does not count as an obligation.

## Partial Data

Partial data narrows the gap. The system accepts it and tracks what remains:

```ft
profile << { name: "Alice" }
```

After this write, `profile.name` is resolved but `profile.email` is still missing. The obligations list still includes `profile` -- but now the remaining obligation is specifically `email`, not the entire profile.

Providing the remaining required field resolves the gap:

```ft
profile << { email: "alice@example.com" }
```

Now all required fields are present. `profile` no longer appears in the obligations list. The optional `bio` field is absent but does not prevent resolution.

## Fine-Grained Dependencies

Dependent operations can condition on specific fields, not just full resolution. An operation that only needs the email suspends until that specific field appears:

```ft
sendWelcome = { to: ref(profile.email) } when profile.email EXISTS
```

This operation suspends while `profile.email` is missing. When the email is written, it resumes -- regardless of whether other fields are present. The dependency is on a specific path, not on full schema satisfaction.

An operation that needs the full profile conditions differently:

```ft
renderCard = { data: ref(profile) } when profile.email EXISTS
```

This operation gates on the email field (the last required field to arrive). In practice, compound conditions (name AND email both present) are expressed as prose: the `when` condition gates on the final dependency, and the narrative explains the full condition.

This only resumes when both required fields are present.

## Derived Values

Derived values participate in the same incremental pattern. They compute as soon as all their inputs are available:

```ft
DisplayName = {
  first: string,
  last: string
}

parts = DisplayName
parts << { first: "Bob" }
-- displayName cannot compute yet (last is missing)
parts << { last: "Smith" }
-- now both inputs are available
```

The derived display name (a concatenation of first and last) computes automatically when both inputs are present. It does not wait for unrelated paths to resolve.

Behavioral note: the actual computation of a derived value from its inputs (e.g., concatenating first + last into a display name) is an interpreter concern. The ft blocks above express when the inputs are available; the computation itself is handled by the runtime when all dependencies are satisfied.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Schema with no value creates a gap in obligations | `profile = Profile` with no data written |
| Partial data accepted, remaining obligations tracked | `profile << { name: "Alice" }` -- email still missing |
| Dependent operation suspends on specific missing field | `sendWelcome = ... when profile.email EXISTS` |
| Dependent operation resumes when field appears | Email written, `when` condition satisfied |
| Full resolution removes path from obligations | Both `name` and `email` provided, `profile` drops from obligations |
| Optional fields do not count as obligations | `bio?` absent but profile still fully resolved |
| Derived values compute when all inputs arrive | `parts << { last: "Smith" }` completes the input set |
