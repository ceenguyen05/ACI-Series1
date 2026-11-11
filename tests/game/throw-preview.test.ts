import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { OUTFITS } from '../../src/config/cosmetics';
import type { UtilityId } from '../../src/config/utilities';
import { emptyCommand } from '../../src/sim/entities/Agent';
import { equip } from '../../src/sim/combat/WeaponSystem';
import { Match } from '../../src/sim/mode/Match';
import { ACI_HQ } from '../../src/sim/maps/aciHq';

const look = { T: { ...OUTFITS.find((o) => o.team === 'T')!.look }, CT: { ...OUTFITS.find((o) => o.team === 'CT')!.look } };
const DT = 1 / 64;
/** Trigger mask held while priming (1 left = overhand, 2 right = underhand, 3 both = medium) and the matching strength. */
const STRENGTH = { 1: 1, 2: 0.45, 3: 0.72 } as const;

/** A player alone on ACI HQ, standing at (x, z) and aiming, with one grenade of `kind` drawn. */
function setup(kind: UtilityId, x: number, z: number, yaw: number, pitch: number) {
  const m = new Match({ map: ACI_HQ, difficulty: 'normal', playerTeam: 'T', playerName: 'P', playerLook: look, seed: 7, rules: { teamSize: 1 } });
  m.skipFreeze(); m.step(DT);
  const p = m.player!;
  for (const a of m.agents) if (a !== p) a.alive = false;
  m.debugTeleport(p, x, z, yaw, pitch);
  p.grenades[kind] = 1;
  equip(m, p, 'grenade', kind);
  p.wpn.drawUntil = 0;
  return { m, p };
}

describe('grenade throw preview', () => {
  // overhand frag off a wall, an underhand smoke rolled along the floor, a medium firebomb into the floor, a lobbed flash
  const throws: [UtilityId, 1 | 2 | 3, number, number, number, number][] = [
    ['frag', 1, 20.5, -28, 1.4, 0.25], ['smoke', 2, -8, -1, 1.57, 0.05], ['fire', 3, 10, 4, 0, -0.1], ['flash', 1, -1, 22, 0, 0.6],
  ];
  for (const [kind, mask, x, z, yaw, pitch] of throws) {
    it(`${kind}: the predicted flight ends exactly where the real grenade goes off`, () => {
      const { m, p } = setup(kind, x, z, yaw, pitch);
      const hold = { ...emptyCommand(), yaw, pitch, fire: (mask & 1) > 0, alt: (mask & 2) > 0 };
      for (let i = 0; i < 3; i++) { m.setPlayerCommand(hold); m.step(DT); }
      expect(p.wpn.throwPrimed).toBe(mask);
      const pred = m.utility.predict(p, kind, STRENGTH[mask], DT);
      expect(pred.path.length).toBeGreaterThan(10);

      let at: Vector3 | null = null;
      const offs = [m.events.on('detonate', (e) => { at ??= e.pos.clone(); }), m.events.on('fireOut', (e) => { at ??= e.pos.clone(); })];
      for (let i = 0; i < 64 * 8 && !at; i++) { m.setPlayerCommand({ ...emptyCommand(), yaw, pitch }); m.step(DT); }
      for (const off of offs) off();
      expect(at).not.toBeNull();
      const end = at as unknown as Vector3;
      // a firebomb's fire is placed on the ground under where it burst; everything else goes off where it is
      if (kind === 'fire') expect(Math.hypot(end.x - pred.end.x, end.z - pred.end.z)).toBeLessThan(0.01);
      else expect(end.distanceTo(pred.end)).toBeLessThan(0.01);
    });
  }

  it('predicting a throw changes nothing in the match', () => {
    const { m, p } = setup('frag', 20.5, -28, 1.4, 0.25);
    const twin = setup('frag', 20.5, -28, 1.4, 0.25).m;
    const fired: string[] = [];
    const off = m.events.onAny((type) => fired.push(String(type)));
    const before = { pos: p.pos.clone(), vel: p.vel.clone(), grenades: p.grenades.frag, time: m.time };
    const pred = m.utility.predict(p, 'frag', 1, DT);
    off();
    expect(pred.bounces.length).toBeGreaterThan(0);
    expect(fired).toEqual([]);
    expect(m.utility.projectiles).toHaveLength(0);
    expect(p.pos.equals(before.pos) && p.vel.equals(before.vel)).toBe(true);
    expect(p.grenades.frag).toBe(before.grenades);
    expect(m.time).toBe(before.time);
    // the random stream is untouched (an identical match that never predicted draws the same
    // numbers), so a preview can never change how the round plays out
    expect([m.rng.next(), m.rng.next()]).toEqual([twin.rng.next(), twin.rng.next()]);
  });

  it('aims with the look it is given, not only the last simulated one', () => {
    const { m, p } = setup('frag', 20.5, -28, 1.4, 0.25);
    const ahead = m.utility.predict(p, 'frag', 1, DT);
    const turned = m.utility.predict(p, 'frag', 1, DT, { yaw: 1.4 + Math.PI / 2, pitch: 0.25 });
    // the first point is in the hand; the next ones head off in different directions
    const d0 = ahead.path[5].clone().sub(ahead.path[0]).setY(0).normalize();
    const d1 = turned.path[5].clone().sub(turned.path[0]).setY(0).normalize();
    expect(Math.abs(d0.dot(d1))).toBeLessThan(0.1);
  });
});
