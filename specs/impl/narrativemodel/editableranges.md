# Editable Ranges Within a Document

A document is not uniformly editable. A contract has a locked header and signature but an editable body. The system must enforce per-section editability as a structural constraint -- not a UI hint -- so that writes to locked sections are suspended (never silently dropped), concurrent writers are protected by exclusive edit locks, and editability can change over time (unlocking a section causes pending writes to resume).

The key insight: editability is a predicate on the section, and writes are gated by that predicate. A suspended write is not lost work -- it is a continuation waiting for the predicate to become true.

## The Section Type

Each section of a document has content, an editability flag, and an optional size budget. The editability flag is inspectable state -- any process can read whether a section is currently editable:

```ft
Section = {
  content: string,
  editable: boolean,
  budget?: number.integer >= 0
}
```

A locked section has `editable = false`. An editable section has `editable = true`. This is queried before every write.

## Write Gating on Editability

Writes to a section are conditioned on the section being editable. A write to a locked section is suspended -- preserved as pending work -- not dropped:

```ft
doc = {
  title: Section,
  body: Section,
  signature: Section
}

doc << { title: { content: "Project Proposal", editable: false } }
doc << { body: { content: "Initial draft...", editable: true } }
doc << { signature: { content: "Approved by: Jane Doe", editable: false } }
```

Writing to the body succeeds because `body.editable = true`:

```ft
doc.body << { content: "Revised draft..." }
```

Writing to the title is suspended because `title.editable = false`. The write is listed as pending, and the title content remains "Project Proposal". The suspended write will resume if the title is later unlocked.

## Sub-Section Granularity

A section can be subdivided into independently editable ranges. The body might have an intro, analysis, and conclusion -- each addressable and writable independently:

```ft
doc.body << {
  intro: "Background context...",
  analysis: "Key findings...",
  conclusion: "Recommendations..."
}
```

Writing to `doc.body.analysis` does not affect `doc.body.intro` or `doc.body.conclusion`. Each sub-section is an independently addressable path.

## Edit Locks and Concurrent Writers

When multiple writers access the same section, an edit lock provides exclusive write permission. A lock has a scope (which section) and a holder (which writer):

```ft
EditLock = {
  section: string,
  holder: string
}
```

Writes conditional on holding the lock are applied only while the lock is held. When the lock transfers to a new writer, the previous holder's lock-conditional edits are invalidated:

```ft
editLock = EditLock
editLock << { section: "body", holder: "writerA" }
```

Writer A writes an edit conditional on holding the lock. When Writer B takes the lock (`editLock << { holder: "writerB" }`), Writer A's lock-conditional edit is removed from the projection. Writer B can then write successfully.

Lock transfer is atomic: the old holder's conditional writes are invalidated in the same operation that grants the new lock. There is never a moment where two writers hold the same lock.

## Size Budgets

A section can declare a maximum content length. Writes exceeding the budget are suspended:

```ft
doc.title << { budget: 200 }
```

A 250-character write to a section with a 200-character budget is suspended. The section content remains within budget. The suspended write surfaces as an obligation -- "content exceeds budget."

## Unlocking and Resumption

Editability is mutable. Unlocking a previously locked section causes suspended writes to that section to be re-evaluated and applied:

```ft
doc.title << { editable: true }
```

After unlocking, any write that was suspended because `title.editable = false` now resumes. The section content updates to reflect the previously pending write.

## Capabilities

Editability flags and edit locks are externally controlled -- the document author or system policy sets them:

```ft
cap Section.editable
cap Section.content
cap Section.budget
cap EditLock.holder
cap EditLock.section
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Locked/editable sections report correct status | `Section.editable = false` for title and signature, `true` for body |
| Write to locked section is suspended | Write gated on `editable = true`; suspended when false, content unchanged |
| Write to editable section succeeds | `doc.body << { content: "Revised draft..." }` applies immediately |
| Sub-sections are independently addressable | `doc.body.analysis` write does not affect `doc.body.intro` or `doc.body.conclusion` |
| Lock-conditional edit applied while lock held | Writer A's edit applies while `editLock.holder = "writerA"` |
| Lock transfer invalidates previous holder's edits | `editLock << { holder: "writerB" }` removes Writer A's conditional edits |
| Size budget enforcement | 250-char write to 200-char budget section is suspended |
| Unlocking resumes suspended writes | `doc.title << { editable: true }` causes pending write to apply |
