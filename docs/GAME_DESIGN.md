# Game Design — ACI: Series 1 · Search & Destroy

> ACI: Series 1 has two modes. This document covers **Search & Destroy**; the round-based co-op
> survival mode is documented in [ZOMBIES.md](ZOMBIES.md).

## Core loop

The game copies CS:GO / CS2 competitive bomb defusal.

1. **Freeze time** (5–15 s, configurable). Everyone is frozen in spawn and can buy.
2. **Buy time.** You can buy during freeze time and for the first 20 s of the round, inside your team's spawn area for that round.
   Spawns change every round: Attackers start in one of three areas (never the same twice in a row), and Defenders are split
   between the A and B sites. Everyone gets a new spot, nudged at random. Details are in [MAP.md](MAP.md#spawns).
3. **Round** (1:55):
   * **Attackers** carry the bomb. They win by planting it at **A** or **B** and letting it explode (40 s), or by eliminating all Defenders.
   * **Defenders** win by eliminating all Attackers before a plant, by defusing (10 s, 5 s with a kit), or when time runs out.
4. **Round end** (6 s). Money is paid out, an MVP is named, and survivors keep their gear.
5. **Halftime.** Sides swap, money resets to $800, and inventories reset.
6. **Match end.** The first team to reach the target wins: 5 (Quick), 9 (MR8), or 13 (MR12). Reaching the maximum round count with a tie is a draw.

Teams: **Attackers** (T side, orange) and **Defenders** (CT side, blue). Each team has 1–5 players; every slot not taken by the human player is a bot.

## Economy (CS2 values)

| Event | Reward |
|---|---|
| Start money / cap | $800 / $16,000 |
| Round won by elimination or time | $3,250 |
| Round won by bomb explosion or defuse | $3,500 |
| Loss bonus (consecutive losses 1→5) | $1,400 / $1,900 / $2,400 / $2,900 / $3,400 |
| Win | Loss streak drops by 1 (CS2 rule) instead of resetting |
| Attackers lose after planting | +$800 each |
| Attackers alive when time runs out | No loss bonus |
| Plant / defuse | +$300 to the player |
| Kill | Weapon kill reward (see below) · grenade $300 · knife $1,500 |
| Team kill | −$300 |

## Weapons

All names and models are original; the stats follow CS archetypes.

| Weapon | Class | Side | Price | Kill $ | Damage | Armor pen. | RPM | Mag | Move (u/s) |
|---|---|---|---|---|---|---|---|---|---|
| Field Knife | knife | Both | — | $1500 | 40 / 65 stab | — | — | — | 250 |
| K9 Compact | pistol | Attackers | $200 | $300 | 30 | 47% | 400 | 20/120 | 240 |
| Warden SD | pistol | Defenders | $200 | $300 | 35 | 50% | 352 | 12/24 | 240 |
| P-30 Duty | pistol | Both | $300 | $300 | 38 | 64% | 400 | 13/26 | 240 |
| Judge .50 | pistol | Both | $700 | $300 | 63 | 93% | 267 | 7/35 | 230 |
| Viper MP | pistol (auto) | Both | $500 | $300 | 24 | 50% | 857 | 18/90 | 236 |
| Vespa SMG | smg | Attackers | $1050 | $600 | 29 | 57% | 800 | 30/100 | 240 |
| Hornet-9 | smg | Defenders | $1250 | $600 | 26 | 60% | 857 | 30/120 | 240 |
| Mako PDW | smg | Both | $1500 | $600 | 26 | 69% | 857 | 50/100 | 235 |
| Breacher-12 | shotgun | Both | $1050 | $900 | 26×9 | 50% | 68 | 8/32 | 220 |
| Reaper Auto-12 | shotgun | Both | $1900 | $900 | 20×6 | 80% | 240 | 7/32 | 215 |
| Galeforce AR | rifle | Attackers | $1800 | $300 | 30 | 77% | 666 | 35/90 | 215 |
| Tempest Carbine | rifle | Defenders | $2050 | $300 | 30 | 70% | 666 | 25/90 | 220 |
| Ravager R7 | rifle | Attackers | $2700 | $300 | 36 | 77% | 600 | 30/90 | 215 |
| Sentinel M4 | rifle | Defenders | $2900 | $300 | 33 | 70% | 666 | 30/90 | 225 |
| Talon B3 | rifle (3-round burst) | Both | $2350 | $300 | 32 | 72% | 1000 in burst, 200 between | 30/90 | 220 |
| Kestrel Scout | sniper | Both | $1700 | $300 | 88 | 85% | 48 | 10/90 | 230 |
| Marshal DMR | sniper (semi-auto, 2× scope) | Both | $3600 | $300 | 58 | 85% | 240 | 15/60 | 215 |
| Longbow .338 | sniper | Both | $4750 | $100 | 115 | 97% | 41 | 5/30 | 200 |
| Bulwark L8 | lmg | Both | $4200 | $300 | 32 | 80% | 750 | 100/200 | 195 |
| Anvil M60 | lmg | Both | $5200 | $300 | 38 | 82% | 580 | 75/150 | 185 |
| Thumper 40mm | launcher | Both | $2900 | $300 | 120 splash (4.6 m) | — | 55 | 1/4 | 209 |
| Hammer RPG | launcher | Both | $4500 | $300 | 170 splash (5.5 m) | — | 30 | 1/2 | 189 |

The buy menu groups these by class: Pistols, SMGs, Shotguns, Assault Rifles, LMGs, Snipers
and Launchers.

**Launchers** fire physical projectiles with gravity (three sub-steps per tick, so they never
tunnel through thin walls). The 40 mm shell arms after 5 m; a shell that bounces before arming
is a dud. RPG rockets fly almost flat at 52 m/s and arm after 4 m; inside that they thud in for
45 damage. Splash damage falls off as `(1 − d / r)^1.1`, needs line of sight to the body or
head, and does triple damage to barricades. Bots switch to their pistol inside 7 m.

**Wall penetration.** Each surface has a resistance (fabric 0.12, glass 0.2, wood 0.6,
vehicle 2, metal 2.4) and each class a penetration power (shotgun 0.15, pistol 0.32,
SMG 0.38, rifle 0.9, LMG 1.0, sniper 1.5). A bullet keeps `(1 − 0.65 × cost) × 0.85` of its
damage per surface, where cost = resistance × thickness / power, and stops after two
surfaces or when the cost runs out. Wooden barricades are penetrable; steel ones and
concrete walls are not.

**Quick melee (V).** Lowers your gun, thrusts the knife (or your crowbar) and brings the gun
back up: 0.42 s busy, 0.78 s between swings. It cancels reloads, ADS and scopes. Damage is 55
(165 from behind). It hits devices and barricades for 45 (×3 with a crowbar), so three swings
open a wooden barricade, as in Siege. The knife slot (3) still works as before.

**Burst fire.** One trigger pull on the Talon fires three rounds at 1000 RPM. The burst
finishes even if you let go, and holding the trigger doesn't start another one.

**DMR.** The Marshal keeps its 2× scope up between shots (no bolt), unlike the snipers.

**Flinch.** Getting hit kicks your aim by up to 5° (less on a helmeted headshot), decaying in
about 0.1 s. The first-person camera shows it fully.
**Damage model.** Damage = base × range falloff (`rangeMod ^ (distance / 12.7 m)`) × hit-group
multiplier. The multipliers are head ×4, chest ×1, stomach ×1.25, and legs ×0.75.

Armor (Kevlar) protects the chest and stomach, and a helmet also protects the head. On a
protected hit, `armor pen.` % of the damage goes to health and half of the rest is taken from
armor. As in CS, the Ravager one-taps a helmeted head and the Sentinel does not; the Longbow
kills with one body shot but not with a leg shot.

**Accuracy.** Total spread = base + stance (standing or crouched) + movement (above 34% of max
speed) + airborne + accumulated fire inaccuracy. Fire inaccuracy decays over the weapon's
recovery time. Running with a rifle is very inaccurate.

**Recoil.** Each gun has a **fixed, learnable spray pattern**: a vertical climb for the first
~9 shots, then a horizontal sway. Bullets follow the pattern exactly, and the camera shows 45% of
it (CS "view punch"), so you pull the mouse down and against the sway. The pattern recovers when
you stop firing.

**Crosshair and sights show where the bullet goes.** The next shot leaves along the view plus the
full recoil punch and flinch (`shotAngles` in `Ballistics.ts`). The HUD projects that direction
through the camera every frame (`MatchView.aimNdc`) and puts everything you aim with on it:
* The crosshair climbs with the 55% of the punch the camera doesn't show, and drifts with stun
  sway (random camera shake is left out). Settings → Crosshair → *Follow recoil* turns this off
  for a CS-style fixed crosshair.
* The dynamic gap is the real spread cone (`spreadCone`): inaccuracy plus, for shotguns, the
  pellet pattern. Running and jumping open it as far as the bullets actually spread.
* Snipers show it too when unscoped, so the no-scope penalty is visible.
* Aimed, the view model turns the whole gun about the eye onto the same point (converted from the
  world camera's FOV to the view model's), so iron sights, red dots, holo rings, the ACOG chevron
  and sniper reticles all sit on the bullet. Hip-fire motion (sway, bob, crouch and landing
  offsets, the free kick) fades out as the sights come up, so the sight picture stays true.

The camera receives the new recoil on the firing tick and eases the visual response across
render frames. Bullet recoil remains deterministic. Automatic fire carries fractional-tick
cooldown time forward so a 600 RPM rifle averages 600 RPM rather than rounding every shot
up to seven ticks. Reloading and drawing another weapon clear the previous spray state.

**Alt fire (right mouse).**
* Snipers cycle through two zoom levels and unscope after each shot, then re-scope automatically.
  The scope has a duplex reticle with a lit centre dot and the zoom readout. A ring opens to the
  real spread whenever moving, firing or jumping has pushed it past the gun's settled accuracy.
* Other guns aim down sights: 1.18× zoom, 25% less spread, 20% slower movement. The crosshair
  fades out as the sights come up.
* The Hammer RPG aims through a 2× ranging scope. Its chevrons for 25 / 50 / 75 / 100 m are
  solved from the rocket's real flight (`launcherHoldover`).
* The Thumper's iron sights get range marks for 10–50 m under the front post: put the target
  on its distance mark to land the 40 mm shell.
* The knife stabs.

**Iron sights.** Every gun's model records its sight line (`userData.ironY`). The eye sits on that
line when aiming, and the front post's tip is exactly on it:
* Rifles and SMGs have a notched rear sight and a front post.
* The carry-handle guns (Tempest, Talon, Bulwark) have both sights on top of the handle.
* The Anvil's sights stand on risers above its feed cover.
* Pistols have a notch-and-post slide.
* The Breacher has low bead sights, so a fitted dot sits clear above them.
* The Thumper has a raised ladder.

`tests/game/aiming.test.ts` casts rays down every gun's sight line to keep it clear.

## Buying shortcuts, markers and tips

* **Rebuy** (buy menu **R** or the button) buys again what you bought last round.
  * Grenades and gadgets are only topped back up to last round's counts.
  * Guns bring their Gunsmith attachments back for free.
  * Anything you still own is skipped.
* **Auto-buy** (buy menu **A**) buys:
  * the best primary you can afford while keeping $650 for a vest (Attackers:
    Ravager → Galeforce → Mako → Vespa; Defenders: Sentinel → Tempest → Mako → Hornet);
  * then a helmet (or a vest);
  * a defuse kit on Defense;
  * then flash, smoke, molotov / second flash and frag while money lasts.
* **Objective markers** (Settings → Game):
  * bomb-site letters with distance, hidden while you stand in that site;
  * once the bomb is planted, a pulsing marker on it with the seconds left (both teams);
  * a dropped bomb, for Attackers only.
  * Markers behind you stick to the screen edge.
* **Gameplay tips** (Settings → Game): one short tip per round for the first six rounds,
  covering buying, prone/slide, pings and leaning, killstreaks and mantling, suppressors,
  and quick melee / inspect / weapon light. Tips use your current key bindings.
* **Paper doll** (Settings → Game, off by default), after Minecraft Bedrock's paper doll and
  the Java *Paper Doll* mod:
  * a small live model of your character in the top-right corner, in your outfit and holding
    your current item;
  * it copies what you do: shots with recoil and a muzzle flash, reloads, throws, melee and
    knife swings, flinches, crouch, prone, slides, jumps, leans and planting or defusing;
  * it swings a little as you turn, and turns side-on when you go prone or slide;
  * **When acting** shows it during those moves (not plain walking), and after a weapon swap,
    then tucks it away 2 seconds later. **Always** keeps it on screen;
  * hidden when you're dead, on a camera or drone feed, or during the killcam. When you
    spectate a teammate it shows them;
  * the kill feed moves to its left, and the size slider runs from 70% to 150%.

## Combat feedback (v1.7.7)

* **Grenade trajectory preview** (Settings → Game, on by default).
  * While you hold a grenade ready (left, right or both mouse buttons), a dotted arc shows the
    flight it would take right now, with a dot at every bounce and a ring where it goes off.
    Smokes and firebombs also outline the ground they will cover.
  * It runs the simulation's own grenade physics, so the grenade goes off exactly at the marker
    (`tests/game/throw-preview.test.ts`). It follows your live mouse look and only you see it.
* **Grenade warning** (on by default). A pulsing badge on a ring around the crosshair points at
  each live frag, firebomb, flashbang or stun grenade close enough to hurt or blind you, with its
  distance.
  * Your own grenade counts once it has left your hand.
  * A teammate's frag or firebomb counts only with friendly fire on; their flashbangs and stuns
    always do.
  * Grenades walled off from you are left out.
* **Damage numbers** (on by default). Each hit you land floats its damage off the wound. Hits on
  the same target within 0.9 s add up on one number: gold for headshots, pale blue into armor,
  red once the target is down.
* **Reload prompt.** RELOAD (with your key) under the crosshair when the magazine is empty, LOW
  AMMO in its last fifth, NO AMMO when the reserve is gone too. The last quarter of a magazine
  also rings hollow as you fire, so you hear it running dry.
* **Near misses.** A round passing within about 2 m of your head cracks past with a hiss,
  darkens the edges of the screen for a moment and flinches the camera slightly. Your aim and
  the crosshair do not move.
* **Sound.**
  * World sounds are muffled and quieter when walls stand between you and them. The check traces
    from the camera to the source, to either side of it and above it, so a sound just round a
    corner or through a doorway is only partly muffled.
  * Gunfire indoors rings with a short room reverb: longest in the tall factory halls, tighter in
    offices, nearly dry outside.
  * Bullets striking metal, glass, wood and fabric each sound different, spent brass tinkles on
    the floor, and aiming, scoping and jumping have their own foley.

## Gunsmith (weapon attachments)

Buy-menu tab **4** lets you customise your primary and secondary, like CoD's Gunsmith and
Siege's attachments.

**Rules.**
* There are eight slots: optic, muzzle, barrel, underbarrel, laser/light, magazine, stock
  and ammo.
* A gun can run at most **5 attachments**, as in CoD Modern Warfare, so you have to choose.
* What a gun can take depends on its class.
  * Snipers and the DMR already have a scope, so they have no optic slot.
  * Bullpups (Tempest, Talon, Mako) have no stock slot.
  * The Warden has an integral suppressor, so no muzzle slot.
  * The tube-fed Breacher has no magazine slot. The Judge takes no optic.
  * Launchers and the knife take nothing.
* **You buy an attachment once per gun, and it stays unlocked for the rest of the half,
  even if you die.** Buy the same gun again in a later round and your fitted loadout comes
  back for free. Swapping or removing attachments you own is free during buy time.
  Everything resets at halftime along with money.
* The prices are set for that. A grenade, used up in one round, costs $200–$600; an attachment costs
  $100–$500 and pays off over several rounds. A full five-attachment rifle costs about
  $1,200, which is roughly two rounds of utility, once per half.
* Dropped guns keep their attachments, so you can pick up an enemy's kitted rifle.
* Suppressed guns don't fire tracers and don't ping the enemy radar. Every unsuppressed shot
  shows you on the enemy radar for 0.9 s (CoD-style).

| Slot | Attachment | Price | Fits | Pros | Cons |
|---|---|---|---|---|---|
| optic | **Red Dot Sight** | $200 | pistol, smg, shotgun, rifle, lmg | Clear red-dot reticle; ADS zoom 1.25×; ADS spread −7% | — |
| optic | **Holographic Sight** | $250 | smg, shotgun, rifle, lmg | Ring-and-dot reticle; ADS zoom 1.4×; ADS spread −15% | ADS move speed −5% |
| optic | **2.5× ACOG** | $450 | rifle, lmg | 2.5× magnified scope; ADS spread −30% | ADS move speed −15%; Draw time +10% |
| muzzle | **Suppressor** | $400 | all guns | Quiet shots: no radar ping, enemies hear you at ~⅓ the distance; No tracers, tiny muzzle flash; Recoil −8% | Damage falls off sooner at range |
| muzzle | **Compensator** | $200 | pistol, smg, rifle, lmg | Horizontal recoil −25% | Vertical recoil +4% |
| muzzle | **Flash Hider** | $100 | smg, rifle, lmg, sniper, shotgun | Hides most of the muzzle flash; Recoil −5% | — |
| muzzle | **Muzzle Brake** | $250 | smg, rifle, lmg, sniper | Vertical recoil −18%; Faster spread recovery | Horizontal recoil +5% |
| muzzle | **Choke** | $150 | shotgun | Pellet spread −30%; Longer effective range | — |
| barrel | **Extended Barrel** | $250 | SMG, shotgun, rifle, LMG, sniper | Damage falls off ~20% slower; Muzzle velocity: stronger penetration (+10%) | Move speed −3%; Hip-fire spread +10% |
| barrel | **Short Barrel** | $150 | smg, shotgun, rifle | Move speed +4%; Hip-fire spread −15%; Draw time −15% | Damage falls off sooner |
| underbarrel | **Vertical Grip** | $250 | smg, shotgun, rifle, lmg | Vertical recoil −15% | — |
| underbarrel | **Angled Grip** | $200 | smg, shotgun, rifle, lmg | Spread recovers 20% faster; Horizontal recoil −10%; ADS move speed +5% | — |
| underbarrel | **Bipod** | $300 | lmg, sniper | While crouched: recoil −40%, spread −40% | Move speed −2% |
| laser | **1 mW Laser** | $200 | pistol, smg, shotgun, rifle, lmg | Hip-fire spread −20%; Run-and-gun spread −10%; Beam only visible to you | — |
| laser | **5 mW Tac Laser** | $300 | pistol, smg, shotgun, rifle, lmg | Hip-fire spread −35%; Run-and-gun spread −20% | Bright green beam everyone can see |
| laser | **Tactical Light** | $200 | pistol, smg, shotgun, rifle, lmg | Toggle with L: dazzles enemies you point it at within 14 m (slower aim, glare) | Enemies see the beam when it is on |
| magazine | **Extended Mag** | $300 | pistol, smg, shotgun, rifle, sniper | Magazine +50% (shotguns +3 shells) | Reload +12%; Move speed −2% |
| magazine | **Fast Mag** | $250 | all guns | Reload −25% | — |
| magazine | **Drum Mag** | $500 | smg, rifle | Magazine ×2 | Reload +35%; Move speed −5%; Draw time +15% |
| stock | **Tactical Stock** | $200 | SMG, shotgun, rifle, LMG, sniper | Recoil −10%; Run-and-gun spread −10% | ADS move speed −5% |
| stock | **Skeleton Stock** | $150 | SMG, shotgun, rifle, LMG, sniper | Move speed +4%; ADS move speed +8%; Draw time −15% | Recoil +8% |
| ammo | **FMJ Rounds** | $350 | pistol, smg, rifle, lmg, sniper | Wall penetration +60%; Armor penetration +8% | Damage −3% |
| ammo | **Hollow Points** | $250 | pistol, smg, rifle | Damage +8% | Armor penetration −15%; Wall penetration −40% |

The stats panel next to the slots shows the gun's damage, range, recoil control, hip-fire
accuracy, run-and-gun spread, ADS zoom, mobility, reload speed and magazine. Each bar compares
the stock gun (white) with your fitted gun (green for better, red for worse).

**Optics in first person.**
* The red dot and holographic sights line the camera up with the optic and draw a crisp
  reticle when you aim down sights. The iron sights may co-witness low in the window but never
  reach the dot.
* The ACOG switches to a 2.5× scope view with a chevron reticle.
* All reticles follow the recoil onto the bullet's point.

**Lasers and the light.**
* The 1 mW laser beam is only visible to you; the 5 mW beam is visible to everyone.
* The Tactical Light toggles with **L**. An enemy inside its 14 m beam who is looking back at
  you gets a glare on screen, and bots aim 50% slower. Everyone can see the light cone.

## Utilities & gadgets

At most 4 grenades in total, and at most 2 flashbangs.

| Utility | Price | Max | Effect |
|---|---|---|---|
| Frag Grenade | $300 | 1 | 1.6 s fuse. Up to 98 damage over 8.5 m, blocked by walls, halved by armor. |
| Flashbang | $200 | 2 | 1.6 s fuse. Blinds for up to 4.6 s, scaled by distance and by how directly you were looking at it. Causes tinnitus and muffled sound. |
| Smoke Grenade | $300 | 1 | Deploys when it stops rolling. 4.6 m cloud for 18 s that blocks vision (bots included) and puts out fires. |
| Firebomb (Molotov / Incendiary) | $400 / $600 | 1 | Bursts on hitting the floor (or after 2 s). 3.2 m fire for 7 s at 32 DPS. A smoke puts it out. |
| Decoy | $50 | 1 | Fires fake shots that sound like your gun for 15 s, and shows as an enemy on the other team's radar. Bots hear it. |
| **Recon Pulse** (gadget) | $250 | 1 | Lands, then pulses 3 times. Every enemy within 12 m is outlined through walls for your team for 2 s and appears on your radar. |
| **Stun Grenade** | $250 | 1 | 1.4 s fuse, 7 m. Anyone with line of sight to the blast (teammates and you included) is stunned for up to 3.8 s: up to 50% slower movement, up to 55% lower mouse sensitivity (65% slower aim for bots), a wobbling, blurred view and a hum. Strength falls off with distance. |
| **Throwing Knife** | $200 | 1 | Thrown overhand at 27 m/s (underhand 15 m/s), and it drops with distance. A hit to the head or body kills; a leg hit does 70. It sticks where it lands, or falls at the victim's feet, and you pick it up by walking over it. |

| Gear | Price | Effect |
|---|---|---|
| Kevlar Vest | $650 | 100 armor |
| Kevlar + Helmet | $1000 ($350 upgrade) | Armor plus headshot protection |
| Armor Plate | $300 | +25 armor, stacking up to 150 |
| Crowbar | $150 | Hold Use (F) at a barricade to pry it off: wood 1 s, steel 4 s. Quick melee hits barricades 3× harder. Shown in your slots; swaps the quick-melee knife for the crowbar. |
| Defuse Kit | $400 (Defenders) | Defuse time 5 s |

Throwing works as in CS: left mouse throws overhand, right mouse lobs underhand, both together
give a medium throw. The throw angle is raised by up to 10° and inherits your velocity.

## Gadgets (slot 6) & camera network

Gadgets are Siege / Operation-One-style devices. They are bought in the **Gadgets** and
**Utilities** tabs of the buy menu and kept in their own slot (key **6** cycles). You can carry
up to 4 different gadget kinds (stim darts count as one). Left mouse throws or places the
selected gadget.

| Gadget | Side | Price | Max | Deploy | Notes |
|---|---|---|---|---|---|
| **Recon Drone** | Both | $300 | 1 | Throw | You take control as soon as it lands: WASD to drive, Space to hop, left mouse to ping. 30 HP. Bots send theirs on autopilot to the target site and auto-spot through it. |
| **Sticky Cam** | Both | $250 | 2 | Throw | Sticks to the first wall, floor or ceiling it hits. Can be watched from the camera network. 10 HP. |
| **Flock Cam** | Defenders | $400 | 1 | Place | Solar-powered auto-scan camera on a 2 m pole. It sweeps a 100° cone out to 20 m and automatically reveals Attackers to your team. Raises a team alert ("FLOCK CAM · 2 enemies spotted — A Long"). 25 HP. |
| **Trip Mine** | Attackers | $500 | 2 | Place | Laser claymore that arms after 1.5 s. A Defender crossing the 2.6 m beam sets it off after 0.35 s: up to 140 damage, directional, blocked by walls. Bot planters lay one across the bomb. Can be shot. |
| **Barbed Wire** | Defenders | $250 | 2 | Place | 2.6 m coil. Anyone inside moves at 40% speed and makes a loud rattle that bots can hear. Frags and knives cut it. |
| **Deployable Shield** | Defenders | $700 | 1 | Place | Waist-high (1.05 m) bulletproof plate with a viewing slit. It is a real collider: it stops bullets, players and bot pathing. 500 HP; explosives do extra damage to it. |
| **EMP Grenade** | Attackers | $350 | 1 | Throw | 1.4 s fuse, 9 m radius, works through walls. Destroys enemy cameras, drones and mines; jams building CCTV for 15 s; kills enemy Recon Pulses and decoys; jams enemy radar for 5 s. Fortifications are not electronic and are unaffected. |
| **Stim Pistol** | Both | $400 | 1 + 2 darts | Shoot | See below. |
| **C4 Charge** | Both | $500 | 2 | Throw | Sticks where it lands. **Z** detonates every charge you've placed: 150 damage over 5.2 m, opens barricades. 20 HP; EMP destroys it. |
| **Wooden Barricade** | Both | $200 | 2 | Place | Boards up the doorway you aim at (doors up to 4.2 m wide). Blocks movement, bot pathing and sight. Bullets pass through it, and it takes a quarter of their damage. 120 HP: three melee hits, a stim dart, explosives (×3) or a crowbar remove it. Boards work loose as it takes damage. |
| **Steel Barricade** | Defenders | $600 | 1 | Place | A bulletproof steel shutter for a doorway. Explosives (×2.5) or a 4 s crowbar pry get through; melee barely scratches it. |
| **Heartbeat Sensor** | Both | $350 | 1 | Hold | While you hold the tablet it sweeps every 1.25 s and shows enemies within 24 m in a 150° cone in front of you, through walls. Each sweep beeps, and enemies within 7 m can hear it. |
| **Ammo Box** | Both | $350 | 1 | Place | Each teammate can press F at it once per round to refill reserve ammo and gain one stim dart (up to 4). |

**Stim Pistol.** One dart loaded and two in reserve, auto-reloading in 1.1 s. Darts fly at
38 m/s and drop with gravity.
* A teammate hit by a dart heals 60 HP over 5 s; pressing **H** injects you for 15 HP over 5 s.
* Each repeat stim on the same person within 12 s is multiplied by 0.55 (60 → 33 → 18).
* An enemy hit by a dart takes 8 damage. A dart does 100 damage to a gadget, so it pops cameras,
  drones and wooden barricades (but only scratches steel). You can also quick-melee with it out.
* Pairing it with an Ammo Box gives a third spare dart.

**Camera network (T):**
* Press T to cycle through your team's feeds (your own drones first), Q/E or the mouse wheel to
  switch feeds, and T again to exit. Feeds can't be opened during freeze time, so the building
  CCTV never shows Defenders where the Attackers spawned that round.
* While you watch a feed, your body stands still in the world. Taking damage, including fire,
  kicks you out of the feed (but not out of a cruise missile you're steering).
* A drone that lands while you are planting or defusing waits: open its feed with T when your
  hands are free.
* Anything visible on a feed you are watching is spotted on your team's radar.
* Left mouse **pings** every enemy within a 22° cone of the crosshair. They are outlined
  through walls for your team for 4 s.
* Fixed cameras can turn ±75° from their mount.

**Building CCTV** (Defenders, free every round):
* Six wall-mounted cameras: A Site, A Long, Mid, B Site, Shipping, Loading Yard.
* Any bullet destroys them. An EMP jams them.
* Attacker bots shoot enemy cameras, drones and mines they spot.

## Movement (Source-style)

* Ground acceleration and friction (`sv_accelerate 6.2`, `sv_friction 5.2`) and air-strafing
  (`sv_airaccelerate 12`, 30 u/s wish cap).
* Max speed depends on the weapon (knife 250 u/s ≈ 6.35 m/s, Longbow 200 u/s).
* Walking (Shift) moves at 52% speed and makes **no footsteps**. Crouching moves at 34% speed and
  improves accuracy.
* Jumps reach about 1.4 m. You can step up ledges of 0.46 m or less. Falling faster than about
  11 m/s causes damage.
* Being shot slows you down ("tagging").

Opposite movement input applies a modest 1.15× braking acceleration. Crouch speed follows
the capsule transition continuously; diagonal input cannot exceed the grounded speed cap.
A fresh jump press is buffered for 90 ms before landing, but holding jump never repeats it.
Landings retain most horizontal momentum and briefly reduce accuracy in proportion to
impact speed. Tiny step-downs do not incur the full jump accuracy penalty. Stair movement
is eased visually without smoothing mouse aim.

**Crouch-jump.** Pressing crouch in the air tucks your legs up 0.46 m while your eyes stay
level, so a crouch-jump clears ledges and boxes about 1.7 m high that a plain jump can't.
Un-crouching in the air lowers your feet again only if there's room.

**Mantle.** Hold jump while moving into a ledge to climb onto it.
* It works on ledges up to 1.75 m above the floor you jumped from, with room for a crouched
  body on top.
* It never triggers for walls, thin edges or shelves.
* From the floor it only triggers when a jump couldn't clear the ledge; otherwise you just
  hop onto it as in CS.
* It takes 0.34–0.56 s depending on height. You can't shoot while climbing, and the weapon
  swings aside.

**Coyote time.** A jump pressed up to 0.1 s after running off an edge still counts.

**Prone.** In the default **Hold** crouch mode, hold the crouch binding (C by default)
while standing still for 0.55 seconds.
* Moving, firing or aiming restarts that timer, so CS-style crouch-walking, crouch-spraying
  and crouched peeks stay crouched.
* In **Toggle** mode (Call of Duty), tap C to crouch or stand and hold C for about 0.4 s to
  go prone. Prone then stays latched: tap C to come up to a crouch, or press Space to stand
  (no hop).

The player lowers over 0.38 seconds into a 0.58 m tall stance with a 0.43 m eye height. Crawl
speed is 18% of the held weapon's run speed. In Hold mode, release crouch to rise. Low
ceilings keep the body down until there is room. The longer body checks walls when entering, crawling and turning. Bots
and aim assist target the low damage volumes, and replays retain the stance. Settled
prone aim is slightly steadier; crawling and stance changes add spread. Jumping and
mantling are unavailable while prone. Going down or up makes a cloth-and-gear rustle.
* Defender bots that reach a hold with a sightline longer than 16 m go prone 30% of the time.
  They keep firing from the floor at range and get up when an enemy is within 8 m.
* Bots otherwise keep their deliberate crouch-spray behavior.

**Slide.** Press Left Alt (rebindable) while grounded and moving forward at 3.6 m/s or
faster. The slide uses existing momentum, decelerates at 6.2 m/s² and lasts at most
0.62 seconds. Its 1.35-second recovery begins after that duration. Holding the key never
repeats it. Sliding makes an audible scrape, lowers the eye to 0.92 m, reduces accuracy,
and cannot begin while prone, airborne or frozen. Walls, jumping and low speed end it.
Planting and defusing wait until the slide ends. Bots occasionally slide while running a long
straight route; it is cosmetic, since slides never add speed.

**Objective feedback.** Plant/defuse progress shows seconds remaining. Defusing occupies
both hands, cancels reload/burst state, and requires a clear line to the bomb. Releasing
Use aborts progress and immediately allows weapon actions again.

**Jump stamina.** Each jump adds fatigue that fades over about half a second on the ground.
Rapid bunny hops get up to 22% lower and lose up to 25% of their horizontal speed, so
jump-spamming around corners is a poor way to peek.

### Tilt aim / lean

Hold **Q** or **E** (or set them to toggle) to tilt around a corner. The camera rolls 13° and
shifts 0.5 m sideways. Your **head and chest hitboxes move with the lean**, so a peek exposes
less of your body. Leaning is limited by nearby walls, and you move 15% slower while leaning.
Bots don't lean yet.

## Killstreaks

Call of Duty-style rewards, scaled down for 5v5 Search & Destroy. Kills in one life count;
dying resets the count, but earned streaks are kept until you use them (key **7** uses the
oldest one). Streaks are cleared at halftime, and kills made by streaks don't extend the
count. Toggle them in Play → match setup.

| Streak | Kills | Effect |
|---|---|---|
| **UAV** | 3 | A recon plane circles the map for 25 s and sweeps every enemy onto your team's radar every 2 s. |
| **Counter-UAV** | 4 | Jams the enemy team's radar for 20 s. |
| **Hunter Drone** | 5 | An autonomous quadcopter launches from your position, paths through the building to the nearest enemy and detonates (140 damage over 4.6 m). 25 HP; it can be shot down. It times out after 30 s. |
| **Cruise Missile** | 6 | You steer a missile from 95 m up with a white-hot thermal view that shows enemies through the roof. It punches through ceilings. Left mouse boosts (30 → 78 m/s). Impact: 260 damage over 9.5 m. Your body stays where you were, so you can be killed while steering. |

In CoD: Modern Warfare II (2022) the UAV costs 4 kills, the Counter-UAV 5 and the Cruise
Missile 6. We lowered the early streaks by one because S&D rounds have no respawns.

## Final killcam, moments and pings

* **Final killcam.**
  * The game keeps the last 7.5 s of every agent's position, view, held item and animation
    state, plus shots, impacts, hits, explosions and kills.
  * When a round is won by an elimination, 1.3 s after the round ends the deciding kill
    replays from the killer's eyes. The clip runs from 4.2 s before the kill to 1.4 s after,
    dropping to 35% speed around the shot.
  * Kills by explosives or killstreaks (and kills made after the killer had died) use a
    camera that circles the victim instead.
  * The round pauses during the replay and continues 1.2 s after it. Space or Use skips it,
    and Settings → Game turns it off.
  * On match point it's labelled *Final Killcam*.
* **Moments.**
  * A "1 v N" banner appears when you become the last player alive on your team, and
    winning that round shows "CLUTCH".
  * Multi-kills in one round show DOUBLE, TRIPLE and QUAD KILL; killing the whole enemy team
    (3 or more players) shows ACE.
  * Each callout has a stinger. The announcer (browser speech synthesis) calls plants,
    defuses, round winners, clutches, aces and killstreaks.
* **Pings** (middle mouse, 0.8 s cooldown).
  * Pinging an enemy within about 0.7 m of your crosshair (with line of sight) spots them on
    your team's radar for 5 s, and the marker follows them for 4 s.
  * Otherwise the ping marks the point you're looking at for 6 s.
  * Idle bots on your team treat a ping like a loud noise there and go to check it.

## Aim assist

An optional assist for the player (never bots), set in Settings → Game: Off / Low / Medium / High.
Everything is measured from where the next bullet goes (view plus recoil punch), the same point
the crosshair shows.
* **Target point:** the nearest point of a visible enemy's body column, from the waist to the
  middle of the head (lean and prone poses included). Aiming anywhere on the body gets no
  vertical drag, so the assist never pulls you off a headshot onto the chest.
* **Friction:** mouse sensitivity drops (to 72% / 56% / 42% on the body) while the shot is
  within a cone around that point. The cone is the angle that covers 0.7 / 1.0 / 1.3 m at the
  enemy's distance, clamped between 1.2° and 5° / 7° / 9°.
* **Magnetism:** a pull toward that point that's proportional to the remaining error and
  capped at 7 / 12 / 18 °/s. Magnified scopes divide the cap by the zoom so the zoomed view
  doesn't swing. It works at full strength while you move the mouse or strafe and at 30% while
  you hold still. The vertical pull is weaker so recoil control stays yours.
* **Tracking:** while you're aiming or moving, the view follows 25% / 40% / 55% of the target's
  motion across your screen (theirs and your own strafing). It's scaled by how close you are to
  them, so strafe duels stay on target.
* It ignores teammates and anything behind walls or smoke, switches off while you're flashed,
  and doesn't apply while you watch a camera or steer a missile.

## Bots

* **Navigation:** a 0.5 m walkability grid built from the map, A\* with wall-clearance costs,
  and string-pulled smoothing.
* **Team coach (Attackers):** each round it picks a site and a strategy:
  * **Rush:** go immediately.
  * **Execute:** wait about 15 s, then all push together.
  * **Split:** two routes into the same site.
  * **Default:** take map control slowly, with one lurker on the other site.
  * Every bot gets a route through named waypoints and waits at a staging point. On the
    execute, it throws smokes, flashes, or a Recon Pulse into the site. The bomb carrier plants;
    the others take post-plant positions. If the bomb is dropped, the nearest bot fetches it.
* **Team coach (Defenders):** a 2-A / 2-B / 1-mid setup on named hold spots.
  * Bots rotate when two or more Attackers are spotted near a site or when a teammate dies there.
  * After a plant they gather about 17 m from the bomb, retake together, and the closest one defuses.
  * They save (run away) if the defuse can't finish in time.
* **Combat:**
  * **Perception:** field of view plus line of sight, blocked by smoke and by flashes.
  * **Reaction:** delayed by difficulty. Bots holding a pre-aimed angle react faster; bots
    running in react slower.
  * **Aim:** initial error closes over time, but smooth persistent drift remains. Bots sample
    target positions at difficulty-specific intervals and estimate motion from the last sample;
    direction changes can fool them. Recoil compensation and headshot preference are lower at
    every level. Losing visibility stops aimed fire immediately; reappearing targets require
    another reaction window.
  * **Shooting style:** counter-strafe to shoot, tap or burst at long range, crouch-spray when
    anchoring, and switch to the pistol instead of reloading in close fights.
  * **Senses:** they hear footsteps, gunshots, reloads and decoys (walls muffle sound) and turn
    toward the noise.
  * **Utility:** frags at last-known positions, Molotovs on defusers, and Defenders throw at
    pushes they can hear.
* **Economy:** full buy, force buy, or eco depending on money and loss streak; occasional AWP-style
  buys; utility and kits.
* **Gadgets:**
  * Attacker bots buy drones, EMPs, sticky cams and trip mines. They send scout drones at round
    start, throw an EMP and a sticky cam on the execute, and the planter mines the bomb.
  * Defender bots set up a Flock Cam, wire and shield at their hold spot.
  * Both sides shoot enemy devices they spot, including Hunter Drones. Attackers walk up to
    enemy wooden barricades within 7 m and hack through them with quick melee.
  * Defenders board up a doorway 2.5–13 m in front of their hold (steel first if they have it).
  * Bots self-stim below 60 HP, shoot stim darts at hurt teammates (leading moving targets
    and allowing for dart drop), quick-melee at point blank, and call in earned killstreaks
    when no enemy is in sight. Bots fire cruise missiles at the most recently spotted enemy.
  * Rich bots sometimes buy LMGs, launchers, the Mako, the Reaper, the Talon or the Marshal,
    plus plates, stims, crowbars and stun grenades. Attackers stun the site on an execute, and
    Defenders throw stuns at pushes they can hear.
  * Stunned bots aim 65% slower.
* **Difficulty:** Easy / Normal / Hard / Expert scale reaction time, aim speed, aim error, spray
  control, FOV, headshot preference, burst recovery, tracking delay, and utility use.

| Level | Base reaction | Tracking sample interval | Recoil compensation | Head aim preference |
| --- | --- | --- | --- | --- |
| Easy | 950 ms | 280 ms | 6% | 4% |
| Normal | 620 ms | 220 ms | 30% | 14% |
| Hard | 400 ms | 160 ms | 58% | 28% |
| Expert | 280 ms | 120 ms | 76% | 42% |

Reaction varies with awareness and movement, with a floor of 80% of the base. These are
target selection preferences, not guaranteed hit or headshot rates. Automatic fire has
short recovery pauses on every level, and semi-auto bots release the trigger between shots.

### Player precision and shot feedback

Human hitscan gunshots use 18% less random inaccuracy at the hip and 28% less while aiming
(on top of weapon ADS modifiers). Movement, jumping, landing, bloom and deterministic
recoil still matter. Shotgun pellet pattern width stays weapon-specific. Launchers retain
their original ballistic spread.

An otherwise missed human gunshot may graze an enemy within 5.5 cm of a body volume or
2.2 cm of a head volume. This fixed tolerance follows crouch, lean, prone and enemy scaling;
it never widens with range. Exact hits take priority, so chest hits remain chest hits.
Teammates, bots, melee, gadgets and penetrated shots keep exact hitboxes. Walls, shields,
smoke and blindness block edge assistance. The bullet and tracer keep their straight path.
The existing Off/Low/Medium/High aim setting separately controls reticle friction and pull;
tracking shares the pull rate limit, and a covered aim point never attracts the reticle.

Sights show current simulation recoil while camera recoil remains smoothed. Tracers start
with fresh geometry at the actual muzzle and end at the resolved shot point. Muzzle flashes
are shorter, fade out, and narrow during ADS; material-specific impacts keep concrete dust,
metal sparks and pale glass fragments distinct without lingering clouds over the target.

Research informing these choices (reviewed November 2, 2026):

* [Riot: The State of Hit Registration](https://playvalorant.com/en-us/news/dev/the-state-of-hit-registration/)
  distinguishes correct hit outcomes from readable feedback. Here, the sights, shot traces
  and effects share the resolved simulation state.
* [Bungie: May 5, 2022 weapon discussion](https://www.bungie.net/7/en/News/article/51319)
  distinguishes accuracy, bullet magnetism, and reticle friction/adhesion. Our adaptation uses
  small fixed hit tolerances and separate reticle assistance, retaining recoil and movement costs.
* [Michael Booth: The Official Counter-Strike Bot, GDC 2004](https://media.gdcvault.com/gdc04/slides/making_of_official.pdf)
  describes aim offsets, view drift, weapon proficiency and human reaction times. Those
  principles inform our persistent drift, delayed motion estimates and difficulty-specific pauses.

The exact values above are local design choices, validated by the firing-lane tests in
`tests/game/hit-registration.test.ts` and `tests/game/bot-accuracy.test.ts`, plus browser gunplay checks.
The fixed 20 m moving-target test (six seeds, eight seconds each, stationary Sentinel bot
against a player strafing through the real movement system) measured hit rates of 15% /
17% / 27% / 35% from Easy to Expert. These isolate aiming, not match win rates.

Use `npm run balance` to measure round-win rates after tuning; the older 55% Attacker
baseline predates the current gunplay changes. The simulation includes plants, defuses and utility in most
rounds.

## Customization

* **Agents:** six presets (three per side), plus gear style (field shirt, hi-vis vest, plate
  carrier, long coat), headgear (cap, beanie, ballistic helmet, balaclava, comms headset,
  bandana), jacket / trousers / accent colors, and skin tone. A separate look is saved for each
  side.
* **Loadout:** ten weapon finishes, from Consumer to Covert (camo, digital, hazard stripes,
  gradient fades, hex, gold), chosen per weapon. They show on your view model and in the
  third-person model.
* **Crosshair editor** (CS-style): classic, dot or circle style; color, size, gap, thickness,
  dot, outline, opacity, a dynamic spread gap, and *follow recoil*. It is drawn on whole device
  pixels, so it stays crisp at any display scaling.
* **Settings:**
  * Game: sensitivity (CS scale, 0.022°/count), zoom sensitivity, invert Y, FOV (4:3
    horizontal, like CS), view-model FOV, left-handed view model, lean and ADS hold/toggle,
    radar rotation and zoom, FPS counter.
  * Audio: volume levels.
  * Video: quality preset and resolution scale.
  * Controls: every key can be rebound.

Everything is saved to `localStorage`.
