# Signatures

When a process produces output, it needs to stamp that output with its identity so downstream consumers can verify who produced it. Signatures are not cryptographic certificates or a separate PKI -- they are ordinary data values co-located with the signed output at a predictable path. Verification uses the same condition mechanism as every other precondition in the system.

The design makes provenance a first-class property of data without introducing any special-case infrastructure. A signature is just a value. Checking a signature is just a condition. Multi-party approval is just multiple conditions. The trust boundary is the runtime itself -- within a single desktop app process, identity-derived signatures are sufficient. Cross-runtime trust would require upgrading to cryptographic backing, but the verification mechanism stays the same.

## Problem Context

- **Actor(s)**: Producing processes that stamp outputs, consuming processes that verify provenance, and multi-party approval workflows requiring sign-off from multiple producers.
- **Domain**: Data provenance and origin verification in a multi-agent system.
- **Core Tension**: Downstream consumers need to verify who produced a piece of data, but the verification mechanism must not require a separate PKI or ACL infrastructure -- it should use the same mechanisms as all other data conditions.

## Requirements

**R1**: A producing process SHALL be able to attach a signature to its output as an ordinary data value at a predictable, conventional path relative to the output.
- *Rationale*: Co-location at a predictable path enables uniform verification without special lookup.
- *Verifiable by*: After a process writes output at path P, a signature value exists at the conventional signature sub-path of P.

**R2**: A signature SHALL contain at minimum a signer identifier traceable to the producing process's identity.
- *Rationale*: The minimum useful provenance is knowing who produced the data.
- *Verifiable by*: The signature value contains a signer field that matches the producing process's identity.

**R3**: Consuming processes SHALL be able to gate operations on signature values using the same condition mechanism used for all other preconditions.
- *Rationale*: No separate verification API; signature checks are just data conditions.
- *Verifiable by*: An operation conditioned on a specific signer proceeds when the signature matches and does not proceed otherwise.

**R4**: When a signature condition is not met (wrong signer or missing signature), the gated operation SHALL suspend, not error.
- *Rationale*: Consistent with identity gating -- suspension allows the operation to proceed if the signature is later corrected.
- *Verifiable by*: An operation gated on signer "A" suspends when the signature says signer "B".

**R5**: The system SHALL support existence checks on signatures -- verifying that output was signed at all, regardless of signer.
- *Rationale*: Sometimes the question is "was this signed?" not "who signed it?" -- a minimum provenance check.
- *Verifiable by*: An operation conditioned on signature existence suspends for unsigned output and proceeds for any signed output.

**R6**: The system SHALL support multi-party signatures, where multiple signers each attach their own signature at distinct sub-paths, and consumers can condition on the presence of all required signatures.
- *Rationale*: Approval workflows often require sign-off from multiple parties (e.g., engineering and legal).
- *Verifiable by*: An operation requiring both engineering and legal signatures suspends until both are present; once both exist, it proceeds.

**R7**: Signature conditions SHALL compose with identity conditions and any other preconditions using the same mechanism -- no special syntax.
- *Rationale*: Uniform composition keeps the system simple and predictable.
- *Verifiable by*: An operation gated on both the consumer's role and the producer's signature requires both conditions to hold.

## Acceptance Criteria

**AC1** [R1, R2]: Given a process with identity "agent-7a3f" produces output at `results.r1`, when the signature is attached, then a signature value exists at the conventional sub-path with signer "agent-7a3f".

**AC2** [R3]: Given a consumer operation gated on signer "agent-7a3f", when the signature matches, then the operation proceeds.

**AC3** [R3, R4]: Given a consumer operation gated on signer "agent-7a3f", when the actual signer is "unknown-identity", then the operation suspends.

**AC4** [R5]: Given a consumer operation gated on signature existence, when the output has no signature, then the operation suspends; when any valid signature is attached, then the operation proceeds.

**AC5** [R6]: Given an operation requiring signatures from both engineering and legal, when only engineering has signed, then the operation suspends; when legal also signs, then the operation proceeds.

**AC6** [R7]: Given an operation gated on both `consumer.role = "admin"` and `producer.signer = "agent-7a3f"`, when only one condition is met, then the operation remains suspended until both hold.

## FT System Demands

The trust boundary for signatures is the runtime process. Within a single runtime, identity-derived signatures are sufficient. Cross-runtime trust (e.g., between separate desktop app instances or cloud services) would require upgrading signatures to include cryptographic backing. The verification mechanism (condition on signature data) should remain the same regardless of whether the backing is identity-derived or cryptographic.

## Open Questions

(None -- signature-as-data, condition-based verification, and multi-party composition are fully resolved.)
