# Nymfo Casino — Contratos compartidos (Fase 1)

Fuente de verdad para s2–s8. Esquema: `apps/api/prisma/schema.prisma` (migración `prisma/migrations/20261020190000_init`). Nadie más edita `schema.prisma` ni `package.json`: pedir el cambio al integrador (s8).

## 1. Dinero
- Todo monto es `bigint` en **unidades mínimas** + `currency` (COP/USD/EUR 2 decimales, USDT 6, BTC 8…; `src/domain/money/currencies.ts`).
- `src/domain/money`: `parseMinorUnits(str)` (solo dígitos, >0, tope 1e18), `parseSignedMinorUnits`, `formatMinor`, `applyMultiplier(amount, mult)` (mult×1e6, redondeo hacia abajo), `ChipConversion` (única tasa: `Operator.chipMinorUnitsPerChip`).
- En JSON los montos viajan como **string de dígitos** (`src/infrastructure/http/serialize.ts`: `bigintReplacer`, `toJsonSafe`). Nada de floats en el money-path.

## 2. Ledger: signos y plan de cuentas
Saldo de cuenta = suma de sus `LedgerEntry.amount` (con signo). En cada `LedgerTransaction` las entradas suman exactamente 0. `LedgerAccount.balance` es caché actualizada en la misma transacción SQL con bloqueo de fila. `LedgerEntry`/`LedgerTransaction` son inmutables (trigger rechaza UPDATE/DELETE). No hay trigger de suma cero a propósito (la reconciliación debe detectar descuadres).

| Cuenta (`ownerKey`) | Tipo | Uso |
|---|---|---|
| jugador | `PLAYER_CASH`, `PLAYER_BONUS` | saldo retirable / bono |
| `OPERATOR` | `HOUSE` | GGR de la casa |
| `OPERATOR` | `PSP_CLEARING` | contrapartida de dinero real con la pasarela |
| `OPERATOR` | `WITHDRAWAL_PENDING` | retiros reservados |
| `OPERATOR` | `BONUS_EXPENSE`, `MANUAL_ADJUSTMENT`, `DEMO_FUNDING` | bonos, ajustes, fichas demo |

Asientos: depósito CASH +X / PSP_CLEARING −X · apuesta CASH −B / HOUSE +B · ganancia CASH +W / HOUSE −W · reserva retiro CASH −X / WITHDRAWAL_PENDING +X · liberación (rechazo) inverso · pago WITHDRAWAL_PENDING −X / PSP_CLEARING +X · rollback = asiento inverso con `reversesId` (único) · ajuste manual CASH ±X / MANUAL_ADJUSTMENT ∓X · demo CASH +X / DEMO_FUNDING −X.

Unicidad de cuenta: `(operatorId, ownerKey, type, currency)`, `ownerKey` = userId u `'OPERATOR'`.

### Claves de idempotencia (únicas por `operatorId`)
`bet:<gameType>:<userId>:<requestId>` · `win:<sessionId>` · `deposit:<depositId>` · `wd-reserve:<withdrawalId>` · `wd-release:<id>` · `wd-payout:<id>` · `adj:<uuid>`.

## 3. Interfaces (`apps/api/src/domain/contracts/`, import desde `domain/contracts`)
- `IWalletService.ts` — getBalances, placeBet, settleWin, betAndSettle, rollback, creditDeposit, reserveWithdrawal, releaseWithdrawal, completeWithdrawal, manualAdjustment, creditDemo. Devuelven `{ledgerTransactionId, balance: bigint, idempotentReplay}`. Errores: `INSUFFICIENT_FUNDS`, `CONFLICT` (misma key, otro payload), `FORBIDDEN` (usuario de otro operador).
- `IReconciliationService.ts` — `run({operatorId?})` → `ReconciliationReport` con checks `TX_SUM_ZERO | GLOBAL_SUM_ZERO | CACHED_VS_DERIVED | PSP_DEPOSITS_VS_CLEARING`.
- `IResponsibleGamingPolicy.ts` — `assertCanDeposit/assertCanBet(ctx, amount)`, `assertCanWithdraw(ctx)`.
- `PaymentProvider.ts` — code, isEnabled, createDeposit, verifyWebhook, requestPayout, getStatus (+ tipos).
- `AuthContext.ts` (`PlayerAuth`, `BackofficeAuth`), `TenantContext.ts`, `IAuditLogger.ts`.
- `AppError` (`src/domain/errors/AppError.ts`): `statusCode`, `code`, fábricas `insufficientFunds, invalidBet, unauthorized(401), forbidden(403), notFound(404), conflict(409), validation(422), limitExceeded(403), selfExcluded(403), kycRequired(403)`.
- `src/config/env.ts`: `loadConfig(env)`, `getConfig()`. Sin valores por defecto para secretos; `JWT_ACCESS_SECRET` (≥32 chars) obligatorio; credenciales de PSP faltantes ⇒ adaptador deshabilitado (campos `undefined`).
- `src/infrastructure/http/types.ts`: augmentation de `Request` (`tenant`, `player`, `backoffice`, `rawBody`) y `HttpGuards {resolveTenant, requirePlayer, requireBackoffice(roles, opts?), rateLimit:{login,cashier}}`. Routers: `createXRouter(deps & HttpGuards)`.
- `src/infrastructure/database/prisma.ts`: cliente singleton (usa `process.env.DATABASE_URL`).

## 4. Contrato HTTP / socket (montos = strings de dígitos en unidades mínimas)
Error REST: `{error:{code, message}}`.
- **Tenant**: cabecera `X-Operator-Slug`, o `X-Operator-Host` (host de la web) → `OperatorDomain`, o `Host` → `OperatorDomain`, o `DEFAULT_OPERATOR_SLUG` (solo dev). No encontrado → 404; no ACTIVE → 403.
- Público: `GET /api/operator/brand` → `{operator:{slug,name,currencies,defaultCurrency,currencyDecimals,chipsEnabled,chipMinorUnitsPerChip}, brand:{displayName,logoUrl,colors,fontFamily,legal}}`.
- Jugador: `POST /api/auth/register {email,password,username?}`, `/login`, `/refresh {refreshToken}`, `/logout` → `{accessToken, refreshToken, user}`; `GET /api/me` → `{user, balances}`; `GET/PUT /api/me/limits`; `POST /api/me/self-exclusion {days|permanent}`.
- Cajero (jugador): `GET /api/cashier/methods`; `POST /api/cashier/deposits {provider, amount, currency}` → `{depositId, redirectUrl?, address?}`; `GET /api/cashier/transactions?cursor=`; `POST /api/cashier/withdrawals {provider, amount, currency, destination}`; `GET /api/cashier/withdrawals`.
- Webhooks (body crudo): `POST /api/webhooks/passimpay`, `POST /api/webhooks/wompi`.
- Backoffice: `POST /api/backoffice/auth/login`, `GET /api/backoffice/stats`, `GET /api/backoffice/withdrawals?status=`, `POST /api/backoffice/withdrawals/:id/approve|reject|mark-paid`, `GET /api/backoffice/reconciliation?operatorId=`, `POST /api/backoffice/players/:id/adjustments {amount (con signo), reason}`, `GET /api/backoffice/players/:id`.
- Socket.io: handshake `auth: { token: <accessToken> }`. Eventos (placeBet, playSlots, blackjack:start|hit|stand, mines:start|reveal|cashout, crash:placeBet|cashout, plinko:drop) reciben `amount` string y `requestId` uuid opcional; respuestas con `newBalance` y `payout` string. Error: `{success:false, error:{message, code, errorCode}}`.

## 5. Archivos que quedan rotos en `npm run typecheck` (los arregla su dueño)
- `src/infrastructure/repositories/PrismaWalletRepository.ts`, `PrismaGameSessionRepository.ts` y use-cases (Wallet/Transaction ya no existen; `betAmount` es bigint; GameSession requiere `operatorId`, `currency`) → **s5**.
- `src/infrastructure/services/PaymentService.ts` → **s4**.
- `src/server.ts` (usa `prisma.wallet`, crea usuario con wallet) → **s8**.

## 6. Cómo correr tests
```bash
# Postgres de pruebas (puerto 5433)
docker compose -f docker-compose.test.yml up -d       # si el 5433 ya responde, reutilízalo; no lo detengas
cd apps/api
npm install
npx prisma generate
npm test                    # vitest run; globalSetup ejecuta `prisma migrate deploy`
npm run typecheck
```
- `TEST_DATABASE_URL` (por defecto `postgresql://nymfo_test:nymfo_test@localhost:5433/nymfo_test?schema=public`) se asigna a `DATABASE_URL`. Sin Docker: cualquier Postgres ≥14 y exporta `TEST_DATABASE_URL`.
- Secretos de prueba: `tests/setup/env.ts` (nunca en `src`).
- **Reglas**: los tests NO truncan tablas. Cada test crea su operador con `createTestOperator()` y acota aserciones (incluida la reconciliación: `run({operatorId})`) a ese operador, así corren en paralelo sobre la misma BD. Factories en `tests/setup/factories.ts`: `createTestOperator`, `createTestPlayer(operatorId, overrides)`, `createBackofficeUser(role, operatorId)`.
- El ledger es inmutable: no se puede “inyectar un descuadre” con UPDATE; para probar la reconciliación inserta una `LedgerTransaction` con entradas que no suman 0 (INSERT permitido) o altera `LedgerAccount.balance`/`Deposit` (mutables).
