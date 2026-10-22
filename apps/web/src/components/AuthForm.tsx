"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { Field } from "./Field";
import { BrandLogo } from "./SiteFooter";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Form({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const params = useSearchParams();
  const { login, register } = useAuth();
  const { brand, operator } = useTheme();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string; username?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === "register";
  const rawNext = params.get("next") ?? "/";
  // Solo rutas internas, para evitar redirecciones abiertas.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!EMAIL_RE.test(email.trim())) errs.email = "Ingresa un correo válido.";
    if (isRegister ? password.length < 8 : password.length === 0) {
      errs.password = isRegister ? "La contraseña debe tener al menos 8 caracteres." : "Ingresa tu contraseña.";
    }
    if (isRegister && username && !/^[A-Za-z0-9_.-]{3,30}$/.test(username)) {
      errs.username = "Usa de 3 a 30 letras, números, punto, guion o guion bajo.";
    }
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;

    setBusy(true);
    try {
      if (isRegister) await register({ email: email.trim(), password, username: username || undefined });
      else await login(email.trim(), password);
      router.replace(next);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "No se pudo completar la solicitud.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <form onSubmit={submit} noValidate className="w-full max-w-md bg-surface border border-gold-900/50 rounded-2xl p-8 flex flex-col gap-5 shadow-2xl" aria-labelledby="auth-title">
        <div className="flex justify-center">
          <BrandLogo className="h-10" />
        </div>
        <h1 id="auth-title" className="font-serif text-3xl text-center text-white uppercase tracking-widest">
          {isRegister ? "Crear cuenta" : "Iniciar sesión"}
        </h1>
        <p className="text-center text-xs text-gray-400">{brand.displayName || operator.name}</p>

        {formError && (
          <div role="alert" className="bg-red-950/60 border border-red-900 text-red-200 text-sm rounded-lg p-3">
            {formError}
          </div>
        )}

        <Field label="Correo electrónico" type="email" value={email} onChange={setEmail} error={errors.email} autoComplete="email" required inputMode="email" name="email" />
        {isRegister && (
          <Field label="Usuario (opcional)" value={username} onChange={setUsername} error={errors.username} autoComplete="username" name="username" />
        )}
        <Field
          label="Contraseña"
          type="password"
          value={password}
          onChange={setPassword}
          error={errors.password}
          autoComplete={isRegister ? "new-password" : "current-password"}
          hint={isRegister ? "Mínimo 8 caracteres." : undefined}
          required
          name="password"
        />

        <button type="submit" disabled={busy} className="bg-gold-gradient text-black font-bold py-3 rounded-xl disabled:opacity-60">
          {busy ? "Procesando…" : isRegister ? "Registrarme" : "Entrar"}
        </button>

        <p className="text-center text-sm text-gray-400">
          {isRegister ? (
            <>
              ¿Ya tienes cuenta?{" "}
              <Link href="/login" className="text-gold-300 underline">
                Inicia sesión
              </Link>
            </>
          ) : (
            <>
              ¿Eres nuevo?{" "}
              <Link href="/register" className="text-gold-300 underline">
                Crea tu cuenta
              </Link>
            </>
          )}
        </p>
        {isRegister && <p className="text-[11px] text-gray-400 text-center">Al registrarte confirmas que eres mayor de 18 años y aceptas los términos de la sala.</p>}
      </form>
    </main>
  );
}

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  return (
    <Suspense fallback={<div role="status" className="flex-1 flex items-center justify-center text-gray-400">Cargando…</div>}>
      <Form mode={mode} />
    </Suspense>
  );
}
