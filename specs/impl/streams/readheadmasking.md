# Read-Head Masking

Data owners classify the sensitivity of their data. Readers have varying access levels. The system enforces visibility constraints at read time -- filtering what a reader can see based on identity and the data's classification. Masking is a projection, not a transformation: the underlying data is stored regardless of visibility. Different readers see different projections of the same state.

There is no separate ACL system. Visibility constraints are metadata on schemas. There is no "access denied" response -- masked data returns nothing, indistinguishable from a non-existent path.

## Visibility-Constrained Data

A visibility constraint attaches to a schema and references the reader's identity. The data exists for authorized readers and is invisible to everyone else:

```ft
Config = {
  appName: string,
  apiKey: string
}

config = Config
config << { appName: "MyApp" }
config << { apiKey: "sk-secret-123" }
config.apiKey = "sk-secret-123" when reader.role = "admin"
```

The `when` condition on `apiKey` means the value is only visible to readers whose role is `"admin"`. For any other reader, reading `config.apiKey` returns nothing -- as if the path does not exist.

`config.appName` has no visibility constraint. It is visible to all readers.

## Key Enumeration Respects Masking

Listing children of a path excludes keys whose values are masked for the current reader. A non-admin listing keys under `config` does not see `apiKey`:

```ft
-- Admin listing keys at config: ["appName", "apiKey"]
-- Analyst listing keys at config: ["appName"]
```

The key itself is masked, not just the value. An unauthorized reader cannot discover that `apiKey` exists.

## Hierarchy Inheritance

A visibility constraint on a parent path applies to all descendants. Classifying an entire subtree as sensitive does not require annotating every child:

```ft
DeptFinance = {
  budget: number,
  headcount: number
}

dept.finance = DeptFinance
dept.finance << { budget: 5000000, headcount: 42 }
dept.finance = ref(dept.finance) when reader.role = "manager"
```

The `when` condition on `dept.finance` masks the entire subtree. A non-manager reading `dept.finance.budget` gets nothing -- the parent's constraint propagates to all children.

Behavioral note: when a child has a LESS restrictive constraint than its parent, the question of whether the child overrides or the parent wins is a policy decision. The ft blocks above express the parent-level constraint; override semantics are an interpreter concern.

## Reader Identity

The reader's identity is provided at read time as part of the execution context. It is not a stored value -- it is the ambient identity of the process performing the read:

```ft
reader = {
  id: string,
  role: "admin" | "manager" | "analyst" | "reader"
}
```

Visibility constraints reference fields on `reader` using the same condition format as all other preconditions in the system. There is no separate ACL language.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Admin sees apiKey, non-admin gets nothing | `config.apiKey = "sk-secret-123" when reader.role = "admin"` |
| Masked path indistinguishable from non-existent | `when` condition fails, value is absent entirely |
| Key enumeration excludes masked keys | Non-admin listing `config` sees only `["appName"]` |
| Admin key enumeration includes all keys | Admin listing `config` sees `["appName", "apiKey"]` |
| Hierarchy inheritance masks descendants | `dept.finance = ... when reader.role = "manager"` covers `budget` and `headcount` |
| Same condition format as other preconditions | `when reader.role = "admin"` uses standard `when` syntax |
