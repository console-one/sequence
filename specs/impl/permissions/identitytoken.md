# Identity Token

Every process in the system has an identity -- a structured value at a well-known path within its own scope. Identity is not hidden metadata; it is ordinary data, readable and inspectable through the same mechanisms as everything else. Operations can be gated on identity using the same condition mechanism used for all other preconditions. No separate permission API, no ACL subsystem.

The design choice is that identity-gated operations suspend (not error) when the condition is unmet. If the identity later changes to match -- a role promotion, for instance -- the suspended operation automatically resumes. This gives the system the property that pending work flows forward as permissions are granted, without manual retry.

## The Identity Type

An identity has a required identifier and role, with an optional organization field. The schema is enforced -- writing a non-conforming identity is rejected:

```ft
Identity = {
  id: string,
  role: "admin" | "analyst" | "reader" | "agent",
  org: string
}
```

Identity lives at a well-known path within each process's scope. It is readable via ordinary data read, writable via ordinary data write (with schema validation).

## Writing and Reading Identity

A process's identity is set by writing to the identity path. Schema violations are suspended:

```ft
identity = Identity
identity << { id: "agent-7a3f", role: "analyst", org: "research" }
```

Reading the identity path returns the full structured value. No special API call needed -- it is the same `read` operation used for any other path.

Attempting to write a non-conforming value (e.g., a numeric `id` when the schema requires `string`) results in suspension with a schema violation reason.

## Gating Operations on Identity

Operations can declare identity preconditions using `when`. The condition references the identity path and uses the same condition syntax as any other precondition:

```ft
adminAction = "execute" when identity.role = "admin"
analystView = "granted" when identity.role = "analyst"
```

When the identity matches, the operation proceeds. When it does not, the operation suspends. This is not a hard error -- it is a gap that resolves when the identity changes.

## Composing Identity with Other Conditions

Identity conditions compose with non-identity conditions using the same mechanism. No special syntax for combining them:

```ft
approvedAdminAction = "execute" when identity.role = "admin"
approvalGate = "ready" when approval.status = "approved"
```

Both conditions must hold for their respective values to be active. The system does not distinguish identity conditions from any other kind of condition -- they are all predicates on data paths.

## Suspension and Resume on Identity Change

When an operation is suspended because the identity does not match, it remains suspended until the identity changes to satisfy the condition:

```ft
-- Process starts as analyst
identity << { id: "agent-7a3f", role: "analyst", org: "research" }

-- Admin-gated operation suspends
restrictedOp = "execute" when identity.role = "admin"
-- restrictedOp is suspended (role is "analyst", not "admin")

-- Identity is promoted
identity << { id: "agent-7a3f", role: "admin", org: "research" }
-- restrictedOp resumes: identity.role is now "admin"
```

The promotion automatically unblocks the suspended operation. No manual retry, no event listener -- the `when` condition re-evaluates when its referenced path changes.

## Per-Partition Identity

Each forked execution partition has its own independent identity scope. A child process does not automatically inherit the parent's identity:

```ft
partition1.identity = Identity
partition1.identity << { id: "agent-A", role: "admin", org: "ops" }

partition2.identity = Identity
partition2.identity << { id: "agent-B", role: "analyst", org: "research" }
```

An admin-gated operation in `partition1` succeeds. The same operation in `partition2` suspends. The identities are independent -- changing one does not affect the other.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Conforming identity writable and readable at well-known path | `identity << { id, role, org }` succeeds; readable via standard read |
| Non-conforming identity rejected/suspended | Schema enforcement on `Identity` type |
| Operation gated on matching role succeeds | `when identity.role = "analyst"` with analyst identity |
| Operation gated on non-matching role suspends | `when identity.role = "admin"` with analyst identity |
| Suspended operation resumes on identity change | `identity << { role: "admin" }` unblocks suspended op |
| Forked partitions have independent identities | `partition1.identity` and `partition2.identity` are separate |
| Identity readable via ordinary data read | Same `read` mechanism as any other path |
