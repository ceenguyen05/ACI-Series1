# Development reference

Project layout, architecture rule, and every check and tool script. For setup and the
pull-request workflow, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Requirements

* **Node.js 20.19+ or 22.12+.** CI uses Node 22 (`.nvmrc`).
* **npm** 10 or newer.
* A WebGL2 browser: Chrome, Edge or Firefox.

No VS Code extensions are required.

```bash
npm install          # once
npm run dev          # starts http://localhost:5173 and opens the browser
npm run dev:online   # frontend + multiplayer server (for public/private online matches)
npm run build        # outputs static files to dist/
npm run preview      # serves dist/ locally
```

## Project structure

```
ACI-SND/
├─ .github/
│  ├─ workflows/ci.yml     # typecheck, tests, build, browser boot check (every push / PR)
│  ├─ workflows/deploy.yml # CI, then publish to GitHub Pages (push to main)
│  └─ ISSUE_TEMPLATE/, pull_request_template.md, CODEOWNERS
├─ index.html              # page shell (canvas + UI root)
├─ Dockerfile, render.yaml # game server container / Render Blueprint (see docs/ONLINE_DEPLOYMENT.md)
├─ .env.example            # every server and build setting, documented
├─ server/                 # authoritative multiplayer server (Node + ws); runs src/sim headless
│  ├─ index.ts             #   HTTP + WebSocket entry point, 64 Hz tick loop, /health and /ready
│  ├─ LobbyService.ts      #   rooms, codes, matchmaking queue, bot fill, rewards, rank settlement
│  ├─ matchmaking.ts       #   pure queue / skill-window / team-balance rules
│  ├─ AccountStore.ts      #   anonymous device profiles and server-owned careers
│  └─ MySqlPersistence.ts  #   optional MySQL storage adapter
├─ src/
│  ├─ main.ts              # bootstrap + loading screen
│  ├─ app/                 # application layer
│  │  ├─ App.ts            #   state machine: title → menu → match; menu showcase camera
│  │  ├─ GameSession.ts    #   one running match (offline or online): fixed 64-tick loop, overlays
│  │  ├─ Input.ts          #   keyboard/mouse, pointer lock, key capture for rebinding
│  │  ├─ PlayerController.ts  # input → AgentCommand (mouse look, lean, ADS, one-shot actions)
│  │  ├─ AimAssist.ts      #   optional slow-down + pull near visible enemies (player only)
│  │  └─ Profile.ts        #   saved profile/settings (localStorage)
│  ├─ net/                 # online client: protocol + validation, snapshots, prediction replicas
│  ├─ progression/         # XP, levels, daily challenges, ranks (shared by browser and server)
│  ├─ config/              # tunable data tables
│  │  ├─ rules.ts          #   match rules and lengths
│  │  ├─ economy.ts
│  │  ├─ movement.ts       #   Source-unit movement constants
│  │  ├─ weapons.ts        #   all guns: stats, spread, recoil
│  │  ├─ utilities.ts      #   grenades and gear
│  │  ├─ gadgets.ts        #   drones, cameras, traps, shield, EMP
│  │  ├─ cosmetics.ts      #   agents, finishes, crosshair defaults
│  │  ├─ difficulty.ts
│  │  └─ controls.ts       #   default key bindings
│  ├─ core/                # engine-agnostic helpers: math, seeded RNG, typed EventBus
│  ├─ sim/                 # deterministic game simulation (no DOM/WebGL; runs in Node tests)
│  │  ├─ maps/index.ts     #   S&D map pool, map choice (incl. Randomize) helpers
│  │  ├─ maps/aciHq.ts     #   ACI HQ: grid, doors, props, signs, spawns, sites, AI data
│  │  ├─ maps/aciB2.ts     #   ACI Building 2 (engineering office)
│  │  ├─ maps/aciHqZombies.ts # Zombies layout: zones, shutters, wall-buys, machine spots
│  │  ├─ world/            #   MapDef types; World = colliders + nav + zone queries
│  │  ├─ physics/          #   AABB collision world (grid + DDA raycast), Source-style motor
│  │  ├─ entities/         #   Agent (player/bot state, inventory, hitboxes, commands)
│  │  ├─ combat/           #   damage model, spray patterns, ballistics + penetration, weapon state machine,
│  │  │                    #   Ordnance (rockets, 40 mm shells, stim darts), Explosion
│  │  ├─ utility/          #   grenade physics, smoke/fire/flash/decoy/pulse effects
│  │  ├─ gadget/           #   drones, cameras, CCTV, trip mines, wire, shields, EMP
│  │  ├─ ai/               #   NavGrid + A*, BotController, TeamCoach, BotBuy
│  │  ├─ mode/             #   Match (S&D rules, rounds, bomb, economy), Economy, Killstreaks, types
│  │  ├─ zombies/          #   ZombiesMatch (waves, zombie AI, points, machines, downs, exfil),
│  │  │                    #   AllyBot, FlowField (horde pathfinding), zweapons, types
│  │  ├─ events.ts         #   simulation event types (consumed by render/audio/UI)
│  │  └─ SimContext.ts
│  ├─ render/              # Three.js presentation
│  │  ├─ Renderer.ts       #   world pass + view-model pass, quality presets
│  │  ├─ MapMesh.ts        #   map geometry with lightmaps, lights, decals, signs, sky
│  │  ├─ lighting/         #   LightLayout (atlas packing), LightBaker (offline GI), BakedLighting (runtime)
│  │  ├─ Props.ts          #   procedural furniture, machines, vehicles
│  │  ├─ Materials.ts      #   material library, geometry batching/merging
│  │  ├─ Textures.ts       #   procedural canvas textures (incl. weapon finishes)
│  │  ├─ CharacterModel.ts #   animated humanoid agents
│  │  ├─ ZombieModel.ts    #   procedural zombies (10 kinds) and their animation
│  │  ├─ ZombiesModels.ts, ZombiesView.ts # machines, shutters, power-ups, hazards, chopper
│  │  ├─ WeaponModels.ts   #   procedural weapons, grenades, bomb
│  │  ├─ GadgetModels.ts   #   drones, cameras, mine, wire, shield, stim, C4, barricades, killstreaks
│  │  ├─ ViewModel.ts      #   first-person arms/weapon animation
│  │  ├─ Effects.ts        #   particles, tracers, decals, smoke volumes, fire, lights
│  │  └─ MatchView.ts      #   binds a Match to visuals/audio; camera; interpolation
│  ├─ audio/Sfx.ts         # WebAudio synthesizer for every sound
│  └─ ui/                  # DOM UI
│     ├─ screens/          #   title, main menu, ModeSelect, Play Online, Career & Rank
│     ├─ hud/              #   HUD, radar, crosshair, buy menu, scoreboard, pause, match end,
│     │                    #   ZombiesHUD, Armory menu, zombies scoreboard / end screen
│     ├─ components.ts, dom.ts
│     └─ styles/main.css
├─ tests/                  # Vitest (npm test)
│  ├─ game/                #   map, physics, combat, economy, bots, complete bot-vs-bot matches
│  ├─ zombies/             #   waves, machines, revives, models, long soak runs
│  └─ online/              #   rooms, matchmaking, replication, real WebSocket server, storage, careers
├─ scripts/                # Node + Playwright tooling (npm scripts wrap the common ones)
│  ├─ lib/browser.mjs      #   shared Chromium launch (GPU locally, SwiftShader on CI)
│  ├─ checks/              #   pass/fail browser checks: boot (CI), smoke, keys, handling, visual,
│  │                       #   gunplay, Zombies and the two-browser online check
│  ├─ visual/              #   screenshot tours for manual review (map, arsenal, sights, Gunsmith…)
│  ├─ perf/                #   FPS, frame cost, draw calls, Zombies horde performance
│  └─ tools/               #   light baker, surface-asset fetch, balance report, ASCII map,
│                          #   dev:online launcher, diag (console/overlay dump)
├─ docs/                   # design, map, Zombies, multiplayer, progression and deployment guides
└─ public/                 # favicon, scanned surfaces, baked lightmaps (public/lightmaps/)
```

**Design rule:** `src/sim` never touches the DOM or WebGL. The renderer, audio and UI subscribe
to the simulation's `EventBus` and read its state each frame. Because of this, entire
bot-vs-bot matches run in Node tests, and the same simulation runs unchanged inside the
authoritative multiplayer server.

## Testing & verification

| Command | What it does |
|---|---|
| `npm run check` | Typecheck + tests + production build: exactly what CI runs on every push |
| `npm run check:boot` | Serves the build from `/ACI-SND/` (like GitHub Pages), boots it in headless Chromium, starts a Search & Destroy match and a Zombies game, and fails on any missing file or error. Runs in CI; needs a build first |
| `npm run typecheck` | Strict TypeScript checks |
| `npm test` | 320+ unit, simulation and server tests. `tests/online/` covers rooms, matchmaking, input validation, snapshot replication and prediction, a real WebSocket server, MySQL/file storage, XP and ranks. `tests/zombies/` has the Zombies tests (formulas, layout validity, waves, points, purchases, perks, revives, specials, power-ups, box and forge, every zombie kind, a bot squad, motor tunnelling) plus the Search & Destroy suite (plus an optional balance report), including prone and slide (clearance, hitboxes, crouch modes), Gunsmith attachments, rebuy/auto-buy, mantling, coyote time, burst fire, stun, throwing knives, the heartbeat sensor, pings and killcam recording, including movement (crouch-jump, stamina), wallbangs, foot placement, weapon handling, input buffering, aim assist, every gadget, the stim pistol, barricades, launchers, C4 and killstreaks. They cover map connectivity, prop/wall overlap, raycasts, damage/armor, spray patterns, economy, and **complete bot-vs-bot matches** (rounds, plants, halftime swap, money limits) |
| `npm run smoke` | Builds, serves, and drives the real game in headless Chromium: title → every menu page → start match → buy menu purchase → quality presets with FPS readout → an accelerated all-bot match until it ends. Fails on any console error and saves screenshots to `screenshots/` |
| `npm run screenshots` | Visual tour of 16 map locations and 8 view models (`screenshots/tour/`) |
| `npm run perf` | FPS per graphics preset on your GPU |
| `npm run bake` | Re-bake every map's lightmaps after changing a map (about 15 s); `npm run bake -- aci_b2` for one map |
| `node scripts/visual/arsenal-look.mjs` | Screenshots of the buy menu, new view models, barricades, RPG blast and missile view (`screenshots/arsenal/`) |
| `node scripts/visual/sights-look.mjs [--spray] [--dpr=1.5]` | Every gun at the hip and aimed at a target, with 3× centre crops marked at the exact screen centre. `--spray` fires real bursts and prints how far the crosshair sits from the last impact (`screenshots/sights/`) |
| `npm run test:handling` | Real keyboard/mouse movement, jump, crouch, hold-to-prone, release-to-stand, slide/cooldown, automatic fire, reload and ADS checks, plus screenshots and graphics-preset measurements in `screenshots/handling/` |
| `npm run test:visual` | High-quality character poses, architecture, weapon animation, WebGL errors and repeated gadget cleanup; screenshots, a motion-review video and a JSON report in `screenshots/visual/` |
| `npm run test:keys` | Presses the new combat keys in the real game (quick melee, self-stim, killstreak, C4 detonate, cameras, ping, stim dart, weapon light) and checks each one works |
| `node scripts/visual/qol-look.mjs` | Screenshots of the round tips, Rebuy / Auto-buy, objective markers and the settings page (`screenshots/qol/`) |
| `node scripts/visual/paperdoll-look.mjs` | The HUD paper doll standing, firing, crouch-reloading, prone and throwing, plus "When acting" hiding it again (top-right close-ups in `screenshots/paperdoll/`) |
| `node scripts/perf/frame-cost.mjs` | Per-frame CPU cost (simulation, view, HUD, render) per quality preset – unaffected by other load on the machine |
| `node scripts/visual/gunsmith-look.mjs` | Buys and fits attachments through the real buy menu, then screenshots the Gunsmith tab, a kitted rifle, red-dot / holo / ACOG aiming, an enemy laser and an enemy light (`screenshots/gunsmith/`) |
| `node scripts/visual/moments-look.mjs` | Screenshots of the new guns, gear, heartbeat screen, pings, stun, multi-kill banner and the killcam, then checks the next round starts (`screenshots/moments/`) |
| `npm run balance [difficulty] [seeds]` | Win-rate and kill statistics over ~60 simulated rounds |
| `npm run test:zombies` | Plays Zombies in the browser through the new menus with a bot squad, then stages every zombie type, the machines, power-ups, hazards, downed / revive, armory, exfil and end screen; reports horde FPS and fails on console errors (`screenshots/zombies/`) |
| `SOAK=1 npx vitest run tests/zombies/zombies-soak.test.ts --silent=false` | Long all-bot Zombies games: progression, per-system timings, no stalled waves, nobody stuck in a closed area |
| `npm run test:online` | Only the online/server/progression tests (`tests/online/`) |
| `npm run test:online:browser` | Two real browsers against the real game server: private room, Play now, purchases, gunfire, movement, bot takeover, public queue, co-op Zombies revive/Armory and online XP |
| `npm run test:gunplay` | Real-browser gunplay regression with visual evidence |
| `npm run diag` | Loads the build in Chromium and prints console output and any fatal-error overlay (`-- --dev` for readable dev-server stacks) |
| `npm run verify` | Full pre-release pass: `check` + `check:boot` + smoke, real-key, Zombies and two-browser online checks (needs a GPU) |

`npx playwright install chromium` downloads the headless browser that the browser checks use.
Add `--swiftshader` to any browser script to use software rendering like CI does.

## CI and deployment

GitHub Actions runs on every push and pull request:

| Event | What runs |
|---|---|
| Push to any other branch / open a PR | **CI**: typecheck, tests, build, then a browser boot check of the build |
| Push to `main` (or Actions → *Deploy to GitHub Pages* → Run workflow) | **CI**, then the tested build is published to GitHub Pages (set the Actions variable `DEPLOY_GITHUB_PAGES=false` to skip Pages) |

| Piece | Host | Deploys |
|---|---|---|
| Game website | Vercel (Git integration) or GitHub Pages | Static `dist/` from `npm run build`; set `VITE_MULTIPLAYER_URL` to the game server's `wss://…/online` |
| Multiplayer server | Render (`render.yaml`) or any Node/Docker host | `npm start`; Render redeploys `main` after CI passes |
| Online profiles | MySQL (Aiven) or a persistent `DATA_DIR` volume | Server-only credentials, never `VITE_*` |

Step-by-step setup: [ONLINE_DEPLOYMENT.md](ONLINE_DEPLOYMENT.md). CI, Pages, rollback and
troubleshooting: [DEPLOYMENT.md](DEPLOYMENT.md).
