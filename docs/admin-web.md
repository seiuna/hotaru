# Admin console (`apps/admin-web`)

A Vue 3 + Naive UI single-page console for the MC Auth Platform. It talks only to the documented
admin API and never to MongoDB, Redis or Mojang.

```
browser ──HTTPS──► Caddy ──/api/*──► auth-server ──► MongoDB / Redis
                     └────/*──────► nginx (SPA)
```

## Login

The console uses a platform account and password. The account must have `admin:users`; the server checks
the live permission list on every admin API request, so revoking the scope takes effect on the next call.

```text
POST /api/v1/portal/login          username + password (+ optional TOTP)
GET  /api/v1/portal/admin-session  account identity + live scopes
POST /api/v1/portal/refresh        rotate the refresh token
```

The access token is stored in **`sessionStorage`** only; closing the tab signs you out. The refresh token
is stored beside it and used silently on a 401. The password itself is never stored by the browser.

`/status` bypasses the auth guard (`meta.public`) and is safe to share with operators or players. It
shows Auth API, MongoDB, Redis, IRC and the console itself. Latency curves are browser-local and retain
the latest 60 samples; the endpoint exposes only status, latency and a short error detail.

### Seed a password administrator

```bash
pnpm --filter @hotaru/auth-server admin:seed -- \
  --uuid <minecraft-uuid> \
  --username LocalAdmin --login-name admin --password admin123456
```

`--login-name` and `--password` are optional; without them the account can still be used through the
Minecraft handshake and the account API, but it cannot use the console's password form.

## Screens

| Route | What it does |
| --- | --- |
| `/login` | Username/password form, optional TOTP field, `admin:users` enforcement |
| `/` | Bento dashboard: user totals, active sessions, 24h audit events, grant count, dependency health, recent audit feed, current identity |
| `/users` | Search by username substring or UUID prefix, filter by status, paginated table |
| `/users/:id` | Profile, permission editor (5 scopes, optional expiry, live diff, save), ban/unban with reason, linked UUID list with per-UUID ban/unban, session list with per-session revoke |
| `/audit` | Audit log filtered by event type or actor id, paginated |
| `/activation-codes` | Issue signed account, bind or claim codes; requires the auth server's activation private key |
| `/status` | Public, login-free availability and latency page; polls `/api/v1/status` every 5 s |

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
- The access token is short-lived (1 hour by default). The console keeps a rotating refresh token in
  `sessionStorage` and renews on a 401; closing the tab clears both.
- No user-facing pagination for sessions beyond the first 20 (API supports `limit`/`offset`).
- Visual verification in this environment was limited: `vite build`, `vue-tsc`, the unit tests and the
  dev server/proxy were verified, but screenshots were not captured because desktop automation is not
  permitted here. Open `http://localhost:5173/login` locally to review the rendering.
- `/activation-codes` returns `ACTIVATION_DISABLED` until the auth server has
  `ACTIVATION_PRIVATE_KEY_FILE` or `ACTIVATION_PRIVATE_KEY_PEM`. The CLI remains available without it.
