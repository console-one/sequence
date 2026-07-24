# Write-Head Masking

Write control gates who can modify which paths based on the writer's identity. Unlike read masking (which hides data), write masking prevents unauthorized state changes. The critical difference from traditional access control: an unauthorized write suspends rather than being rejected. The write remains as a pending intention that activates if the writer's identity later satisfies the condition. This preserves intent and enables automatic resumption on role change.

There is no separate permission-grant API. Write permissions are conditions on operations, using the same mechanism as all other preconditions.

## Identity-Gated Writes

A write can declare a condition on the writer's identity. It applies only when the condition holds, and suspends otherwise:

```ft
writer = {
  id: string,
  role: "admin" | "engineer" | "reader"
}

config.secret = "new-value" when writer.role = "admin"
```

If the current writer's role is `"reader"`, this write suspends. The value is not written, but the intention is preserved. When the identity changes to role `"admin"`, the write automatically resumes and `config.secret` becomes `"new-value"`.

No resubmission is needed. The suspended write waits for its condition.

## Compound Constraints

Identity conditions compose with business-rule conditions. Both must hold for the write to apply:

```ft
approval = { status: "pending" }
```

The write itself gates on both the identity condition and the business rule:

```ft
content.published = "article body" when approval.status = "approved"
```

The identity gate (`writer.role = "admin"`) is a second precondition that must also hold. Compound conjunction of multiple `when` conditions (identity AND business rule both required) is expressed as prose: the write suspends unless ALL conditions are satisfied simultaneously.

This write requires BOTH admin role AND approval status. If the writer is admin but approval is pending, the write suspends. When approval changes to `"approved"`, the write resumes -- but only if the writer still has the admin role. If either condition breaks, the write re-suspends.

## Capability Registration

Registering an implementation for a function type follows the same pattern. A capability registration is a write, so it is subject to identity-based gating:

```ft
tool config.secret when writer.role = "engineer"
```

If the identity is not `"engineer"`, the capability registration suspends. When the identity changes to `"engineer"`, the capability becomes available. This is not a separate authorization mechanism -- it is the same `when` condition used everywhere.

## Revocable Permissions

A write can have a lifetime condition. When the condition breaks, the write is automatically invalidated and its value disappears:

```ft
config.secret = "granted-value" while permissions.canWrite EXISTS
```

While `permissions.canWrite` exists, the value is in effect. When `permissions.canWrite` is removed, the `while` condition breaks and `config.secret` disappears from observable state. This is automatic revocation -- no manual cleanup, no stale authorizations.

The `while` condition is continuously evaluated. A permission that is granted and then revoked cleanly unwinds the writes it authorized.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Unauthorized write suspends (not rejected) | `config.secret = "new-value" when writer.role = "admin"` suspends for non-admin |
| Suspended write resumes on identity change | Identity changes to admin, `when` condition satisfied, write applies |
| Compound constraints require all conditions | `when writer.role = "admin"` AND `when approval.status = "approved"` |
| Capability registration follows same gating | `cap config.secret when writer.role = "engineer"` |
| Revocable permission invalidates write on break | `config.secret = ... while permissions.canWrite EXISTS` |
