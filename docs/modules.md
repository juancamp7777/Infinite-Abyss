# Módulos de Infinite Abyss: arquitectura

Cada módulo vive en `apps/api/src/modules/<módulo>/` con capas `domain/` (reglas puras), `application/`
(servicios y casos de uso) e `infrastructure/` (HTTP, Prisma, InMemory, sockets). Expone un `NymfoModule`
con `register(app, io, deps)`. Sin `deps.prisma` usa repositorios en memoria. Su schema está en el esquema único
`apps/api/prisma/schema.prisma` (modelos con prefijo por módulo y `@@map`; migración `20261021090000_modules`). Montaje: `registerModules` en `modules/index.ts` (ver `integration.md`).

| Módulo | Prefijo | Qué hace | Servicios publicados |
|---|---|---|---|
| `shared` | — | Kernel: `WalletPort` + `InMemoryWallet` idempotente, `EventBus`, puertos de auth, cumplimiento, catálogo, guardia de apuestas y segmentos; helpers HTTP, zod, HMAC y bigint | — |
| `hub` | `/hub/v1` | Catálogo unificado con activación y orden por operador. Seamless wallet `/wallet/{balance,bet,win,rollback}` con HMAC, idempotencia por transactionId y tombstones de rollback. `ProviderAdapter`: Mock completo y esqueletos de Pragmatic, Evolution y agregador genérico (con TODO de contrato). Lado saliente (`/outbound/*` + `RemoteSeamlessWallet`) y reportes GGR | `catalog`, `sessions`, `hubReports` |
| `studio` | `/studio/v1`, socket `/studio` | Motor server-authoritative: `GameMath`, provably fair (HMAC-SHA256 con server seed, client seed y nonce), simulador y CLI `npm run sim`. Slots Starfall (6x5, tumble), Verdant Grid (cluster 7x7) y Ember Lines (5x3, 20 líneas), todas al 96,5 %. Originals: dice, plinko, roulette, crash (también en vivo), mines y blackjack, con RTP por operador dentro de rango | `studioPlay`, `studioConfig`, `studioFairness`, `crashLive` |
| `promotions` | `/promo/v1`, socket `/promotions` | Bonos (depósito, giros gratis, cashback, códigos) con wagering, contribución por categoría, apuesta máxima, expiración y ciclo de vida. Jackpots progresivos mini/major/mega con contabilidad cuadrada. Drops & wins | `promotions`, `promotions.betGuard`, `promotions.freeSpins` |
| `crm` | `/crm/v1` | Perfil 360 proyectado desde eventos (LTV, GGR, RFM, VIP, riesgo de abandono), segmentos con reglas AND/OR, notas, etiquetas, timeline y tickets | `crmProfiles`, `crmSegments` (SegmentPort), `crmTimeline` |
| `marketing` | `/marketing/v1` | Campañas, journeys (presets: registro sin depósito 24 h, inactivo 7 días, cumpleaños, gran pérdida → cashback), canales (`Channel`: email HTTP, SMS/WhatsApp, push, in-app), plantillas con marca, A/B, métricas, afiliados y postbacks. Cumplimiento: opt-in por canal, exclusión de autoexcluidos, menores o con límites, y registro de envíos | `marketing`, `marketing.messaging` |
| `gamification` | `/gamification/v1`, socket `/gamification` | VIP con puntos y rakeback, misiones, logros, racha de login, rueda diaria y torneos con leaderboard en tiempo real | `gamification.service` |
| `backoffice-api` | `/backoffice/v1` | KPIs (GGR, NGR, depositantes, FTD, retención), skins del operador y reportes CSV con protección contra inyección de fórmulas | `skins`, `dashboard`, `reports`, `kpiRepo` |
| `feed` | `/feed/v1`, socket `/feed` | Apuestas en vivo del lobby desde `bet.settled` (Hub y Studios): todas, grandes apostadores (`FEED_HIGH_ROLLER_MIN` por moneda) y grandes victorias (`FEED_LUCKY_MULTIPLIER`), más las del propio jugador. El jugador sale con alias HMAC (`FEED_PSEUDONYM_SECRET`), nunca con su id. Duplicados descartados; socket agrupado en lotes (`FEED_FLUSH_MS`) | `feed.service` |

Frontend:
- `apps/web/src/app/(lobby)/lobby/*`: lobby del jugador, con el tema del operador en variables `--nf-*`.
- `apps/web/src/app/(games)/studio/[gameId]`: host de los juegos propios en Canvas 2D (`components/studio`).
- `apps/backoffice`: panel de plataforma y operadores.

Montos: siempre `bigint` en unidades mínimas; en JSON viajan como string.
