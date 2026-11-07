# Admin console (`apps/admin-web`)

A Vue 3 + Naive UI single-page console for the MC Auth Platform. It talks only to the documented
admin API and never to MongoDB, Redis or Mojang.

```
browser ──HTTPS──► Caddy ──/api/*──► auth-server ──► MongoDB / Redis
                     └────/*──────► nginx (SPA)
```

## Why login goes through the game

The platform has no password store, by design: the only credential that proves a premium Minecraft
account is the Mojang handshake, and that handshake needs the player's Minecraft access token — which
only the game client holds. A browser cannot obtain it, and adding a web password would create a second
authentication system with weaker properties than the one we just built.

So `/login` offers two paths, in this order:

### 1. Default: the local mod bridge

The Fabric mod runs a loopback HTTP server (`apps`-independent, see `docs/mod-login-bridge.md`). Clicking
**通过本地游戏登录**:

1. probes `http://127.0.0.1:8765/v1/health` so the button reflects whether the game is actually running;
2. `POST /v1/login` — the mod shows an in-game confirmation prompt;
3. after the player confirms, the mod performs the Mojang handshake and returns the token pair;
4. the console validates the token against `/users/me` + `/users/me/permissions` and refuses accounts
   without `admin:users`.

Nothing is copied by hand. Failures are explicit: mod not running, origin not on the mod's allowlist,
player denied, prompt timed out, or the game's session expired.

### 2. Fallback: paste an access token

For machines without the mod (or when the bridge port is blocked), paste the `accessToken` minted by the
Fabric client. The console validates it the same way.

The console immediately validates it against `GET /users/me` and `GET /users/me/permissions`, refuses
any account without `admin:users`, and keeps the token in **`sessionStorage`** only — closing the tab
signs you out. The token is never written to `localStorage`, never put in a URL by the app itself, and
every screen's data is re-read from the server, so a revoked scope or ban takes effect on the next
request rather than at token expiry.

### One-time bootstrap (ops convenience)

`/login#token=<jwt>[&next=/path]` signs in without retyping a 1000-character token. The fragment is
never sent to a server and is stripped from history with `replaceState` before any request. `next` is
restricted to same-app absolute paths.

## Screens

| Route | What it does |
| --- | --- |
| `/login` | Paste/validate a token, explains how to obtain one, links the `admin:seed` command |
| `/` | Bento dashboard: user totals, active sessions, 24h audit events, grant count, dependency health, recent audit feed, current identity |
| `/users` | Search by username substring or UUID prefix, filter by status, paginated table |
| `/users/:id` | Profile, permission editor (5 scopes, optional expiry, live diff, save), ban/unban with reason, session list with per-session revoke |
| `/audit` | Audit log filtered by event type or actor id, paginated |

Everything is server-backed; there are no mocked rows or decorative-only controls.

## Develop

```bash
pnpm --filter @hotaru/admin-web dev     # http://localhost:5173
```

Vite proxies `/api` to `http://127.0.0.1:3000`, so the SPA is always same-origin and needs no CORS
grant. Start the API first:

```bash
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d mongo redis   # or reuse local containers
pnpm --filter @hotaru/auth-server dev
```

Grant the first admin (once per account):

```bash
pnpm --filter @hotaru/auth-server admin:seed -- --uuid <minecraft-uuid> --username <name>
```

## Build and test

```bash
pnpm --filter @hotaru/admin-web build       # vue-tsc + vite build -> dist/
pnpm --filter @hotaru/admin-web test        # vitest (token decoding, permission diffing, formatting)
pnpm --filter @hotaru/admin-web lint
```

## Deploy

`deploy/Dockerfile.admin-web` builds the SPA and serves it with nginx (SPA fallback, immutable asset
caching, `no-store` on `index.html`). `deploy/compose.yaml` runs it as `admin-web`, and Caddy exposes it
on `ADMIN_DOMAIN` (defaults to `admin.$AUTH_DOMAIN`) while routing `/api/*` on that host to
`auth-server` — so the bundle keeps using a relative `/api` and there is no CORS configuration to get
wrong.

## Design notes (cozy-breeze-ui)

- **Palette A (sky blue)** with mint as the secondary accent. Design tokens live in
  `src/styles/tokens.css`; Naive UI is themed from the same values in `src/theme.ts` so its widgets do
  not clash with the custom surfaces.
- Buttons use the deeper `--primary-strong` (`#267DBF`) so white label text keeps ≥ 4.5:1 contrast;
  `--primary` is reserved for accents and focus rings.
- Bento grid on the dashboard, faint dot texture, soft radial washes, 16px card / 10px control radii,
  pill tags, 2px hover lift, `:focus-visible` rings, `prefers-reduced-motion` support, and real
  empty/loading/error states.
- Responsive at 1440 / 1080 / 860 / 640px: the sidebar collapses into a top bar, bento spans stack,
  tables remain horizontally scrollable.

## Known limits

- Light theme only (no dark mode).
- The access token is short-lived (15 min by default); the console does not use the refresh token, so a
  long admin session ends with a re-paste. Deliberate: a refresh token in browser storage is a bigger
  prize than a 15-minute access token.
- No user-facing pagination for sessions beyond the first 20 (API supports `limit`/`offset`).
- Visual verification in this environment was limited: `vite build`, `vue-tsc`, the unit tests and the
  dev server/proxy were verified, but screenshots were not captured because desktop automation is not
  permitted here. Open `http://localhost:5173/login` locally to review the rendering.
