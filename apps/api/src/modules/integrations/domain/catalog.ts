/**
 * Catálogo de integraciones de Abyss Command: qué se puede conectar, con qué campos y en qué alcance.
 * Los secretos nunca vuelven al navegador (se muestran enmascarados); los campos `env` alimentan a los módulos
 * que hoy leen su configuración del entorno (proveedores de juegos del Hub) sin reiniciar el servidor.
 */

export type IntegrationCategory = 'ai' | 'games' | 'payments' | 'alerts';
/** platform = una sola para toda la plataforma (solo PLATFORM_ADMIN) · operator = cada casino la suya · both = la del casino o, si no tiene, la de la plataforma. */
export type IntegrationScope = 'platform' | 'operator' | 'both';
/** live = funciona hoy · contract = el conector existe y se completa con el manual del proveedor · soon = se guarda ya, el conector llega en el bloque de pagos. */
export type IntegrationReadiness = 'live' | 'contract' | 'soon';

export interface FieldDef {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  /** Debe ser https://… */
  url?: boolean;
  /** Variable de entorno que reemplaza (proveedores del Hub). */
  env?: string;
  placeholder?: string;
}

export interface IntegrationDef {
  key: string;
  category: IntegrationCategory;
  name: string;
  description: string;
  scope: IntegrationScope;
  readiness: IntegrationReadiness;
  /** http = se prueba contra el servicio · catalog = se descarga el catálogo de juegos · none = sin prueba automática todavía. */
  test: 'http' | 'catalog' | 'none';
  fields: FieldDef[];
}

const apiKey = (label = 'API key'): FieldDef => ({ name: 'apiKey', label, secret: true, required: true });
const allowedIps = (env: string): FieldDef => ({ name: 'allowedIps', label: 'IPs permitidas del proveedor (separadas por coma)', env, placeholder: '203.0.113.10, 203.0.113.11' });

export const INTEGRATIONS: IntegrationDef[] = [
  // ───── Inteligencia artificial (Pearl, Nautilus) ─────
  { key: 'anthropic', category: 'ai', name: 'Claude (Anthropic)', description: 'Lee comprobantes en Pearl y será el cerebro de Nautilus, el operador IA.', scope: 'both', readiness: 'live', test: 'http', fields: [apiKey()] },
  { key: 'gemini', category: 'ai', name: 'Gemini (Google)', description: 'Alternativa para leer comprobantes en Pearl.', scope: 'both', readiness: 'live', test: 'http', fields: [apiKey()] },
  { key: 'deepseek', category: 'ai', name: 'DeepSeek', description: 'Alternativa económica para leer comprobantes en Pearl.', scope: 'both', readiness: 'live', test: 'http', fields: [apiKey()] },

  // ───── Proveedores de juegos (Hub, toda la plataforma) ─────
  {
    key: 'api-matic', category: 'games', name: 'API-Matic', description: 'Agregador con cientos de slots y casino en vivo. Al conectarlo se descarga su catálogo.', scope: 'platform', readiness: 'live', test: 'catalog',
    fields: [
      { name: 'apiKey', label: 'API key', secret: true, required: true, env: 'HUB_APIMATIC_API_KEY' },
      { name: 'secretKey', label: 'Secret key (hex)', secret: true, required: true, env: 'HUB_APIMATIC_SECRET_KEY' },
      { name: 'host', label: 'Host de la API', env: 'HUB_APIMATIC_HOST', placeholder: 'api.proveedor.com' },
      allowedIps('HUB_APIMATIC_ALLOWED_IPS'),
    ],
  },
  {
    key: 'api-slots', category: 'games', name: 'API-Slots', description: 'Agregador de slots. Al conectarlo se descarga su catálogo.', scope: 'platform', readiness: 'live', test: 'catalog',
    fields: [
      { name: 'partnerId', label: 'Partner ID', required: true, env: 'HUB_APISLOTS_PARTNER_ID' },
      { name: 'apiKey', label: 'API key', secret: true, required: true, env: 'HUB_APISLOTS_API_KEY' },
      { name: 'apiUrl', label: 'URL de la API', url: true, env: 'HUB_APISLOTS_API_URL', placeholder: 'https://…' },
      allowedIps('HUB_APISLOTS_ALLOWED_IPS'),
    ],
  },
  {
    key: 'pragmatic-play', category: 'games', name: 'Pragmatic Play', description: 'Conexión directa. Se completa con el manual y las credenciales de prueba que entrega Pragmatic tras el contrato.', scope: 'platform', readiness: 'contract', test: 'catalog',
    fields: [
      { name: 'apiUrl', label: 'URL de la API', required: true, url: true, env: 'HUB_PRAGMATIC_API_URL', placeholder: 'https://…' },
      { name: 'secureLogin', label: 'Secure login', required: true, env: 'HUB_PRAGMATIC_SECURE_LOGIN' },
      { name: 'secret', label: 'Secret key', secret: true, required: true, env: 'HUB_PROVIDER_PRAGMATIC_PLAY_SECRET' },
    ],
  },
  {
    key: 'evolution', category: 'games', name: 'Evolution', description: 'Casino en vivo directo. Se completa con el manual de Evolution tras el contrato.', scope: 'platform', readiness: 'contract', test: 'catalog',
    fields: [
      { name: 'apiUrl', label: 'URL de la API', required: true, url: true, env: 'HUB_EVOLUTION_API_URL', placeholder: 'https://…' },
      { name: 'casinoKey', label: 'Casino key', secret: true, required: true, env: 'HUB_EVOLUTION_CASINO_KEY' },
      { name: 'apiToken', label: 'API token', secret: true, required: true, env: 'HUB_EVOLUTION_API_TOKEN' },
      { name: 'secret', label: 'Secreto de firma', secret: true, required: true, env: 'HUB_PROVIDER_EVOLUTION_SECRET' },
    ],
  },
  {
    key: 'aggregator', category: 'games', name: 'Otro agregador', description: 'Cualquier agregador con wallet sin costura. Se completa con su manual.', scope: 'platform', readiness: 'contract', test: 'catalog',
    fields: [
      { name: 'apiUrl', label: 'URL de la API', required: true, url: true, env: 'HUB_AGGREGATOR_API_URL', placeholder: 'https://…' },
      { name: 'operatorRef', label: 'ID de operador en el agregador', required: true, env: 'HUB_AGGREGATOR_OPERATOR_ID' },
      { name: 'secret', label: 'Secreto de firma', secret: true, required: true, env: 'HUB_PROVIDER_AGGREGATOR_SECRET' },
    ],
  },

  // ───── Pagos (cada casino con su cuenta) ─────
  {
    key: 'binance-pay', category: 'payments', name: 'Binance Pay', description: 'Depósitos en cripto con confirmación automática. El conector llega en el bloque de pagos cripto.', scope: 'operator', readiness: 'soon', test: 'none',
    fields: [{ name: 'apiKey', label: 'API key', secret: true, required: true }, { name: 'secretKey', label: 'Secret key', secret: true, required: true }],
  },
  {
    key: 'passimpay', category: 'payments', name: 'Passimpay', description: 'Pasarela cripto (USDT, BTC, ETH…). El conector llega en el bloque de pagos cripto.', scope: 'operator', readiness: 'soon', test: 'none',
    fields: [{ name: 'platformId', label: 'Platform ID', required: true }, { name: 'apiKey', label: 'API key', secret: true, required: true }],
  },
  {
    key: 'usdt-wallet', category: 'payments', name: 'Billetera USDT', description: 'Dirección donde recibir USDT. Se mostrará al jugador al depositar en cripto.', scope: 'operator', readiness: 'soon', test: 'none',
    fields: [{ name: 'network', label: 'Red (TRC20, BEP20, ERC20…)', required: true, placeholder: 'TRC20' }, { name: 'address', label: 'Dirección', required: true }],
  },

  // ───── Alertas (Depth y Nautilus) ─────
  {
    key: 'telegram-alerts', category: 'alerts', name: 'Alertas por Telegram', description: 'Bot que avisa de caídas, saldos bajos, colas atascadas y el resumen diario de Nautilus.', scope: 'both', readiness: 'live', test: 'http',
    fields: [{ name: 'botToken', label: 'Token del bot (@BotFather)', secret: true, required: true }, { name: 'chatId', label: 'Chat ID del grupo o persona', required: true, placeholder: '-1001234567890' }],
  },
];

export const integrationDef = (key: string): IntegrationDef | undefined => INTEGRATIONS.find((d) => d.key === key);

/** ¿Este alcance puede guardar esta integración? */
export function scopeAllowed(def: IntegrationDef, scope: 'platform' | 'operator'): boolean {
  return def.scope === 'both' || def.scope === scope;
}

/** Secreto enmascarado para mostrar: solo los últimos 4 caracteres. */
export const maskSecret = (v: string): string => (v.length <= 8 ? '••••' : `••••${v.slice(-4)}`);

export interface ValidationResult {
  values: Record<string, string>;
  errors: string[];
}

/**
 * Combina lo guardado con lo nuevo. Un campo secreto vacío conserva el valor anterior (el navegador nunca lo tuvo);
 * null borra. Valida obligatorios, URLs https y tamaños.
 */
export function mergeValues(def: IntegrationDef, current: Record<string, string>, input: Record<string, unknown>): ValidationResult {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const f of def.fields) {
    const raw = input[f.name];
    let v: string | undefined;
    if (raw === null) v = undefined;
    else if (typeof raw === 'string' && raw.trim() !== '') v = raw.trim();
    else if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) v = f.secret ? current[f.name] : raw === undefined ? current[f.name] : undefined;
    else errors.push(`${f.label}: valor inválido`);
    if (v !== undefined) {
      if (v.length > 4000) errors.push(`${f.label}: demasiado largo`);
      else if (/[\r\n\0]/.test(v)) errors.push(`${f.label}: no puede tener saltos de línea`);
      else if (f.url && !/^https:\/\/[^\s<>"']+$/i.test(v)) errors.push(`${f.label}: debe empezar con https://`);
      else values[f.name] = v;
    }
    if (f.required && values[f.name] === undefined && !errors.some((e) => e.startsWith(f.label))) errors.push(`${f.label}: obligatorio`);
  }
  for (const k of Object.keys(input)) if (!def.fields.some((f) => f.name === k)) errors.push(`Campo desconocido: ${k}`);
  return { values, errors };
}
