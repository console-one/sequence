# Socket Converter

A socket converter bridges UDP datagram communication into the system's typed state. UDP is connectionless, unreliable, and unordered -- datagrams may be lost, duplicated, or arrive out of sequence. The converter faithfully reflects these semantics: it translates each datagram independently, adds no reliability guarantees, and surfaces all conversion errors as typed values.

The converter is a thin boundary between two fundamentally different reliability models. The internal system operates on typed, consistent state. UDP provides none of those guarantees. The converter translates the data, not the semantics -- ordering, deduplication, and acknowledgment are application-level concerns.

## Problem Context

- **Actor(s)**: Remote UDP endpoints sending datagrams; internal processes producing outbound data; the converter translating between UDP's connectionless world and the system's typed state.
- **Domain**: UDP datagram translation -- parsing inbound datagrams into typed data and serializing outbound data into datagrams, with no reliability layer added by the converter itself.
- **Core Tension**: UDP provides no ordering, no delivery confirmation, no duplicate detection. The converter must faithfully reflect these non-guarantees (not paper over them) while still producing well-typed internal data from raw payloads. It must also enforce payload size limits and handle malformed data gracefully, since UDP provides no content validation.

## Requirements

**R1**: The converter SHALL decompose each incoming UDP datagram into typed fields: payload content, source address (host + port), and arrival timestamp.
- *Rationale*: Downstream processes need structured access to the datagram's data, origin, and timing. Losing the source address makes it impossible to respond.
- *Verifiable by*: An incoming datagram from 10.0.0.1:5000 with payload "hello" at time T is decomposed into `{payload: "hello", source: {host: "10.0.0.1", port: 5000}, timestamp: T}`.

**R2**: Both local bind address (for receiving) and remote target address (for sending) SHALL be explicitly configurable. Neither SHALL be hardcoded or defaulted.
- *Rationale*: Different deployments bind to different interfaces and send to different targets. Hardcoded addresses are unusable in production.
- *Verifiable by*: The converter can be configured with `localAddress: {host: "0.0.0.0", port: 9000}` and `remoteAddress: {host: "10.0.0.1", port: 5000}`, and both values take effect.

**R3**: The serialization format for parsing inbound payloads and serializing outbound data SHALL be explicitly declared in configuration. Supported formats SHALL include at minimum: JSON, plain text, and binary.
- *Rationale*: Unlike HTTP, UDP datagrams carry no content-type header. The format cannot be inferred from the payload -- it must be declared in advance.
- *Verifiable by*: Configuring format as "json" causes the converter to parse incoming payloads as JSON. Changing to "text" causes them to be treated as raw strings.

**R4**: Port numbers SHALL be constrained to valid values (1-65535). Invalid port numbers SHALL be rejected at configuration time.
- *Rationale*: Port 0 and ports above 65535 are invalid. Catching this at configuration time prevents runtime failures.
- *Verifiable by*: Configuring `port: 0` or `port: 70000` is rejected with a validation error.

**R5**: Each inbound datagram SHALL be converted independently. The converter SHALL NOT buffer, reorder, deduplicate, or maintain any state between conversions.
- *Rationale*: UDP is connectionless and unordered by design. The converter must reflect these semantics, not add a reliability layer. If datagrams arrive as B, A, C, they are processed in that order.
- *Verifiable by*: Processing datagram B, then A, then C produces three independent results in B, A, C order. No reordering occurs. Processing B does not affect A's result.

**R6**: Outbound conversion SHALL serialize internal data according to the configured format and send it as a UDP datagram to the configured remote address. No delivery confirmation is provided or expected.
- *Rationale*: UDP's fire-and-forget semantics mean the send completes without knowing whether the remote received it. The converter must not fake a delivery guarantee.
- *Verifiable by*: Sending a value completes immediately. No callback, promise, or confirmation indicates whether the remote received it.

**R7**: The converter SHALL enforce a configurable maximum payload size. Incoming datagrams exceeding this limit SHALL be rejected with a typed error (not silently dropped, not silently truncated).
- *Rationale*: UDP has a practical unfragmented payload limit (~1400 bytes). Oversized datagrams indicate misconfiguration or malformed data. Silent truncation would produce corrupted data.
- *Verifiable by*: With `maxPayloadSize: 1400`, a 2000-byte incoming datagram produces a size violation error with the raw payload preserved for inspection.

**R8**: Malformed payloads (e.g., invalid JSON when format is "json") SHALL produce a typed error containing the error kind, a human-readable message, and the raw payload preserved for inspection.
- *Rationale*: Silent drops lose data permanently. Preserving the raw payload enables debugging and potential reprocessing.
- *Verifiable by*: An incoming datagram with payload `{malformed json` when format is "json" produces a parse failure error with `rawPayload: "{malformed json"`.

**R9**: Conversion errors SHALL be categorized by kind: `parse_failure` (malformed payload), `size_violation` (exceeds max size), `format_unknown` (unsupported format).
- *Rationale*: Error categorization enables automated handling. A size violation might be retried with compression; a parse failure might trigger an alert.
- *Verifiable by*: Each error type produces the correct kind value.

## Acceptance Criteria

**AC1** [R1]: Given a datagram from 10.0.0.1:5000 with payload `{"temp": 22.5}` and format "json", when the converter processes it, then the result is `{data: {temp: 22.5}, source: {host: "10.0.0.1", port: 5000}}`.

**AC2** [R2]: Given config `{localAddress: {host: "0.0.0.0", port: 9000}, remoteAddress: {host: "10.0.0.1", port: 5000}}`, when the converter binds, then it receives on 0.0.0.0:9000 and sends to 10.0.0.1:5000.

**AC3** [R4]: Given config with `port: 0`, when the converter is configured, then a validation error is produced.

**AC4** [R5]: Given datagrams B, A, C arriving in that order, when the converter processes them, then three independent results are produced in order B, A, C, with no reordering or cross-datagram state.

**AC5** [R7]: Given `maxPayloadSize: 1400` and a 2000-byte incoming datagram, when the converter processes it, then a `size_violation` error is produced with the raw payload preserved.

**AC6** [R8]: Given format "json" and incoming payload `{malformed`, when the converter processes it, then a `parse_failure` error is produced with `rawPayload: "{malformed"`.

**AC7** [R6]: Given an outbound value, when the converter sends it, then the send operation completes without a delivery confirmation.

**AC8** [R5]: Given datagram A produces result X, when datagram B arrives, then B's processing does not reference or depend on X.

## Open Questions

1. **Multicast support**: Should the converter support UDP multicast (sending to/receiving from multicast groups), or is it strictly unicast?
2. **Outbound size enforcement**: Should the configured `maxPayloadSize` also apply to outbound datagrams, or only inbound? Sending an oversized datagram may cause IP fragmentation.
3. **Binary format details**: When the format is "binary", what is the internal representation? A byte buffer, a base64-encoded string, or something else?
4. **Multiple local bindings**: Can a single converter instance bind to multiple local addresses/ports, or does each binding require a separate converter instance?
