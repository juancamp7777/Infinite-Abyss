# Infraestructura de Infinite Abyss (VPS + Docker)

Portable: las mismas imágenes y el mismo `docker-compose.prod.yml` sirven en cualquier VPS (y migran a Kubernetes sin reescribir nada).

| Pieza | Qué hace |
|---|---|
| `docker-compose.prod.yml` | Postgres (red interna, sin puertos), API, web, backoffice, Caddy (HTTPS automático) y backup |
| `caddy/Caddyfile` | Casino, backoffice y API por dominio; `/api-proxy/*` directo a la API (incluye websockets) |
| `backup/` | `pg_dump` verificado cada `BACKUP_INTERVAL_HOURS`, retención local y copia externa cifrada con restic |
| `ansible/site.yml` | Endurece el VPS (SSH solo con llave, sin root, UFW 22/80/443, fail2ban, parches automáticos), instala Docker y despliega |
| `.github/workflows/deploy.yml` | Cada push a `main` publica imágenes en GHCR y, si hay servidor, despliega ese sha |

## Primera puesta en marcha
1. **Proveedor**: VPS Ubuntu 24.04 (4 vCPU / 8 GB para staging) de un proveedor cuyos términos permitan iGaming.
2. **DNS**: registros A de `CASINO_DOMAIN`, `BACKOFFICE_DOMAIN` y `API_DOMAIN` → IP del VPS.
3. **Variables**: `cp infra/.env.production.example infra/.env.production`, completar y generar cada secreto con `openssl rand -hex 32`.
4. **Provisionar y desplegar** (desde tu PC, con tu llave SSH cargada en el VPS):
   ```bash
   cp infra/ansible/inventory.example.ini infra/ansible/inventory.ini   # IP y usuario inicial
   ansible-galaxy collection install -r infra/ansible/requirements.yml
   GHCR_USER=juancamp7777 GHCR_TOKEN=<token con read:packages> \
     ansible-playbook -i infra/ansible/inventory.ini infra/ansible/site.yml -e env_file=../.env.production
   ```
5. **Bootstrap** (admin de plataforma, operador y dominios; sin datos demo):
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production exec \
     -e BOOTSTRAP_ADMIN_EMAIL=ops@tuempresa.com -e BOOTSTRAP_ADMIN_PASSWORD='…' \
     -e BOOTSTRAP_OPERATOR_SLUG=abyss -e BOOTSTRAP_OPERATOR_NAME='Infinite Abyss' \
     -e BOOTSTRAP_OPERATOR_CURRENCY=COP -e BOOTSTRAP_DOMAINS=casino.tudominio.com \
     api npm run bootstrap
   ```
6. **CI**: en GitHub → Settings → Environments → `staging`, cargar `DEPLOY_HOST`, `DEPLOY_USER` (`abyss`), `DEPLOY_SSH_KEY` y `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan <ip>`), y la variable `CASINO_URL`.

## Operación
- **Desplegar una versión**: push a `main` (automático) o `IMAGE_TAG=<sha>` en `.env.production` y `docker compose … up -d --pull always --no-build`.
- **Rollback**: volver `IMAGE_TAG` al sha anterior y repetir el `up`. Las migraciones son aditivas; nunca se ejecuta `db push`.
- **Backup manual**: `docker compose … run --rm backup --once`.
- **Restaurar** (destructivo, exige nombre de base):
  `docker compose … run --rm --entrypoint /bin/sh backup /opt/backup/restore.sh /backups/abyss-<fecha>.dump <base>`.
  Probar la restauración en una base aparte (p. ej. `abyss_restore_test`) al menos una vez al mes.
- **Logs**: `docker compose … logs -f api` (rotación 5 × 20 MB por servicio).

## Escalar
Una instancia de la API por ahora: el bus de eventos, los sockets en vivo y la memoria anti-replay de los agregadores son en proceso.
Para varias instancias: Redis (bus de eventos, adaptador de socket.io y nonces compartidos) y Postgres administrado o con réplica.
