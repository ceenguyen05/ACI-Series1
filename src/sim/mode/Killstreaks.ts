import { Vector3 } from 'three';
import { otherTeam, type Team } from '../../config/rules';
import type { Agent } from '../entities/Agent';
import type { MatchQuery } from './types';

/**
 * Call of Duty-style killstreaks, scaled for 5v5 Search & Destroy:
 * kills in one life (without dying) earn rewards that are kept until used (key 7).
 */
export type StreakId = 'uav' | 'counterUav' | 'hunter' | 'missile';

export interface StreakDef { id: StreakId; name: string; kills: number; blurb: string }

export const STREAKS: Record<StreakId, StreakDef> = {
  uav: { id: 'uav', name: 'UAV', kills: 3, blurb: 'Surveillance drone overhead: sweeps every enemy onto your team\'s radar every 2s for 25s.' },
  counterUav: { id: 'counterUav', name: 'Counter-UAV', kills: 4, blurb: 'Jams the enemy team\'s radar for 20s.' },
  hunter: { id: 'hunter', name: 'Hunter Drone', kills: 5, blurb: 'Autonomous quadcopter that tracks down the nearest enemy and detonates.' },
  missile: { id: 'missile', name: 'Cruise Missile', kills: 6, blurb: 'Steer a missile from the sky with a thermal view. Punches through roofs. Left mouse to boost.' },
};
export const STREAK_ORDER: StreakId[] = ['uav', 'counterUav', 'hunter', 'missile'];
/** Kills from killstreaks themselves don't extend your streak. */
const STREAK_SOURCES = new Set(['hunter', 'missile']);

export class Killstreaks {
  readonly uavUntil: Record<Team, number> = { T: 0, CT: 0 };
  readonly cuavUntil: Record<Team, number> = { T: 0, CT: 0 };
  private nextSweep: Record<Team, number> = { T: 0, CT: 0 };

  constructor(private m: MatchQuery & { rules: { killstreaks: boolean } }) {}

  reset() {
    for (const t of ['T', 'CT'] as Team[]) { this.uavUntil[t] = 0; this.cuavUntil[t] = 0; }
  }

  onKill(killer: Agent, source: string) {
    if (!this.m.rules.killstreaks || STREAK_SOURCES.has(source)) return;
    killer.streakKills++;
    for (const id of STREAK_ORDER) {
      if (STREAKS[id].kills === killer.streakKills) {
        killer.streaks.push(id);
        this.m.events.emit('killstreakEarned', { agentId: killer.id, streak: id });
      }
    }
  }

  /** Use the oldest earned streak. Returns true if something was launched. */
  activate(a: Agent): boolean {
    const m = this.m;
    // planting or defusing keeps both hands busy (a missile would also pull you off the bomb)
    if (!a.alive || a.isPlanting || a.isDefusing || !a.streaks.length || (m.phase !== 'live' && m.phase !== 'planted')) return false;
    const id = a.streaks[0];
    const now = m.time;
    const enemy = otherTeam(a.team);
    switch (id) {
      case 'uav':
        this.uavUntil[a.team] = Math.max(this.uavUntil[a.team], now) + 25;
        this.nextSweep[a.team] = now;
        break;
      case 'counterUav':
        this.cuavUntil[enemy] = Math.max(this.cuavUntil[enemy], now) + 20;
        break;
      case 'hunter':
        m.gadgets.spawnHunter(a);
        break;
      case 'missile': {
        // bots fire it straight at the most recently spotted enemy; players steer it
        let target: Vector3 | null = null;
        if (a.isBot) {
          const foes = m.agents.filter((x) => x.alive && x.team === enemy);
          const spotted = foes.filter((x) => x.spottedUntil > now - 3);
          const pick = (spotted.length ? spotted : foes)[0];
          if (pick) target = pick.pos.clone();
        }
        if (!m.gadgets.spawnMissile(a, target)) return false;
        break;
      }
    }
    a.streaks.shift();
    m.events.emit('killstreakUsed', { agentId: a.id, team: a.team, streak: id });
    return true;
  }

  update() {
    const m = this.m, now = m.time;
    for (const team of ['T', 'CT'] as Team[]) {
      const enemy = otherTeam(team);
      if (this.uavUntil[team] > now && now >= this.nextSweep[team]) {
        this.nextSweep[team] = now + 2;
        for (const e of m.agents) if (e.alive && e.team === enemy) e.spottedUntil = Math.max(e.spottedUntil, now + 1.8);
        m.events.emit('uavSweep', { team });
      }
      if (this.cuavUntil[team] > now) {
        for (const a of m.agents) if (a.team === team) a.radarScrambledUntil = Math.max(a.radarScrambledUntil, now + 0.3);
      }
    }
  }
}
