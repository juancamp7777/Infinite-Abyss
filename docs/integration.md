# Integración de los módulos Nymfo en la API

> **Estado: YA INTEGRADO.** Los módulos (Hub, Studios, CRM, marketing, promociones, gamificación y backoffice-api) están montados en `createApp` (`apps/api/src/app.ts`) sobre la Fase 1 de `main`. Este documento describe cómo funciona hoy, no un plan de integración pendiente.

## 1. Qué se monta y en qué orden

`apps/api/src/app.ts` llama a `registerModules(app, io, deps)` de `apps/api/src/modules/index.ts`. Los módulos se montan en este orden:

`hub → studio → promotions → crm → marketing → gamification → backoffice`

Cada módulo publica sus servicios con su clave y también como `'<módulo>.<clave>'` (por ejemplo `wallet.jackpotLedger` o `promotions.betGuard`). Algunas dependencias se resuelven de forma perezosa (`hub.catalog`, `promotions.betGuard`, `crm.crmSegments`), porque el módulo que las expone puede montarse después.

El montaje es asíncrono: `createApp` devuelve `ready` y `services.{bus, modules}`. Mientras los módulos no terminan de montarse, sus peticiones esperan a `ready` (un router anterior al 404). Si el montaje falla, se registra un error con `event: MODULES_MOUNT_ERROR`. En tests hay que hacer `await created.ready` y, si se verifican eventos, `await created.services.bus.drain()`.

### Configuración

- `MODULES_ENABLED=true|false` (por defecto `true`). Con `false`, `createApp` no monta los módulos.
- En producción con módulos activos, `src/config/env.ts` exige `MKT_UNSUBSCRIBE_SECRET` y `PROMO_DROPS_SECRET`, de al menos 32 caracteres. Sin ellos la API no arranca.
- Los secretos de proveedores del Hub (`HUB_PROVIDER_<ID>_SECRET`) son por proveedor: sin secreto, ese proveedor queda deshabilitado. El proveedor simulado solo se habilita fuera de producción o con `HUB_MOCK_PROVIDER=1`.
- Lista completa en `.env.example` de la raíz y en los `.env.example` de cada módulo.


## 2. Dependencias inyectadas (`deps`)

Los módulos no conocen Prisma ni Express de la Fase 1. Reciben puertos:

| Dependencia | Implementación en la API real | Dónde está |
|---|---|---|
| `wallet` (`WalletPort`) | Billetera sobre `PrismaWalletService` (doble partida, BigInt, idempotencia) | `src/infrastructure/modules/wallet/index.ts` |
| `bonusFunds` (`BonusFundsPort`) | Mismo adaptador; publicado como `services['wallet.bonusFunds']` | mismo archivo |
| `jackpotLedger` | Contribuciones y semillas de jackpot en `JACKPOT_POOL`; publicado como `services['wallet.jackpotLedger']` antes de montar promociones | mismo archivo |
| `auth` (`AuthPort`) | JWT HS256 de la Fase 1 (jugador y backoffice) | `src/infrastructure/modules/auth/Phase1ModuleAuth.ts` |
| `compliance` | KYC, autoexclusión, cool-off y límites de la Fase 1 | `src/infrastructure/modules/compliance/Phase1Compliance.ts` |
| `eventBus` | Bus de eventos de dominio que emite la Fase 1 | `src/infrastructure/modules/events/` |

`createModuleWalletAdapters({ prisma, wallet, logger? })` devuelve `{ wallet, bonusFunds, jackpotLedger }`. El plan de cuentas que siguen esos adaptadores está en [architecture.md](architecture.md#9-módulos-nymfo-integrados-sobre-la-fase-1).

## 3. Raw body del Hub (firma HMAC)

Las llamadas del proveedor al Hub (`/hub/v1/wallet`) van firmadas con HMAC sobre el cuerpo tal como llega. Por eso el `express.json` global no puede consumir el stream sin guardarlo. El módulo hub exporta `captureRawBody`, que se usa como `verify` del parser:

```ts
app.use(express.json({ limit: '100kb', verify: captureRawBody }));
```

(Así está en `apps/api/src/app.ts`, línea 171; `captureRawBody` se importa desde `./modules`.) `captureRawBody` guarda el buffer original en `req.rawBody` antes de parsear el JSON, y el Hub verifica la firma sobre ese buffer, no sobre el objeto ya parseado. Cualquier parser JSON nuevo debe usar el mismo `verify`; si no, la firma de `/hub/v1/wallet` no se puede comprobar.

## 4. Eventos que alimentan a los módulos

La Fase 1 emite los eventos (ver [architecture.md](architecture.md#93-eventos-del-eventbus)) y los módulos se suscriben a ellos con `bus.subscribe(nombre, handler)`. Los errores de los listeners se registran y no se propagan a la operación original.

## 5. Desarrollo sin la Fase 1: `dev:modules`

Para trabajar en los módulos sin Postgres ni la Fase 1 completa:

```bash
cd apps/api
npm run dev:modules
```

El script `src/modules/dev-server.ts` levanta todos los módulos en `:4000` con:

- `InMemoryWallet` sembrada con `DEV_PLAYERS`, lista separada por comas en formato `operador:jugador` (por defecto `op-demo:player-demo`).
- `MockAuth`: los tokens tienen la forma `dev:<ROL>:<operador>:<id>`. El script se niega a arrancar con `NODE_ENV=production`, y la autenticación real de `Phase1ModuleAuth` rechaza los tokens `dev:`.
- `DEV_CORS_ORIGINS` (por defecto `http://localhost:3000,http://localhost:3001`) y `PORT` (por defecto 4000).
- `HUB_MOCK_PROVIDER` se fuerza a `1` si no se define.

Es el modo recomendado para E2E del lobby y del backoffice. No sustituye las pruebas contra la billetera real (`npm test`), que siguen usando `PrismaWalletService` y Postgres.

## 6. Verificación

- `cd apps/api && npx tsc --noEmit -p .` debe dar 0 errores.
- `cd apps/api && npm test` ejecuta también `src/modules/**` con el `globalSetup` de Postgres. Las pruebas largas de RTP se activan con `RTP_LONG=1`.
- Para comprobar el wiring: `tests/modules-wiring/modulesWiring.test.ts`.
