"use client";

import { useEffect, useState } from "react";
import { ApiError, asList } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { dateTime, int } from "@/lib/format";
import { emptyRule, RuleBuilder, type Group } from "@/components/RuleBuilder";
import { Button, Card, DataTable, ErrorBox, Field, inputCls, NeedOperator, Notice, PageHeader, Spinner, type Column } from "@/components/ui";

interface Segment {
  id: string;
  name: string;
  description?: string;
  rule: Group;
  updatedAt?: string;
}

export default function SegmentsPage() {
  const { call, operatorId } = useApiClient();
  const list = useApi<{ items: Segment[] }>(operatorId ? "/crm/v1/admin/segments" : null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rule, setRule] = useState<Group>(emptyRule());
  const [formKey, setFormKey] = useState(0);
  const [count, setCount] = useState<{ loading: boolean; value?: number; error?: string }>({ loading: false });
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const ruleJson = JSON.stringify(rule);

  // Vista previa del conteo con debounce.
  useEffect(() => {
    if (!operatorId) return;
    setCount((c) => ({ ...c, loading: true, error: undefined }));
    const ctl = new AbortController();
    const t = setTimeout(() => {
      call<Record<string, unknown>>("/crm/v1/admin/segments/preview", { method: "POST", body: { rule: JSON.parse(ruleJson) }, signal: ctl.signal })
        .then((r) => {
          const n = [r.count, r.total, r.matched, r.size].find((x) => typeof x === "number") as number | undefined;
          setCount({ loading: false, value: n ?? (Array.isArray(r.items) ? r.items.length : undefined) });
        })
        .catch((e) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setCount({ loading: false, error: e instanceof ApiError ? e.message : "Error" });
        });
    }, 500);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [ruleJson, call, operatorId]);

  if (!operatorId) return <><PageHeader title="Segmentos" /><NeedOperator /></>;

  function reset() {
    setEditing(null);
    setName("");
    setDescription("");
    setRule(emptyRule());
    setFormKey((k) => k + 1);
  }

  async function save() {
    setErr(null);
    setSaved(false);
    try {
      const body = { name: name.trim(), description: description.trim() || undefined, rule };
      if (editing) await call(`/crm/v1/admin/segments/${editing}`, { method: "PUT", body });
      else await call("/crm/v1/admin/segments", { method: "POST", body });
      setSaved(true);
      reset();
      list.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.message}${e.details ? ` — ${JSON.stringify(e.details).slice(0, 300)}` : ""}` : "Error inesperado");
    }
  }

  async function remove(id: string) {
    if (!window.confirm("¿Eliminar este segmento?")) return;
    try {
      await call(`/crm/v1/admin/segments/${id}`, { method: "DELETE" });
      if (editing === id) reset();
      list.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Error inesperado");
    }
  }

  const cols: Column<Segment>[] = [
    { key: "name", label: "Nombre", render: (s) => <div><div>{s.name}</div><div className="text-xs text-white/40">{s.description}</div></div> },
    { key: "updatedAt", label: "Actualizado", render: (s) => dateTime(s.updatedAt) },
    { key: "a", label: "", render: (s) => (
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => { setEditing(s.id); setName(s.name); setDescription(s.description ?? ""); setRule(s.rule); setFormKey((k) => k + 1); }}>Editar</Button>
        <Button variant="danger" onClick={() => remove(s.id)}>Eliminar</Button>
      </div>
    ) },
  ];

  return (
    <>
      <PageHeader title="Segmentos" subtitle="Reglas dinámicas con condiciones AND/OR sobre atributos del perfil del jugador." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={editing ? "Editar segmento" : "Nuevo segmento"}>
          <div className="space-y-3">
            <Field label="Nombre" htmlFor="sn"><input id="sn" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
            <Field label="Descripción" htmlFor="sd"><input id="sd" className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></Field>
            <RuleBuilder key={formKey} rule={rule} onChange={setRule} />
            <div className="flex flex-wrap items-center gap-3">
              <div aria-live="polite" className="rounded-md bg-violet-500/15 px-3 py-2 text-sm">
                {count.loading ? "Calculando…" : count.error ? <span className="text-red-300">{count.error}</span> : <>Coinciden <strong>{int(count.value)}</strong> jugadores</>}
              </div>
              <Button onClick={save} disabled={!name.trim()}>{editing ? "Guardar cambios" : "Crear segmento"}</Button>
              {editing && <Button variant="ghost" onClick={reset}>Cancelar</Button>}
            </div>
            {err && <ErrorBox message={err} />}
            {saved && <Notice tone="ok">Segmento guardado.</Notice>}
          </div>
        </Card>
        <Card title="Segmentos guardados">
          {list.loading && !list.data && <Spinner />}
          {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
          {list.data && <DataTable rows={asList<Segment>(list.data)} columns={cols} rowKey={(s) => s.id} empty="Aún no hay segmentos." />}
        </Card>
      </div>
    </>
  );
}
