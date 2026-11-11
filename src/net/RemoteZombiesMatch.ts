import { ZombiesMatch } from '../sim/zombies/ZombiesMatch';
import { ACI_HQ_ZOMBIES } from '../sim/maps/aciHqZombies';
import type { Agent } from '../sim/entities/Agent';
import type { ArmoryId } from '../config/zombies';
import { ReplicaDriver } from './RemoteMatch';
import type { OnlineClient } from './OnlineClient';
import type { MatchStart } from './protocol';

/** Coop replica retains Zombies queries/rendering but never advances its AI or machines. */
export class RemoteZombiesMatch extends ZombiesMatch {
  readonly remote = true;
  private replica: ReplicaDriver;
  constructor(readonly client: OnlineClient, start: MatchStart) {
    if (!start.zombiesConfig) throw new Error('Missing Zombies match configuration');
    super({ ...start.zombiesConfig, layout: ACI_HQ_ZOMBIES, localPlayerId: start.playerId });
    // The base simulation has internal listeners with gameplay side effects (e.g.
    // decoy explosions); replicas only replay presentation events from the server.
    this.events.clear(); this.allies.clear();
    this.replica = new ReplicaDriver(this, client, start);
  }
  receiveSnapshot() { this.replica.receiveSnapshot(); }
  override step(dt: number) { this.replica.step(this.playerCmd, dt); }
  override buyArmory(a: Agent, item: ArmoryId) {
    if (a !== this.player || !this.nearArmory(a) || this.armoryBlocker(a, item)) return false;
    this.client.send({ type: 'armory', item }); return true;
  }
  override tryBuy() { return false; }
  override hurryRoundEnd() { /* Shared server clock. */ }
}
