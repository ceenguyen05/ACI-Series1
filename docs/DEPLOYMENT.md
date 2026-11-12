# Deployment & CI

For **Vercel Free frontend + Render Free backend + Aiven Free MySQL**, follow the step-by-step
[online deployment guide](ONLINE_DEPLOYMENT.md). Set the GitHub Actions repository
variable `DEPLOY_GITHUB_PAGES=false` if you do not want Pages publishing; all CI checks
still run on `main`. Without that variable, the Pages flow below remains enabled.

The game is a static site (Vite build of TypeScript + Three.js). GitHub Actions checks every
change and publishes `main` to **GitHub Pages**:

**https://ceenguyen05.github.io/ACI-SND/**

The frontend also works with the existing GitHub-to-Vercel deployment. Online Search &
Destroy and Zombies use a persistent Node game server; configure `VITE_MULTIPLAYER_URL` in Vercel
and host that process separately. See [multiplayer hosting](MULTIPLAYER.md#keep-the-frontend-on-vercel)
for the exact setup and current Vercel WebSocket constraints. Use MySQL for free-hosted
XP, ranks and profiles, or a persistent `DATA_DIR` volume for file storage on another host; [progression documentation](PROGRESSION.md)
describes the account/storage boundaries.

## How it flows

```
push to a branch / open a PR ──► CI ─────────────────────────────► ✓ / ✗ on the commit / PR
                                  ├─ checks: typecheck · tests · build ──► "dist" artifact
                                  └─ boot:   serve dist at /ACI-SND/, boot the game in Chromium

push to main (or "Run workflow") ──► Deploy to GitHub Pages
                                      ├─ CI (the same two jobs, reused)
                                      └─ deploy: publish that exact "dist" ──► Pages site
```

* **Nothing deploys unless CI passes.** The deploy job publishes the artifact CI built and
  tested; it doesn't rebuild.
* Deploys never cancel each other half-way (`concurrency: pages`); a newer push waits for the
  running deploy, then publishes.
* Every deployed site has a build stamp at **`/version.json`**: commit, branch, build time and
  a link to the workflow run.

## Workflows (`.github/workflows/`)

| File | Runs on | Jobs |
|---|---|---|
| `ci.yml` | pushes to any branch except `main` (docs-only pushes skipped), every pull request, manual runs, and called by `deploy.yml` | **checks**: `npm ci` → `npm run typecheck` → `npm test` → `vite build` → upload `dist`<br>**boot**: download `dist` → install Chromium → `npm run check:boot` → upload screenshots |
| `deploy.yml` | pushes to `main`, manual runs ("Run workflow" button) | **ci** (calls `ci.yml`) → **deploy** (`configure-pages` → `upload-pages-artifact` → `deploy-pages`) |

### What the checks cover

* **Typecheck:** strict TypeScript over `src/`, `server/` and `tests/`.
* **Unit and simulation tests:**
  * Movement and physics (prone, slide, mantle, crouch-jump), ballistics, wallbangs,
    economy and the Gunsmith.
  * Gadgets, killstreaks, bots, input bindings and aim assist.
  * Complete bot-vs-bot matches.
  * Public matchmaking, private codes, queue deadlines, bot filling, ownership,
    input validation, snapshot/prediction and real WebSocket integration.
  * A guard that fails if the map changed without re-baking the lightmaps.
* **Production build:** the exact files that will be published.
* **Boot check** (`scripts/checks/boot-check.mjs`):
  * Serves the build from **`/ACI-SND/`**, the same sub-path GitHub Pages uses, so broken
    asset paths show up as 404s.
  * Loads it in headless Chromium, goes through the menu and starts a Search & Destroy match,
    steps 10 seconds of the round and takes a screenshot.
  * Goes back to the menu, starts a Zombies game, steps 20 seconds of wave 1 and takes a second
    screenshot.
  * Fails on any console error, page error or missing file.
  * It doesn't depend on frame rate, so it's reliable on GitHub's GPU-less runners, where
    WebGL runs on the SwiftShader software renderer at about 1 FPS.

### Checks that need a real GPU (run locally)

CI's unit suite includes actual WebSocket server integration tests. The full interactive
multiplayer browser check (`npm run test:online:browser`) runs locally with a GPU, like
the existing smoke/key checks; its evidence is saved in `screenshots/online/`.

GitHub's Linux runners have no GPU, so these interactive checks run on your machine before a
bigger release:

| Command | What it does |
|---|---|
| `npm run verify` | `check` + `check:boot` + the full smoke test + the real-key check + the Zombies run |
| `npm run test:zombies` | Plays Zombies with a bot squad, then stages every zombie type, machines, power-ups, revive, exfil and the end screen; reports horde FPS |
| `npm run smoke` | Clicks through every menu, buys through the buy menu, shoots a target, runs an accelerated bot match |
| `npm run test:keys` | Presses every combat key (quick melee, stim, killstreak, C4, cameras, ping, light) |
| `npm run test:handling` | Real movement / prone / slide / firing / reload / ADS input |
| `npm run test:visual` | High-quality render checks: feet on the floor, prone and slide poses, resource cleanup |

Add `--swiftshader` to any of them to force software rendering, as CI does.

## One-time GitHub setup

1. **Turn on Pages from Actions:** repository **Settings → Pages → Build and deployment →
   Source: GitHub Actions**. This is the only manual step; the first push to `main`
   afterwards deploys.
2. *(Recommended)* **Protect `main`:** Settings → Branches (or Rules → Rulesets) → require a
   pull request and require the status checks **"Typecheck, tests and build"** and **"Browser
   boot check"**. Then broken code can't reach `main` (and the live site) at all.

Dependency updates are managed manually; automated Dependabot update PRs are disabled.

No secrets or tokens are needed. The workflows use the built-in `GITHUB_TOKEN` with the
minimum permissions: `contents: read`, plus `pages: write` / `id-token: write` only for the
deploy job.

## Everyday use

```bash
git checkout -b my-change
# ...edit, then before pushing:
npm run check            # typecheck + tests + build  (what CI runs)
npm run check:boot       # boot the build like GitHub Pages does
git push -u origin my-change   # CI runs on the branch; open a PR to see the checks on it
# merge the PR (or push to main) → deploys automatically
```

* **Manual redeploy:** Actions → *Deploy to GitHub Pages* → **Run workflow** (branch `main`).
* **Roll back:** revert the bad commit on `main` (`git revert <sha>` and push). The deploy
  workflow publishes the previous good state. You can also re-run an older successful
  *Deploy* run from the Actions tab.
* **See what's live:** open `https://ceenguyen05.github.io/ACI-SND/version.json`.

## Custom domain (optional)

1. Settings → Pages → **Custom domain** → enter e.g. `snd.example.com` and save.
2. At your DNS provider add a `CNAME` record `snd` → `ceenguyen05.github.io`.
3. Tick **Enforce HTTPS** once the certificate is issued.

The build uses relative asset paths (`base: './'` in `vite.config.ts`), so it works both at
`/ACI-SND/` and at the root of a custom domain without changes.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Deploy job fails with *"Get Pages site failed"* / *Not Found* | Pages isn't enabled for Actions yet; see One-time setup, step 1 |
| Deploy waits on *"Waiting for approval"* or says branch not allowed | Settings → Environments → **github-pages** → deployment branches must include `main` |
| `npm ci` fails: lock file out of sync | Run `npm install` locally and commit `package-lock.json` |
| Tests fail on the lighting hash | The map changed: run `npm run bake` and commit `public/lightmaps/` |
| Boot check: `missing asset: 404 …` | An asset is referenced with an absolute path (`/textures/...`). Use a relative path or `import.meta.env.BASE_URL`. Also check exact upper/lower case, because Linux and GitHub Pages are case-sensitive while Windows isn't |
| Boot check: console error | Open the **boot-screenshots** artifact on the run and reproduce with `npm run check:boot -- --swiftshader` |
| Site shows an old version | Hard refresh (Ctrl+F5); Pages' CDN caches for up to ~10 minutes. Check `/version.json` |

## Files

```
.github/
├─ workflows/
│  ├─ ci.yml               # checks + boot check (reusable)
│  └─ deploy.yml           # CI gate → GitHub Pages deploy
├─ ISSUE_TEMPLATE/         # bug report / feature idea forms
├─ pull_request_template.md
└─ CODEOWNERS
scripts/
├─ checks/boot-check.mjs   # deploy boot check (CI)
└─ lib/browser.mjs         # shared Chromium flags: GPU locally, SwiftShader on CI
.nvmrc                     # Node version used by CI (22)
```
