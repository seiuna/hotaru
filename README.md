# skymatrix-servers

pnpm + TypeScript monorepo for Skymatrix backend services.

## Requirements

- Node.js >= 20.11 (tested on 24)
- pnpm >= 9 (repo pins `pnpm@11`)

```bash
corepack enable && corepack prepare pnpm@11.12.0 --activate
```

## Layout

```
skymatrix-servers/
├── apps/
│   └── api/                 # @skymatrix/api — HTTP service (tsx in dev, tsc build)
├── packages/
│   └── shared/              # @skymatrix/shared — shared types & helpers
├── pnpm-workspace.yaml      # workspace globs: apps/*, packages/*
├── tsconfig.base.json       # strict base TS config extended by every package
└── .prettierrc.json
```

## Commands

| Command          | Description                                      |
| ---------------- | ------------------------------------------------ |
| `pnpm install`   | Install all workspace dependencies               |
| `pnpm dev`       | Run `@skymatrix/api` with hot reload (tsx watch) |
| `pnpm build`     | Build every package in topological order         |
| `pnpm start`     | Run the built `@skymatrix/api`                   |
| `pnpm typecheck` | `tsc --noEmit` across all packages               |
| `pnpm clean`     | Remove all `dist/` folders                       |
| `pnpm format`    | Format with Prettier                             |

## Adding a package

```bash
mkdir -p packages/utils/src && cd packages/utils
# create package.json named @skymatrix/utils, then:
pnpm install
```

Reference it from another workspace package with the `workspace:` protocol:

```json
{ "dependencies": { "@skymatrix/shared": "workspace:*" } }
```

pnpm links it locally and `pnpm -r build` respects dependency order.

## Verify

```bash
pnpm install && pnpm build && pnpm start
# in another shell: curl http://localhost:3000/health
```
