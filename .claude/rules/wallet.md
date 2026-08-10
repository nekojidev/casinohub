---
paths:
  - "services/wallet/**"
---

# Wallet Service

Ядро проекта. Здесь решается задача "не потерять и не задвоить фишки при конкурентных запросах" — самое ценное для обучения во всём проекте, не торопись здесь.

## Конвенции

- `wallets.cached_balance` и `wallet_transactions.amount/balance_after` — только `bigint` (в TypeORM колонка типа `bigint`, в JS приходит как строка — не забывай `BigInt(value)` перед арифметикой).
- Баланс — производная величина. Источник правды — `wallet_transactions` (append-only, никогда `UPDATE`/`DELETE`).
- Каждая операция изменения баланса обязана иметь `idempotency_key` и записываться в той же транзакции БД, что и списание.
- Redis lock (`lock:wallet:{userId}`) — быстрый путь отказа при конкуренции. Postgres optimistic lock (`@VersionColumn`) — гарантия корректности, даже если Redis лок истёк раньше времени.
- Не используй `pessimistic_write` и `optimistic` locking одновременно без явного понимания зачем — обсуждай оба варианта, прежде чем писать.

## Тесты — обязательны для этого сервиса

- Concurrency-тест на `Promise.allSettled` с 50 параллельными ставками — без него PR не считается готовым.
- Используй `testcontainers` для реального Postgres в тесте, не мокай `Repository` — race conditions на моках не воспроизводятся честно.

## Порядок работы (входит в шаг 3-6 корневого плана)

1. Наивный `placeBet` без локов
2. Тест, который его ломает
3. Redis lock
4. Postgres optimistic lock
5. Idempotency key
6. Миграции up/down

## Что не трогать пока

RabbitMQ/Outbox pattern для Wallet — на потом (шаг 11). Сначала должен работать надёжный синхронный путь.
