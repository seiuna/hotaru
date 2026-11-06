# Feature map — @skymatrix/api

The index of every user-facing behavior this service exposes, and the exact way to drive each one.
An agent proving a change picks the entries the change touches; a change to request handling usually
touches `health-check` and `default-route`, a change to startup touches `port-config`, and a change
to process lifecycle touches `graceful-shutdown`.

Journeys are driven with real HTTP against a launched instance — see
[../SKILL.md](../SKILL.md) for launch, doctor, evidence, and cleanup. Every journey below assumes a
healthy instance on the port you launched (examples use `3100`).

| Feature | Entry point | Proven by |
| --- | --- | --- |
| [health-check](health-check.md) | `GET /health` | 200 + `status: ok`, `service`, `uptimeSeconds`, ISO `timestamp` |
| [default-route](default-route.md) | any other path, e.g. `GET /hello` | 200 + `{ message, path }` echoing the request path |
| [port-config](port-config.md) | `PORT` env var at launch | listener on that port only; `/health` there |
| [graceful-shutdown](graceful-shutdown.md) | `SIGINT` / `SIGTERM` | log line + exit code 0, no new requests accepted |

Adding a feature means adding a file here with the same four sections, and a row in this table.

## Known precondition gaps

None at seed time: the service needs no database, no seed data, no auth, and no config file. If a
future journey needs a precondition the empty checkout does not provide, the journey fails and the
reason is recorded in that feature's **Gotchas** — the map is not weakened to make it pass.
