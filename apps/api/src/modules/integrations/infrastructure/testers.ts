/**
 * Pruebas de conexión de las integraciones con prueba HTTP. Cada una hace la llamada más barata posible del servicio
 * (listar modelos, getMe del bot) y nunca incluye la llave en el mensaje de error.
 */

export interface TestResult {
  ok: boolean;
  message: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 8000;

async function call(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<Response | TestResult> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, message: timeout ? 'El servicio no respondió a tiempo' : 'No se pudo conectar con el servicio' };
  }
}

const isResult = (r: Response | TestResult): r is TestResult => !(r instanceof Response);

function httpFailure(service: string, status: number): TestResult {
  if (status === 401 || status === 403) return { ok: false, message: `${service} rechazó la llave (${status}): revisa que esté bien copiada y activa` };
  if (status === 429) return { ok: false, message: `${service} respondió 429: límite de uso o saldo agotado` };
  return { ok: false, message: `${service} respondió con error ${status}` };
}

async function models(fetchImpl: FetchLike, service: string, url: string, headers: Record<string, string>): Promise<TestResult> {
  const r = await call(fetchImpl, url, { headers });
  if (isResult(r)) return r;
  if (!r.ok) return httpFailure(service, r.status);
  return { ok: true, message: `${service}: llave válida` };
}

export async function testHttpIntegration(key: string, v: Record<string, string>, fetchImpl: FetchLike = fetch): Promise<TestResult> {
  switch (key) {
    case 'anthropic':
      return models(fetchImpl, 'Claude', 'https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': v.apiKey, 'anthropic-version': '2023-06-01' });
    case 'gemini':
      return models(fetchImpl, 'Gemini', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': v.apiKey });
    case 'deepseek':
      return models(fetchImpl, 'DeepSeek', 'https://api.deepseek.com/models', { Authorization: `Bearer ${v.apiKey}` });
    case 'telegram-alerts': {
      if (!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(v.botToken)) return { ok: false, message: 'El token no tiene el formato de @BotFather (123456:ABC…)' };
      const base = `https://api.telegram.org/bot${v.botToken}`;
      const me = await call(fetchImpl, `${base}/getMe`);
      if (isResult(me)) return me;
      if (!me.ok) return httpFailure('Telegram', me.status);
      const bot = ((await me.json().catch(() => null)) as { result?: { username?: string } } | null)?.result?.username;
      const sent = await call(fetchImpl, `${base}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: v.chatId, text: '✅ Infinite Abyss conectado: las alertas llegarán a este chat.' }),
      });
      if (isResult(sent)) return sent;
      if (!sent.ok) return { ok: false, message: `El bot${bot ? ` @${bot}` : ''} existe, pero no pudo escribir en el chat ${v.chatId}: agrégalo al grupo o escríbele primero` };
      return { ok: true, message: `Bot${bot ? ` @${bot}` : ''} conectado: se envió un mensaje de prueba al chat` };
    }
    default:
      return { ok: false, message: 'Esta integración no tiene prueba automática' };
  }
}
