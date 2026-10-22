# Nymfo Casino

Plataforma iGaming **multi-operador (white-label)**: cada operador levanta su propia sala (nombre, skin y dominio), los jugadores se registran, depositan, juegan y retiran. Todo el dinero pasa por un **ledger de doble partida** en enteros (unidades mínimas, BigInt). Sobre esa base están integrados los **módulos Nymfo**: Hub de juegos de terceros, Studios (juegos propios), CRM, marketing, promociones (bonos, jackpots, torneos), gamificación y el backoffice-api.

## Estructura

Monorepo con tres aplicaciones y documentación:

| Carpeta | Qué es | Puerto |
|---|---|---|
| `apps/api` | API Node 20 + TypeScript (tsx), Express 5, socket.io, Prisma 5 y PostgreSQL. Incluye la Fase 1 (`src/`) y los módulos (`src/modules/**`). | 4000 |
| `apps/web` | Next.js 16: lobby de módulos (`/lobby`), juegos de Studios (`/studio/[gameId]`), juegos clásicos (`/classic`, `/crash`…), cajero y cuenta. | 3000 |
| `apps/backoffice` | Next.js 16: panel para operadores y plataforma (login real con JWT). | 3001 |
| `docs/` | [architecture.md](docs/architecture.md) (dominio, ledger, plan de cuentas, módulos), [integration.md](docs/integration.md) (cómo se montan los módulos) y [contracts.md](docs/contracts.md) (contratos REST/socket). | — |

El esquema de base de datos es único: `apps/api/prisma/schema.prisma`, con las migraciones de `apps/api/prisma/migrations/` (la de módulos es `20261021090000_modules`).

## Requisitos

- Docker y Docker Compose (para el stack completo), o Node 20+ y PostgreSQL 14+ para correr sin Docker.

## Cómo levantar con Docker

```bash
cp .env.example .env          # edita los valores marcados con change-me y rellena lo que uses
docker compose up --build
# Solo en desarrollo: crea 2 operadores demo, el admin de plataforma y fichas demo
docker compose exec api npm run seed
```

Servicios de `docker-compose.yml`: `postgres` (publicado solo en `127.0.0.1:5432`), `api` (4000), `web` (3000) y `backoffice` (3001, imagen con usuario no root).

Todas las credenciales viven en `.env` (ignorado por git); `docker-compose.yml` no contiene secretos. `JWT_ACCESS_SECRET` (≥ 32 caracteres) es obligatorio: sin él la API no arranca. Si dejas vacías las variables de Passimpay o Wompi, ese adaptador queda deshabilitado. Las variables de los módulos (Hub, Studios, marketing, promociones) están documentadas en `.env.example`; con `MODULES_ENABLED=false` la API arranca solo con la Fase 1. En producción con módulos activos, `MKT_UNSUBSCRIBE_SECRET` y `PROMO_DROPS_SECRET` son obligatorios (≥ 32 caracteres).

La API aplica `prisma migrate deploy` al arrancar (nunca `db push`).

### Dónde entrar

| URL | Qué es |
|---|---|
| http://localhost:3000 | Lobby del operador “Nymfo Casino” (la home redirige a `/lobby`) |
| http://demo.localhost:3000 | Operador demo de ejemplo (otra skin; `*.localhost` resuelve a 127.0.0.1 en navegadores modernos) |
| http://localhost:3001 | Backoffice. Usuarios del seed (contraseña `SEED_ADMIN_PASSWORD`): `platform@nymfo.local` (PLATFORM_ADMIN, vista de plataforma), `admin@<slug>.local` (OPERATOR_ADMIN), `finance@<slug>.local` (OPERATOR_FINANCE); jugadores demo `demo@<slug>.local` |
| http://localhost:3000/admin | Página de administración heredada de la Fase 1 |
| http://localhost:4000/health | Health check de la API |

### Vista previa / dominios

La web habla con la API por su **mismo origen**: `NEXT_PUBLIC_API_URL=/api-proxy` (Next reescribe `/api-proxy/*` hacia `API_INTERNAL_URL`, en compose `http://api:4000`) y socket.io usa `NEXT_PUBLIC_SOCKET_PATH=/api-proxy/socket.io`. Las URLs de launch de los juegos de Studios son relativas (`/studio/<id>?…`) si `WEB_URL`/`PUBLIC_WEB_URL` están vacías, y el juego del MockProvider usa `HUB_PUBLIC_API_URL` (por defecto `/api-proxy`) como prefijo público. Así la plataforma funciona detrás de cualquier host sin apuntar a `localhost`.

**Resolución de operador (tenant).** La API busca el host (`X-Operator-Host` que manda la web, o `Host`) en `OperatorDomain`. Si no está registrado, usa `DEFAULT_OPERATOR_SLUG` (en producción solo con `ALLOW_DEFAULT_OPERATOR=true`). Un `X-Operator-Slug` explícito e inexistente sigue respondiendo 404. Para registrar dominios:

- Con el seed (desarrollo/vista previa): `SEED_EXTRA_DOMAINS=preview.example.com,aurora=aurora-preview.example.com` (`host` → operador `nymfo`; `slug=host` → ese operador). No cambia el dominio primario. Luego `docker compose exec api npm run seed`.
- A mano (cualquier entorno), por ejemplo con un script de Prisma:
  ```ts
  const op = await prisma.operator.findUniqueOrThrow({ where: { slug: 'nymfo' } });
  await prisma.operatorDomain.upsert({
    where: { host: 'casino.example.com' },
    update: { operatorId: op.id },
    create: { host: 'casino.example.com', operatorId: op.id, isPrimary: false },
  });
  ```

**CORS.** Orígenes permitidos = `CORS_ORIGINS` (separados por coma) + origen de `PUBLIC_WEB_URL` + origen de `BACKOFFICE_URL`; fuera de producción se suman los `localhost` de desarrollo. Con el proxy same-origin no hace falta CORS.

**Ejemplo de vista previa** con la API bajo `/_svc/api/` y el backoffice bajo `/_svc/backoffice/` (en `.env`, antes de `docker compose up --build`, porque las `NEXT_PUBLIC_*` se fijan en el build):

```bash
NEXT_PUBLIC_API_URL=/_svc/api
NEXT_PUBLIC_SOCKET_PATH=/_svc/api/socket.io
BACKOFFICE_BASE_PATH=/_svc/backoffice
BACKOFFICE_API_URL=/_svc/api
HUB_PUBLIC_API_URL=/_svc/api
DEFAULT_OPERATOR_SLUG=nymfo
SEED_EXTRA_DOMAINS=mi-preview.example.com
```

**Cabeceras de seguridad (API).** Todas las respuestas llevan `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` y CSP `frame-ancestors 'none'`, sin `X-Powered-By`; HSTS solo en producción. Excepción: `/hub/mock-provider/*` se puede encuadrar (`frame-ancestors 'self'` + `PUBLIC_WEB_URL` + `CORS_ORIGINS`).

## Sin Docker

```bash
cp .env.example .env   # y exporta las variables, p. ej. con `set -a; . ./.env; set +a`
cd apps/api && npm ci --legacy-peer-deps && npx prisma migrate deploy && npm run seed && npm run dev
cd apps/web && npm ci --legacy-peer-deps && npm run dev
cd apps/backoffice && npm ci && npm run dev    # puerto 3001
```

Atajos desde la raíz: `npm run dev:api`, `npm run dev:web`, `npm run db:migrate`, `npm run db:seed`.

### Desarrollo de módulos sin la Fase 1 completa

```bash
npm --prefix apps/api run dev:modules
```

Levanta todos los módulos en `:4000` con una billetera en memoria (`InMemoryWallet`), jugadores sembrados con `DEV_PLAYERS` (formato `operador:jugador`, separados por coma) y autenticación simulada (`MockAuth`, tokens `dev:<ROL>:<operador>:<id>`). No sirve en producción y no usa Postgres. Úsalo para probar el lobby y el backoffice en local. Detalle en [docs/integration.md](docs/integration.md).

## Pruebas

```bash
docker compose -f docker-compose.test.yml up -d   # Postgres efímero en el puerto 5433
npm test                                          # = npm --prefix apps/api test (Vitest)
npm run test:long                                 # igual, con RTP_LONG=1 (pruebas largas de RTP)
npm --prefix apps/api run typecheck
```

`npm --prefix apps/api test` ejecuta `tests/**` y `src/modules/**` con la misma configuración (`apps/api/vitest.config.mts`, con `globalSetup` que aplica las migraciones a la base de pruebas). Sin Docker, apunta `TEST_DATABASE_URL` a cualquier Postgres ≥ 14. Las pruebas de promociones contra Prisma usan `PROMO_TEST_DATABASE_URL` (con su propio `schema`). Sin `RTP_LONG=1`, las pruebas largas de RTP se saltan.

Las pruebas cubren el ledger de suma cero, idempotencia, concurrencia de apuestas, webhooks (firma inválida y reenvío), aislamiento entre operadores, reconciliación y el cableado de los módulos.

Otros scripts útiles de la API: `npm --prefix apps/api run sim` (simulación de la studio), `npm --prefix apps/api run prisma:modules` (valida el esquema Prisma único).

## Simular un webhook firmado (desarrollo)

```bash
npm --prefix apps/api run simulate:webhook
```

Firma y envía un webhook de depósito al endpoint local con las credenciales del PSP configuradas en `.env`; ver las opciones del script en `apps/api/scripts/simulate-webhook.ts`.

## Reconciliación del money-path

```bash
npm run reconcile                 # informe de discrepancias por operador
```

También disponible por API: `GET /api/backoffice/reconciliation?operatorId=` y como job periódico (`RECONCILIATION_INTERVAL_MINUTES`). Detalle de los chequeos en [docs/architecture.md](docs/architecture.md#reconciliación).

## Seguridad

No hay ningún endpoint que acredite dinero sin un webhook con firma verificada, una acción de backoffice autorizada y auditada, o un movimiento de juego firmado por un proveedor. No subas `.env` ni credenciales de PSP o de proveedores al repositorio.
