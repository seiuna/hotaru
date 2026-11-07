---
name: verify-api
description: "Drive the @hotaru/api HTTP service the way a caller does — launch it on an isolated port, hit real routes with HTTP, capture evidence, tear down. Use to prove a change to apps/api or packages/shared actually works end to end, not just that it compiles."
---

# Verify @hotaru/api

`apps/api` is a Node HTTP service (`node:http`, no framework) that imports shared helpers from
`packages/shared`. The user-facing surface is the HTTP API on `$PORT` (default `3000`). There is no
database, no auth, and no seed data: an empty checkout is enough to run it.

Use this skill when a change touches request handling in `apps/api/src/index.ts`, the payload
helpers in `packages/shared/src/index.ts`, or the port/shutdown wiring. Passing `pnpm typecheck`
proves nothing about behavior; drive the HTTP surface instead.

All commands are PowerShell from the repo root (the directory containing `pnpm-workspace.yaml`; the
snippets use `$PWD`). Windows PowerShell
5.1 is what is installed here (`powershell.exe`; `pwsh` 7 is not on PATH), so the snippets below avoid
PowerShell 7-only syntax and pass `-UseBasicParsing` to web cmdlets.

## Launch

One isolated instance, one port, one evidence folder. Copy this block as-is; change `3100` to a free
port when needed. It builds first, so a broken build fails here instead of producing a confusing
runtime error.

```powershell
# 1. build once (fails loudly on a broken base)
pnpm --filter @hotaru/api build

# 2. start on an isolated port, capturing logs into a fresh evidence folder
$port  = 3100
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dir   = Join-Path $PWD ".verify\evidence\$stamp"
New-Item -ItemType Directory -Force -Path $dir, (Join-Path $PWD '.verify\run') | Out-Null
$env:PORT = "$port"
$proc = Start-Process node -ArgumentList 'apps/api/dist/index.js' -WorkingDirectory $PWD -PassThru `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir "server-$port.out.log") `
  -RedirectStandardError  (Join-Path $dir "server-$port.err.log")
@{ pid = $proc.Id; port = $port; evidenceDir = $dir } | ConvertTo-Json |
  Set-Content -Path (Join-Path $PWD ".verify\run\server-$port.pid") -Encoding utf8

# 3. wait until USABLE: the health payload, not merely an open port
$deadline = (Get-Date).AddSeconds(20)
$h = $null
while ((Get-Date) -lt $deadline) {
  try { $h = Invoke-RestMethod "http://localhost:$port/health" -UseBasicParsing -TimeoutSec 2 } catch { $h = $null }
  if ($h.status -eq 'ok') { break }
  Start-Sleep -Milliseconds 300
}
if ($h.status -ne 'ok') {
  Get-Content (Join-Path $dir "server-$port.err.log") -ErrorAction SilentlyContinue
  throw "instance on port $port never became ready"
}
Write-Host "ready: http://localhost:$port (pid $($proc.Id)) evidence: $dir"
```

**Ready means usable.** The service has no migrations and no seed step — startup is just `listen()` —
so the only readiness signal is a `GET /health` that returns `status: ok`. An open port is not
enough: a process can accept connections before the handler runs.

The port is the only shared resource, so `3100` and `3101` can be driven at the same time; keep that
convention rather than reusing a developer's default `3000`. To add several drives to one proof, pass
the same `$dir` instead of making a new one per block.

Teardown is [Cleanup](#cleanup). Do not leave an instance running between tasks.

## Doctor

Read-only answer to "is this instance worth driving?". Run it first whenever a drive looks wrong
(the instance died, someone else took the port, the payload shape changed):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .agents\skills\verify-api\scripts\doctor.ps1 -Port 3100
```

Checks, in order: PID file exists → recorded PID is running and is `node` → the listener on the port
is owned by **that** PID → `/health` returns `status: ok`, `service: hotaru-api`, a parseable
`timestamp`, and `uptimeSeconds` that does not decrease across two calls one second apart. Exit `0`
with a one-line summary, or exit `1` with each problem listed. It starts nothing and stops nothing.

If it reports a stale PID file, the instance is gone: relaunch instead of reusing the port blindly.

## Drive

Plain HTTP. Prefer these exact handles — the `path` echo and the health keys are the contract the
feature map asserts:

```powershell
# 1. health check
$h = Invoke-RestMethod "http://localhost:3100/health" -UseBasicParsing
#    -> { status: 'ok', service: 'hotaru-api', uptimeSeconds: <int>, timestamp: <ISO> }

# 2. default/catch-all route echoes the request path
$r = Invoke-RestMethod "http://localhost:3100/hello" -UseBasicParsing
#    -> { message: 'Hello from hotaru-api', path: '/hello' }

# 3. status code + headers, when the proof needs them
$resp = Invoke-WebRequest "http://localhost:3100/health" -UseBasicParsing
$resp.StatusCode              # 200
$resp.Headers['Content-Type'] # application/json; charset=utf-8
```

Both routes answer any method and any path (`/` included) because the handler branches only on
`url.pathname`. Unknown paths are **not** 404s — that is current behavior, and the feature map
records it as such. `Invoke-RestMethod` throws on a non-JSON body, so a body that stops being JSON
surfaces as an exception rather than a silent pass; catch it and report the status code when the
change under test might alter the content type.

`pnpm dev` (`tsx watch`) is fine for interactive poking, but for proof launch directly as above so the
instance has a PID file, an isolated port, and captured logs.

## Evidence

Write proof artifacts under `.verify/evidence/<yyyyMMdd-HHmmss>/`. The launch block already puts the
server logs there as `server-<port>.out.log` / `.err.log`; the drive writes its own files beside them:

```powershell
$dir = (Get-Content .verify\run\server-3100.pid -Raw | ConvertFrom-Json).evidenceDir
Invoke-WebRequest "http://localhost:3100/health" -UseBasicParsing |
  Select-Object StatusCode, @{n='Body';e={$_.Content}} |
  ConvertTo-Json -Depth 4 | Set-Content (Join-Path $dir 'health.json') -Encoding utf8
```

A proof is not a snapshot of a happy path. Standards for this repo:

- Exercise the real user path: a real HTTP request to a real listening port. Never call
  `healthPayload()` directly from Node and call it verified — that skips routing, serialization,
  status codes, and the listener.
- Capture the **request and the resulting state**, not just the last response: the URL called, the
  status, and the body for every step in the journey.
- Verify side effects you claim. If a change is supposed to write something (a log line, a file), show
  it — `/health`'s `uptimeSeconds` growth and the `[hotaru-api] listening on …` stdout line are
  the two observable side effects this service has today.
- A journey from the feature map that cannot pass reports a failure with the reason. Never soften the
  assertion to make it pass; record the reason in that feature's **Gotchas**.

`.verify/` is git-ignored; JSON bodies plus logs are the durable evidence — no screenshots needed.

## Cleanup

Stop only what this skill started, by PID — never `Stop-Process -Name node`, which would kill the
agent's own host and other instances:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .agents\skills\verify-api\scripts\stop.ps1 -Port 3100
```

It stops the recorded PID, waits for the port to free, and deletes the PID file. Run it after every
attempt, including failed ones, so no instance or port is left stranded.

Cleanup removes processes and `.verify\run\` — it never removes `.verify\evidence\`. After teardown,
confirm the proof files still exist at the path `stop.ps1` prints.

## Helpers

Two scripts ship with this skill; both are stable on Windows PowerShell 5.1 and PowerShell 7.

| Script | Purpose | Invocation |
| --- | --- | --- |
| `scripts/doctor.ps1` | Read-only readiness/ownership probe | `powershell -NoProfile -ExecutionPolicy Bypass -File .agents\skills\verify-api\scripts\doctor.ps1 -Port 3100` |
| `scripts/stop.ps1` | Stop the recorded PID, free the port, keep evidence | `powershell -NoProfile -ExecutionPolicy Bypass -File .agents\skills\verify-api\scripts\stop.ps1 -Port 3100` |

Both accept `-Root` (defaults to the repo root four levels above `scripts/`) and default to
`-Port 3100`.

Launch deliberately ships no script: it is the copy-paste block above. Keep it that way unless a
launcher script survives a write/read cycle in this repo — a helper that vanishes silently is worse
than five inline commands.

## Feature map

`.agents/skills/verify-api/features/` indexes every user-facing feature with how to drive it and what
observable end state proves it works. A proof that drives one convenient route is incomplete when the
map lists others — see [features/README.md](features/README.md).
