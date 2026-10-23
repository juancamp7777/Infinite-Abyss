# Paridad con los repos originales

Auditoría del 2026-10-23: cada función de Magik CRM, Beast CRM, StrikeIQ, Astroclub y BetBattle comparada con Infinite Abyss.
✅ ya está · 🟡 parcial · ❌ falta. El orden de "Plan" es el de construcción (impacto en el negocio primero).

## Ya cubierto (✅)
- Inbox en tiempo real, respuestas rápidas, notas internas, WhatsApp Cloud API, Telegram, webchat con login del jugador.
- Comprobantes con IA cruzados con feed bancario (Pearl), retiro desde el chat, crear usuario desde el bot (nodo `register` de Tide).
- Ajuste manual de saldo (Jugadores), aprobación de retiros, flujos Tide con versiones, segmentos, perfil 360, 2FA, integraciones.
- Agregadores API-Slots y API-Matic, catálogo, lobby, caja, autoexclusión, jackpots, rueda, torneos, misiones, VIP.
- Plantillas Reef (4) con borrador, vista previa, versiones y rollback.
- Crew: fichaje, pausas, checklist, avisos con acuse, caja de turno, nómina básica; Ascend: XP, ligas, insignias, ranking.

## Plan

### 1. Caja en el chat (Magik)
- Panel lateral del chat con la ficha del jugador vinculado: saldo real, bonos, retirable y última carga.
- Campo de monto con **+ Cargar / − Descontar** (idempotente, auditado) y estado "carga sin confirmar".
- Vincular el chat a un jugador o **crear usuario** desde el chat, con diálogo de credenciales y botón para enviarlas.
- Comprobantes y transferencias del chat con ✓ para acreditar; **Pedir retiro** con cola, banquero y límites por persona y turno.
- Bono desde el chat; filtro "Esperando"; etiquetas en la conversación.

### 2. Bot cajero (RoboBeast)
- Bot por embudo que acredita comprobantes solo y pasa a humano moviendo el chat (Soporte / Pendiente).
- Configuración por agencia: bienvenida, seguimientos, depósito y retiro mínimos, modo sin carga por horario.

### 3. Atención y equipo
- Reparto automático de chats (round-robin / ponderado), presencia, SLA y alertas de demora por agente.
- Métricas por agente y turno: cargas, retiros, mensajes, tiempo de respuesta, cargas del bot.
- Embudos configurables con SLA, edición masiva, mensajes programados, chat interno.

### 4. Captación y reactivación
- Plantillas de WhatsApp (HSM) y envíos masivos a contactos del inbox.
- Rotador de links de WhatsApp con clics y atribución Meta CTWA hasta el primer depósito.
- Importar y exportar contactos por CSV.
- Promos interactivas (cofres), regalos de fichas con presets, cashback por niveles.

### 5. Plataforma abierta
- Roles y permisos granulares (unificar `OPERATOR_SUPPORT`/`OPERATOR_FINANCE` con `OPERATOR_AGENT`).
- Tokens de API con scopes, API pública v1, webhooks salientes firmados con reintentos (**n8n** se conecta por aquí).
- Tide: disparadores por evento y horario, nodo de IA de intención, HTTP, subflujo, visor de ejecuciones.

### 6. Red de agentes (Astroclub)
- Jerarquía de agentes con venta de fichas: cuenta corriente, crédito, liquidaciones, comisiones, transferencias entre niveles.
- RTP y juegos por sala; multisitio por operador; editor de páginas por bloques.

### 7. Jugador
- Recuperar contraseña, centro de notificaciones, página de promociones con progreso de wager, raspadita, i18n.
- KYC con documentos y revisión; antifraude multicuenta (IP/wifi compartido, holds AML).

### 8. Leviathan (BetBattle)
- Concursos de fichas con bolsa cerrada: motor, escrow, curva de premios, rake, modos rápido, torneo y amigos.
- Feed deportivo con confirmación de resultados en dos fuentes; sección de deportes.

### 9. Gestión (StrikeIQ)
- Caja avanzada: cierre diario, multimoneda, cotización USDT, cuentas recaudadoras, wallets.
- Nómina completa (aguinaldo, reparto por marca, asiento en ledger, comprobante), kanban con cronómetro.
- Dashboard analítico: comparar períodos, nuevos y recurrentes, cohortes, CAC/ROI, informe IA.
- Academia, contenido y flyers, publicidad Meta, minijuegos.

## Excluido a propósito
- WhatsApp no oficial por QR, "warmer" y humanizador de líneas (riesgo de baneo y de términos de Meta).
