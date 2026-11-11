# ACI: Series 1

[![CI](https://github.com/ceenguyen05/ACI-Series1/actions/workflows/ci.yml/badge.svg)](https://github.com/ceenguyen05/ACI-Series1/actions/workflows/ci.yml)

**A tactical first-person shooter that runs in your browser.** Plant the bomb, hold the site,
or survive the horde across two hand-built maps. Nothing to download or install.

### ▶ [Play now at aci-series1.vercel.app](https://aci-series1.vercel.app)

Desktop Chrome, Edge or Firefox, with keyboard and mouse.

---

## The maps

When you start or create a Search & Destroy match, pick **ACI HQ**, **ACI Building 2** or
**Randomize**. Zombies is played on ACI HQ.

* **ACI HQ** is a single-story building split down the middle. The west half is offices: meeting
  rooms, engineering cubicles and the B-site bullpen. The east half is manufacturing: the A-site
  assembly line, factory floor, warehouse and shipping docks. You get close-quarters fights through
  the cubicles and long sightlines across the factory floor.
* **ACI Building 2** is the company's engineering office, with no factory floor. Attackers come in
  from the front parking lot past field-test radar poles and plate-reader cameras. Defenders hold
  the café (B site) and the prototype lab (A site), either side of a skylit atrium. In between are a
  lobby with security turnstiles, a party room, restrooms, a training room, a bullpen and an RF lab.

Spawns change every round: Attackers start in a different part of the yard or lot each round, and
Defenders are split between the A and B sites.

Callouts and routes for both maps are in [docs/MAP.md](docs/MAP.md).

## Game modes

### Search & Destroy

Competitive bomb defusal with CS2 rules: freeze time and a buy phase, 1:55 rounds, a 40-second
bomb, a halftime side swap and the full round economy. Play 1v1 through 5v5 against bots
offline, or queue online for casual and ranked matches.

### Zombies: ACI HQ: Outbreak

Round-based co-op survival. Start with a knife and a pistol, earn points, open up the
building, take your chances on the Mystery Box and stack perks. Then call in the exfil chopper,
or play Endless and see how far you get. Play solo or in a squad of up to five, with friends
or bots.

## Key features

**Gunplay**
- 22 original guns plus a knife across 8 classes, from pistols and SMGs to LMGs, snipers, a
  40 mm grenade launcher and an RPG
- Fixed, learnable spray patterns, head/body/leg hit groups, range falloff, and wallbangs
  through wood, glass and thin metal
- **Gunsmith:** up to 5 attachments per gun (optics, muzzles, grips, lasers, mags, ammo types)
- Source-style movement: counter-strafing, air-strafing, crouch-jumps, slides, prone,
  mantling and lean
- Readable fights: glowing tracer streaks, muzzle flashes and spent brass in the world, the crack
  of near misses, floating damage numbers, and sound that is muffled through walls and rings in
  big rooms

**Tactics**
- Frags, flashbangs, smokes, Molotovs and an original Recon Pulse
- A grenade trajectory preview while you hold a throw, and a warning that points at live grenades
  near you
- Siege-style gadgets: drones, sticky cams, trip mines, barbed wire, deployable shields, EMP
  and building CCTV
- Fortify and breach: board up doorways, pry them open, plant and detonate C4
- Killstreaks: UAV, Counter-UAV, Hunter Drone and a steerable Cruise Missile
- Pings, a final killcam, and clutch and ACE callouts
- An optional Minecraft-style paper doll: a live model of your character in the top-right
  corner that copies your shots, reloads, throws and stance

**Zombies**
- Ten zombie types, including Spitters, Shriekers, armored Firefighters and a Juggernaut boss
- 14 wall weapons, the Mystery Box, the **Disruptor** wonder weapon and Pack-a-Punch-style
  upgrades at the Prototype Forge
- 8 perks, 7 power-ups, an Armory full of gear, revives, and an exfil to win
- Four difficulties, from Casual to Nightmare

**Bots**
- Team strategies: rushes, executes, splits, lurkers, rotations and grouped retakes
- They hear footsteps, throw utility, buy from the full arsenal, plant, defuse and save
- Four difficulty levels in both modes

**Online & progression**
- Public matchmaking and private rooms with five-digit invite codes; pick a map or Randomize
- Empty slots fill with bots, so a room never sits waiting forever
- Ranked S&D (3v3 to 5v5) with placements, skill-based queues and Iron to Champion divisions
- Career XP and levels in both modes, with rewards for daily play
- The server runs the full game simulation, so online matches play by the same rules as
  offline ones

**Built from scratch**
- Every model, animation and sound is generated in code; the only bundled art is three CC0
  scanned surface textures
- Baked global illumination: an offline light baker adds soft shadows and bounce light across
  the whole map
- Operator and weapon-finish customization with live 3D previews
- Low, Medium and High graphics presets that run on integrated graphics

## Controls

Every key can be rebound in **Settings → Controls**.

| Action | Key | Action | Key |
|---|---|---|---|
| Move | W A S D | Fire / Aim | Left / Right mouse |
| Jump / Mantle | Space | Reload | R |
| Crouch (hold to go prone) | C | Lean left / right | Q / E |
| Slide | Left Alt (while running forward) | Walk quietly | Left Shift |
| Use · Defuse · Buy (Zombies) | F | Buy menu | B |
| Weapons / Knife | 1 / 2 / 3 | Grenades / Bomb / Gadgets | 4 / 5 / 6 |
| Scoreboard | Tab (hold) | Pause | Esc |

<details>
<summary><b>All controls</b></summary>

| Action | Key | Action | Key |
|---|---|---|---|
| Quick melee | V | Stim yourself | H |
| Use killstreak | 7 | Detonate C4 | Z |
| Camera / drone feeds | T (Q/E switch, left mouse pings) | Ping enemy / spot | Middle mouse |
| Drop weapon | G | Last weapon | X |
| Inspect weapon | Y | Weapon light on/off | L |
| Gunsmith | B, then tab 4 | Rebuy / Auto-buy (in buy menu) | R / A |
| Skip killcam | Space | Leave prone | Release C (needs room to stand) |

* Crouch is on **C** instead of Ctrl because Ctrl+W closes the browser tab. Prefer Call of
  Duty-style crouching? Set **Settings → Game → Crouch & prone** to **Toggle**.
* **In Zombies:** F buys from wall weapons, shutters, perk machines, the Mystery Box, the
  Prototype Forge and the power switch, and opens the Armory. Hold F next to a downed
  teammate to revive them. Tab shows the squad board.
* **Aim assist** is set in **Settings → Game** (Off / Low / Medium / High; Low is the default).
  It never applies to bots.

Movement, aiming and crosshair details are in [docs/GAME_DESIGN.md](docs/GAME_DESIGN.md).

</details>

## Run it locally

You need **Node.js 20.19+ or 22.12+** and a WebGL2 browser.

```bash
npm install
npm run dev          # game at http://localhost:5173
npm run dev:online   # game + a local multiplayer server
```

Click the game to capture the mouse; press **Esc** to pause and release it.

## Tech stack

| Part | Built with |
|---|---|
| Game | TypeScript, Three.js, Vite, WebAudio |
| Multiplayer server | Node.js + WebSockets, 64-tick authoritative simulation |
| Player profiles | MySQL |
| Testing | Vitest (320+ tests, including full bot-vs-bot matches) and Playwright browser checks |
| Hosting | Vercel (website), Render (game server), Aiven (MySQL) |

The game simulation never touches the DOM or WebGL. The renderer, audio and UI only read its
state and events, which is why the exact same code runs in the browser, in Node tests and on
the multiplayer server.

## Documentation

| Topic | Document |
|---|---|
| Rules, weapons, economy, movement, gadgets and bots | [docs/GAME_DESIGN.md](docs/GAME_DESIGN.md) |
| Zombies: waves, zombie types, perks, prices and exfil | [docs/ZOMBIES.md](docs/ZOMBIES.md) |
| Map layout and callouts | [docs/MAP.md](docs/MAP.md) |
| XP, daily streaks, ranks and matchmaking | [docs/PROGRESSION.md](docs/PROGRESSION.md) |
| Online multiplayer and rooms | [docs/MULTIPLAYER.md](docs/MULTIPLAYER.md) |
| Hosting it yourself (Vercel + Render + MySQL, free plans) | [docs/ONLINE_DEPLOYMENT.md](docs/ONLINE_DEPLOYMENT.md) |
| Project structure, tests and tools | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| CI, deploys and rollback | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Movement and visual overhaul | [docs/POLISH.md](docs/POLISH.md) |
| Art sources and licenses | [docs/ASSETS.md](docs/ASSETS.md) |
| Development plan | [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Performance

Measured on Intel UHD 620 integrated graphics at 1280×720:

| Quality | FPS |
|---|---|
| Low | 60 (vsync cap) |
| Medium (default) | 50–60 |
| High | 30–45 |

If the game stutters, lower **Settings → Video → Graphics quality** or **Resolution scale**.

## Troubleshooting

* **The mouse doesn't turn the camera.** Click inside the game first. Browsers only allow mouse
  capture after a click.
* **No sound.** Click once on the page. Browsers block audio until you interact.
* **Black screen or "Failed to start".** Turn on hardware acceleration in your browser
  settings so WebGL can run.
* **Can't connect online.** The free game server sleeps when nobody is playing. Give it about a
  minute to wake up, then try again.
* **Reset all settings.** Clear the site's data in your browser. Settings are saved under
  `aci-snd-profile-v1`.

## Roadmap

- Rejoining a running online match after a disconnect
- More maps (and Zombies on ACI Building 2)
- Destructible soft walls
- More killstreaks (care package, sentry)
- Weapon inspect animations
- Demo replays
- Controller support

See [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md#8-future-work-post-v1) for details.
