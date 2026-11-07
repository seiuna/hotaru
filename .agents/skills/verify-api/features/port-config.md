# Port config

The listening port comes from the `PORT` environment variable at startup, falling back to `3000`
(`Number(process.env.PORT ?? 3000)` in `apps/api/src/index.ts`). It is what makes two instances able
to run side by side, and therefore what makes verification itself possible.

## Sub-features

- `port-default` listens on `3000` when `PORT` is unset.
- `port-override` listens on the number given in `PORT`.
- `port-isolation` two instances with different `PORT` values serve independently.
- `port-startup-log` prints `[hotaru-api] listening on http://localhost:<port>` on success.

## How to get to it (user POV)

- Start the service with `PORT=8080 pnpm start` (or set `$env:PORT=8080` in PowerShell first), then
  use `http://localhost:8080`.

## Driving it with HTTP (pwsh)

Preconditions:

- No instance already owns the ports under test.

- **Default port.** Start without `PORT`. Run
  `Remove-Item Env:PORT -ErrorAction SilentlyContinue` then
  the [launch block](../SKILL.md#launch) with `$port = 3000`. `doctor.ps1 -Port 3000` exits `0`
  and the startup log names `http://localhost:3000`.
- **Override.** Start on a chosen port. Run
  the [launch block](../SKILL.md#launch) with `$port = 3100`. `GET /health` on `3100` answers,
  and nothing answers on `3000`.
- **Isolation.** Launch a second instance. Run the launch block again in a new shell with `$port = 3101` and its own `$dir`. Both `doctor.ps1 -Port 3100`
  and `doctor.ps1 -Port 3101` exit `0`, and each PID file records a different pid 鈥?so a request to
  one port is not served by the other. Confirm by checking the two `server-<port>.out.log` files
  name their own ports.
- **Proof.** Keep both startup logs and one `/health` payload per port in the same evidence folder,
  then stop both with `stop.ps1 -Port 3100` and `stop.ps1 -Port 3101`.

## Gotchas

- `PORT` is not validated. A non-numeric value (`PORT=abc`) makes `Number()` return `NaN` and
  `server.listen` throws at startup 鈥?the process exits non-zero with an `ERR_SOCKET_BAD_PORT`
  stack, which the launch block surfaces as a readiness timeout, not a health failure.
- An **empty** `PORT` (`$env:PORT=''`) becomes `Number('') === 0`, which Node treats as "pick any
  free port". The service starts on a random ephemeral port and nothing answers on the port you
  expected. If a launch reports ready but the port you asked for is dead, check for this.
- The port is read once at startup. Changing `PORT` in another shell has no effect on a running
  instance; relaunch instead.
- The skill's own examples use `3100`/`3101` so they never collide with a developer's default `3000`
  instance. Keep that convention when adding journeys.
