# HTTP Converter

An HTTP converter translates between the request-response world of HTTP and the system's internal typed state. HTTP clients send requests with methods, paths, headers, and bodies; the converter mounts these as typed values. Internal processes produce results; the converter serializes them back as HTTP responses. The converter is stateless and thin -- a translator, not a framework.

The hard part is faithfulness in both directions: no HTTP semantics lost on inbound, no internal error details leaked on outbound.

## Problem Context

- **Actor(s)**: HTTP clients sending requests; internal processes producing results; the converter bridging the two.
- **Domain**: HTTP request/response translation -- decomposing inbound HTTP into typed internal data and serializing internal results back into well-formed HTTP responses.
- **Core Tension**: HTTP is a rich protocol (methods, headers, query strings, content negotiation, status codes). The converter must preserve all semantically relevant information on the way in while sanitizing internal details on the way out. It must be stateless (each request is independent) yet support bidirectional data flow (request in, response out).

## Requirements

**R1**: The converter SHALL fully decompose an incoming HTTP request into typed fields: method, path, query parameters, headers, and body.
- *Rationale*: Downstream processes need structured access to every part of the HTTP request. Losing query parameters or headers silently would break application logic.
- *Verifiable by*: An incoming request with method GET, path /api/users, query `?page=2`, header `Authorization: Bearer xyz`, and no body is decomposed into five distinct typed fields, all accessible.

**R2**: The HTTP method SHALL be constrained to the standard set: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS.
- *Rationale*: Non-standard methods should be rejected or explicitly handled, not silently passed through.
- *Verifiable by*: A request with method "FOOBAR" is rejected or flagged as non-standard.

**R3**: The converter SHALL use the request's Content-Type header to determine how to parse the body. Supported formats SHALL include at minimum: `application/json`, `application/x-www-form-urlencoded`, `text/plain`, and `application/octet-stream`.
- *Rationale*: JSON and form-encoded are the two dominant API body formats. The converter must not guess the format -- it must use the declared Content-Type.
- *Verifiable by*: A request with `Content-Type: application/json` and body `{"name":"Alice"}` is parsed as a JSON object. The same body with `Content-Type: text/plain` is treated as a raw string.

**R4**: The converter SHALL construct HTTP responses with a status code (100-599), headers, and a serialized body.
- *Rationale*: HTTP clients expect well-formed responses with appropriate status codes and content.
- *Verifiable by*: An internal success result produces a 200 response with the serialized result as the body.

**R5**: Internal error conditions SHALL map to specific HTTP status codes: not-found to 404, validation failure to 400, unauthorized to 401, internal error to 500.
- *Rationale*: HTTP status codes have well-defined semantics. Mapping internal errors to the correct codes enables clients to handle errors appropriately.
- *Verifiable by*: An internal "not found" condition produces a 404 response, not a 200 or 500.

**R6**: Internal implementation details (stack traces, process IDs, internal type names) SHALL NEVER appear in HTTP response bodies.
- *Rationale*: Leaking internal details is a security risk and provides no value to API consumers.
- *Verifiable by*: When an internal error occurs, the response body contains a safe, human-readable error message but no stack trace, internal path, or type name.

**R7**: The converter SHALL be stateless -- processing request B has no dependency on request A. No mutable state is retained between requests.
- *Rationale*: Statelessness is fundamental to HTTP's scalability model. A stateful converter would break horizontal scaling and introduce ordering dependencies.
- *Verifiable by*: Two requests processed in sequence produce the same results regardless of order. Processing request A does not affect the result of request B.

**R8**: The converter SHALL support bidirectional reference binding: an inbound request writes to a configurable internal location, and the outbound response reads from a configurable internal location.
- *Rationale*: The converter is a bridge, not a processor. Internal logic reads from the inbound location, computes a result, and writes to the outbound location. The converter's input and output paths must be configurable so different endpoints can route to different internal locations.
- *Verifiable by*: Configuring inbound to write to `input.data` and outbound to read from `output.result`, when a request arrives, internal logic reads from `input.data` and writes to `output.result`, and the response is constructed from `output.result`.

**R9**: The converter SHALL use the request's Accept header (or a default) to determine the serialization format of the response body.
- *Rationale*: Content negotiation is part of HTTP's protocol contract. The response format should match what the client can accept.
- *Verifiable by*: A request with `Accept: application/json` receives a JSON-serialized response body.

## Acceptance Criteria

**AC1** [R1]: Given an HTTP POST to `/api/users?page=2` with header `Authorization: Bearer xyz` and JSON body `{"name":"Alice"}`, when the converter processes it, then internal state contains `{method: "POST", path: "/api/users", query: {page: "2"}, headers: {Authorization: "Bearer xyz"}, body: {name: "Alice"}}`.

**AC2** [R3]: Given a request with `Content-Type: application/x-www-form-urlencoded` and body `name=Alice&age=30`, when the converter processes it, then the body is parsed as `{name: "Alice", age: "30"}`.

**AC3** [R5, R6]: Given an internal "not found" error, when the converter produces a response, then the status is 404 and the body contains a safe error message with no stack traces or internal identifiers.

**AC4** [R7]: Given request A writes "foo" to a path and request B reads from an unrelated path, when B is processed after A, then B's processing is unaffected by A's data.

**AC5** [R5]: Given an internal validation failure ("age must be >= 0"), when the converter produces a response, then the status is 400 and the body contains the validation error message.

**AC6** [R8]: Given binding config `{inputRef: "input.data", outputRef: "output.result"}`, when a request arrives and internal logic writes `{result: "ok"}` to `output.result`, then the response body contains `{result: "ok"}`.

## Open Questions

1. **Duplicate headers/query params**: HTTP allows duplicate header names (e.g., multiple `Set-Cookie` headers) and duplicate query parameter keys. How are these represented in the typed decomposition -- as arrays, or last-wins?
2. **Streaming bodies**: Large request/response bodies may need streaming rather than full buffering. Does the converter need to support chunked transfer, or is it always full-body?
3. **CORS and preflight**: Does the converter handle OPTIONS preflight requests for CORS, or is that the responsibility of a separate middleware layer?
