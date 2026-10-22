"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Eye, History, Rocket, Save, Upload } from "lucide-react";
import { ApiError, buildUrl } from "@/lib/api";
import { API_URL, authClient } from "@/lib/auth";
import { useApi, useApiClient, useOperator } from "@/lib/hooks";
import { Badge, Button, Card, ErrorBox, Field, Notice, NeedOperator, PageHeader, Spinner, inputCls } from "@/components/ui";

type TemplateKey = "abyss" | "golden" | "emerald" | "royal";
type Font = "cinzel" | "playfair" | "inter" | "poppins" | "montserrat" | "geist";
type SectionKey = "hero" | "tiles" | "providers" | "last_wins" | "originals" | "slots" | "popular" | "new" | "live" | "live_bets" | "tournaments";
interface Banner { title: string; subtitle?: string; cta?: string; href: string; imageUrl?: string }
interface SiteConfig {
  template: TemplateKey;
  brand: { siteName: string; logoUrl?: string; faviconUrl?: string };
  colors: Record<"primary" | "secondary" | "background" | "surface" | "text" | "accent", string>;
  fonts: { display: Font; body: Font };
  layout: { nav: "sidebar" | "topbar"; cards: "square" | "portrait"; radius: "sm" | "md" | "lg" | "xl" };
  home: { sections: Array<{ key: SectionKey; visible: boolean }> };
  banners: Banner[];
  seo: { title: string; description: string };
  footer: { about: string; socials: Array<{ type: string; url: string }>; legal: string; license: string };
}
interface Editor { config: SiteConfig; hasDraft: boolean; publishedVersion: number | null; versions: Array<{ version: number; status: string; publishedAt: string; publishedBy: string }> }
interface Template { key: TemplateKey; name: string; description: string; defaults: Pick<SiteConfig, "colors" | "layout"> }

const COLOR_KEYS: Array<[keyof SiteConfig["colors"], string]> = [["primary", "Principal"], ["secondary", "Secundario"], ["background", "Fondo"], ["surface", "Tarjetas"], ["text", "Texto"], ["accent", "Acento"]];
const FONTS: Array<[Font, string]> = [["montserrat", "Montserrat"], ["poppins", "Poppins"], ["inter", "Inter"], ["geist", "Geist"], ["cinzel", "Cinzel"], ["playfair", "Playfair"]];
const SECTION_LABEL: Record<SectionKey, string> = {
  hero: "Banners y club VIP", tiles: "Accesos rápidos (mosaico)", providers: "Proveedores", last_wins: "Últimas ganancias", originals: "Originals", slots: "Slots",
  popular: "Populares", new: "Nuevos", live: "Casino en vivo", live_bets: "Apuestas en vivo", tournaments: "Torneos y misiones",
};
const SOCIALS = ["instagram", "facebook", "x", "tiktok", "telegram", "whatsapp", "youtube"];
const CASINO_URL = (process.env.NEXT_PUBLIC_CASINO_URL || "http://localhost:3000").replace(/\/+$/, "");

// Contraste WCAG (mismas reglas que valida el API al guardar).
const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (h: string) => { const n = parseInt(h.slice(1), 16); return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
function contrastIssues(c: SiteConfig["colors"]): string[] {
  const out: string[] = [];
  if (ratio(c.text, c.background) < 4.5) out.push(`Texto sobre fondo ${ratio(c.text, c.background)}:1 (mínimo 4.5)`);
  if (ratio(c.text, c.surface) < 4.5) out.push(`Texto sobre tarjetas ${ratio(c.text, c.surface)}:1 (mínimo 4.5)`);
  if (ratio(c.primary, c.background) < 3) out.push(`Principal sobre fondo ${ratio(c.primary, c.background)}:1 (mínimo 3)`);
  return out;
}

/** Imágenes subidas: la ruta del API se muestra a través del API. */
const imgSrc = (v?: string) => (v?.startsWith("/reef/v1/") ? `${API_URL}${v}` : v);
const errText = (e: unknown) => {
  if (!(e instanceof ApiError)) return "Error inesperado";
  const d = e.details;
  if (Array.isArray(d) && d.length) return `${e.message}: ${d.map((x) => (typeof x === "string" ? x : (x as { message?: string })?.message ?? "")).filter(Boolean).join(" · ")}`;
  return e.message;
};

/** Al cambiar de operador el editor se monta de nuevo (sin arrastrar borrador ni mensajes del anterior). */
export default function ReefPage() {
  const { operatorId } = useOperator();
  return <ReefEditor key={operatorId ?? "none"} />;
}

function ReefEditor() {
  const { operatorId, call } = useApiClient();
  const ed = useApi<Editor>(operatorId ? "/reef/v1/admin/site" : null);
  const tpl = useApi<{ items: Template[] }>(operatorId ? "/reef/v1/admin/templates" : null);
  const [cfg, setCfg] = useState<SiteConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => { if (ed.data) { setCfg(ed.data.config); setDirty(false); } }, [ed.data]);

  const set = (patch: Partial<SiteConfig>) => { setCfg((c) => (c ? { ...c, ...patch } : c)); setDirty(true); };
  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label);
    setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(null); }
  }
  const saveDraft = async () => { await call("/reef/v1/admin/site/draft", { method: "PUT", body: cfg }); setDirty(false); };

  if (!operatorId) return <div className="space-y-4"><PageHeader title="Reef · Plantillas" /><NeedOperator /></div>;
  if (ed.error) return <ErrorBox message={ed.error} onRetry={ed.reload} />;
  if (!cfg || !ed.data) return <Spinner />;

  const issues = contrastIssues(cfg.colors);
  const sections = cfg.home.sections;
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    set({ home: { sections: next } });
  };
  const updBanner = (i: number, patch: Partial<Banner>) => set({ banners: cfg.banners.map((b, j) => (j === i ? { ...b, ...patch } : b)) });

  async function upload(file: File, apply: (url: string) => void) {
    await run("upload", async () => {
      const token = authClient.token();
      const res = await fetch(buildUrl("/reef/v1/admin/assets", { operatorId }), { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(j?.error?.message ?? `Error ${res.status}`, res.status);
      apply((j as { url: string }).url);
      return "Imagen subida: guarda el borrador para conservarla";
    });
  }
  const fileInput = (label: string, apply: (url: string) => void) => (
    <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-xs hover:bg-white/5">
      <Upload aria-hidden className="h-3.5 w-3.5" />{label}
      <input type="file" accept="image/png,image/jpeg,image/webp,image/x-icon" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f, apply); }} />
    </label>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reef · Plantillas"
        subtitle="Diseño del casino del operador: plantilla, colores, tipografías, home, banners, SEO y footer. Se edita en borrador y se publica con versión."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {ed.data.publishedVersion ? <Badge tone="good">Publicada v{ed.data.publishedVersion}</Badge> : <Badge tone="warn">Sin publicar</Badge>}
            {(dirty || ed.data.hasDraft) && <Badge tone="warn">{dirty ? "Cambios sin guardar" : "Borrador pendiente"}</Badge>}
          </div>
        }
      />

      <Card title="Plantilla">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(tpl.data?.items ?? []).map((t) => (
            <button
              key={t.key} type="button" aria-pressed={cfg.template === t.key} disabled={!!busy}
              onClick={() => run("template", async () => {
                if (dirty) await saveDraft();
                const c = await call<SiteConfig>("/reef/v1/admin/site/template", { method: "POST", body: { template: t.key } });
                setCfg(c);
                setDirty(false);
                return `Plantilla ${t.name} aplicada al borrador (marca, banners, SEO y footer se conservan)`;
              })}
              className={`rounded-lg border p-3 text-left transition-colors ${cfg.template === t.key ? "border-amber-400 bg-amber-400/10" : "border-white/10 hover:border-white/30"}`}
            >
              <div className="mb-2 flex h-14 overflow-hidden rounded-md" aria-hidden style={{ background: t.defaults.colors.background }}>
                {t.defaults.layout.nav === "sidebar" && <div className="w-4" style={{ background: t.defaults.colors.surface }} />}
                <div className="flex flex-1 flex-col gap-1 p-1.5">
                  {t.defaults.layout.nav === "topbar" && <div className="h-2 rounded-sm" style={{ background: t.defaults.colors.surface }} />}
                  <div className="h-4 rounded-sm" style={{ background: `linear-gradient(90deg, ${t.defaults.colors.primary}, ${t.defaults.colors.secondary})` }} />
                  <div className="flex gap-1">{[0, 1, 2, 3].map((i) => <div key={i} className="h-3 flex-1 rounded-sm" style={{ background: t.defaults.colors.surface }} />)}</div>
                </div>
              </div>
              <p className="font-semibold">{t.name}</p>
              <p className="text-xs text-white/60">{t.description}</p>
            </button>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Marca">
          <Field label="Nombre del casino" htmlFor="rf-name"><input id="rf-name" maxLength={40} className={inputCls} value={cfg.brand.siteName} onChange={(e) => set({ brand: { ...cfg.brand, siteName: e.target.value } })} /></Field>
          {(["logoUrl", "faviconUrl"] as const).map((k) => (
            <div key={k} className="mt-3">
              <Field label={k === "logoUrl" ? "Logo" : "Favicon"} htmlFor={`rf-${k}`} hint="https://… o sube PNG, JPG, WEBP o ICO (máx. 1 MB)">
                <div className="flex items-center gap-2">
                  <input id={`rf-${k}`} className={inputCls} value={cfg.brand[k] ?? ""} placeholder="https://…" onChange={(e) => set({ brand: { ...cfg.brand, [k]: e.target.value || undefined } })} />
                  {fileInput("Subir", (url) => set({ brand: { ...cfg.brand, [k]: url } }))}
                </div>
              </Field>
              {cfg.brand[k] && <img src={imgSrc(cfg.brand[k])} alt={`Vista del ${k === "logoUrl" ? "logo" : "favicon"}`} className="mt-2 h-10 w-auto rounded bg-black/30 p-1" />}
            </div>
          ))}
        </Card>

        <Card title="Colores">
          <div className="grid grid-cols-2 gap-3">
            {COLOR_KEYS.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="color" aria-label={label} value={cfg.colors[k]} onChange={(e) => set({ colors: { ...cfg.colors, [k]: e.target.value } })} />
                {label} <code className="text-xs text-white/50">{cfg.colors[k]}</code>
              </label>
            ))}
          </div>
          <div className="mt-3" role="status">
            {issues.length ? <Notice tone="warn">Legibilidad insuficiente: {issues.join(" · ")}</Notice> : <Notice tone="ok">Contraste correcto (WCAG AA)</Notice>}
          </div>
          <div className="mt-3 rounded-md p-3 text-sm" style={{ background: cfg.colors.background, color: cfg.colors.text }} aria-label="Muestra de colores">
            <div className="rounded p-2" style={{ background: cfg.colors.surface }}>
              <strong style={{ color: cfg.colors.primary }}>{cfg.brand.siteName}</strong> · texto de ejemplo{" "}
              <span className="rounded px-1.5 py-0.5 text-xs font-bold" style={{ background: cfg.colors.accent, color: "#000" }}>JACKPOT</span>
            </div>
          </div>
        </Card>

        <Card title="Diseño">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tipografía de títulos" htmlFor="rf-fd">
              <select id="rf-fd" className={inputCls} value={cfg.fonts.display} onChange={(e) => set({ fonts: { ...cfg.fonts, display: e.target.value as Font } })}>{FONTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Field>
            <Field label="Tipografía de texto" htmlFor="rf-fb">
              <select id="rf-fb" className={inputCls} value={cfg.fonts.body} onChange={(e) => set({ fonts: { ...cfg.fonts, body: e.target.value as Font } })}>{FONTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </Field>
            <Field label="Menú" htmlFor="rf-nav">
              <select id="rf-nav" className={inputCls} value={cfg.layout.nav} onChange={(e) => set({ layout: { ...cfg.layout, nav: e.target.value as "sidebar" | "topbar" } })}><option value="sidebar">Lateral</option><option value="topbar">Superior</option></select>
            </Field>
            <Field label="Cartas de juegos" htmlFor="rf-cards">
              <select id="rf-cards" className={inputCls} value={cfg.layout.cards} onChange={(e) => set({ layout: { ...cfg.layout, cards: e.target.value as "square" | "portrait" } })}><option value="portrait">Verticales</option><option value="square">Cuadradas</option></select>
            </Field>
            <Field label="Bordes" htmlFor="rf-radius">
              <select id="rf-radius" className={inputCls} value={cfg.layout.radius} onChange={(e) => set({ layout: { ...cfg.layout, radius: e.target.value as SiteConfig["layout"]["radius"] } })}><option value="sm">Rectos</option><option value="md">Suaves</option><option value="lg">Redondeados</option><option value="xl">Muy redondeados</option></select>
            </Field>
          </div>
        </Card>

        <Card title="Secciones de la home">
          <ol className="space-y-1">
            {sections.map((s, i) => (
              <li key={s.key} className="flex items-center gap-2 rounded-md border border-white/10 px-2 py-1.5 text-sm">
                <input type="checkbox" aria-label={`Mostrar ${SECTION_LABEL[s.key]}`} checked={s.visible} onChange={(e) => set({ home: { sections: sections.map((x, j) => (j === i ? { ...x, visible: e.target.checked } : x)) } })} />
                <span className={`flex-1 ${s.visible ? "" : "text-white/40 line-through"}`}>{SECTION_LABEL[s.key]}</span>
                <button type="button" className="rounded p-1 hover:bg-white/10 disabled:opacity-30" aria-label={`Subir ${SECTION_LABEL[s.key]}`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp aria-hidden className="h-4 w-4" /></button>
                <button type="button" className="rounded p-1 hover:bg-white/10 disabled:opacity-30" aria-label={`Bajar ${SECTION_LABEL[s.key]}`} disabled={i === sections.length - 1} onClick={() => move(i, 1)}><ArrowDown aria-hidden className="h-4 w-4" /></button>
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Banners" actions={cfg.banners.length < 6 ? <Button type="button" variant="ghost" onClick={() => set({ banners: [...cfg.banners, { title: "", href: "/lobby" }] })}>Añadir</Button> : undefined}>
          {cfg.banners.length === 0 && <p className="text-sm text-white/50">Sin banners: se usan los de la marca.</p>}
          {cfg.banners.map((b, i) => (
            <div key={i} className="mb-3 grid gap-2 rounded-md border border-white/10 p-3">
              <input aria-label={`Título del banner ${i + 1}`} maxLength={60} className={inputCls} placeholder="Título" value={b.title} onChange={(e) => updBanner(i, { title: e.target.value })} />
              <input aria-label={`Subtítulo del banner ${i + 1}`} maxLength={140} className={inputCls} placeholder="Subtítulo" value={b.subtitle ?? ""} onChange={(e) => updBanner(i, { subtitle: e.target.value || undefined })} />
              <div className="grid grid-cols-2 gap-2">
                <input aria-label={`Botón del banner ${i + 1}`} maxLength={24} className={inputCls} placeholder="Texto del botón" value={b.cta ?? ""} onChange={(e) => updBanner(i, { cta: e.target.value || undefined })} />
                <input aria-label={`Enlace del banner ${i + 1}`} className={inputCls} placeholder="/lobby/…" value={b.href} onChange={(e) => updBanner(i, { href: e.target.value })} />
              </div>
              <div className="flex items-center gap-2">
                <input aria-label={`Imagen del banner ${i + 1}`} className={inputCls} placeholder="Imagen https://… (opcional)" value={b.imageUrl ?? ""} onChange={(e) => updBanner(i, { imageUrl: e.target.value || undefined })} />
                {fileInput("Subir", (url) => updBanner(i, { imageUrl: url }))}
              </div>
              <Button type="button" variant="danger" onClick={() => set({ banners: cfg.banners.filter((_, j) => j !== i) })}>Quitar</Button>
            </div>
          ))}
        </Card>

        <Card title="SEO y footer">
          <Field label="Título en buscadores" htmlFor="rf-st"><input id="rf-st" maxLength={70} className={inputCls} value={cfg.seo.title} onChange={(e) => set({ seo: { ...cfg.seo, title: e.target.value } })} /></Field>
          <div className="mt-3"><Field label="Descripción" htmlFor="rf-sd"><textarea id="rf-sd" rows={2} maxLength={170} className={inputCls} value={cfg.seo.description} onChange={(e) => set({ seo: { ...cfg.seo, description: e.target.value } })} /></Field></div>
          <div className="mt-3"><Field label="Sobre el casino" htmlFor="rf-ab"><textarea id="rf-ab" rows={2} maxLength={500} className={inputCls} value={cfg.footer.about} onChange={(e) => set({ footer: { ...cfg.footer, about: e.target.value } })} /></Field></div>
          <div className="mt-3"><Field label="Aviso legal" htmlFor="rf-lg"><textarea id="rf-lg" rows={3} maxLength={2000} className={inputCls} value={cfg.footer.legal} onChange={(e) => set({ footer: { ...cfg.footer, legal: e.target.value } })} /></Field></div>
          <div className="mt-3"><Field label="Licencia" htmlFor="rf-lc"><input id="rf-lc" maxLength={200} className={inputCls} value={cfg.footer.license} onChange={(e) => set({ footer: { ...cfg.footer, license: e.target.value } })} /></Field></div>
          <fieldset className="mt-3 space-y-2">
            <legend className="mb-1 text-xs text-white/60">Redes sociales</legend>
            {cfg.footer.socials.map((s, i) => (
              <div key={i} className="flex gap-2">
                <select aria-label={`Red ${i + 1}`} className={`${inputCls} w-36`} value={s.type} onChange={(e) => set({ footer: { ...cfg.footer, socials: cfg.footer.socials.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)) } })}>{SOCIALS.map((v) => <option key={v} value={v}>{v}</option>)}</select>
                <input aria-label={`Enlace de la red ${i + 1}`} className={inputCls} placeholder="https://…" value={s.url} onChange={(e) => set({ footer: { ...cfg.footer, socials: cfg.footer.socials.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) } })} />
                <Button type="button" variant="danger" onClick={() => set({ footer: { ...cfg.footer, socials: cfg.footer.socials.filter((_, j) => j !== i) } })}>Quitar</Button>
              </div>
            ))}
            {cfg.footer.socials.length < 8 && <Button type="button" variant="ghost" onClick={() => set({ footer: { ...cfg.footer, socials: [...cfg.footer.socials, { type: "instagram", url: "" }] } })}>Añadir red</Button>}
          </fieldset>
        </Card>
      </div>

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-white/10 bg-[#050d1c]/95 py-3 backdrop-blur">
        <Button type="button" disabled={!!busy || issues.length > 0} onClick={() => run("save", async () => { await saveDraft(); ed.reload(); return "Borrador guardado"; })}><Save aria-hidden className="mr-1 inline h-4 w-4" />{busy === "save" ? "Guardando…" : "Guardar borrador"}</Button>
        <Button type="button" variant="ghost" disabled={!!busy || issues.length > 0} onClick={() => {
          // La pestaña se abre ya (sin esperar al API) para que el navegador no la bloquee.
          const w = window.open("about:blank", "_blank");
          void run("preview", async () => {
            try {
              if (dirty) await saveDraft();
              const { token } = await call<{ token: string }>("/reef/v1/admin/site/preview", { method: "POST" });
              const url = `${CASINO_URL}/lobby?reef_preview=${encodeURIComponent(token)}`;
              setPreviewUrl(url);
              if (w) { w.opener = null; w.location.href = url; }
              return w ? "Vista previa abierta en otra pestaña (válida 1 hora)" : "El navegador bloqueó la pestaña: usa el enlace «Abrir vista previa»";
            } catch (e) { w?.close(); throw e; }
          });
        }}><Eye aria-hidden className="mr-1 inline h-4 w-4" />Vista previa</Button>
        <Button type="button" variant="ghost" disabled={!!busy || issues.length > 0} onClick={() => run("publish", async () => {
          if (dirty) await saveDraft();
          const r = await call<{ version: number }>("/reef/v1/admin/site/publish", { method: "POST" });
          ed.reload();
          return `Publicada la versión ${r.version}: los jugadores ya la ven`;
        })}><Rocket aria-hidden className="mr-1 inline h-4 w-4" />{busy === "publish" ? "Publicando…" : "Publicar"}</Button>
        {previewUrl && <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-amber-300 underline">Abrir vista previa</a>}
        {msg && <div role={msg.ok ? "status" : "alert"} className="min-w-0 flex-1"><Notice tone={msg.ok ? "ok" : "warn"}>{msg.text}</Notice></div>}
      </div>

      <Card title="Historial">
        {ed.data.versions.length === 0 ? <p className="text-sm text-white/50">Todavía no se publicó ninguna versión.</p> : (
          <ul className="divide-y divide-white/10">
            {ed.data.versions.map((v) => (
              <li key={v.version} className="flex items-center gap-3 py-2 text-sm">
                <History aria-hidden className="h-4 w-4 text-white/40" />
                <span className="font-semibold">v{v.version}</span>
                <Badge tone={v.status === "published" ? "good" : "neutral"}>{v.status === "published" ? "Publicada" : "Archivada"}</Badge>
                <span className="flex-1 text-white/60">{new Date(v.publishedAt).toLocaleString("es")}</span>
                {v.status !== "published" && (
                  <Button type="button" variant="ghost" disabled={!!busy} onClick={() => { if (window.confirm(`¿Volver a publicar la versión ${v.version}?`)) void run("rollback", async () => { const r = await call<{ version: number }>(`/reef/v1/admin/site/rollback/${v.version}`, { method: "POST" }); ed.reload(); return `Versión ${v.version} republicada como v${r.version}`; }); }}>Restaurar</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
