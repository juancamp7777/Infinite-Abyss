"use client";

import { useState, type ReactNode } from "react";
import { ApiError, asList } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { Button, Card, DataTable, ErrorBox, inputCls, NeedOperator, Notice, Spinner, type Column } from "./ui";

export interface ResourceCtx {
  reload(): void;
  call: ReturnType<typeof useApiClient>["call"];
  /** Muestra un panel con contenido propio (métricas, reportes…). */
  showPanel(title: string, node: ReactNode): void;
  fail(e: unknown): void;
}

export interface ResourceManagerProps<T extends { id?: string }> {
  /** Texto singular para botones: "campaña", "bono"… */
  noun: string;
  listPath: string;
  listQuery?: Record<string, string | undefined>;
  columns: Column<T>[];
  /** JSON inicial al crear. */
  template: object;
  /** Método para actualizar; null = solo crear/borrar. */
  updateMethod?: "PUT" | "PATCH" | null;
  allowDelete?: boolean;
  allowCreate?: boolean;
  itemPath?: (item: T) => string;
  extra?: (item: T, ctx: ResourceCtx) => ReactNode;
  /** Quita campos del servidor antes de editar. */
  editView?: (item: T) => object;
  emptyText?: string;
  needOperator?: boolean;
}

const errText = (e: unknown) =>
  e instanceof ApiError ? `${e.message}${e.details ? ` — ${JSON.stringify(e.details).slice(0, 400)}` : ""}` : e instanceof SyntaxError ? `JSON inválido: ${e.message}` : "Error inesperado";

/** CRUD genérico con editor JSON validado por el servidor (zod): sirve a entidades con esquemas largos. */
export function ResourceManager<T extends { id?: string }>(p: ResourceManagerProps<T>) {
  const { call, operatorId } = useApiClient();
  const list = useApi<unknown>(p.needOperator !== false && !operatorId ? null : p.listPath, p.listQuery);
  const [editor, setEditor] = useState<{ id: string | null; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ title: string; node: ReactNode } | null>(null);
  const [busy, setBusy] = useState(false);

  if (p.needOperator !== false && !operatorId) return <NeedOperator />;

  const itemPath = (it: T) => (p.itemPath ? p.itemPath(it) : `${p.listPath}/${it.id}`);
  const ctx: ResourceCtx = { reload: list.reload, call, showPanel: (title, node) => setPanel({ title, node }), fail: (e) => setErr(errText(e)) };

  async function save() {
    if (!editor) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const body = JSON.parse(editor.text) as unknown;
      if (editor.id) {
        const it = rows.find((r) => r.id === editor.id);
        await call(it ? itemPath(it) : `${p.listPath}/${editor.id}`, { method: p.updateMethod ?? "PUT", body });
      } else {
        await call(p.listPath, { method: "POST", body });
      }
      setOk("Guardado.");
      setEditor(null);
      list.reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(it: T) {
    if (!window.confirm(`¿Eliminar esta ${p.noun}?`)) return;
    setErr(null);
    try {
      await call(itemPath(it), { method: "DELETE" });
      list.reload();
    } catch (e) {
      setErr(errText(e));
    }
  }

  const rows = list.data ? asList<T>(list.data) : [];
  const cols: Column<T>[] = [
    ...p.columns,
    {
      key: "__actions",
      label: "",
      render: (it) => (
        <div className="flex flex-wrap gap-2">
          {p.updateMethod !== null && (
            <Button variant="ghost" onClick={() => setEditor({ id: it.id ?? null, text: JSON.stringify(p.editView ? p.editView(it) : it, null, 2) })}>
              Editar
            </Button>
          )}
          {p.extra?.(it, ctx)}
          {p.allowDelete && (
            <Button variant="danger" onClick={() => remove(it)}>
              Eliminar
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {p.allowCreate !== false && (
        <div>
          <Button onClick={() => { setEditor({ id: null, text: JSON.stringify(p.template, null, 2) }); setOk(null); }}>+ Nueva {p.noun}</Button>
        </div>
      )}
      {err && <ErrorBox message={err} />}
      {ok && <Notice tone="ok">{ok}</Notice>}
      {editor && (
        <Card title={editor.id ? `Editar ${p.noun}` : `Nueva ${p.noun}`}>
          <label htmlFor="json-editor" className="mb-1 block text-xs text-white/60">
            Definición (JSON). El servidor valida los campos y devuelve el detalle si algo no es válido.
          </label>
          <textarea id="json-editor" spellCheck={false} className={`${inputCls} h-72 font-mono text-xs`} value={editor.text} onChange={(e) => setEditor({ ...editor, text: e.target.value })} />
          <div className="mt-3 flex gap-2">
            <Button onClick={save} disabled={busy}>{busy ? "Guardando…" : "Guardar"}</Button>
            <Button variant="ghost" onClick={() => setEditor(null)}>Cancelar</Button>
          </div>
        </Card>
      )}
      {panel && (
        <Card title={panel.title} actions={<Button variant="ghost" onClick={() => setPanel(null)} aria-label="Cerrar panel">✕</Button>}>
          {panel.node}
        </Card>
      )}
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {!!list.data && <DataTable rows={rows} columns={cols} rowKey={(r, i) => r.id ?? String(i)} empty={p.emptyText ?? `Aún no hay ${p.noun}s.`} />}
    </div>
  );
}

/** Tabla clave→valor para mostrar métricas planas. */
export function KeyValueTable({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
      {entries.map(([k, v]) => (
        <div key={k} className="rounded bg-black/20 p-2">
          <dt className="text-xs text-white/50">{k}</dt>
          <dd className="break-words">{typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "—")}</dd>
        </div>
      ))}
    </dl>
  );
}
