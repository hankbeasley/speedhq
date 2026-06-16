# SpeedHQ Turbo Racer

An 80s-style pseudo-3D arcade racer built with React + Vite and rendered on an
HTML canvas. Pure client-side — no backend.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server (port 3000). |
| `npm run build` | Type-safe production build into `dist/`. |
| `npm run preview` | Serve the built `dist/` locally. |
| `npm run lint` | Type-check with `tsc --noEmit`. |
| `npm test` | Run the physics/collision unit tests (Node test runner). |
| `npm run deploy` | Build and deploy to Cloudflare Pages. |

## Deploying to Cloudflare Pages

This is a static single-page app, so it deploys as plain static assets. Config
lives in [`wrangler.toml`](./wrangler.toml) (`pages_build_output_dir = "dist"`),
and [`public/_redirects`](./public/_redirects) provides the SPA fallback.

### Option A — Wrangler CLI (this repo is already set up for it)

Deploys to the existing **`speedhq`** Pages project (set in `wrangler.toml`).

```bash
# One-time: authenticate the CLI with your Cloudflare account
npx wrangler login            # or set CLOUDFLARE_API_TOKEN in the environment

# Build + upload to Cloudflare Pages (production)
npm run deploy

# Build + upload to a named "preview" deployment instead
npm run deploy:preview
```

`npm run deploy` builds and uploads `dist/` to the `speedhq` project and prints
the live URL. Whether it lands on the production domain depends on your project's
production branch — if it reports a preview URL, set the production branch in the
Pages dashboard (Settings → Builds & deployments) or pass `--branch=<prod-branch>`.

For CI, set `CLOUDFLARE_API_TOKEN` (a token with the *Cloudflare Pages — Edit*
permission) and `CLOUDFLARE_ACCOUNT_ID` instead of `wrangler login`.

### Option B — Git integration (Cloudflare dashboard)

Push this repo to GitHub/GitLab, then in the Cloudflare dashboard:
**Workers & Pages → Create → Pages → Connect to Git**, and set:

- **Framework preset:** Vite
- **Build command:** `npm run build`
- **Build output directory:** `dist`

Every push to the production branch then builds and deploys automatically.
