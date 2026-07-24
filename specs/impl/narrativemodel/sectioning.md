# Document Sections as Segmented Types

A document is not flat text -- it has structure. A report has a header, body, and footer. Each section has its own type, size budget, and mutability rules. The header is short and may be locked after approval. The body is long and freely editable. The footer is short and immutable once signed. These constraints must be enforced structurally at the data layer, not left to the UI to police.

Locking is not a separate mechanism -- it is a tightening of the type constraint to a literal. A locked footer's schema constrains its value to exactly its current content, making any different value invalid by definition.

## The Section Type

Each section has a name, content, a size budget, and an optional lock state. Sections are independently addressable by path:

```ft
Section = {
  name: string,
  content: string,
  budget: number.integer >= 0,
  locked: boolean,
  mutations?: string
}
```

The `mutations` field declares permitted transformations on the section content -- values like "expand" (add detail) or "compress" (summarize). These guide automated agents and UI affordances.

## Defining a Sectioned Document

A document is an ordered collection of named sections. Each section has its own budget and lock state:

```ft
report = {
  header: Section,
  body: Section,
  footer: Section
}

report << {
  header: { name: "header", content: "Q4 Financial Summary", budget: 200, locked: false },
  body: { name: "body", content: "The quarterly results show...", budget: 4000, locked: false },
  footer: { name: "footer", content: "Confidential - Internal Use Only", budget: 100, locked: false }
}
```

Each section holds its own content independently. Writing to `report.body` does not affect `report.header` or `report.footer`.

## Size Budget Enforcement

Each section's budget is enforced on writes. A write within the budget succeeds. A write exceeding the budget is suspended:

```ft
report.body << { content: "A 3000-character report body..." }
```

This succeeds because 3000 is within the 4000-character budget.

A 4001-character write to the same section is suspended -- the content remains unchanged, and the write surfaces as an obligation ("content exceeds budget").

Budget enforcement happens at write time, not read time. The data layer rejects oversized content before it enters the store.

## Locking via Literal Constraint

Locking a section constrains its value to exactly its current content. Any write of a different value is invalid because it does not match the literal:

```ft
report.footer << { locked: true }
```

After locking, the footer's content is constrained to "Confidential - Internal Use Only". Writing "Changed text" to the footer fails validation -- "Changed text" does not match the literal constraint. This enforcement is structural, not UI-based. A direct non-UI write to a locked section is rejected identically.

Writing the exact same value as the current content to a locked section is a no-op -- it matches the literal constraint and changes nothing.

## Section Enumeration

The system supports reading all section names for a document, providing a structural overview for navigation and table-of-contents generation:

```ft
-- Querying report sections returns: header, body, footer (in order)
```

Section order is the declared order. Sections are enumerable and navigable.

## Mutation Policies

Sections can declare permitted mutation types. These are metadata that guide what transformations are allowed on the section:

```ft
report.body << { mutations: "expand" }
```

A section marked "expand" can have detail added. A section marked "compress" can be summarized. These policies are inspectable -- agents and UI affordances read them to determine what actions to offer.

## Capabilities

Section content, budgets, and lock states are externally controlled:

```ft
tool Section.content
tool Section.budget
tool Section.locked
tool Section.mutations
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Three sections hold content independently | `report.header`, `report.body`, `report.footer` each with own content |
| Write exceeding budget is suspended | 4001-char write to 4000-char budget section rejected |
| Write within budget succeeds | 3000-char write to 4000-char budget section accepted |
| Locked section rejects writes from any source | `report.footer << { locked: true }` constrains to literal; different value fails |
| Section list queryable in order | Section enumeration returns header, body, footer |
| Mutation policies inspectable | `report.body << { mutations: "expand" }` is readable metadata |
| Locking is a literal constraint | Footer locked to "Confidential - Internal Use Only"; mismatching write fails validation |
