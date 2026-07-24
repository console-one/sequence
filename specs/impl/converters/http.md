# HTTP Converter

An HTTP converter translates between the request-response world of HTTP and the system's internal typed state. HTTP clients send requests with methods, paths, headers, and bodies; the converter mounts these as typed values. Internal processes produce results; the converter serializes them back as HTTP responses. The converter is stateless and thin -- a translator, not a framework.

The hard part is faithfulness in both directions: no HTTP semantics lost on inbound, no internal error details leaked on outbound.

## The Request Type

An HTTP request decomposes into five typed fields. The converter parses an incoming request and mounts each field independently. Content-type determines how the body is parsed:

```ft
HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"

HttpRequest = {
  method: HttpMethod,
  path: string,
  query: { key: string, value: string },
  headers: { key: string, value: string },
  body: string | null
}
```

The query and headers are key-value structures -- the converter preserves all of them, including duplicates and custom headers. The body is parsed according to the Content-Type header before mounting, but the raw type here is the structural shape.

## Content Negotiation

The converter uses Content-Type to decide how to parse request bodies and Accept to decide how to serialize response bodies. This is a format mapping, not a type transformation:

```ft
ContentType = "application/json" | "application/x-www-form-urlencoded" | "text/plain" | "application/octet-stream"

ContentNegotiation = {
  parseFormat: ContentType,
  serializeFormat: ContentType
}
```

A request with `Content-Type: application/json` has its body parsed as JSON. A request with `Content-Type: application/x-www-form-urlencoded` has its body parsed as key-value pairs. The converter selects the parser based on the declared content type -- it does not guess.

## The Response Type

An HTTP response is a status code, headers, and a serialized body. Internal results map to specific status codes -- success is 200, missing is 404, invalid input is 400, internal failure is 500:

```ft
HttpStatus = number.integer 100..599

HttpResponse = {
  status: HttpStatus,
  headers: { key: string, value: string },
  body: string | null
}
```

The converter constructs the response by mapping internal result states to HTTP status codes and serializing the body according to the negotiated format. Internal error details (stack traces, process IDs, internal type names) are never included in the response body.

## Error Mapping

Internal error conditions map to HTTP status codes. The mapping is explicit -- each internal error kind has a defined HTTP status. The error message exposed to the client is sanitized:

```ft
ErrorMapping = {
  notFound: number.integer,
  validationFailed: number.integer,
  unauthorized: number.integer,
  internalError: number.integer
}

errorMapping = ErrorMapping
errorMapping << { notFound: 404, validationFailed: 400, unauthorized: 401, internalError: 500 }
```

An internal "not found" error produces a 404 response with a safe message. An internal "validation failed" error produces a 400. Stack traces and implementation details are stripped -- the client sees a meaningful HTTP error, not a raw dump.

## Inbound Conversion

An incoming HTTP request is converted to internal state by mounting it as a typed value. The converter writes to an internal reference so downstream processes can read the structured request:

```ft
inbound = (request: HttpRequest) -> { data: HttpRequest }

tool inbound
```

Each conversion is independent -- processing request B has no dependency on request A. The converter holds no mutable state between requests. This is the fundamental statelessness guarantee.

## Outbound Conversion

Internal results are converted back to HTTP responses. The converter reads the internal result, maps the status, serializes the body, and produces a well-formed response:

```ft
outbound = (result: { data: string | null, error: string | null }) -> { response: HttpResponse }

tool outbound
```

## Reference Binding

The converter supports bidirectional reference binding. An HTTP request can write to an internal reference, and an internal process can write a result to another reference that the converter reads back as the HTTP response:

```ft
RefBinding = {
  inputRef: string,
  outputRef: string
}

binding = RefBinding
binding << { inputRef: "input.data", outputRef: "output.result" }
```

The inbound converter writes the parsed request to `inputRef`. An internal process reads from `inputRef`, computes a result, and writes to `outputRef`. The outbound converter reads from `outputRef` and serializes the HTTP response. The converter is the bridge -- it does not participate in the computation.

## What This Validates

| AC | Expressed by |
|----|-------------|
| HTTP request fully decomposed | `HttpRequest` type preserves method, path, query, headers, body |
| Response with correct status and body | `HttpResponse` with `HttpStatus` and serialized body via `outbound` |
| Content-type negotiation | `ContentNegotiation` determines parse/serialize format |
| Stateless conversion | Each `inbound` call is independent, no shared mutable state |
| Internal errors mapped to HTTP codes | `ErrorMapping` with explicit status per error kind |
| Bidirectional reference binding | `RefBinding` with `inputRef` and `outputRef` connecting request to response |
