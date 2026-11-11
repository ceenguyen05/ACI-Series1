# Movement and presentation overhaul

The aim is a sharper tactical FPS while retaining ACI HQ, the offline match rules, the
existing controls and the editable code-generated models. Three CC0 scanned surface sets
now supplement the procedural materials; see [ASSETS.md](ASSETS.md).

## Movement and shooting

- Counter-strafing uses 1.15× acceleration when input opposes current velocity. The normal
  ground acceleration is 6.2 for quicker starts; friction remains 5.2. Top speeds are unchanged.
  Partial movement input retains its strength, and diagonal turns respect walk/weapon speed.
  Releasing movement and counter-strafing still brake naturally; Shift eases down to silent walking.
- Crouch speed interpolates with the capsule. Standing still checks head clearance.
- Holding crouch enters prone, with a clearance-aware long hull, low damage volumes,
  crawl animation, quiet movement, and matching first-person/replay camera height.
  Crawl friction scales down so slow movement stays responsive.
- Left Alt adds a momentum slide with a baseball-slide pose (lead leg out, trailing leg tucked,
  torso leaned back with the gun level), reduced weapon bob, scrape audio,
  cooldown and an accuracy tradeoff. It never grants extra speed or repeats on hold.
  Slide entry requires forward momentum. Backward input or Shift brakes out, and returning
  to a run preserves decaying momentum while the pose rises, subject to head clearance.
- A compact stance indicator explains prone release, blocked standing and slide recovery.
  Plant/defuse progress shows remaining seconds; defusing prevents firing and checks cover.
- A new jump press can be buffered for 90 ms before landing. Holding jump does not repeat.
- Landing momentum loss is bounded at 18%; landing inaccuracy scales with impact and
  recovers over 220 ms. Small steps do not behave like full jumps.
- Stair camera motion accounts for render interpolation, preventing a reverse jerk on each
  step. Landing camera/weapon motion compresses and settles with a damped spring.
  Mouse aim remains immediate. Raw pointer lock is requested
  with a fallback for browsers without unadjusted mouse support.
- Brief fire clicks are retained until the next simulation tick.
- Automatic weapons carry cooldown remainders between ticks. Tests measure the time to
  empty a magazine against the configured RPM to within one simulation tick.
- Recoil updates on the firing tick. Reloads / weapon changes clear old recoil and spread;
  cancelling a reload never transfers ammunition.
- The dynamic crosshair uses the perspective projection's actual angular scale.

## Presentation

- Weapons have beveled receivers, shaped stocks, rail teeth, ventilation, controls, open
  trigger guards, sights, bores and smoothly curved, ribbed magazines. Scopes have ocular
  lenses and adjustment turrets. The knife has a shaped blade.
- Magazines, pistol slides and rifle bolts are independent animated parts. Reloads have
  removal, insertion and charging phases, with audio timed to each weapon's reload length.
  Shotguns have a moving pump followed by the support hand; scoped rifles cycle their bolt
  handles over a slower action sequence.
- First-person sleeves taper toward articulated gloves. Weapon bob follows distance
  travelled, with frame-rate-independent look sway, strafe inertia and a restrained landing
  response. ADS suppresses most movement motion. Suppressed muzzle flashes are smaller.
  A small running carry pose and forward inertia blend out during aiming and other actions.
- A fixed pool of instanced brass provides ejection feedback without unbounded allocation.
- Characters have continuous tapered clothing, folds, shaped torsos, rounded heads,
  shoulder patches, bent elbows, cargo pockets, kneepads, boot soles/laces, radios and
  layered equipment. Prone damage volumes follow the low, rotated body.
- Feet use two-bone inverse kinematics with separate stance and lifted recovery phases.
  Strafe and backpedal animation follow local velocity; crouching bends knees forward while
  keeping soles grounded. Breathing, reload and firing affect the upper body independently.
  Distance-driven gait blends turns, starts, stops and airborne transitions. Foot recovery
  matches planted velocity at toe-off/contact; overextended strides shorten horizontally
  instead of lifting a planted foot. Side-steps keep the ankles separated, and sliding
  stops the stepping cycle.
- Indoor reflections light weapons and equipment. High adds scanned / procedural normal
  and roughness maps, 2x multisampling and depth-based contact shading in linear color.
  The first-person weapon stays crisp in a separate pass. Medium retains diffuse textures
  and geometry with lighter lighting shaders.
- ACI HQ gains skirting, doorway frames, structural flanges, service pipes, softened prop
  edges, machine controls, corrected forklift wheel orientation and soft contact shadows.
- Exterior brick facades gain piers, framed sealed windows and roof flashing; factory walls
  have masonry bases, high windows, service cabinets and trunking. Office walls gain vents
  and switches. Machine backs have maintenance doors, vents, handles and identification
  plates; pallets have individual boards and vehicles have correctly oriented wheels/hubs.
- Scanned concrete, galvanized cladding and brick reduce the old repetitive look.
  Large site identifiers reinforce A/B orientation; existing routes and collision stay intact.
- HUD panels and the default crosshair are smaller and quieter. Existing saved custom
  crosshairs and player settings remain in place.
- Static geometry is batched by material within 24 m tiles for frustum culling. Four nearby
  room lights keep shader cost bounded. Quality changes release old map materials and
  render targets; changing outfits and leaving matches release owned character batches.
- Thrown gadgets and settled decoys/pulses retain their models across frames. Removing
  gadgets, projectiles, effects and match views releases owned GPU buffers/materials while
  preserving cached weapon resources. A repeated spawn/remove browser check verifies
  geometry usage stays flat.

## Lighting

- `npm run bake` runs an offline light baker in Node. It traces every ceiling fixture (office
  panels, warm conference lights, factory high-bays, coloured accents), the sun and sky
  visibility with shadow rays. It adds ambient occlusion and a one-bounce approximation,
  then writes a lightmap atlas (floor, ceiling and every wall face) plus a 1 m light-probe
  grid to `public/lightmaps/`.
- At runtime Low and Medium use unlit lightmapped materials. High keeps PBR speculars but
  replaces direct diffuse with the baked light. The bake is checked against a hash of the
  map, so an edited map falls back to dynamic lighting until it is re-baked.
- Props, characters and the first-person weapon are tinted from the probe grid, so they
  darken in shadowed corners and brighten under fixtures and muzzle flashes.

## Arsenal presentation (v1.2)

- New view models: two belt-fed LMGs (box magazine, ammo belt, heat shroud, bipod), a
  break-action 40 mm launcher with a ladder sight, an RPG with a removable warhead and side
  optic, the stim pistol with a glowing vial, and a crowbar.
- Quick melee: the gun dips and rolls away while a knife (or crowbar) winds up, thrusts
  toward the crosshair and recovers in 0.42 s.
- World models for C4 (wired, blinking), plank barricades that work loose as they take
  damage, ribbed steel shutters, an ammo crate, a quadcopter with spinning rotors, a cruise
  missile with an exhaust flame and a circling UAV.
- Rockets leave smoke and ember trails. Explosions scale their fireball, debris, smoke,
  light flash, sound and screen shake with blast radius. Stims emit rising green motes, and
  barricades splinter or spark when broken.
- The cruise missile view is a white-hot thermal feed with a ring reticle, altitude readout
  and boost state. Enemies glow through the roof, and the normal HUD is hidden.
- The HUD adds a killstreak tracker with progress pips and a "ready" key badge, a green
  healing indicator, pry progress, and context hints (pry, resupply, break barricade,
  stim controls).

## S&D moments (v1.3)

- **Final killcam.** A letterboxed replay from the killer's view model and eyes, with a
  recording dot, killer → weapon silhouette → victim line, a progress bar and slow motion
  plus a light flash on the kill. Explosive and killstreak kills get a circling chase camera.
  The normal HUD hides while it plays.
- **Kill feed.** Entries use SVG weapon silhouettes for every class and source (grenades,
  fire, explosives, missile, hunter drone, bomb).
- **Moments.** Multi-kill and clutch callouts pop in with a stinger. Low health adds a
  heartbeat thump, red edges and desaturation. A stun adds a blurred, wobbling view, camera
  sway and a hum.
- **Animation.** Weapon inspect (Y) turns the gun to its side and tips it up. Mantling
  swings the weapon down and aside with a camera dip. The heartbeat sensor is a two-handed
  tablet whose live screen (sweep line, range arcs, fading blips) is drawn by the HUD.
- **World.** Blood sprays onto the surface behind bullet hits, with a 48-decal pool
  stretched along the bullet direction. Thrown knives tumble in flight and stick into
  surfaces. Characters have soft contact shadows under baked lighting, which grow while
  airborne.

## Combat effects (v1.7.7)

- **Tracers** are camera-facing streaks drawn in one batch: a white-hot core inside a warm glow,
  about two pixels wide at any range. They fade in over the first few metres, so your own fire
  never smears across the sights. (GL lines were one pixel wide whatever the resolution.)
- **Muzzle flashes** of other players are drawn in the world: a hot core, sparks thrown forward
  and a wisp of smoke. A suppressor or flash hider all but hides them.
- **Spent casings.** A fixed pool of 56 instanced casings arcs out of the gun, bounces once or
  twice on the floor and lies there for a few seconds. Pistols and SMGs throw small brass,
  shotguns red hulls; pump and bolt actions eject when the action is cycled. Your own brass
  lands beside you, and the view model keeps its close-up casings.
- **Explosions** add a white-hot fireball, flying debris, a pressure-wave shell and a scorch mark
  on the floor that lasts 45 s or until the next round.
- **Draw order.** The fireball glows through its own smoke, while smoke grenade clouds still
  cover sparks and tracers behind them, so a muzzle flash inside a smoke gives nobody away.
- **Impacts** knock loose chips that fall under gravity: masonry flakes, wood splinters and
  glass fragments. Hard landings and slides kick up dust.
- **View model.** Each shot also twists the gun a little to a random side, so a spray never looks
  like one canned bounce. Standing still at the hip, the gun rides your breathing. An empty
  pistol holds its slide open (a rifle its bolt) until the new magazine is seated.
- **Death camera.** It no longer drifts through a wall or ceiling next to where you fell.
- **Audio cost.** Every layer of a sound now shares one panner. A gunshot has five layers, so a
  firefight builds a fraction of the audio nodes it used to.

## Verification

`npm run build` checks TypeScript and builds the production bundle. `npm test` covers
complete matches, foot-placement and handling regressions; the optional
long balance report is skipped unless explicitly enabled.

`npm run smoke` exercises menus, purchases, player hits and accelerated bot rounds.
`npm run test:handling` checks real keyboard/mouse movement, jump, crouch, prone, sliding, firing, reload and
ADS, then captures all quality presets, weapon variants, A/B sites, the yard and an agent.
Its screenshots and machine-specific FPS results are saved in `screenshots/handling/`.

`node scripts/checks/movement-check.mjs` checks the real stair camera at several render
interpolation points and captures run/strafe/backpedal/crouch/slide cycles and weapon
poses in `screenshots/movement/`. Movement unit tests also cover 30/60/144 FPS response,
landing recovery, proportional input, walking speed limits and slide recovery/clearance.

`npm run test:visual` checks High quality, grounded standing/crouched feet, prone/crawl/slide
poses, animated shotgun pump travel, stable transient geometry, browser console and WebGL errors. It captures architecture, close-up character
poses and weapons in `screenshots/visual/`, plus `animation-review.webm` for motion review.

Character and weapon models remain procedural; the animation is not motion-captured. This
is a fidelity and handling upgrade to this browser game, not CS2's asset/rendering pipeline.
