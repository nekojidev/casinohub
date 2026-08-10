---
paths:
  - "services/leaderboard/**"
---

# Leaderboard Service

Рейтинги игроков. Один из самых простых сервисов — хорошее место для практики RabbitMQ consumer.

## Конвенции

- Live-рейтинг — Redis Sorted Set (`leaderboard:daily:{date}`, `leaderboard:alltime`), не Postgres.
- Postgres — только архив для аналитики, не источник для live-запросов.
- Обновление рейтинга — исключительно через RabbitMQ-событие `game.round.completed`, не прямой вызов из Game Service.
- Не пересчитывай весь рейтинг с нуля на каждое событие — инкрементально (`ZINCRBY`).

## Тесты

- Consumer корректно обрабатывает событие и инкрементирует нужный Sorted Set.
- Повторная обработка одного и того же события (retry RabbitMQ) не должна задвоить очки.
