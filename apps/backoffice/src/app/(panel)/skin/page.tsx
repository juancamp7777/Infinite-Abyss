"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ApiError, type Skin } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { Button, Card, ErrorBox, Field, Notice, NeedOperator, PageHeader, Spinner, inputCls } from "@/components/ui";

type Colors = Skin["colors"];
type Banner = Skin["banners"][number];
const COLOR_KEYS: Array<[keyof Colors, string]> = [["primary", "Primario"], ["secondary", "Secundario"], ["background", "Fondo"], ["surface", "Superficie"], ["text", "Texto"], ["accent", "Acento"]];

export default function SkinPage() {
  const { operatorId, call } = useApiClient();
  const cur = useApi<Skin & { logoSvg?: string }>(operatorId ? `/backoffice/v1/admin/skins/${encodeURIComponent(operatorId)}` : null);
  const [name, setName] = useState("");
  const [logoMode, setLogoMode] = useState<"url" | "svg">("url");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoSvg, setLogoSvg] = useState("");
  const [colors, setColors] = useState<Colors | null>(null);
  const [banners, setBanners] = useState<Banner[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const s = cur.data;
    if (!s) return;
    setName(s.name);
    setLogoUrl(s.logoUrl ?? "");
    setLogoSvg(s.logoSvg ?? "");
    setLogoMode(s.logoSvg ? "svg" : "url");
    setColors(s.colors);
    setBanners(s.banners ?? []);
  }, [cur.data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      const body = { name, colors, banners: banners.map((b) => ({ ...b, imageUrl: b.imageUrl || undefined })), ...(logoMode === "svg" ? { logoSvg } : { logoUrl }) };
      await call(`/backoffice/v1/admin/skins/${encodeURIComponent(operatorId!)}`, { method: "PUT", body });
      setMsg({ ok: true, text: "Skin guardada" });
      cur.reload();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : "Error inesperado" });
    } finally {
      setSaving(false);
    }
  }
  const updBanner = (i: number, patch: Partial<Banner>) => setBanners((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const vars = colors
    ? ({ "--brand-primary": colors.primary, "--brand-secondary": colors.secondary, "--brand-bg": colors.background, "--brand-surface": colors.surface, "--brand-text": colors.text, "--brand-accent": colors.accent } as CSSProperties)
    : undefined;

  return (
    <div className="space-y-4">
      <PageHeader title="Skin del operador" subtitle="Marca del lobby: nombre, logo, colores y banners, con vista previa en vivo." />
      {!operatorId && <NeedOperator />}
      {operatorId && cur.loading && !cur.data && <Spinner />}
      {cur.error && <ErrorBox message={cur.error} onRetry={cur.reload} />}
      {operatorId && colors && (
        <div className="grid gap-4 lg:grid-cols-2">
          <form onSubmit={save} className="space-y-4">
            <Card title="Identidad">
              <Field label="Nombre" htmlFor="sk-name"><input id="sk-name" required maxLength={60} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <fieldset className="mt-3">
                <legend className="mb-1 text-xs text-white/60">Logo</legend>
                <label className="mr-4 text-sm"><input type="radio" name="lm" checked={logoMode === "url"} onChange={() => setLogoMode("url")} /> URL</label>
                <label className="text-sm"><input type="radio" name="lm" checked={logoMode === "svg"} onChange={() => setLogoMode("svg")} /> SVG</label>
                {logoMode === "url" ? (
                  <input aria-label="URL del logo" className={`${inputCls} mt-2`} placeholder="https://… o /ruta" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
                ) : (
                  <textarea aria-label="SVG del logo" rows={4} className={`${inputCls} mt-2 font-mono`} placeholder="<svg viewBox=…>" value={logoSvg} onChange={(e) => setLogoSvg(e.target.value)} />
                )}
              </fieldset>
            </Card>
            <Card title="Colores">
              <div className="grid grid-cols-2 gap-3">
                {COLOR_KEYS.map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2 text-sm">
                    <input type="color" aria-label={label} value={/^#[0-9a-fA-F]{6}$/.test(colors[k]) ? colors[k] : "#000000"} onChange={(e) => setColors({ ...colors, [k]: e.target.value })} />
                    {label} <code className="text-xs text-white/50">{colors[k]}</code>
                  </label>
                ))}
              </div>
            </Card>
            <Card title="Banners" actions={<Button type="button" variant="ghost" onClick={() => setBanners([...banners, { title: "", subtitle: "", href: "/" }])}>Añadir</Button>}>
              {banners.length === 0 && <p className="text-sm text-white/50">Sin banners.</p>}
              {banners.map((b, i) => (
                <div key={i} className="mb-3 grid gap-2 rounded-md border border-white/10 p-3">
                  <input aria-label={`Título del banner ${i + 1}`} className={inputCls} placeholder="Título" value={b.title} onChange={(e) => updBanner(i, { title: e.target.value })} />
                  <input aria-label={`Subtítulo del banner ${i + 1}`} className={inputCls} placeholder="Subtítulo" value={b.subtitle} onChange={(e) => updBanner(i, { subtitle: e.target.value })} />
                  <input aria-label={`Enlace del banner ${i + 1}`} className={inputCls} placeholder="/ruta" value={b.href} onChange={(e) => updBanner(i, { href: e.target.value })} />
                  <input aria-label={`Imagen del banner ${i + 1}`} className={inputCls} placeholder="URL de imagen (opcional)" value={b.imageUrl ?? ""} onChange={(e) => updBanner(i, { imageUrl: e.target.value })} />
                  <Button type="button" variant="danger" onClick={() => setBanners(banners.filter((_, j) => j !== i))}>Quitar</Button>
                </div>
              ))}
            </Card>
            <Button type="submit" disabled={saving}>{saving ? "Guardando…" : "Guardar skin"}</Button>
            {msg && <div role={msg.ok ? "status" : "alert"}><Notice tone={msg.ok ? "ok" : "warn"}>{msg.text}</Notice></div>}
          </form>
          <Card title="Vista previa">
            <div style={{ ...vars, background: "var(--brand-bg)", color: "var(--brand-text)" }} className="space-y-3 rounded-lg p-4" aria-label="Vista previa del lobby">
              <div className="flex items-center gap-3 rounded-md p-3" style={{ background: "var(--brand-surface)" }}>
                {logoMode === "url" && logoUrl && /^(https?:\/\/|\/(?!\/))/.test(logoUrl) && /* eslint-disable-next-line @next/next/no-img-element */ <img src={logoUrl} alt="" className="h-8" />}
                <strong>{name || "Nombre del casino"}</strong>
              </div>
              {logoMode === "svg" && <div className="text-xs opacity-60">El logo SVG se sanea en el servidor al guardar.</div>}
              <button type="button" className="rounded-md px-4 py-2 text-sm font-semibold" style={{ background: "var(--brand-primary)", color: "#fff" }}>Jugar ahora</button>{" "}
              <button type="button" className="rounded-md px-4 py-2 text-sm font-semibold" style={{ background: "var(--brand-secondary)", color: "#fff" }}>Depositar</button>
              <div className="inline-block rounded px-2 py-1 text-xs font-bold" style={{ background: "var(--brand-accent)", color: "#000" }}>JACKPOT</div>
              {banners.map((b, i) => (
                <div key={i} className="rounded-md p-4" style={{ background: `linear-gradient(135deg, var(--brand-primary), var(--brand-secondary))` }}>
                  <div className="font-semibold">{b.title || "Título"}</div>
                  <div className="text-sm opacity-80">{b.subtitle || "Subtítulo"}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
