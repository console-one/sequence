# Socket Converter

A socket converter bridges UDP datagram communication into the system's typed state. UDP is connectionless, unreliable, and unordered -- datagrams may be lost, duplicated, or arrive out of sequence. The converter faithfully reflects these semantics: it translates each datagram independently, adds no reliability guarantees, and surfaces all conversion errors as typed values.

The converter is a thin boundary between two fundamentally different reliability models. The internal system operates on typed, consistent state. UDP provides none of those guarantees. The converter translates the data, not the semantics -- ordering, deduplication, and acknowledgment are application-level concerns.

## Network Address

A UDP endpoint is a host and port pair. Both local (for receiving) and remote (for sending) addresses must be configured explicitly:

```ft
NetAddress = {
  host: string,
  port: number.integer 1..65535
}
```

The converter binds to a local address to receive datagrams and sends to a remote address. Both are configurable -- nothing is hardcoded.

## Datagram Representation

An incoming datagram is decomposed into its payload, source address, and arrival timestamp. This is the raw material before content parsing:

```ft
Datagram = {
  payload: string,
  source: NetAddress,
  timestamp: number
}
```

The payload is the raw content of the datagram. The source address tells the system who sent it. The timestamp records when it arrived. Each datagram is a self-contained value -- there is no relationship to previous or future datagrams at this level.

## Serialization Format

The converter needs to know how to parse incoming payloads and serialize outgoing values. The format is declared in configuration, not inferred from content:

```ft
SerializationFormat = "json" | "text" | "binary"

SocketConfig = {
  localAddress: NetAddress,
  remoteAddress: NetAddress,
  format: SerializationFormat,
  maxPayloadSize: number.integer >= 0
}
```

Unlike HTTP, which carries its content type in headers, UDP datagrams have no self-describing format. The converter must be told what format to expect. This is a required configuration, not an optional convenience.

## Inbound Conversion

An incoming datagram is parsed according to the configured format and mounted as typed internal data. Each conversion is independent -- processing datagram B has no dependency on datagram A:

```ft
inbound = (datagram: Datagram) -> { data: string, source: NetAddress }

cap inbound
```

The converter does not buffer, reorder, or deduplicate. If datagrams arrive as B, A, C, the converter processes B, then A, then C -- each independently. There is no "waiting for A before processing B."

## Outbound Conversion

Internal values are serialized according to the configured format and sent as UDP datagrams to the configured remote address:

```ft
outbound = (data: string) -> { datagram: Datagram }

cap outbound
```

The converter serializes the internal value, wraps it in a datagram, and sends it. UDP provides no delivery confirmation -- the send completes without knowing whether the remote system received it.

## Size Enforcement

UDP datagrams have a practical size limit (~1400 bytes for unfragmented delivery). The converter enforces a configurable maximum payload size:

```ft
config = SocketConfig
config << { localAddress: { host: "0.0.0.0", port: 9000 }, remoteAddress: { host: "10.0.0.1", port: 5000 }, format: "json", maxPayloadSize: 1400 }
```

A datagram exceeding the configured size limit is rejected with a typed error -- not silently processed, not silently dropped. The raw payload is preserved in the error for inspection.

## Error Handling

Conversion errors (malformed payloads, unknown formats, size violations) produce typed errors with the raw content preserved. Nothing is silently dropped:

```ft
ConversionError = {
  kind: "parse_failure" | "size_violation" | "format_unknown",
  message: string,
  rawPayload: string
}
```

A datagram with payload `{malformed json` produces a `parse_failure` error with the raw string preserved. A 2000-byte datagram against a 1400-byte limit produces a `size_violation` error. The system always knows what went wrong and has the raw data to investigate.

## Statelessness

Each datagram is converted independently. The converter holds no state between conversions -- no session tracking, no sequence numbers, no conversation context:

```ft
-- Datagram A processed, produces value X
-- Datagram B arrives
-- B's processing does not reference X
-- Each inbound call is a fresh, independent conversion
```

This is not a limitation -- it is faithful to UDP's connectionless nature. Any stateful behavior (tracking message sequences, deduplication, acknowledgment) is built above the converter, never inside it.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Incoming datagram converted with source address | `inbound` returns `data` + `source: NetAddress` from `Datagram` |
| Outbound value serialized and sent | `outbound` produces a `Datagram` from internal data |
| Local port and remote address configurable | `SocketConfig` with `localAddress` and `remoteAddress` |
| No ordering assumption on arrival | `inbound` processes each datagram independently, no reordering |
| Payload parsed according to format | `SerializationFormat` in config determines parse/serialize |
| Oversized datagram rejected | `maxPayloadSize` in config, `size_violation` in `ConversionError` |
| Each datagram independent | Statelessness -- no state carried between `inbound` calls |
| Malformed payload produces typed error | `ConversionError` with `parse_failure` kind and `rawPayload` preserved |
