import { Vector3 } from 'three';
import type { Match } from '../sim/mode/Match';
import type { SimEvents } from '../sim/events';
import { makeWeapon } from '../sim/entities/Agent';
import { ZombiesMatch } from '../sim/zombies/ZombiesMatch';
import { zWeapon } from '../sim/zombies/zweapons';

// Explicit tagged values retain vectors/maps/sets across JSON, including event payloads and
// nested mantle/weapon state. No functions, contexts, AI, scene graph or world grid cross the wire.
export type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue };
export interface WireEvent { type: keyof SimEvents; payload: WireValue }
export function encode(value: unknown): WireValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Vector3) return { $v: [value.x, value.y, value.z] };
  if (value instanceof Map) return { $m: [...value].map(([k, v]) => [encode(k), encode(v)]) };
  if (value instanceof Set) return { $s: [...value].map(encode) };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== 'function' && v !== undefined).map(([k, v]) => [k, encode(v)]));
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  return value as string | boolean;
}
export function decode(value: WireValue): any {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    if ('$v' in value) return new Vector3(...value.$v as [number, number, number]);
    if ('$m' in value) return new Map((value.$m as WireValue[][]).map(([k, v]) => [decode(k), decode(v)]));
    if ('$s' in value) return new Set((value.$s as WireValue[]).map(decode));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}
const STATE_KEYS = ['time', 'tick', 'phase', 'phaseEnd', 'liveStart', 'round', 'score', 'lossStreak', 'history', 'items', 'winner', 'matchOver', 'bomb', 'lastRoundEnd', 'roundDamage', 'spawnAreas'] as const;
export interface MatchSnapshot {
  state: WireValue;
  agents: WireValue[];
  utility: WireValue;
  gadgets: WireValue;
  ordnance: WireValue;
  colliders: WireValue;
  zombies?: WireValue;
}
const pick = (o: object, keys: readonly string[]) => Object.fromEntries(keys.map(k => [k, (o as Record<string, unknown>)[k]]));
/** Corpses render for 30 s (MatchView); after that an unreserved pooled zombie shows nothing. */
const DORMANT_AFTER = 31;
/** `full` is for a joining replica; regular snapshots send idle pooled zombies as identity only. */
export function captureSnapshot(m: Match, full = false): MatchSnapshot {
  return {
    state: encode(pick(m, STATE_KEYS)),
    agents: m.agents.map(a => {
      if (!full && a.zombie && !a.alive && !a.zombie.active && m.time - a.deathTime > DORMANT_AFTER) return { id: a.id, alive: false };
      // Weapon definitions are static data; send ids/attachments/ammo instead.
      const data = { ...a } as Record<string, unknown>;
      for (const slot of ['primary', 'secondary', 'knife'] as const) {
        const w = a[slot];
        data[slot] = w ? { weaponId: w.def.id, tier: w.def.tier ?? 0, att: w.att ?? {}, mag: w.mag, reserve: w.reserve } : null;
      }
      return encode(data);
    }),
    utility: encode(pick(m.utility, ['projectiles', 'smokes', 'fires', 'decoys', 'pulses'])),
    gadgets: encode(pick(m.gadgets, ['devices', 'thrown'])),
    ordnance: encode(pick(m.ordnance, ['shots', 'knives'])),
    colliders: encode(m.world.collision.dynamic),
    ...(m instanceof ZombiesMatch ? { zombies: encode({
      state: pick(m, ['power', 'wave', 'wavesCleared', 'wavePhase', 'waveKindNow', 'phaseUntil', 'waveTotal', 'spawned', 'killedThisWave', 'powerUps', 'timers', 'gas', 'acid', 'spits', 'exfil', 'gameOver', 'won', 'totalKills', 'zoneOpen']),
      gates: m.gates.map(g => ({ open: g.open, openedAt: g.openedAt })), box: m.box, forge: m.forge, perkMachines: m.perkMachines,
    }) } : {}),
  };
}

export function applySnapshot(m: Match, s: MatchSnapshot) {
  Object.assign(m, decode(s.state));
  for (const wire of s.agents) {
    const data = decode(wire), a = m.getAgent(data.id);
    if (!a) continue;
    for (const slot of ['primary', 'secondary', 'knife']) {
      if (!(slot in data)) continue; // compact (dormant) entries leave weapons untouched
      const w = data[slot];
      data[slot] = w ? { ...(m instanceof ZombiesMatch && data.zp ? zWeapon(w.weaponId, w.tier, data.zp.perks) : makeWeapon(w.weaponId, w.att)), mag: w.mag, reserve: w.reserve } : null;
    }
    Object.assign(a, data);
  }
  Object.assign(m.utility, decode(s.utility));
  Object.assign(m.gadgets, decode(s.gadgets));
  Object.assign(m.ordnance, decode(s.ordnance));
  m.world.collision.dynamic.splice(0, m.world.collision.dynamic.length, ...decode(s.colliders));
  if (m instanceof ZombiesMatch && s.zombies) {
    const z = decode(s.zombies);
    Object.assign(m, z.state); Object.assign(m.box, z.box); Object.assign(m.forge, z.forge);
    z.gates.forEach((g: { open: boolean }, i: number) => {
      const gate = m.gates[i]; Object.assign(gate, g);
      if (gate.open) m.world.nav.unblock(gate.key);
    });
    z.perkMachines.forEach((p: object, i: number) => Object.assign(m.perkMachines[i], p));
  }
}
