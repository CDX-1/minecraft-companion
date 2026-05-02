import type { Bot } from 'mineflayer';
import { Movements } from 'mineflayer-pathfinder';

export function createServerSafeMovements(bot: Bot): Movements {
  const movements = new Movements(bot);
  movements.allowParkour = false;
  movements.allowSprinting = false;
  return movements;
}
