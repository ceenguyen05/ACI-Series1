import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { OUTFITS } from '../../src/config/cosmetics';
import { emptyCommand, type Agent } from '../../src/sim/entities/Agent';
import { ZombiesMatch } from '../../src/sim/zombies/ZombiesMatch';
import { ACI_HQ_ZOMBIES } from '../../src/sim/maps/aciHqZombies';

// Regressions found in the 1.7.7 Zombies review.
const DT = 1 / 64;
const look = { T: OUTFITS[0].look, CT: OUTFITS[3].look };
const zombies = (players: 1 | 3, seed: number) =>
  new ZombiesMatch({ layout: ACI_HQ_ZOMBIES, difficulty: 'normal', players, length: 'short', playerName: 'P', playerLook: look, seed });
const steps = (m: ZombiesMatch, s: number) => { for (let t = 0; t < s - DT / 2; t += DT) m.step(DT); };
const down = (m: ZombiesMatch, h: Agent) => m.applyDamage(h, null, { health: 99999, armor: 0 }, 'chest', 'zombie', h.pos.clone(), new Vector3(0, 0, 1));

describe('zombies review fixes', () => {
  it('keeps reviving the first teammate when a second one goes down beside the reviver', () => {
    const m = zombies(3, 31);
    m.wavePhase = 'intermission'; m.phaseUntil = 1e6;
    m.allies.clear();
    const [r, second, first] = m.humans;
    m.debugTeleport(r, 4, -30, 0); m.debugTeleport(first, 4.9, -30, 0); m.debugTeleport(second, 8, -30, 0);
    down(m, first);
    steps(m, 43); // the reviver gets there late, so the bleed-out timer runs out mid-revive
    m.setPlayerCommand({ ...emptyCommand(), use: true, yaw: r.yaw });
    steps(m, 2.6);
    const progress = first.zp!.revive!.progress;
    expect(progress).toBeGreaterThan(0.8);
    m.debugTeleport(second, 3.1, -30, 0);
    down(m, second);
    steps(m, 2 * DT);
    expect(first.zp!.revive?.byId).toBe(r.id);
    expect(first.zp!.revive!.progress).toBeGreaterThan(progress);
    expect(first.alive && !first.zp!.dead).toBe(true);
  });

  it('drops the frenzy Max Ammo when the last zombie is a bomber that blows itself up', () => {
    const m = zombies(1, 7), p = m.player!;
    m.debugTeleport(p, 4, -30, 0);
    m.debugSetWave(11); m.step(DT);
    m.debugClear();
    m.spawned = m.waveTotal; // everything else already came and went
    p.armor = 500; p.maxHealth = 1e6; p.health = 1e6;
    const z = m.spawnZombie('bomber', 4, -26)!;
    Object.assign(z.zombie!, { mode: 'fuse', modeAt: m.time, modeUntil: m.time + 0.02 });
    steps(m, 40 * DT);
    expect(m.waveKindNow).toBe('frenzy');
    expect(m.powerUps.map((u) => u.kind)).toContain('maxAmmo');
  });

  it('counts a wave cleared before you fall in the break after it', () => {
    const m = zombies(1, 7), p = m.player!;
    m.debugTeleport(p, 4, -30, 0);
    m.debugSetWave(5); m.step(DT);
    m.debugClear(); m.spawned = m.waveTotal;
    const z = m.spawnZombie('bloater', 4, -28.8)!;
    m.applyDamage(z, p, { health: 99999, armor: 0 }, 'chest', 'p30', z.pos.clone(), new Vector3(0, 0, 1));
    m.step(DT);
    expect(m.wavePhase).toBe('intermission');
    expect(m.wavesCleared).toBe(5);
    m.endGame(false);
    expect(m.wavesCleared).toBe(5); // the end screen says "survived 5 waves", not 4
  });

  it('lets you buy at the Armory while a downed teammate beside you takes the Use prompt', () => {
    const m = zombies(3, 31);
    m.wavePhase = 'intermission'; m.phaseUntil = 1e6;
    m.allies.clear();
    const [a, b] = m.humans, ap = m.armoryPos;
    const fx = ap.x - Math.sin(ap.yaw) * 1.0, fz = ap.z - Math.cos(ap.yaw) * 1.0;
    m.debugTeleport(a, fx, fz, ap.yaw + Math.PI); // in front of the Armory, facing it
    expect(m.interactionFor(a)?.kind).toBe('armory');
    m.debugTeleport(b, fx + 0.9, fz, 0);
    down(m, b);
    expect(m.interactionFor(a)?.kind).toBe('revive');
    expect(m.nearArmory(a)).toBe(true);
  });
});
