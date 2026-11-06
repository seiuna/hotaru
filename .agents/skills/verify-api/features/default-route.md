# Default route

Every path that is not `/health` was answered by the catch-all branch in `apps/api/src/index.ts`,
which returns the service name plus the path that was requested. It is what a caller sees when they
hit the root URL or a mistyped route.

## Sub-features

- `route-root` answers `GET /` with the echo payload.
- `route-any-path` echoes any path segment set, e.g. `/hello`, `/api/v1/users`, `/a/b/c`.
- `route-echo-path` returns `path` exactly as requested, including leading slash and case.
- `route-any-method` answers non-GET methods from the same branch (the handler does not branch on
  method).
- `route-query-stripped` uses `url.pathname`, so `?query=1` is not part of the echoed `path`.

## How to get to it (user POV)

- Open `http://localhost:3000/` in a browser, or call any unfamiliar path on the service.

## Driving it with HTTP (pwsh)

Preconditions:

- An instance launched per [../SKILL.md](../SKILL.md) reports ready on port `3100`.

- **Root path.** Request the root. Run `Invoke-RestMethod -Uri "http://localhost:3100/"`. The
  response `message` equals `Hello from skymatrix-api` and `path` equals `/`.
- **Arbitrary path.** Request a nested path. Run
  `Invoke-RestMethod -Uri "http://localhost:3100/api/v1/users"`. `path` equals `/api/v1/users`.
- **Echo fidelity.** Request a mixed-case path. Run
  `Invoke-RestMethod -Uri "http://localhost:3100/Hello-World"`. `path` equals `/Hello-World` with
  case preserved.
- **Query is not echoed.** Request with a query string. Run
  `Invoke-RestMethod -Uri "http://localhost:3100/hello?x=1&y=2"`. `path` equals `/hello` 鈥?the query
  is not part of it.
- **Non-GET method.** Send POST. Run
  `Invoke-WebRequest -Method Post -Uri "http://localhost:3100/anything" -Body '{"a":1}' -ContentType 'application/json'`.
  Status is `200` and the body carries the echo payload; the request body is not read.
- **Proof.** Capture one drive. Write the response to
  `"$evidenceDir/default-route.json"` as in [health-check](health-check.md), and keep
  `server-3100.out.log` beside it.

## Gotchas

- Unknown paths are **not** 404s. That is current behavior, not a bug this map can fix; if a change
  introduces a 404 for unknown paths, this journey fails and the failure is the finding.
- `POST`/`PUT`/`DELETE` bodies are never read, so a client that streams a large body still gets an
  immediate response. Do not assert on request-body handling here 鈥?there is none.
- `HEAD` requests get the headers with the body suppressed by Node itself, not by this handler.
- The echoed `path` comes from `new URL(req.url, ...)`, so a request target that is not a valid URL
  path makes `new URL` throw inside the handler; that surfaces as a crashed request, not a 400.
