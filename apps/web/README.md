# apps/web — Nymfo Casino (Next.js 16)

Frontend del operador: lobby de módulos, juegos de Studios, juegos clásicos de la Fase 1, cajero y cuenta. Corre en el puerto 3000 y habla con la API (`apps/api`, puerto 4000). Visión general del monorepo en el [README raíz](../../README.md).

## Puesta en marcha

```bash
cd apps/web
npm ci --legacy-peer-deps
cp .env.example .env.local     # por defecto usa /api-proxy → API_INTERNAL_URL
npm run dev                    # http://localhost:3000
```

Comprobaciones: `npx tsc --noEmit` y `npm run build`. Con la API de módulos sin la Fase 1 completa, usa `npm --prefix ../api run dev:modules` (ver [docs/integration.md](../../docs/integration.md)).

## Rutas

| Ruta | Qué es |
|---|---|
| `/` | Redirige a `/lobby`. |
| `/lobby`, `/lobby/category/[slug]`, `/lobby/provider/[id]`, `/lobby/search`, `/lobby/favorites`, `/lobby/recent` | Catálogo de juegos del Hub. |
| `/lobby/game/[id]` | Ficha y lanzamiento de un juego del Hub. |
| `/lobby/tournaments`, `/lobby/tournaments/[id]` | Torneos. |
| `/lobby/vip` | Zona VIP (requiere sesión). |
| `/studio/[gameId]` | Juego propio de Studios, identificado por `gameId`. |
| `/classic` | Antigua home de la Fase 1; enlaza a los juegos clásicos. |
| `/crash`, `/plinko`, `/mines`, `/roulette`, `/blackjack`, `/slots` | Juegos clásicos de la Fase 1 (requieren sesión). Su enlace “volver” apunta a `/classic`. |
| `/login`, `/register`, `/account`, `/cashier` | Sesión, registro, cuenta y cajero de la Fase 1. |
| `/admin` | Página de administración heredada de la Fase 1. El panel nuevo es `apps/backoffice`. |

## Cliente de módulos

- `src/lib/modules.ts` es el único cliente de los endpoints de módulos (`moduleRequest`, sobre `apiRequest` de `src/lib/api.ts`).
- Los endpoints públicos de módulos (hub/games, promo/jackpots, backoffice/v1/public/skin) exigen `operatorId` en la query. `moduleOperatorId` lo obtiene de `NEXT_PUBLIC_OPERATOR_ID`, del claim `op` del token, de `brand.id` o, fuera de producción, del token de desarrollo.
- `formatMinor` y `toMinorUnits` convierten entre unidades menores (BigInt) y montos mostrados, con los decimales del ledger del operador. El formato es es-CO sin floats (`formatCurrency` en `src/lib/money.ts`): COP/CLP/PYG/JPY sin decimales visibles (`$ 1.234.567`, se trunca hacia cero), el resto con los decimales del ledger (`US$ 1.234,56`). En COP se escriben pesos enteros (`5000` o `5.000`) y el ledger sigue en centavos.
- La moneda sale del saldo/usuario o de `operator.defaultCurrency` (`/api/operator/brand`); ya no existe `NEXT_PUBLIC_CURRENCY`.
- Montos de apuesta: `src/lib/bets.ts` (`betPresets`, `betSteps`) usa `operator.betLimits` (`minBet`, `maxBet`, `presets`) y, si faltan, valores de respaldo (COP 500…50.000, USD 0,10…10).
- El token de desarrollo `NEXT_PUBLIC_DEV_TOKEN` solo funciona fuera de producción. Está documentado en `.env.example`.
- TypeScript: el target es ES2017, así que se usan `BigInt(0)` y nunca literales `0n`.

## API same-origin, Socket.io y cabeceras

- `NEXT_PUBLIC_API_URL` admite URL absoluta o ruta relativa (`/api-proxy` por defecto, `/_svc/api` tras un proxy con prefijo). `next.config.ts` reescribe `/api-proxy/*` hacia `API_INTERNAL_URL` (runtime), incluido `/api-proxy/socket.io/`.
- Socket.io usa `NEXT_PUBLIC_SOCKET_URL` (o el origen actual) y `NEXT_PUBLIC_SOCKET_PATH` (o `<base del API>/socket.io`), con websocket y respaldo a polling.
- `next.config.ts` desactiva `x-powered-by` y fija CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` y HSTS (solo producción). Todo es `frame-ancestors 'none'` salvo `/studio/*` (`'self'`, el iframe del lobby). Orígenes extra de juegos: `NEXT_PUBLIC_GAME_FRAME_ORIGINS`.

## Variables de entorno

Ver `.env.example` de este directorio. Las variables `NEXT_PUBLIC_*` se incrustan en el build; cámbialas y vuelve a construir.
