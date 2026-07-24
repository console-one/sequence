# Form Specifications as Typed Objects with Gaps

A form is a typed object where required fields without values are gaps. Between creation and submission, a form exists in an incomplete state -- the system must make this incompleteness explicit and queryable, not just "empty fields." Per-field validation happens at entry time, not just on submit. Defaults for optional fields are tracked separately from user-provided values so the system always knows whether a value was explicitly chosen or fell through to a default.

There is no hidden state. The gap list IS the form's completeness status. Fill a field, and the gap disappears. Fill all required fields with valid values, and the form is ready.

## The Form Schema

A form is a typed object where each property has a declared type with constraints. Required fields are obligations -- they must be filled before the form is complete:

```ft
RegistrationForm = {
  fullName: string 1..200,
  email: string /^[^@]+@[^@]+\.[^@]+$/,
  age: number.integer 13..120,
  bio?: string 0..500,
  phone?: string /^\+?[0-9\-\s]+$/
}
```

`fullName`, `email`, and `age` are required. `bio` and `phone` are optional (marked with `?`). Each field carries its own constraints -- length bounds, patterns, numeric ranges.

## Gaps as Obligations

Before any fields are filled, the form has 3 gaps -- one for each required field. Gaps are queryable: they report the path and expected type of each unfilled required field:

```ft
form = RegistrationForm
```

At this point, reading the form's obligations returns three gaps: `fullName` (string 1..200), `email` (string matching pattern), `age` (integer 13..120). Optional fields are never gaps -- they have no obligation to be filled.

## Incremental Fill

Fields are filled one at a time or in atomic batches. Each fill narrows the form's type -- the gap disappears for that field:

```ft
form << { fullName: "Alice Johnson" }
form << { email: "alice@example.com", age: 28 }
```

After the first narrow, 2 gaps remain (email, age). After the second narrow, 0 gaps remain. The form is complete.

Batch fill is atomic -- either all fields in the batch are set, or none are. This matters when validation is involved.

## Schema Validation

Validation checks every field against its declared constraints and reports all violations at once -- not one at a time:

```ft
FormViolation = {
  path: string,
  constraint: string,
  message: string
}
```

Submitting a form with an empty name, an invalid email, and an age below minimum produces 3 violations:
- `fullName`: length below minimum (1)
- `email`: pattern mismatch
- `age`: value below minimum (13)

A fully valid form produces zero violations.

## Defaults and Provenance

Optional fields support default values. Defaults apply when the user has not provided a value. The system tracks provenance -- whether each value is user-provided or default:

```ft
PreferencesForm = {
  theme: "light" | "dark",
  language: string,
  notifications: boolean
}
```

```ft
defaults = PreferencesForm
defaults << { theme: "light", language: "en", notifications: true }
```

When the user provides only `theme: "dark"`:

```ft
prefs = PreferencesForm
prefs << { theme: "dark" }
```

Reading the form shows: theme is "dark" (user-provided), language is "en" (default), notifications is true (default). Provenance is queryable -- the system can report which values are defaults vs. explicit choices.

Defaults are non-destructive: applying defaults never overwrites a user-provided value.

## Capabilities

Form fields are filled by external actors -- users or automated processes. Schema validation is system-provided:

```ft
tool RegistrationForm.fullName
tool RegistrationForm.email
tool RegistrationForm.age
tool PreferencesForm.theme
tool PreferencesForm.language
tool PreferencesForm.notifications
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Form schema with typed, constrained fields | `RegistrationForm` with string length, pattern, integer range constraints |
| Required fields without values are gaps | 3 gaps before fill; each fill removes one gap; 0 gaps when complete |
| Atomic batch fill | `form << { email: "...", age: 28 }` sets both fields in one operation |
| Validation reports all violations at once | `FormViolation` with path, constraint, and message for each violation |
| Valid form passes validation | Zero violations when all constraints are satisfied |
| Optional fields with defaults | `defaults << { theme: "light" }` applies when user provides no value |
| Provenance tracking (user vs. default) | System can report which values are user-provided vs. default |
