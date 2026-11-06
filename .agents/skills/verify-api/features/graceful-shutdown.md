# Graceful shutdown

On `SIGINT` or `SIGTERM` the service logs `[skymatrix-api] <signal> received, shutting down`, calls
`server.close()`, and exits with code `0` once the callback fires. This is the promise that a
deploy-time restart does not cut an in-flight request in half.

## Sub-features

- `shutdown-sigint` handles Ctrl+C (`SIGINT`).
- `shutdown-sigterm` handles `SIGTERM` from a supervisor or container runtime.
- `shutdown-log` logs which signal arrived before closing.
- `shutdown-clean-exit` exits `0` only after `server.close()`'s callback runs.
- `shutdown-refuse-new` stops accepting new connections once closing begins.

## How to get to it (user POV)

- Press Ctrl+C in the terminal running `pnpm start`, or send `SIGTERM` from a process manager
  (`docker stop`, systemd, `kill <pid>`).

## Driving it with HTTP (pwsh)

Preconditions:

- Linux, macOS, or WSL — a platform where one process can deliver a real signal to another. On
  Windows this journey cannot be driven (see Gotchas) and must be reported as unverified there.
- An instance started directly, keeping its handle: `$env:PORT=3100; $p = Start-Process node -ArgumentList 'apps/api/dist/index.js' -PassThru -NoNewWindow`

- **SIGTERM while idle.** Send the signal. Run `kill -TERM $p.Id` (bash) / `Stop-Process` is *not*
  equivalent. The stdout log gains `[skymatrix-api] SIGTERM received, shutting down` and the exit
  code is `0`.
- **SIGINT while idle.** Run `kill -INT $p.Id`. Same log line with `SIGINT`, same exit code `0`.
- **Signal during an in-flight request.** Start a slow request against a route that takes time, then
  send `SIGTERM` before it returns. Run `curl -s -o /tmp/out.json -w '%{http_code}' http://localhost:3100/hello &`
  then `kill -TERM $p.Id`. The in-flight request completes with status `200` and its body arrives;
  the process exits `0` afterwards. This is the case the feature exists for.
- **New connections refused after signal.** Once the shutdown log line appears, a new request fails
  to connect (`curl` exit code `7`, connection refused) rather than hanging or being served.
- **Proof.** Keep the captured stdout log containing the signal line and the recorded exit code in
  the evidence folder, alongside the in-flight response body.

## Gotchas

- **Windows cannot drive this journey.** Node on Windows does not receive `SIGINT`/`SIGTERM` from
  another process: `Stop-Process -Id` terminates unconditionally, the handler never runs, and the
  log line never appears. `stop.ps1` therefore hard-stops, and this feature stays unverified when
  the agent runs on Windows. Record that gap rather than asserting a pass.
- `server.close()` stops new connections but does **not** destroy established keep-alive sockets.
  A client holding an idle keep-alive connection can keep the process alive past the signal; the
  handler has no `closeIdleConnections()` or timeout. A journey that observes "exit is immediate"
  is asserting the wrong thing — assert "exit after the callback", not "exit within N ms".
- Nothing forces exit if a connection never closes; there is no second signal handler and no
  watchdog timer. A stuck socket means a hung shutdown (a real finding, not a test flaw).
- Signals sent twice do not produce two exits, but they also do not escalate — a second Ctrl+C does
  nothing but re-log.
