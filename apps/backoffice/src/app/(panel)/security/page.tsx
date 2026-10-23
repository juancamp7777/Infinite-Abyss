"use client";

import { useState } from "react";
import { Copy, KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { ApiError, request } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { patchSession } from "@/lib/auth";
import { Badge, Button, Card, ErrorBox, Field, Notice, PageHeader, Spinner, inputCls } from "@/components/ui";

interface Status { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number }
interface Setup { secret: string; otpauthUrl: string; qrSvg: string }

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Error inesperado");

export default function SecurityPage() {
  const st = useApi<Status>("/api/backoffice/auth/2fa");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMsg(null);
    try { await fn(); } catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(false); }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="Mi seguridad" subtitle="Verificación en dos pasos: además de la contraseña, un código de 6 dígitos de tu celular que cambia cada 30 segundos." />
      {st.error && <ErrorBox message={st.error} onRetry={st.reload} />}
      {st.loading && !st.data && <Spinner />}
      {st.data && (
        <Card title="Verificación en dos pasos" actions={st.data.enabled || recovery ? <Badge tone="good">Activa</Badge> : <Badge tone="warn">Desactivada</Badge>}>
          {recovery ? (
            <div className="space-y-3">
              <Notice tone="ok">¡Listo! Desde ahora te pediremos el código al entrar.</Notice>
              <p className="text-sm">Guarda estos <strong>códigos de respaldo</strong> en un lugar seguro (gestor de contraseñas o papel). Cada uno sirve <strong>una sola vez</strong> si pierdes el celular. No se vuelven a mostrar.</p>
              <ol className="grid grid-cols-2 gap-2 rounded-lg border border-white/10 bg-black/30 p-4 font-mono text-base sm:grid-cols-5">
                {recovery.map((c) => <li key={c}>{c}</li>)}
              </ol>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="ghost" onClick={() => void navigator.clipboard?.writeText(recovery.join("\n")).then(() => setMsg({ ok: true, text: "Códigos copiados" }))}><Copy aria-hidden className="mr-1 inline h-4 w-4" />Copiar códigos</Button>
                <Button type="button" onClick={() => { setRecovery(null); st.reload(); }}>Ya los guardé</Button>
              </div>
            </div>
          ) : st.data.enabled ? (
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => {
              const s = await request<Status>("/api/backoffice/auth/2fa/disable", { method: "POST", body: { password, code } });
              setPassword(""); setCode(""); patchSession({ mfaEnabled: s.enabled }); st.reload();
              setMsg({ ok: true, text: "Verificación en dos pasos desactivada" });
            }); }}>
              <p className="text-sm text-white/70"><ShieldCheck aria-hidden className="mr-1 inline h-4 w-4 text-emerald-400" />Activa desde {new Date(st.data.enabledAt!).toLocaleString("es")}. Te quedan <strong>{st.data.recoveryCodesLeft}</strong> códigos de respaldo.</p>
              <p className="text-sm text-white/60">Para desactivarla confirma tu contraseña y un código actual.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Contraseña" htmlFor="sec-pw"><input id="sec-pw" type="password" autoComplete="current-password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
                <Field label="Código" htmlFor="sec-code"><input id="sec-code" inputMode="numeric" autoComplete="one-time-code" className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} required maxLength={20} /></Field>
              </div>
              <Button type="submit" variant="danger" disabled={busy}><ShieldOff aria-hidden className="mr-1 inline h-4 w-4" />Desactivar</Button>
            </form>
          ) : !setup ? (
            <div className="space-y-3">
              <p className="text-sm text-white/70">Necesitas una app de autenticación en tu celular: <strong>Google Authenticator</strong>, Microsoft Authenticator, 1Password o Authy.</p>
              <Button type="button" disabled={busy} onClick={() => void run(async () => { setSetup(await request<Setup>("/api/backoffice/auth/2fa/setup", { method: "POST" })); })}><KeyRound aria-hidden className="mr-1 inline h-4 w-4" />Activar verificación en dos pasos</Button>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void run(async () => {
              const r = await request<{ recoveryCodes: string[]; status: Status }>("/api/backoffice/auth/2fa/enable", { method: "POST", body: { code } });
              setCode(""); setSetup(null); setRecovery(r.recoveryCodes); patchSession({ mfaEnabled: true });
            }); }}>
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                <li>Abre tu app de autenticación y toca <strong>+</strong> → <strong>Escanear código QR</strong>.</li>
                <li>Escanea este código (o escribe la clave a mano).</li>
                <li>Escribe abajo los 6 dígitos que muestra la app.</li>
              </ol>
              <div className="flex flex-wrap items-center gap-4">
                {/* SVG generado por el API (librería qrcode); no contiene texto del usuario. */}
                <div className="h-48 w-48 rounded-lg bg-white p-2" aria-label="Código QR para la app de autenticación" role="img" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
                <div className="min-w-0 flex-1 space-y-1 text-sm">
                  <p className="text-white/60">Clave para escribir a mano:</p>
                  <code className="block break-all rounded bg-black/30 p-2 font-mono tracking-wider">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
                </div>
              </div>
              <Field label="Código de 6 dígitos" htmlFor="sec-new-code">
                <input id="sec-new-code" autoFocus inputMode="numeric" autoComplete="one-time-code" className={`${inputCls} max-w-40 tracking-[.3em]`} value={code} onChange={(e) => setCode(e.target.value)} required maxLength={7} />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>{busy ? "Verificando…" : "Confirmar y activar"}</Button>
                <Button type="button" variant="ghost" onClick={() => { setSetup(null); setCode(""); }}>Cancelar</Button>
              </div>
            </form>
          )}
          {msg && <div className="mt-3" role={msg.ok ? "status" : "alert"}><Notice tone={msg.ok ? "ok" : "warn"}>{msg.text}</Notice></div>}
        </Card>
      )}
    </div>
  );
}
