import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';

interface LockResult {
  acquired: boolean;
  release: () => Promise<void>;
}

interface AcquireOptions {
  ttlMs?: number;
  retryDelayMs?: number;
  maxWaitMs?: number;
}

@Injectable()
export class RedisLockService implements OnModuleDestroy {
  private readonly redis = new Redis(
    process.env.REDIS_URL ?? 'redis://localhost:6380',
  );

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async acquire(
    userId: string,
    options: AcquireOptions = {},
  ): Promise<LockResult> {
    const { ttlMs = 5000, retryDelayMs = 5, maxWaitMs = 2000 } = options;
    const lockKey = `lock:wallet:${userId}`;
    const lockValue = randomUUID(); // proves ownership so we never release someone else's lock

    const deadline = Date.now() + maxWaitMs;
    let acquired: string | null = null;

    // retry with a short delay instead of failing immediately — turns
    // concurrent callers into a queue instead of rejecting all but one
    while (Date.now() < deadline) {
      acquired = await this.redis.set(lockKey, lockValue, 'PX', ttlMs, 'NX');
      if (acquired) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    if (!acquired) {
      return { acquired: false, release: async () => {} };
    }

    return {
      acquired: true,
      release: async () => {
        // atomic check-and-delete: only remove the key if we still own it
        const script = `
          if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
          else
            return 0
          end
        `;
        await this.redis.eval(script, 1, lockKey, lockValue);
      },
    };
  }
}
