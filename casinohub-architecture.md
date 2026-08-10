# CasinoHub — детальная архитектура

Виртуальная казино-платформа (фишки, не реальные деньги). Стек: NestJS (микросервисы), PostgreSQL, Redis, RabbitMQ, GraphQL, Next.js, TanStack Query, Zod, Storybook, Docker Compose, Kubernetes + Helm, AWS, Prometheus + Grafana.

---

## 1. Карта сервисов

```
                        ┌─────────────────────┐
                        │   API Gateway        │
                        │  (GraphQL Federation)│
                        └──────────┬───────────┘
                                   │
   ┌──────────┬──────────┬─────────┼─────────┬──────────┬──────────┐
   │          │          │         │         │          │          │
┌──▼───┐  ┌───▼───┐  ┌───▼───┐ ┌───▼───┐ ┌───▼────┐ ┌───▼────┐ ┌──▼──────┐
│ Auth │  │Wallet │  │ Game  │ │  RNG  │ │Leaderb.│ │ Notif. │ │ History │
│Service│  │Service│  │Service│ │Service│ │Service │ │Service │ │ Service │
└──┬───┘  └───┬───┘  └───┬───┘ └───┬───┘ └───┬────┘ └───┬────┘ └──┬──────┘
   │          │          │         │         │          │         │
┌──▼──────────▼──────────▼─────────▼─────────▼──────────▼─────────▼───┐
│         Postgres (по БД на сервис)  +  Redis  +  RabbitMQ            │
└────────────────────────────────────────────────────────────────────┘
```

### Зоны ответственности

| Сервис | Отвечает за | Хранилище |
|---|---|---|
| **Auth** | Регистрация, JWT, refresh-токены, ежедневный бонус | Postgres |
| **Wallet** | Баланс, транзакции, локи, идемпотентность | Postgres (append-only) + Redis (локи) |
| **Game** | Логика раундов (рулетка/слоты/blackjack/crash), приём ставок | Redis (live-state) + Postgres (архив раундов) |
| **RNG** | Честная генерация исходов, provably fair | Postgres (seed-журнал) |
| **Leaderboard** | Рейтинги, статистика | Postgres + Redis (Sorted Set) |
| **Notification** | Джекпот-алерты, бонус-напоминания | RabbitMQ consumer, без своей БД |
| **History** | Аналитика, экспорт истории игр | Postgres (read-model) |
| **API Gateway** | GraphQL Federation, аутентификация запросов | — |

Каждый сервис — **отдельная БД**, общение только через API Gateway (синхронно) или RabbitMQ (асинхронно). Прямых обращений к чужой БД нет.

---

## 2. Wallet Service — ядро системы

Это самый критичный сервис: тут решается задача "не потерять и не задвоить фишки при конкурентных запросах".

### 2.1 Модель данных (append-only, никогда UPDATE баланса напрямую)

```sql
-- Баланс — это ВСЕГДА производная величина, не хранится как мутируемое число
CREATE TABLE wallets (
  user_id UUID PRIMARY KEY,
  cached_balance BIGINT NOT NULL DEFAULT 0, -- денормализованный кэш для быстрых чтений
  version INT NOT NULL DEFAULT 0,           -- optimistic lock
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES wallets(user_id),
  idempotency_key VARCHAR(128) NOT NULL,     -- защита от дублей при retry
  type VARCHAR(20) NOT NULL,                 -- BET | PAYOUT | BONUS | DEPOSIT
  amount BIGINT NOT NULL,                    -- всегда в минимальных единицах (центы фишки)
  balance_after BIGINT NOT NULL,             -- снапшот баланса после операции
  reference_id UUID,                         -- id раунда игры, к которому относится
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, idempotency_key)
);

CREATE INDEX idx_wallet_tx_user_created ON wallet_transactions(user_id, created_at DESC);
```

**Почему append-only:** баланс не хранится как единственный источник правды — он пересчитывается (или кэшируется и сверяется) из суммы транзакций. Это даёт полный аудит-лог "куда ушла каждая фишка" и защищает от рассинхронизации.

### 2.2 Защита от race condition — два уровня

**Уровень 1: Redis distributed lock (Redlock) — быстрый путь**

```typescript
// wallet.service.ts
import { Redis } from 'ioredis';

interface LockResult {
  acquired: boolean;
  release: () => Promise<void>;
}

class RedisLock {
  constructor(private redis: Redis) {}

  async acquire(userId: string, ttlMs = 5000): Promise<LockResult> {
    const lockKey = `lock:wallet:${userId}`;
    const lockValue = crypto.randomUUID(); // уникальный токен владения локом

    const acquired = await this.redis.set(lockKey, lockValue, 'PX', ttlMs, 'NX');

    if (!acquired) {
      return { acquired: false, release: async () => {} };
    }

    return {
      acquired: true,
      release: async () => {
        // снимаем лок только если он всё ещё наш (Lua-скрипт для атомарности)
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
```

**Уровень 2: Optimistic locking в Postgres — гарантия на случай сбоя Redis**

```typescript
async function placeBet(userId: string, amount: bigint, idempotencyKey: string) {
  const lock = await redisLock.acquire(userId);
  if (!lock.acquired) {
    throw new ConflictException('Wallet is busy, retry shortly');
  }

  try {
    await db.transaction(async (trx) => {
      // 1. Проверяем идемпотентность — если такой ключ уже обработан, возвращаем старый результат
      const existing = await trx.query(
        `SELECT * FROM wallet_transactions WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey],
      );
      if (existing.rows.length > 0) {
        return existing.rows[0]; // идемпотентный повтор — не списываем дважды
      }

      // 2. Читаем текущий баланс с версией (SELECT ... FOR UPDATE как доп. защита)
      const wallet = await trx.query(
        `SELECT cached_balance, version FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const { cached_balance, version } = wallet.rows[0];

      if (cached_balance < amount) {
        throw new BadRequestException('Insufficient balance');
      }

      const newBalance = cached_balance - amount;

      // 3. Обновляем баланс с проверкой версии (optimistic lock)
      const updateResult = await trx.query(
        `UPDATE wallets SET cached_balance = $1, version = version + 1, updated_at = now()
         WHERE user_id = $2 AND version = $3`,
        [newBalance, userId, version],
      );

      if (updateResult.rowCount === 0) {
        throw new ConflictException('Concurrent modification detected, retry');
      }

      // 4. Пишем транзакцию в append-only лог
      await trx.query(
        `INSERT INTO wallet_transactions (user_id, idempotency_key, type, amount, balance_after, reference_id)
         VALUES ($1, $2, 'BET', $3, $4, $5)`,
        [userId, idempotencyKey, -amount, newBalance, gameRoundId],
      );

      return { balance: newBalance };
    });
  } finally {
    await lock.release();
  }
}
```

**Почему два уровня:** Redis-лок — это оптимизация (быстро отсекает конкурентные запросы ещё до похода в БД), а Postgres optimistic lock — это гарантия корректности (даже если Redis упал/лок истёк раньше времени, БД не даст создать несогласованное состояние).

### 2.3 Idempotency — защита от повторных запросов

Каждый запрос на ставку должен передавать `idempotency_key` (генерируется на клиенте, например `${userId}-${roundId}-${clientTimestamp}`). Если фронт из-за сетевого сбоя отправил один и тот же запрос дважды — второй раз вернётся тот же результат, а не повторное списание.

---

## 3. RNG Service — честность (Provably Fair)

### 3.1 Алгоритм

Классическая схема из крипто-казино индустрии, адаптированная под TS:

```typescript
import { createHash, randomBytes } from 'crypto';

interface FairRound {
  roundId: string;
  serverSeed: string;       // секретный, генерируется до раунда
  serverSeedHash: string;   // публикуется ДО раунда (доказательство, что seed не менялся)
  clientSeed: string;       // клиент может передать своё значение (или дефолт)
  nonce: number;             // счётчик ставок этого клиента, защита от повтора seed
  revealed: boolean;
  serverSeedRevealed?: string; // раскрывается ПОСЛЕ раунда
}

class ProvablyFairService {
  // Шаг 1: перед началом раунда — генерируем seed и публикуем его hash
  createRound(clientSeed: string, nonce: number): FairRound {
    const serverSeed = randomBytes(32).toString('hex');
    const serverSeedHash = createHash('sha256').update(serverSeed).digest('hex');

    return {
      roundId: crypto.randomUUID(),
      serverSeed,           // храним приватно, не отдаём клиенту пока
      serverSeedHash,       // это отдаём клиенту СРАЗУ — доказательство честности
      clientSeed,
      nonce,
      revealed: false,
    };
  }

  // Шаг 2: вычисляем результат раунда из комбинации seed'ов (детерминированно)
  computeResult(round: FairRound, outcomeSpace: number): number {
    const combined = `${round.serverSeed}:${round.clientSeed}:${round.nonce}`;
    const hash = createHash('sha256').update(combined).digest('hex');

    // берём первые 8 hex-символов как число и приводим к диапазону результата
    const intValue = parseInt(hash.substring(0, 8), 16);
    return intValue % outcomeSpace;
  }

  // Шаг 3: после раунда раскрываем seed — клиент может пересчитать результат сам
  revealSeed(round: FairRound): string {
    round.revealed = true;
    round.serverSeedRevealed = round.serverSeed;
    return round.serverSeed;
  }
}
```

### 3.2 Почему это доказывает честность

1. **До ставки** клиент получает `serverSeedHash` — хэш от секретного seed. Казино физически не может поменять seed после того, как увидело ставку клиента (хэш уже опубликован и неизменен).
2. **Результат раунда** вычисляется как детерминированная функция от `serverSeed + clientSeed + nonce` — если казино знает исход заранее, оно всё равно не может подстроить его без изменения seed, что сломает хэш.
3. **После раунда** казино раскрывает `serverSeed`. Клиент (или сторонний скрипт) пересчитывает `sha256(serverSeed)` и сверяет с ранее полученным `serverSeedHash` — если совпадает, seed не менялся.

### 3.3 Хранение seed-журнала

```sql
CREATE TABLE fair_rounds (
  round_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  server_seed_hash VARCHAR(64) NOT NULL,
  server_seed VARCHAR(64),          -- NULL до раскрытия
  client_seed VARCHAR(64) NOT NULL,
  nonce INT NOT NULL,
  outcome INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revealed_at TIMESTAMPTZ
);
```

Публичный эндпоинт `GET /fair/verify/:roundId` отдаёт всё нужное для независимой проверки — это украсит README и покажет глубину понимания темы.

---

## 4. Game Service — логика игр

### 4.1 Общий интерфейс игры

```typescript
interface GameEngine<TBet, TResult> {
  validateBet(bet: TBet, balance: bigint): void;
  computeOutcome(fairRound: FairRound): TResult;
  calculatePayout(bet: TBet, result: TResult): bigint;
}
```

### 4.2 Рулетка (самая простая — хороший MVP)

```typescript
interface RouletteBet {
  type: 'straight' | 'red' | 'black' | 'even' | 'odd' | 'dozen';
  numbers?: number[];   // для straight bet
  amount: bigint;
}

const PAYOUT_MULTIPLIERS: Record<RouletteBet['type'], number> = {
  straight: 35,  // ставка на конкретное число
  red: 1,
  black: 1,
  even: 1,
  odd: 1,
  dozen: 2,
};

class RouletteEngine implements GameEngine<RouletteBet, number> {
  computeOutcome(fairRound: FairRound): number {
    return provablyFair.computeResult(fairRound, 37); // 0-36, европейская рулетка
  }

  calculatePayout(bet: RouletteBet, result: number): bigint {
    const won = this.isWinning(bet, result);
    return won ? bet.amount * BigInt(PAYOUT_MULTIPLIERS[bet.type] + 1) : 0n;
  }

  private isWinning(bet: RouletteBet, result: number): boolean {
    switch (bet.type) {
      case 'straight': return bet.numbers?.includes(result) ?? false;
      case 'red': return RED_NUMBERS.has(result);
      case 'black': return result !== 0 && !RED_NUMBERS.has(result);
      case 'even': return result !== 0 && result % 2 === 0;
      case 'odd': return result % 2 === 1;
      case 'dozen': return result >= 1 && result <= 12; // упрощённо
      default: return false;
    }
  }
}
```

### 4.3 Слоты — весовая математика (RTP-контроль)

```typescript
interface SlotSymbol {
  id: string;
  weight: number;      // вероятность появления (относительный вес)
  payoutMultiplier: number; // выплата при 3-в-ряд
}

const SLOT_SYMBOLS: SlotSymbol[] = [
  { id: 'cherry', weight: 40, payoutMultiplier: 2 },
  { id: 'lemon',  weight: 30, payoutMultiplier: 3 },
  { id: 'bell',   weight: 15, payoutMultiplier: 10 },
  { id: 'seven',  weight: 10, payoutMultiplier: 25 },
  { id: 'diamond', weight: 5, payoutMultiplier: 100 },
];

class SlotEngine {
  private totalWeight = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);

  // Взвешенный выбор символа из детерминированного числа RNG
  private pickSymbol(randomValue: number): SlotSymbol {
    let cumulative = 0;
    const target = randomValue % this.totalWeight;

    for (const symbol of SLOT_SYMBOLS) {
      cumulative += symbol.weight;
      if (target < cumulative) return symbol;
    }
    return SLOT_SYMBOLS[0];
  }

  spin(fairRound: FairRound): SlotSymbol[] {
    // используем разные nonce-сдвиги для трёх барабанов, чтобы не коррелировали
    return [0, 1, 2].map((reelIndex) => {
      const value = provablyFair.computeResult(
        { ...fairRound, nonce: fairRound.nonce + reelIndex },
        1_000_000,
      );
      return this.pickSymbol(value);
    });
  }

  calculatePayout(bet: bigint, reels: SlotSymbol[]): bigint {
    const allSame = reels.every((s) => s.id === reels[0].id);
    if (!allSame) return 0n;
    return bet * BigInt(reels[0].payoutMultiplier);
  }
}
```

**Важно про RTP (Return to Player):** веса подбираются так, чтобы математическое ожидание выплаты было < 100% ставки (например, 95% — стандарт индустрии). Это стоит явно посчитать и вынести в README/тест — "теоретический RTP этой конфигурации: X%", и через 100k+ симуляций юнит-тестом подтвердить, что фактический RTP близок к теоретическому.

### 4.4 Crash game — самая интересная real-time механика

```typescript
// Растущий множитель, который может "взорваться" в любой момент
class CrashRoundManager {
  private currentMultiplier = 1.0;
  private crashPoint: number;
  private cashedOutUsers = new Set<string>();
  private startedAt: number;

  constructor(fairRound: FairRound) {
    // crash point вычисляется ДО начала раунда через RNG — детерминированно, но неизвестно игрокам
    const raw = provablyFair.computeResult(fairRound, 1_000_000) / 1_000_000;
    // формула распределения даёт house edge ~1-3% и экспоненциальный рост шанса краша
    this.crashPoint = Math.max(1.0, 0.99 / (1 - raw));
    this.startedAt = Date.now();
  }

  getCurrentMultiplier(): number {
    const elapsedSec = (Date.now() - this.startedAt) / 1000;
    this.currentMultiplier = Math.pow(Math.E, 0.06 * elapsedSec); // экспоненциальный рост
    return Math.min(this.currentMultiplier, this.crashPoint);
  }

  hasCrashed(): boolean {
    return this.getCurrentMultiplier() >= this.crashPoint;
  }

  // Критичный момент: cashOut должен быть atomic относительно проверки "уже упал или нет"
  async cashOut(userId: string, redisLock: RedisLock): Promise<number | null> {
    const lock = await redisLock.acquire(`crash-round:${this.roundId}`);
    try {
      if (this.hasCrashed() || this.cashedOutUsers.has(userId)) {
        return null; // поздно — раунд уже упал, или юзер уже забрал
      }
      this.cashedOutUsers.add(userId);
      return this.getCurrentMultiplier();
    } finally {
      await lock.release();
    }
  }
}
```

**Технически сложный момент здесь:** тысяча игроков могут нажать "cash out" почти одновременно на грани краша. Нужен централизованный лок на раунд (не на юзера — на весь раунд), потому что момент краша общий для всех, и WebSocket-broadcast должен уведомить всех клиентов синхронно, что раунд закрылся.

---

## 5. Redis — детальная схема ключей

```
wallet:lock:{userId}                     → строка (owner token), TTL 5s
crash:round:{roundId}:state              → hash {status, startedAt, crashPoint}
crash:round:{roundId}:cashouts           → set userId'ов, кто уже забрал
game:room:{roomId}:players               → set активных игроков
leaderboard:daily:{date}                 → sorted set (userId → totalWinnings)
leaderboard:alltime                      → sorted set
bonus:claimed:{userId}:{date}            → строка "1", TTL до конца дня (защита от повторного бонуса)
```

Pub/Sub каналы:
```
channel: crash:{roundId}:tick     → рассылка текущего множителя всем зрителям (раз в 100мс)
channel: crash:{roundId}:crashed  → событие краша, всем клиентам мгновенно
channel: jackpot:won              → крупный выигрыш — транслируется во все открытые сессии
```

---

## 6. RabbitMQ — схема очередей и событий

### Exchange: `casino.events` (topic exchange)

| Routing key | Публикует | Слушает | Назначение |
|---|---|---|---|
| `game.round.completed` | Game Service | Leaderboard, History | Обновление рейтинга и архива после каждого раунда |
| `wallet.transaction.created` | Wallet Service | History, Notification | Аудит-лог + уведомление о крупных суммах |
| `game.jackpot.won` | Game Service | Notification | Broadcast всем "кто-то выиграл X!" |
| `user.bonus.claimed` | Auth Service | Wallet Service | Начисление ежедневного бонуса |
| `user.registered` | Auth Service | Wallet Service, Notification | Создание кошелька, welcome-email |

### Dead Letter Queue

```typescript
// notification.module.ts (пример конфигурации очереди с DLQ)
{
  exchange: 'casino.events',
  queue: 'notification.jackpot',
  routingKey: 'game.jackpot.won',
  options: {
    deadLetterExchange: 'casino.events.dlx',
    deadLetterRoutingKey: 'notification.jackpot.failed',
    messageTtl: 30000, // если за 30 сек не обработано — в DLQ
  },
}
```

Если отправка email/push упала (например, внешний SMTP недоступен) — сообщение уходит в DLQ, отдельный consumer с exponential backoff пытается повторить (3 попытки, потом — в "мёртвую" таблицу для ручного разбора).

---

## 7. GraphQL — схема (фрагмент)

```graphql
type Wallet {
  balance: Int!
  currency: String!
  transactions(limit: Int = 20): [Transaction!]!
}

type Transaction {
  id: ID!
  type: TransactionType!
  amount: Int!
  balanceAfter: Int!
  createdAt: DateTime!
  referenceRound: GameRound
}

type GameRound {
  id: ID!
  gameType: GameType!
  bet: Int!
  payout: Int!
  outcome: JSON!
  fairnessProof: FairnessProof!
  createdAt: DateTime!
}

type FairnessProof {
  serverSeedHash: String!
  serverSeed: String       # null пока не раскрыт
  clientSeed: String!
  nonce: Int!
  verifyUrl: String!
}

type Subscription {
  crashMultiplierUpdated(roundId: ID!): CrashTick!
  jackpotWon: JackpotEvent!
  balanceUpdated(userId: ID!): Wallet!
}

type Mutation {
  placeBet(input: PlaceBetInput!): GameRound!
  cashOutCrash(roundId: ID!): CashOutResult
}
```

Federation: `Wallet` резолвится Wallet Service, `GameRound` — Game Service, `FairnessProof` — RNG Service, но клиент видит единую схему через Gateway.

---

## 8. Kubernetes / Helm — структура

```
helm/
├── casinohub-umbrella/         # родительский чарт
│   ├── Chart.yaml              # зависимости на все сервисы
│   └── values.yaml             # общие настройки (namespace, image tags)
├── charts/
│   ├── auth-service/
│   ├── wallet-service/
│   ├── game-service/
│   │   ├── templates/
│   │   │   ├── deployment.yaml
│   │   │   ├── hpa.yaml        # автоскейл — нагрузка скачкообразная
│   │   │   ├── service.yaml
│   │   │   └── configmap.yaml
│   │   └── values.yaml
│   ├── rng-service/
│   ├── leaderboard-service/
│   ├── notification-service/
│   ├── history-service/
│   └── api-gateway/
```

**HPA для Game Service** — обоснование: пик нагрузки, когда много игроков одновременно в Crash-раунде, WebSocket-соединения растут нелинейно.

```yaml
# game-service/templates/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: game-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: game-service
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65
```

**AWS-соответствия:**
- Postgres → RDS (по инстансу на сервис, либо один multi-tenant RDS с разными БД — дешевле для пет-проекта)
- Redis → ElastiCache
- RabbitMQ → Amazon MQ, либо self-hosted RabbitMQ StatefulSet в K8s (дешевле для демо)
- Kubernetes → EKS
- Секреты → AWS Secrets Manager + External Secrets Operator в K8s (не хардкодить в values.yaml)

---

## 9. Prometheus метрики — что реально мониторить

```typescript
// game.metrics.ts
import { Counter, Histogram, Gauge } from 'prom-client';

export const betsPlacedTotal = new Counter({
  name: 'casino_bets_placed_total',
  help: 'Общее число ставок',
  labelNames: ['game_type'],
});

export const payoutAmountTotal = new Counter({
  name: 'casino_payout_amount_total',
  help: 'Сумма всех выплат',
  labelNames: ['game_type'],
});

export const betAmountTotal = new Counter({
  name: 'casino_bet_amount_total',
  help: 'Сумма всех ставок',
  labelNames: ['game_type'],
});

// КЛЮЧЕВАЯ метрика: реальный RTP в реальном времени
// rtp = payoutAmountTotal / betAmountTotal — если резко отклоняется от ожидаемого, алерт!

export const activeGameRounds = new Gauge({
  name: 'casino_active_rounds',
  help: 'Число активных раундов прямо сейчас',
  labelNames: ['game_type'],
});

export const betLatency = new Histogram({
  name: 'casino_bet_processing_seconds',
  help: 'Время обработки ставки (от запроса до ответа)',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
});
```

**Alerting rule (Prometheus):**
```yaml
- alert: RTPAnomaly
  expr: |
    (rate(casino_payout_amount_total[1h]) / rate(casino_bet_amount_total[1h])) > 1.05
  for: 15m
  annotations:
    summary: "RTP превышает 105% — казино в минусе, вероятен баг в RNG или payout-логике"
```

Это по-настоящему осмысленный алерт: если казино вдруг "платит больше, чем должно математически" — это либо баг, либо эксплойт, и мониторинг должен на это реагировать.

**Grafana дашборд — панели:**
- RTP по каждой игре в реальном времени (главная панель)
- Активные раунды / игроки онлайн
- Latency ставок (p50/p95/p99)
- Топ крупных выигрышей за час
- Health микросервисов (стандартный RED: Rate, Errors, Duration)

---

## 10. Тестирование — приоритеты

### Unit
- `SlotEngine.calculatePayout` — весовая математика, соответствие теоретического RTP
- `ProvablyFairService` — детерминированность (одинаковый seed+nonce всегда даёт одинаковый результат), равномерность распределения на больших выборках
- `RouletteEngine.isWinning` — все типы ставок

### Concurrency-тест (самое ценное для демонстрации)
```typescript
describe('Wallet concurrency', () => {
  it('не допускает двойного списания при параллельных ставках', async () => {
    const userId = await createTestUserWithBalance(1000n);

    // 50 параллельных запросов на ставку по 100 фишек с одного счёта
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        walletService.placeBet(userId, 100n, crypto.randomUUID()),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const finalBalance = await walletService.getBalance(userId);

    // Должно пройти ровно 10 ставок (1000/100), остальные — insufficient balance
    expect(succeeded.length).toBe(10);
    expect(finalBalance).toBe(0n);
  });

  it('идемпотентный повтор не списывает баланс дважды', async () => {
    const userId = await createTestUserWithBalance(1000n);
    const idempotencyKey = crypto.randomUUID();

    await walletService.placeBet(userId, 100n, idempotencyKey);
    await walletService.placeBet(userId, 100n, idempotencyKey); // тот же ключ

    const balance = await walletService.getBalance(userId);
    expect(balance).toBe(900n); // списалось только раз
  });
});
```

### E2E
- Полный флоу: регистрация → бонус → ставка → результат → баланс обновился → в истории появилась запись
- Crash game: несколько клиентов подключаются по WebSocket, один "падает" раунд — все получают событие синхронно

---

## 11. Roadmap реализации (по неделям)

1. **Неделя 1** — Auth + Wallet Service с полной защитой от race conditions, покрыт unit + concurrency тестами
2. **Неделя 2** — RNG Service (provably fair) + Roulette (самая простая игра) end-to-end
3. **Неделя 3** — Slot Engine + RTP-тесты на симуляциях, Storybook для игровых компонентов
4. **Неделя 4** — Crash game + WebSocket real-time + Redis Pub/Sub
5. **Неделя 5** — RabbitMQ события (Leaderboard, Notification, History), GraphQL Federation
6. **Неделя 6** — Docker Compose полностью рабочий, Helm-чарты, деплой в EKS, Prometheus/Grafana дашборды
7. **Неделя 7** — Полировка, README с объяснением provably fair и RTP, демо-видео

---

## 12. TypeORM: миграции up/down

### 12.1 DataSource конфигурация (общая для CLI и приложения)

```typescript
// src/database/data-source.ts
import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { WalletEntity } from '../wallet/entities/wallet.entity';
import { WalletTransactionEntity } from '../wallet/entities/wallet-transaction.entity';

config({ path: `.env.${process.env.NODE_ENV || 'development'}` });

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [WalletEntity, WalletTransactionEntity],
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false, // ВСЕГДА false — синхронизация схемы вручную через миграции
  logging: process.env.NODE_ENV === 'development',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
```

### 12.2 package.json — скрипты для миграций

```json
{
  "scripts": {
    "typeorm": "typeorm-ts-node-commonjs -d src/database/data-source.ts",
    "migration:generate": "npm run typeorm -- migration:generate",
    "migration:create": "npm run typeorm -- migration:create",
    "migration:run": "npm run typeorm -- migration:run",
    "migration:revert": "npm run typeorm -- migration:revert",
    "migration:show": "npm run typeorm -- migration:show"
  }
}
```

Генерация миграции из изменений в сущностях:
```bash
npm run migration:generate -- src/database/migrations/CreateWalletTables
```

### 12.3 Пример миграции с up/down

```typescript
// src/database/migrations/1707000000000-CreateWalletTables.ts
import { MigrationInterface, QueryRunner, Table, TableIndex, TableForeignKey } from 'typeorm';

export class CreateWalletTables1707000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'wallets',
        columns: [
          { name: 'user_id', type: 'uuid', isPrimary: true },
          { name: 'cached_balance', type: 'bigint', default: 0 },
          { name: 'version', type: 'int', default: 0 },
          { name: 'updated_at', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'wallet_transactions',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'user_id', type: 'uuid' },
          { name: 'idempotency_key', type: 'varchar', length: '128' },
          {
            name: 'type', type: 'enum',
            enum: ['BET', 'PAYOUT', 'BONUS', 'DEPOSIT'],
          },
          { name: 'amount', type: 'bigint' },
          { name: 'balance_after', type: 'bigint' },
          { name: 'reference_id', type: 'uuid', isNullable: true },
          { name: 'created_at', type: 'timestamptz', default: 'now()' },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      'wallet_transactions',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedTableName: 'wallets',
        referencedColumnNames: ['user_id'],
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'wallet_transactions',
      new TableIndex({
        name: 'IDX_wallet_tx_idempotency',
        columnNames: ['user_id', 'idempotency_key'],
        isUnique: true,
      }),
    );

    await queryRunner.createIndex(
      'wallet_transactions',
      new TableIndex({
        name: 'IDX_wallet_tx_user_created',
        columnNames: ['user_id', 'created_at'],
      }),
    );
  }

  // down ВСЕГДА зеркалит up в обратном порядке — сначала индексы/FK, потом таблицы
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('wallet_transactions', 'IDX_wallet_tx_user_created');
    await queryRunner.dropIndex('wallet_transactions', 'IDX_wallet_tx_idempotency');
    await queryRunner.dropTable('wallet_transactions');
    await queryRunner.dropTable('wallets');
  }
}
```

**Правило дисциплины:** каждая миграция обязана иметь работающий `down`, который откатывает ровно то, что сделал `up` — это проверяется вручную (`migration:run` → `migration:revert` → база должна вернуться к прежнему виду) перед мержем в main. Без этого правила откат прод-деплоя становится небезопасным.

### 12.4 Миграции в CI/CD и Kubernetes

Миграции нельзя запускать из самого приложения при старте (риск двух подов, гоняющих миграцию одновременно). Правильный паттерн — отдельный **Kubernetes Job**, выполняемый перед деплоем:

```yaml
# helm/charts/wallet-service/templates/migration-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: wallet-service-migrate-{{ .Release.Revision }}
  annotations:
    "helm.sh/hook": pre-install,pre-upgrade   # выполняется ДО деплоя новой версии
    "helm.sh/hook-weight": "-5"
    "helm.sh/hook-delete-policy": hook-succeeded
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          command: ["npm", "run", "migration:run"]
          envFrom:
            - secretRef:
                name: wallet-service-db-secret
      restartPolicy: Never
  backoffLimit: 2
```

Это гарантирует: миграция прогоняется один раз, до того как новые поды с новым кодом начнут принимать трафик.

---

## 13. Dev и Prod окружения

### 13.1 Переменные окружения

```bash
# .env.development
NODE_ENV=development
DB_HOST=localhost
DB_PORT=5432
DB_USER=casino_dev
DB_PASSWORD=dev_password
DB_NAME=casino_wallet_dev
REDIS_URL=redis://localhost:6379
RABBITMQ_URL=amqp://guest:guest@localhost:5672
LOG_LEVEL=debug
JWT_SECRET=dev-only-not-secure

# .env.production — реальные значения приходят из K8s Secret / AWS Secrets Manager,
# в репозитории только шаблон с плейсхолдерами для документации
NODE_ENV=production
DB_HOST=${DB_HOST}
DB_PORT=5432
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=casino_wallet_prod
REDIS_URL=${REDIS_URL}
RABBITMQ_URL=${RABBITMQ_URL}
LOG_LEVEL=info
JWT_SECRET=${JWT_SECRET}
```

`.env.production` в `.gitignore`, в репозитории — только `.env.production.example` с плейсхолдерами.

### 13.2 Nest конфигурация через @nestjs/config + Zod-валидация окружения

```typescript
// src/config/env.validation.ts
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().default(5432),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  REDIS_URL: z.string().url(),
  RABBITMQ_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${result.error.message}`);
  }
  return result.data;
}
```

```typescript
// app.module.ts
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: `.env.${process.env.NODE_ENV || 'development'}`,
      validate: validateEnv, // приложение не стартует, если .env некорректен — фейл-фаст
      isGlobal: true,
    }),
  ],
})
export class AppModule {}
```

Плюс этого подхода: если забыл переменную окружения (например, `JWT_SECRET` в проде) — сервис не поднимется вообще, а не упадёт посреди работы с непонятной ошибкой.

### 13.3 Docker Compose — раздельные файлы для dev/prod

```yaml
# docker-compose.yml — базовый, общий для всех окружений
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine

  rabbitmq:
    image: rabbitmq:3-management-alpine
    ports:
      - "15672:15672" # management UI

  wallet-service:
    build:
      context: ./services/wallet
    depends_on:
      - postgres
      - redis
      - rabbitmq

volumes:
  postgres-data:
```

```yaml
# docker-compose.override.yml — подхватывается автоматически в dev (docker compose up)
services:
  wallet-service:
    build:
      target: development       # multi-stage Dockerfile, dev-стадия с hot-reload
    volumes:
      - ./services/wallet/src:/app/src   # live-reload без ребилда образа
    command: npm run start:dev
    ports:
      - "3001:3000"
      - "9229:9229"              # Node.js debugger port
    environment:
      NODE_ENV: development

  postgres:
    ports:
      - "5432:5432"              # открыт наружу только в dev, для локальных GUI-клиентов

  rabbitmq:
    ports:
      - "5672:5672"
```

```yaml
# docker-compose.prod.yml — явно указывается: docker compose -f docker-compose.yml -f docker-compose.prod.yml up
services:
  wallet-service:
    build:
      target: production        # multi-stage Dockerfile, минимальный production-образ
    restart: always
    deploy:
      resources:
        limits:
          memory: 512M
    environment:
      NODE_ENV: production
    # никаких открытых портов БД наружу, никаких volume с исходниками
```

### 13.4 Multi-stage Dockerfile (dev + prod из одного файла)

```dockerfile
# Dockerfile
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM base AS development
COPY . .
CMD ["npm", "run", "start:dev"]

FROM base AS build
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev              # только production-зависимости, образ легче
COPY --from=build /app/dist ./dist
USER node                          # не root в проде — базовая security-практика
CMD ["node", "dist/main.js"]
```

### 13.5 Helm values — разделение по окружениям

```
helm/charts/wallet-service/
├── values.yaml           # общие дефолты
├── values-dev.yaml       # оверрайды для dev-namespace
└── values-prod.yaml      # оверрайды для prod-namespace
```

```yaml
# values-dev.yaml
replicaCount: 1
resources:
  requests: { cpu: 100m, memory: 128Mi }
  limits: { cpu: 250m, memory: 256Mi }
autoscaling:
  enabled: false
ingress:
  host: wallet.dev.casinohub.internal

# values-prod.yaml
replicaCount: 3
resources:
  requests: { cpu: 250m, memory: 256Mi }
  limits: { cpu: 500m, memory: 512Mi }
autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 10
ingress:
  host: wallet.casinohub.com
  tls: true
podDisruptionBudget:
  minAvailable: 2          # при обновлении/скейле хотя бы 2 пода всегда живы
```

```bash
# деплой в разные окружения
helm upgrade --install wallet-service ./charts/wallet-service -f values.yaml -f values-dev.yaml -n dev
helm upgrade --install wallet-service ./charts/wallet-service -f values.yaml -f values-prod.yaml -n prod
```

### 13.6 GitHub Actions — раздельные пайплайны

```yaml
# .github/workflows/deploy.yml
name: CI/CD

on:
  push:
    branches: [develop, main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run lint
      - run: npm run migration:show   # проверка, что миграции консистентны
      - run: npm run test             # unit + concurrency
      - run: npm run test:e2e

  deploy-dev:
    needs: test
    if: github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    steps:
      - run: helm upgrade --install wallet-service ./charts/wallet-service -f values-dev.yaml -n dev

  deploy-prod:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment:
      name: production            # GitHub Environment с manual approval gate
    steps:
      - run: helm upgrade --install wallet-service ./charts/wallet-service -f values-prod.yaml -n prod
```

`develop` → авто-деплой в dev, `main` → деплой в prod через **manual approval** (GitHub Environments позволяют настроить обязательное подтверждение перед прод-деплоем) — стандартная практика, которую стоит показать.

---

## 14. Дополнительные библиотеки — расширенный список

| Библиотека | Зачем | Куда |
|---|---|---|
| `@nestjs/config` | Типобезопасная конфигурация из env | Все сервисы |
| `nestjs-zod` | Единая валидация DTO через Zod (вместо class-validator — не дублировать подход с фронтом) | Все сервисы |
| `@nestjs/terminus` | Health checks (`/health/live`, `/health/ready`) для K8s проб | Все сервисы |
| `@nestjs/cqrs` | Command/Query/Event разделение — естественно для PlaceBet/CashOut/RoundCompleted | Game, Wallet |
| `@nestjs/throttler` + Redis | Rate limiting на ставки (защита от спама запросов) | Game, Wallet |
| `ioredis` | Redis-клиент с поддержкой Lua-скриптов (нужен для атомарного release лока) | Wallet, Game |
| `amqplib` / `@golevelup/nestjs-rabbitmq` | RabbitMQ интеграция с декораторами в стиле Nest | Все сервисы, публикующие/слушающие события |
| `@willsoto/nestjs-prometheus` | Готовая интеграция Prometheus-метрик в Nest | Все сервисы |
| `nestjs-pino` | Структурированное JSON-логирование (лучше для агрегации в Loki/ELK, чем дефолтный Nest-логгер) | Все сервисы |
| `@opentelemetry/sdk-node` + `@opentelemetry/exporter-jaeger` | Distributed tracing | Все сервисы |
| `class-transformer` | Сериализация ответов API (скрытие приватных полей, например `serverSeed` до раскрытия) | Wallet, RNG |
| `bull` / `@nestjs/bullmq` | Лёгкие фоновые задачи на Redis (генерация отчётов, ресайз аватарок) — отдельно от RabbitMQ для тяжёлых межсервисных событий | Notification, History |
| `@sentry/node` | Трекинг ошибок в проде, особенно `OptimisticLockVersionMismatchError` | Все сервисы |
| `supertest` | HTTP/GraphQL e2e-тесты | Все сервисы |
| `testcontainers` | Поднятие реального Postgres/Redis/RabbitMQ в Docker для интеграционных тестов (честнее, чем моки) | Wallet (особенно для concurrency-тестов) |
| `k6` | Нагрузочное тестирование Wallet Service (не npm-библиотека, отдельный бинарь) | CI, локально |
| `helmet` | Базовые security HTTP-заголовки | API Gateway |
| `@casl/ability` | Декларативные права доступа (например, кто может видеть чужую историю ставок — админ vs юзер) | Auth, Gateway |

**Особо отмечу `testcontainers`** — для Wallet Service с его конкурентными транзакциями тестировать на реальном Postgres в Docker-контейнере, поднимаемом прямо в тесте, даёт куда больше доверия к результатам, чем мокать `Repository` — race conditions на моках просто не воспроизводятся честно.

---

## 15. Важная юридическая ремарка (вставить в README проекта)

Проект использует **виртуальную валюту без денежной стоимости**, создан как демонстрация инженерных паттернов (distributed locks, provably fair RNG, финансовые append-only транзакции, real-time системы) и не предназначен как реальный gambling-продукт. Превращение в продукт с реальными деньгами требует лицензирования азартных игр, которое сильно различается по юрисдикциям — это отдельная юридическая, а не инженерная задача.
