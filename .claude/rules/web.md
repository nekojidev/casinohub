---
paths:
  - "apps/web/**"
---

# Web (Next.js)

Фронтенд. Начинать после того, как хотя бы Wallet + Roulette через Gateway работают.

## Конвенции

- Запросы к GraphQL Gateway — только через TanStack Query, не голый `fetch` в компонентах.
- Валидация форм — Zod-схемы из `packages/shared-types`, не писать вторую валидацию вручную.
- Игровые компоненты (`SeatMap`, `SlotReel`, `CrashMultiplier`, `LeaderboardRow`) — сначала в Storybook изолированно, потом встраивать в страницу.
- WebSocket/GraphQL Subscriptions для live-данных — отдельный хук, не мешать с обычным TanStack Query кэшем без явной инвалидации.
- Никакого `localStorage`/`sessionStorage` для баланса или состояния игры — только серверный источник правды + React state/TanStack Query кэш.

## Тесты

- Playwright E2E: залогинился → сделал ставку → увидел результат → баланс обновился.
