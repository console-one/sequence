# Form Specifications as Typed Objects with Gaps

## Original Notes

A form is a typed object where required fields without values are gaps. Between creation and submission, a form exists in an incomplete state -- the system must make this incompleteness explicit and queryable, not just "empty fields." Per-field validation happens at entry time, not just on submit. Defaults for optional fields are tracked separately from user-provided values so the system always knows whether a value was explicitly chosen or fell through to a default.

There is no hidden state. The gap list IS the form's completeness status. Fill a field, and the gap disappears. Fill all required fields with valid values, and the form is ready.

## Problem Context

- **Actor(s)**: Users (filling fields), automated processes (pre-populating or validating), the system (tracking completeness and enforcing constraints).
- **Domain**: Structured data entry where incomplete state must be explicit, per-field validation is continuous, and the distinction between user-provided and default values must be preserved.
- **Core Tension**: Incompleteness must be a queryable, first-class status (not just "empty fields"), validation must happen incrementally at entry time (not only on submit), and default values must be distinguishable from explicit user input.

## Requirements

**R1**: A form schema SHALL declare fields with typed constraints (e.g., length bounds, regex patterns, numeric ranges) and required/optional designation.
- *Rationale*: Structural constraints prevent invalid data from entering the system.
- *Verifiable by*: A form schema with constrained required and optional fields is definable and inspectable.

**R2**: Each required field without a value SHALL be reported as incomplete, and the set of incomplete required fields SHALL be queryable at any time.
- *Rationale*: Explicit incompleteness tracking lets consumers (UI, agents) know exactly what remains to complete the form.
- *Verifiable by*: Before any fills, the incomplete count equals the number of required fields; after filling one, it decreases by one.

**R3**: Optional fields SHALL NOT appear as incomplete regardless of whether they have values.
- *Rationale*: Optional fields have no requirement to be filled; reporting them as incomplete would create false incompleteness.
- *Verifiable by*: An unfilled optional field does not appear in the incomplete fields list.

**R4**: Fields SHALL be fillable individually or in atomic batches; a batch fill SHALL either set all fields in the batch or none.
- *Rationale*: Atomic batch fill prevents partial updates that could leave the form in an inconsistent intermediate state.
- *Verifiable by*: A batch fill with one invalid field in the batch results in no fields being set.

**R5**: Validation SHALL check every field against its declared constraints and report all violations at once, not one at a time.
- *Rationale*: Reporting all violations together lets users fix everything in one pass instead of iterating.
- *Verifiable by*: Submitting a form with three invalid fields produces three violation reports in a single response.

**R6**: A form with all required fields filled with valid values SHALL report zero incomplete fields and be considered complete.
- *Rationale*: Completeness is the termination condition for form filling.
- *Verifiable by*: After filling all required fields validly, the incomplete fields list is empty.

**R7**: Optional fields SHALL support default values that apply when no user-provided value exists.
- *Rationale*: Defaults provide sensible initial state without requiring explicit user action.
- *Verifiable by*: An unfilled optional field with a declared default returns the default value.

**R8**: The system SHALL track provenance for each field value, distinguishing user-provided values from defaults.
- *Rationale*: Downstream logic may need to know whether a value was an explicit choice or a fallback.
- *Verifiable by*: After a user provides a value for one field and leaves another at its default, querying provenance correctly identifies which is which.

**R9**: Applying defaults SHALL NOT overwrite a user-provided value.
- *Rationale*: User intent takes precedence over defaults; defaults are fallbacks, not overrides.
- *Verifiable by*: After a user sets a field, applying defaults leaves that field unchanged.

## Acceptance Criteria

**AC1** [R1, R2]: Given a form with 3 required fields and 2 optional fields, when no fields are filled, then 3 incomplete fields are reported; when one required field is filled, then 2 remain incomplete.

**AC2** [R3]: Given a form with optional fields, when no optional fields are filled, then they do not appear in the incomplete fields list.

**AC3** [R4]: Given a batch fill of email and age, when both are valid, then both are set; when one is invalid, then neither is set.

**AC4** [R5]: Given a form with an empty name, invalid email, and below-minimum age, when validation runs, then three violations are reported in a single response.

**AC5** [R6]: Given a form where all required fields are filled with valid values, when querying completeness, then all fields are satisfied and the form is complete.

**AC6** [R7, R8, R9]: Given a form with defaults for theme, language, and notifications, when the user provides only theme, then theme shows as user-provided, language and notifications show as defaults, and the user's theme value is not overwritten by the default.

## Open Questions

- Should validation run eagerly on every individual field entry, or only when a fill operation is explicitly committed?
- How should conditional required-ness be expressed (e.g., "phone is required if email is not provided")?
