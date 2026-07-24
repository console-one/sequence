# Signatures

When a process produces output, it needs to stamp that output with its identity so downstream consumers can verify who produced it. Signatures are not cryptographic certificates or a separate PKI -- they are ordinary data values co-located with the signed output at a predictable path. Verification uses the same condition mechanism as every other precondition in the system.

The design makes provenance a first-class property of data without introducing any special-case infrastructure. A signature is just a value. Checking a signature is just a condition. Multi-party approval is just multiple conditions. The trust boundary is the runtime itself -- within a single desktop app process, identity-derived signatures are sufficient. Cross-runtime trust would require upgrading to cryptographic backing, but the verification mechanism stays the same.

## The Signature Type

A signature is a value derived from the signer's identity, stored at a conventional path relative to the signed data:

```ft
Signature = {
  signer: string,
  identity: string
}
```

The `signer` field holds an identifier traceable to the producing process's identity. The `identity` field records the full identity reference for provenance tracing.

## Attaching a Signature

When a process produces output, it writes the output and co-locates a signature value. The signature path follows a convention -- `_sig` relative to the data path:

```ft
results.r1 = "analysis complete"
results.r1._sig = Signature
results.r1._sig << { signer: "agent-7a3f", identity: "agent-7a3f" }
```

The signature is ordinary data. It is readable via the same read mechanism as any other value. No special storage, no separate retrieval API.

## Verifying a Signature

A consuming process gates its operations on the presence and value of a signature. This uses the same `when` condition syntax as identity checks and all other preconditions:

```ft
-- Accept only if signed by agent-7a3f
consumeResult = ref(results.r1) when results.r1._sig.signer = "agent-7a3f"
```

When the signature matches, the operation proceeds. When it does not match (wrong signer, or a different identity signed it), the operation suspends:

```ft
-- Signed by unknown-identity, consumer expects agent-7a3f
results.r1._sig << { signer: "unknown-identity", identity: "unknown-identity" }
consumeResult = ref(results.r1) when results.r1._sig.signer = "agent-7a3f"
-- consumeResult is suspended (signer mismatch)
```

## Existence Check

Sometimes the question is not "who signed this?" but "was this signed at all?" A condition on signature existence provides a minimum provenance check:

```ft
-- Accept any signed output, reject unsigned
trustedResult = ref(results.r1) when results.r1._sig EXISTS
```

Unsigned output (no `_sig` path at all) causes the operation to suspend. Any valid signature -- regardless of signer -- allows it to proceed.

## Multi-Party Signatures

Multiple signatures from different producers can be required on the same data. Each signer writes to a distinct sub-path under `_sig`, and the consumer conditions on all of them:

```ft
results.r1._sig.engineering = Signature
results.r1._sig.engineering << { signer: "agent-A", identity: "agent-A" }

results.r1._sig.legal = Signature
results.r1._sig.legal << { signer: "agent-B", identity: "agent-B" }
```

```ft
-- Require both engineering and legal sign-off
publishResult = ref(results.r1) when results.r1._sig.engineering EXISTS
approvalGate = "approved" when results.r1._sig.legal EXISTS
```

If only engineering has signed, the legal condition suspends. When legal also signs, both conditions are met and the gated operations proceed. This gives multi-party approval workflows without any special approval subsystem -- just multiple conditions on multiple signature paths.

## Signatures and Identity Composition

Signature conditions compose with identity conditions and any other preconditions. No special syntax for combining them:

```ft
-- Only admin can consume, and only if signed by agent-7a3f
adminConsume = ref(results.r1) when identity.role = "admin"
sigCheck = "verified" when results.r1._sig.signer = "agent-7a3f"
```

Both conditions must hold. The system treats signature verification identically to any other data condition.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Producer attaches identity-derived signature at predictable path | `results.r1._sig << { signer: "agent-7a3f" }` |
| Consumer gates on matching signature -- succeeds | `when results.r1._sig.signer = "agent-7a3f"` with matching sig |
| Consumer gates on mismatched signature -- suspends | `when results.r1._sig.signer = "agent-7a3f"` with wrong sig |
| Existence check suspends for unsigned output | `when results.r1._sig EXISTS` with no `_sig` path |
| Existence check succeeds for signed output | `when results.r1._sig EXISTS` with any valid signature |
| Multi-party: suspends until all signatures present | Conditions on `_sig.engineering` and `_sig.legal`; resumes when both exist |
