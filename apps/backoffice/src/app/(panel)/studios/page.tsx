"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { Badge, Button, Card, ErrorBox, Notice, NeedOperator, PageHeader, Spinner, inputCls } from "@/components/ui";

interface Cfg {
  gameId: string;
  enabled: boolean;
  rtp: number;
  rtpProfile?: string;
  rtpMode: "range" | "profiles" | "fixed";
  rtpRange?: { min: number; max: number };
  rtpProfiles?: string[];
  defaultRtp: number;
  customized: boolean;
}
const P = "/studio/v1/admin/configs";
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

function Row({ c, operatorId, onSaved }: { c: Cfg; operatorId: string; onSaved: () => void }) {
  const { call } = useApiClient();
  const [rtp, setRtp] = useState(String((c.rtp * 100).toFixed(2)));
  const [profile, setProfile] = useState(c.rtpProfile ?? c.rtpProfiles?.[0] ?? "");
  const [enabled, setEnabled] = useState(c.enabled);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const errId = `err-${c.gameId}`;

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { operatorId, gameId: c.gameId, enabled };
      if (c.rtpMode === "range") body.rtp = Number(rtp) / 100;
      if (c.rtpMode === "profiles") body.rtpProfile = profile;
      await call(P, { method: "PUT", body });
      setMsg({ ok: true, text: "Guardado" });
      onSaved();
    } catch (e) {
      const range = e instanceof ApiError && e.code === "RTP_OUT_OF_RANGE" ? ` (${e.code})` : "";
      setMsg({ ok: false, text: (e instanceof ApiError ? e.message : "Error inesperado") + range });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title={c.gameId} actions={<Badge tone={c.customized ? "warn" : "neutral"}>{c.customized ? "personalizado" : "por defecto"}</Badge>}>
      <div className="flex flex-wrap items-end gap-4">
        <div className="text-sm text-white/70">
          RTP efectivo <strong className="text-white">{pct(c.rtp)}</strong> · por defecto {pct(c.defaultRtp)}
          <div className="text-xs text-white/50">
            {c.rtpMode === "range" && c.rtpRange && `Rango permitido: ${pct(c.rtpRange.min)} – ${pct(c.rtpRange.max)}`}
            {c.rtpMode === "profiles" && `Perfiles: ${(c.rtpProfiles ?? []).map((p) => `${p}%`).join(", ")}`}
            {c.rtpMode === "fixed" && "RTP fijo (no configurable)"}
          </div>
        </div>
        {c.rtpMode === "range" && (
          <div>
            <label htmlFor={`rtp-${c.gameId}`} className="mb-1 block text-xs text-white/60">RTP (%)</label>
            <input id={`rtp-${c.gameId}`} inputMode="decimal" className={`${inputCls} w-28`} value={rtp} onChange={(e) => setRtp(e.target.value)} aria-invalid={msg?.ok === false} aria-describedby={msg ? errId : undefined} />
          </div>
        )}
        {c.rtpMode === "profiles" && (
          <div>
            <label htmlFor={`pf-${c.gameId}`} className="mb-1 block text-xs text-white/60">Perfil de RTP</label>
            <select id={`pf-${c.gameId}`} className={`${inputCls} w-28`} value={profile} onChange={(e) => setProfile(e.target.value)}>
              {(c.rtpProfiles ?? []).map((p) => <option key={p} value={p}>{p}%</option>)}
            </select>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Habilitado</label>
        <Button onClick={save} disabled={saving}>{saving ? "Guardando…" : "Guardar"}</Button>
      </div>
      {msg && <div id={errId} role={msg.ok ? "status" : "alert"} className="mt-3"><Notice tone={msg.ok ? "ok" : "warn"}>{msg.text}</Notice></div>}
    </Card>
  );
}

export default function StudiosPage() {
  const { operatorId } = useApiClient();
  const cfg = useApi<{ configs: Cfg[] }>(operatorId ? P : null);
  return (
    <div className="space-y-4">
      <PageHeader title="Juegos Studios" subtitle="RTP y habilitación de los juegos propios por operador, siempre dentro del rango o los perfiles permitidos." />
      {!operatorId && <NeedOperator />}
      {operatorId && cfg.loading && !cfg.data && <Spinner />}
      {cfg.error && <ErrorBox message={cfg.error} onRetry={cfg.reload} />}
      {cfg.data && cfg.data.configs.length === 0 && <Notice>No hay juegos de Studios registrados.</Notice>}
      {operatorId && cfg.data?.configs.map((c) => <Row key={`${operatorId}-${c.gameId}`} c={c} operatorId={operatorId} onSaved={cfg.reload} />)}
    </div>
  );
}
