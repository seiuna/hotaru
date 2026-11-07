# Health check

`GET /health` tells a caller the process is up and reports how long it has been serving. It is the
contract every other tool uses to decide an instance is worth driving, and it is built from the
`healthPayload()` helper in `packages/shared/src/index.ts`.

## Sub-features

- `health-status` answers 200 with `status: "ok"`.
- `health-service` names the service as `hotaru-api` (composed in `apps/api/src/index.ts` as
  `` `${APP_NAME}-api` ``).
- `health-uptime` reports whole seconds since process start, so consecutive calls never decrease.
- `health-timestamp` reports an ISO 8601 UTC timestamp at call time.
- `health-content-type` answers `application/json; charset=utf-8` so JSON clients parse it without
  guessing.

## How to get to it (user POV)

- Call `GET http://localhost:3000/health` (or whatever `PORT` you launched) with curl, a browser, or
  any HTTP client. No headers and no auth are required.

## Driving it with HTTP (pwsh)

Preconditions:

- An instance launched per [../SKILL.md](../SKILL.md) reports ready on port `3100`.
- `doctor.ps1 -Port 3100` exits `0`.

- **Status and payload.** Request the endpoint. Run
  `Invoke-RestMethod -Uri "http://localhost:3100/health"`. The response has `status` equal to `ok`
  and `service` equal to `hotaru-api`.
- **Uptime grows.** Call twice two seconds apart. Run the call, `Start-Sleep -Seconds 2`, run it
  again. The second `uptimeSeconds` is `>=` the first, and both are non-negative integers.
- **Timestamp is current.** Compare the payload `timestamp` to `Get-Date`. The timestamp parses as a
  date and is within 60 seconds of now (UTC in the payload, converted for comparison).
- **Content type.** Request headers. Run
  `(Invoke-WebRequest -Uri "http://localhost:3100/health").Headers['Content-Type']`. It reads
  `application/json; charset=utf-8`.
- **Proof.** Capture the payload next to the server log. Run
  `$d = (Get-Content .verify/run/server-3100.pid -Raw | ConvertFrom-Json).evidenceDir` then
  `Invoke-RestMethod -Uri "http://localhost:3100/health" | ConvertTo-Json | Set-Content "$d/health.json"`.
  After `stop.ps1`, `health.json` and `server-3100.out.log` still exist and the log contains
  `[hotaru-api] listening on http://localhost:3100`.

## Gotchas

- `/health` is matched on `url.pathname === '/health'` exactly. `/health/` and `/healthz` fall
  through to the [default route](default-route.md) and return the echo payload, not a 404.
- Query strings are ignored by the health branch, so `?format=text` still answers JSON.
- `uptimeSeconds` is rounded, so two calls in the same second legitimately report the same value 鈥?  assert non-decreasing, never strictly increasing.
- The timestamp is generated per request from `new Date()`. A frozen or injected clock is a real
  change worth proving here, and would make the "within 60 seconds" assertion fail by design.
- `GET /health` is the readiness signal the launch block polls; if a change breaks this endpoint, every
  other journey fails at launch rather than at its own step.
