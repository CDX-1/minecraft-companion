import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

type EntityState = {
  position: Vec3;
  velocity: Vec3;
};

function isFiniteVec3(value: Vec3 | undefined): value is Vec3 {
  if (!value) return false;
  return true
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.z);
}

function cloneVec3(value: Vec3): Vec3 {
  return new Vec3(value.x, value.y, value.z);
}

export function createFiniteEntityStateRepair(
  bot: Bot,
  log: (message: string) => void,
): (source: string) => boolean {
  let lastFinite: EntityState | null = null;

  return (source: string): boolean => {
    const entity = bot.entity;
    if (!entity) return false;

    if (isFiniteVec3(entity.position)) {
      lastFinite = {
        position: cloneVec3(entity.position),
        velocity: isFiniteVec3(entity.velocity) ? cloneVec3(entity.velocity) : new Vec3(0, 0, 0),
      };
      return false;
    }

    if (!lastFinite) {
      log(`[move-repair] ${source}: invalid bot position and no finite fallback`);
      return false;
    }

    entity.position = cloneVec3(lastFinite.position);
    entity.velocity = new Vec3(0, 0, 0);
    bot.clearControlStates();
    log(`[move-repair] ${source}: restored position to ${lastFinite.position.x.toFixed(3)},${lastFinite.position.y.toFixed(3)},${lastFinite.position.z.toFixed(3)}`);
    return true;
  };
}
