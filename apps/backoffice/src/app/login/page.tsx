"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient, BASE_PATH, homeFor, MOCK_AUTH, MOCK_ROLES, ROLE_LABEL, takeLoginNotice, type Role } from "@/lib/auth";
import { Button, ErrorBox, Field, inputCls, Notice } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [role, setRole] = useState<Role>("OPERATOR_ADMIN");
  const [operatorId, setOperatorId] = useState("demo");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // takeLoginNotice borra el aviso: en StrictMode el efecto corre dos veces, así que no se pisa con null.
    const n = takeLoginNotice();
    if (n) setNotice(n);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await authClient.login(MOCK_AUTH ? { role, operatorId: role === "PLATFORM_ADMIN" ? undefined : operatorId.trim() } : { email, password });
      router.replace(homeFor(s.role));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar sesión");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="flex flex-col items-center gap-3 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${BASE_PATH}/brand/infinite-abyss-logo.svg`} alt="Infinite Abyss" className="h-14 w-auto" />
        <span className="text-[11px] font-semibold uppercase tracking-[.3em] text-brand">Abyss Command</span>
      </h1>
      {MOCK_AUTH && <Notice tone="warn">Modo desarrollo: login simulado (NEXT_PUBLIC_BACKOFFICE_MOCK_AUTH=true). Nunca se activa en producción.</Notice>}
      {notice && <Notice tone="warn">{notice}</Notice>}
      <form onSubmit={submit} className="space-y-4 rounded-2xl border border-white/10 bg-panel/80 p-6 shadow-2xl shadow-black/40">
        {MOCK_AUTH ? (
          <>
            <Field label="Rol" htmlFor="role">
              <select id="role" className={inputCls} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {MOCK_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </Field>
            {role !== "PLATFORM_ADMIN" && (
              <Field label="Operador" htmlFor="op">
                <input id="op" className={inputCls} value={operatorId} onChange={(e) => setOperatorId(e.target.value)} required pattern="[A-Za-z0-9_.:\-]{1,64}" />
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label="Correo" htmlFor="email">
              <input id="email" type="email" autoComplete="username" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />
            </Field>
            <Field label="Contraseña" htmlFor="password">
              <input id="password" type="password" autoComplete="current-password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={200} />
            </Field>
          </>
        )}
        {error && <ErrorBox message={error} />}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Entrando…" : "Entrar"}
        </Button>
      </form>
    </main>
  );
}
