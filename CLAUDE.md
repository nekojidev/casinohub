# CasinoHub — корневой контекст

Монорепо. Этот файл — общие правила на весь проект, загружается всегда.

Специфика каждого сервиса лежит в `.claude/rules/{имя}.md` — они path-scoped (загружаются только когда открываешь файлы внутри `services/{имя}/` или `apps/web/`, `packages/shared-types/`) и дополняют этот файл, не заменяют.

## Кто я и что мне нужно

Учу стек через практику. Мне нужно ПОНИМАТЬ код, не просто получить готовый результат.

**Правила во всех сессиях, независимо от того, в каком сервисе работаю:**
- Маленькие шаги. Один файл/метод за раз.
- Перед кодом — 2-3 предложения, что делаем и почему именно так.
- Если есть два подхода — объясни разницу, не выбирай молча.
- Если прошу "напиши весь сервис целиком" — напомни про план по шагам, предложи текущий. Если настаиваю — дай, но напомни.
- Правлю твой код с ошибкой — сначала объясни, что не так и почему проблема, потом покажи исправление.
- Деньги — всегда `bigint`/строка в БД, никогда `number`.
- TypeORM `synchronize: true` запрещён — только миграции.

## Триггер-фразы

- `объясни, не пиши код` — только концепция
- `дай попробовать самому` — сигнатура без реализации
- `проверь мой код` — список проблем по важности, не переписывай сразу
- `дальше` — следующий шаг плана
- `застрял` — 1-2 наводящих вопроса перед ответом

## Архитектура

@casinohub-architecture.md

## Стек и структура

NestJS (микросервисы, TS) · TypeORM · PostgreSQL · Redis (ioredis) · RabbitMQ · GraphQL federation · Next.js · TanStack Query · Zod · Storybook · Docker Compose · K8s + Helm · AWS · Prometheus/Grafana

```
casinohub/
├── packages/shared-types/   # общие DTO/Zod-схемы
├── services/{auth,wallet,game,rng,leaderboard,notification,history,gateway}/
└── apps/web/
```

## Порядок обучения — НЕ перепрыгивать

Начинаем и заканчиваем Wallet, прежде чем создавать остальные сервисы как реальный код (не как пустые папки).

1. TS/NestJS основы (decorators, DI) — только на Wallet
2. TypeORM: entity → миграция → repository
3. Wallet: сначала НАИВНАЯ версия без локов
4. Concurrency-тест, ломающий наивную версию
5. Redis lock → тест → Postgres optimistic lock → тест → idempotency → тест зелёный
6. Миграции up/down
7. RNG: сначала Math.random(), потом provably fair
8. Roulette — первая связка Wallet + RNG
9. Docker Compose dev (Postgres + Redis)
10. Slot Engine + RTP-тест на симуляциях
11. RabbitMQ + события, потом Outbox pattern
12. GraphQL Gateway
13. Crash game + WebSocket
14. K8s/Helm/AWS
15. Prometheus/Grafana

## Прогресс (обновляй сам)

- [x] TS generics/decorators
- [x] NestJS DI
- [x] TypeORM entity + миграции
- [x] Redis lock
- [x] Postgres optimistic lock
- [x] Идемпотентность
- [x] Concurrency-тесты
- [ ] Provably fair RNG
- [ ] RabbitMQ producer/consumer
- [ ] Outbox pattern
- [ ] GraphQL resolvers
- [ ] Docker Compose dev/prod
- [ ] Helm/K8s
