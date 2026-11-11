import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { OUTFITS } from '../../src/config/cosmetics';
import { deriveDef } from '../../src/config/attachments';
import { angleDiff, yawTo } from '../../src/core/math';
import { emptyCommand } from '../../src/sim/entities/Agent';
import { inaccuracy } from '../../src/sim/combat/Ballistics';
import { Match } from '../../src/sim/mode/Match';
import { ACI_HQ } from '../../src/sim/maps/aciHq';

// Regressions found in the 1.7.7 simulation review. Each test pins one fixed bug.
const look = { T: OUTFITS[0].look, CT: OUTFITS[3].look };
const DT = 1 / 64;
const LETHAL = { health: 500, armor: 0 };
const run = (m: Match, seconds: number) => { for (let i = 0; i < Math.round(seconds / DT); i++) m.step(DT); };
function setup(opts: { playerTeam?: 'T' | 'CT' | 'spectator'; freezeTime?: number; seed?: number; teamSize?: number } = {}) {
  const m = new Match({ map: ACI_HQ, difficulty: 'normal', playerTeam: opts.playerTeam ?? 'spectator', playerName: 'P', playerLook: look, seed: opts.seed ?? 7,
    rules: { teamSize: opts.teamSize ?? 1, freezeTime: opts.freezeTime ?? 999 } });
  return { m, t: m.agents.find((a) => a.team === 'T')!, ct: m.agents.find((a) => a.team === 'CT')! };
}

describe('bot routes around shields and barricades', () => {
  it('counts overlapping blocks, so they can be lifted in any order', () => {
    const { m } = setup();
    const nav = m.world.nav, f = m.gadgets.doorFrames()[0];
    expect(nav.isWalkableAt(f.cx, f.cz)).toBe(true);
    nav.block(1, f.cx - 0.5, f.cz - 0.5, f.cx + 0.5, f.cz + 0.5);
    nav.block(2, f.cx - 0.2, f.cz - 0.2, f.cx + 1.5, f.cz + 1.5);
    nav.unblock(1);
    expect(nav.isWalkableAt(f.cx, f.cz)).toBe(false); // still under the second obstacle
    nav.unblock(2);
    expect(nav.isWalkableAt(f.cx, f.cz)).toBe(true);
    nav.unblock(3); // never blocked anything: no effect
    nav.block(4, f.cx - 0.5, f.cz - 0.5, f.cx + 0.5, f.cz + 0.5);
    nav.block(4, f.cx - 0.5, f.cz - 0.5, f.cx + 0.5, f.cz + 0.5); // re-blocking a key replaces it
    nav.unblock(4);
    expect(nav.isWalkableAt(f.cx, f.cz)).toBe(true);
  });

  it('reopens a doorway when its barricade goes, and after a round with a shield set up behind it', () => {
    const { m, t, ct } = setup({ freezeTime: 0.1 });
    run(m, 0.2);
    const nav = m.world.nav, f = m.gadgets.doorFrames()[0];
    const sx = f.alongX ? f.cx : f.cx + 2, sz = f.alongX ? f.cz + 2 : f.cz;
    const board = () => {
      m.debugTeleport(ct, sx, sz, yawTo(f.cx - sx, f.cz - sz));
      return m.gadgets.placeBarricade(ct, 'barricade', ct.eyePos(new Vector3()), ct.viewDir(new Vector3()));
    };
    m.debugTeleport(t, 10, 30, 0);
    expect(board()).toBe(true);
    expect(nav.isWalkableAt(f.cx, f.cz)).toBe(false);
    const bar = m.gadgets.devices.find((d) => d.kind === 'barricade')!;
    m.gadgets.damage(bar, 100, t, 'dart'); // one stim dart takes a wooden barricade down
    expect(bar.alive).toBe(false);
    expect(nav.isWalkableAt(f.cx, f.cz)).toBe(true);

    m.debugTeleport(ct, sx + (f.alongX ? 0 : 1.5), sz + (f.alongX ? 1.5 : 0), 0);
    expect(m.gadgets.placeAt(ct, 'shield', new Vector3(f.alongX ? f.cx : f.cx + 1, 0, f.alongX ? f.cz + 1 : f.cz), f.alongX ? 0 : Math.PI / 2)).toBe(true);
    expect(board()).toBe(true);
    m.applyDamage(t, ct, LETHAL, 'chest', 'sentinel', t.pos.clone(), new Vector3(0, 0, 1));
    run(m, 7);
    expect(m.round).toBe(2);
    expect(nav.isWalkableAt(f.cx, f.cz)).toBe(true);
  });
});

describe('rules and economy', () => {
  it('keeps the camera network closed during freeze time', () => {
    const { m } = setup({ playerTeam: 'CT' });
    const p = m.player!;
    m.setPlayerCommand({ ...emptyCommand(), yaw: p.yaw, cams: true });
    m.step(DT);
    expect(m.phase).toBe('freeze');
    expect(p.operating).toBeNull();
    m.setPlayerCommand({ ...emptyCommand(), yaw: p.yaw });
    m.skipFreeze(); m.step(DT);
    m.setPlayerCommand({ ...emptyCommand(), yaw: p.yaw, cams: true });
    m.step(DT);
    expect(p.operating).not.toBeNull(); // building CCTV opens once the round is live
  });

  it('rebuys only the last gun bought for each slot', () => {
    const { m } = setup({ playerTeam: 'T' });
    const p = m.player!;
    p.money = 5000;
    p.lastBuys = [{ kind: 'weapon', id: 'p30' }, { kind: 'weapon', id: 'judge' }];
    expect(m.rebuy(p)).toBe(1);
    expect(p.secondary?.def.id).toBe('judge');
    expect(p.money).toBe(5000 - 700);
  });

  it('never lowers plated armor when the helmet is bought', () => {
    const { m } = setup({ playerTeam: 'CT' });
    const p = m.player!;
    p.money = 5000;
    for (const id of ['kevlar', 'plate', 'plate', 'helmet'] as const) expect(m.tryBuy(p, { kind: 'gear', id })).toBe(true);
    expect(p.armor).toBe(150);
    expect(p.helmet).toBe(true);
  });

  it('gives no killstreak credit for a kill made after the killer died', () => {
    const { m } = setup({ freezeTime: 0.1, teamSize: 2 });
    run(m, 0.2);
    const t1 = m.agents.find((a) => a.team === 'T')!, ct1 = m.agents.find((a) => a.team === 'CT')!;
    m.applyDamage(t1, ct1, LETHAL, 'chest', 'sentinel', t1.pos.clone(), new Vector3(0, 0, 1));
    expect(t1.alive).toBe(false);
    m.applyDamage(ct1, t1, LETHAL, 'chest', 'frag', ct1.pos.clone(), new Vector3(0, 0, 1)); // their frag goes off after they died
    expect(ct1.alive).toBe(false);
    expect(t1.stats.kills).toBe(1);
    expect(t1.streakKills).toBe(0);
    expect(t1.streaks).toEqual([]);
  });

  it('launches no killstreak while planting or defusing', () => {
    const { m, ct } = setup({ freezeTime: 0.1 });
    run(m, 0.2);
    ct.streaks = ['missile'];
    ct.isDefusing = true;
    expect(m.killstreaks.activate(ct)).toBe(false);
    ct.isDefusing = false;
    expect(m.killstreaks.activate(ct)).toBe(true);
  });
});

describe('weapons and gadgets', () => {
  it('applies attachments\' hip-fire changes only away from the sights', () => {
    const { m } = setup({ playerTeam: 'T' });
    const p = m.player!;
    const stock = deriveDef('ravager', undefined), laser = deriveDef('ravager', { laser: 'laser5mw' });
    p.wpn.ads = false;
    const hip = [inaccuracy(stock, p), inaccuracy(laser, p)];
    p.wpn.ads = true;
    const ads = [inaccuracy(stock, p), inaccuracy(laser, p)];
    expect(hip[1]).toBeLessThan(hip[0] * 0.9);
    expect(ads[1]).toBeCloseTo(ads[0], 10);
  });

  it('does not play a knife swing when a thrown knife lands', () => {
    const { m, t } = setup({ freezeTime: 0.1 });
    run(m, 0.2);
    m.debugTeleport(t, -1, 22, 0, 0.1);
    const swings: number[] = [];
    m.events.on('knife', (e) => swings.push(e.agentId));
    m.ordnance.throwKnife(t, 1);
    run(m, 2);
    expect(m.ordnance.knives.length).toBe(1);
    expect(swings).toEqual([]);
  });

  it('holds a Flock Cam on the aim of whoever is watching it', () => {
    const { m, ct } = setup({ freezeTime: 0.1 });
    run(m, 0.2);
    const at = ct.pos.clone(); at.x += 1.5;
    expect(m.gadgets.placeAt(ct, 'flockCam', at, 0)).toBe(true);
    const cam = m.gadgets.devices.find((d) => d.kind === 'flockCam')!;
    m.gadgets.operate(ct, cam.id);
    m.gadgets.control(ct, { ...emptyCommand(), yaw: cam.baseYaw + 1, pitch: cam.basePitch }, DT, false);
    m.gadgets.update(DT);
    expect(Math.abs(angleDiff(cam.yaw, cam.baseYaw + 1))).toBeLessThan(1e-6);
  });

  it('replays a seeded match with a Hunter Drone exactly', () => {
    const replay = () => {
      const { m, t } = setup({ freezeTime: 0.1, seed: 11 });
      run(m, 0.2);
      m.gadgets.spawnHunter(t);
      run(m, 3);
      return m.agents.map((a) => `${a.pos.x.toFixed(5)},${a.pos.z.toFixed(5)},${a.health}`).join('|') + `|${m.rng.next()}`;
    };
    expect(replay()).toBe(replay());
  });
});
