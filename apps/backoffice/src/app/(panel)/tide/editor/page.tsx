"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  addEdge, Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState,
  type Connection, type Edge, type Node, type NodeProps, useNodesInitialized, useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft, CheckCircle2, CircleAlert, Flag, GitFork, HelpCircle, ListChecks, MessageSquare, Play, Save, UserRound, Variable, X } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApiClient } from "@/lib/hooks";
import { Badge, Button, inputCls, NeedOperator, Notice, PageHeader, Spinner } from "@/components/ui";

type NodeType = "trigger" | "message" | "ask" | "condition" | "set_var" | "faq" | "handoff" | "close";
interface Field { key: string; label: string; kind: "text" | "textarea" | "number" | "list" | "channels" | "select" | "faq"; options?: string[]; hint?: string }
interface Descriptor { type: NodeType; label: string; description: string; ports: string[]; dynamicPorts?: "options"; fields: Field[] }
interface Graph { nodes: Array<{ id: string; type: NodeType; config: Record<string, unknown>; x: number; y: number }>; edges: Array<{ from: string; port: string; to: string }> }
interface Flow { id: string; name: string; enabled: boolean; publishedVersion?: number; draft: Graph }
type TideData = { type: NodeType; config: Record<string, unknown>; catalog: Descriptor[] };

const ICON: Record<NodeType, typeof Play> = { trigger: Play, message: MessageSquare, ask: HelpCircle, condition: GitFork, set_var: Variable, faq: ListChecks, handoff: UserRound, close: Flag };
const COLOR: Record<NodeType, string> = { trigger: "#34d399", message: "#3cc8f0", ask: "#f4b73f", condition: "#a78bfa", set_var: "#94a3b8", faq: "#fb923c", handoff: "#f472b6", close: "#f87171" };
const PORT_LABEL: Record<string, string> = { next: "siguiente", other: "otra respuesta", timeout: "sin respuesta", true: "sí", false: "no", answered: "respondida", no_match: "sin coincidencia" };
const newNodeId = (type: string) => `${type}_${crypto.randomUUID().slice(0, 6)}`;
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Error inesperado");

function portsOf(d: Descriptor | undefined, config: Record<string, unknown>): Array<{ id: string; label: string }> {
  if (!d) return [];
  const opts = d.dynamicPorts === "options" && Array.isArray(config.options) ? (config.options as string[]).map((o, i) => ({ id: `opt:${i}`, label: o || `opción ${i + 1}` })) : [];
  return [...opts, ...d.ports.map((p) => ({ id: p, label: PORT_LABEL[p] ?? p }))];
}

function summary(type: NodeType, c: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (type) {
    case "trigger": return Array.isArray(c.keywords) && c.keywords.length ? `Palabras: ${(c.keywords as string[]).join(", ")}` : "Cualquier mensaje";
    case "message": return s(c.text);
    case "ask": return s(c.question);
    case "condition": return `${s(c.left)} ${s(c.operator)} ${s(c.right)}`;
    case "set_var": return `${s(c.name)} = ${s(c.value)}`;
    case "faq": return `${Array.isArray(c.entries) ? c.entries.length : 0} preguntas`;
    case "handoff": return s(c.note) || "A la cola de agentes";
    case "close": return s(c.text) || "Cierra la conversación";
  }
}

function TideNode({ data, selected }: NodeProps<Node<TideData>>) {
  const d = data.catalog.find((x) => x.type === data.type);
  const Icon = ICON[data.type];
  const ports = portsOf(d, data.config);
  return (
    <div className={`w-56 rounded-xl border bg-[#0b1a30] text-left shadow-xl transition-shadow ${selected ? "border-[var(--color-brand)] shadow-[0_0_0_3px_rgba(244,183,63,.25)]" : "border-white/10"}`}>
      {data.type !== "trigger" && <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-[#0b1a30] !bg-white/70" />}
      <div className="flex items-center gap-2 rounded-t-xl px-3 py-2" style={{ background: `${COLOR[data.type]}22` }}>
        <Icon aria-hidden className="h-4 w-4" style={{ color: COLOR[data.type] }} />
        <span className="text-xs font-bold uppercase tracking-wider" style={{ color: COLOR[data.type] }}>{d?.label ?? data.type}</span>
      </div>
      <div className="line-clamp-3 px-3 py-2 text-xs text-white/75">{summary(data.type, data.config) || <span className="text-white/35">Sin configurar</span>}</div>
      {ports.length > 0 && (
        <div className="space-y-1 border-t border-white/5 py-1.5">
          {ports.map((p) => (
            <div key={p.id} className="relative pr-4 text-right text-[10px] text-white/50">
              {p.label}
              <Handle type="source" id={p.id} position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-[#0b1a30]" style={{ background: COLOR[data.type] }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
const nodeTypes = { tide: TideNode };

const toFlow = (g: Graph, catalog: Descriptor[]): { nodes: Node<TideData>[]; edges: Edge[] } => ({
  nodes: g.nodes.map((n) => ({ id: n.id, type: "tide", position: { x: n.x, y: n.y }, data: { type: n.type, config: n.config, catalog }, deletable: n.type !== "trigger" })),
  edges: g.edges.map((e) => ({ id: `${e.from}:${e.port}`, source: e.from, sourceHandle: e.port, target: e.to, animated: true, style: { stroke: "rgba(60,200,240,.7)", strokeWidth: 2 } })),
});
const toGraph = (nodes: Node<TideData>[], edges: Edge[]): Graph => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.data.type, config: n.data.config, x: Math.round(n.position.x), y: Math.round(n.position.y) })),
  edges: edges.map((e) => ({ from: e.source, port: e.sourceHandle ?? "next", to: e.target })),
});

function ConfigForm({ d, config, onChange }: { d: Descriptor; config: Record<string, unknown>; onChange(c: Record<string, unknown>): void }) {
  const set = (k: string, v: unknown) => onChange({ ...config, [k]: v });
  return (
    <div className="space-y-3">
      {d.fields.map((f) => {
        const id = `f-${f.key}`;
        const v = config[f.key];
        let input: React.ReactNode;
        if (f.kind === "textarea") input = <textarea id={id} rows={4} className={`${inputCls} w-full`} value={typeof v === "string" ? v : ""} onChange={(e) => set(f.key, e.target.value)} />;
        else if (f.kind === "number") input = <input id={id} type="number" className={`${inputCls} w-full`} value={typeof v === "number" ? v : ""} onChange={(e) => set(f.key, e.target.value === "" ? undefined : Number(e.target.value))} />;
        else if (f.kind === "list") input = <textarea id={id} rows={3} className={`${inputCls} w-full`} placeholder="Una por línea" value={Array.isArray(v) ? (v as string[]).join("\n") : ""} onChange={(e) => set(f.key, e.target.value.split("\n"))} onBlur={(e) => set(f.key, e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))} />;
        else if (f.kind === "select") input = <select id={id} className={`${inputCls} w-full`} value={typeof v === "string" ? v : ""} onChange={(e) => set(f.key, e.target.value)}><option value="">—</option>{f.options?.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
        else if (f.kind === "channels") {
          const cur = Array.isArray(v) ? (v as string[]) : ["webchat", "whatsapp", "telegram"];
          input = <div className="flex flex-wrap gap-3 text-sm">{["webchat", "whatsapp", "telegram"].map((c) => (
            <label key={c} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={cur.includes(c)} onChange={(e) => set(f.key, e.target.checked ? [...cur, c] : cur.filter((x) => x !== c))} /> {c}</label>
          ))}</div>;
        } else if (f.kind === "faq") {
          const rows = Array.isArray(v) ? (v as Array<{ q: string; a: string }>) : [];
          input = (
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="space-y-1 rounded-lg border border-white/10 p-2">
                  <input className={`${inputCls} w-full`} placeholder="Pregunta" value={r.q} onChange={(e) => set(f.key, rows.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))} aria-label={`Pregunta ${i + 1}`} />
                  <textarea className={`${inputCls} w-full`} rows={2} placeholder="Respuesta" value={r.a} onChange={(e) => set(f.key, rows.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))} aria-label={`Respuesta ${i + 1}`} />
                  <button type="button" className="text-xs text-red-300 hover:underline" onClick={() => set(f.key, rows.filter((_, j) => j !== i))}>Quitar</button>
                </div>
              ))}
              <Button variant="ghost" onClick={() => set(f.key, [...rows, { q: "", a: "" }])}>Añadir pregunta</Button>
            </div>
          );
        } else input = <input id={id} className={`${inputCls} w-full`} value={typeof v === "string" ? v : ""} onChange={(e) => set(f.key, e.target.value)} />;
        return (
          <div key={f.key}>
            <label htmlFor={id} className="mb-1 block text-xs font-semibold text-white/60">{f.label}</label>
            {input}
            {f.hint && <p className="mt-1 text-[11px] text-white/35">{f.hint}</p>}
          </div>
        );
      })}
    </div>
  );
}

function Editor({ id }: { id: string }) {
  const { call } = useApiClient();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [catalog, setCatalog] = useState<Descriptor[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TideData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const rf = useReactFlow();
  const ready = useNodesInitialized();
  // Encuadre al cargar (cuando React Flow ya midió los nodos).
  useEffect(() => {
    if (ready) void rf.fitView({ padding: 0.12, duration: 300 });
  }, [ready, rf]);

  useEffect(() => {
    Promise.all([call<{ items: Descriptor[] }>("/tide/v1/admin/node-types"), call<Flow>(`/tide/v1/admin/flows/${id}`)])
      .then(([c, f]) => {
        setCatalog(c.items);
        setFlow(f);
        setName(f.name);
        const g = toFlow(f.draft, c.items);
        setNodes(g.nodes);
        setEdges(g.edges);
      })
      .catch((e) => setNotice({ tone: "warn", text: errMsg(e) }));
  }, [call, id, setNodes, setEdges]);

  // Una sola conexión por salida: conectar de nuevo reemplaza la anterior.
  const onConnect = useCallback((c: Connection) => {
    if (c.source === c.target) return;
    setEdges((eds) => addEdge({ ...c, id: `${c.source}:${c.sourceHandle}`, animated: true, style: { stroke: "rgba(60,200,240,.7)", strokeWidth: 2 } }, eds.filter((e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle))));
  }, [setEdges]);

  const addNode = (type: NodeType) => {
    const nid = newNodeId(type);
    const defaults: Record<NodeType, Record<string, unknown>> = {
      trigger: {}, message: { text: "" }, ask: { question: "", options: [], timeoutMinutes: 30 }, condition: { left: "", operator: "eq", right: "" },
      set_var: { name: "", value: "" }, faq: { entries: [{ q: "", a: "" }], threshold: 0.35 }, handoff: { note: "" }, close: { text: "" },
    };
    const maxX = nodes.reduce((m, n) => Math.max(m, n.position.x), 0);
    setNodes((ns) => [...ns, { id: nid, type: "tide", position: { x: maxX + 280, y: 120 + (ns.length % 4) * 60 }, data: { type, config: defaults[type], catalog }, selected: true }]);
    setSelected(nid);
  };

  const updateConfig = (nid: string, config: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data: { ...n.data, config } } : n)));
    // Si una Pregunta pierde opciones, sus conexiones huérfanas desaparecen.
    const count = Array.isArray(config.options) ? config.options.length : 0;
    setEdges((es) => es.filter((e) => e.source !== nid || !e.sourceHandle?.startsWith("opt:") || Number(e.sourceHandle.slice(4)) < count));
  };

  const save = async (): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    try {
      const f = await call<Flow>(`/tide/v1/admin/flows/${id}`, { method: "PUT", body: { name, draft: toGraph(nodes, edges) } });
      setFlow(f);
      const v = await call<{ errors: string[] }>(`/tide/v1/admin/flows/${id}/validate`, { method: "POST", body: {} });
      setErrors(v.errors);
      setNotice({ tone: "ok", text: v.errors.length ? "Borrador guardado (con pendientes para publicar)." : "Borrador guardado." });
      return true;
    } catch (e) {
      setNotice({ tone: "warn", text: errMsg(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!(await save())) return;
    setBusy(true);
    try {
      const f = await call<Flow>(`/tide/v1/admin/flows/${id}/publish`, { method: "POST", body: {} });
      setFlow(f);
      setErrors([]);
      setNotice({ tone: "ok", text: `Versión ${f.publishedVersion} publicada y activa.` });
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.details)) setErrors(e.details as string[]);
      setNotice({ tone: "warn", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const sel = nodes.find((n) => n.id === selected);
  const selDesc = sel ? catalog.find((d) => d.type === sel.data.type) : undefined;
  const palette = useMemo(() => catalog.filter((d) => d.type !== "trigger"), [catalog]);

  if (!flow) return notice ? <Notice tone="warn">{notice.text}</Notice> : <Spinner />;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link href="/tide" className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 hover:bg-white/5" aria-label="Volver a los flujos"><ArrowLeft aria-hidden className="h-4 w-4" /></Link>
        <input className={`${inputCls} min-w-0 flex-1 text-base font-semibold sm:max-w-sm`} value={name} onChange={(e) => setName(e.target.value)} aria-label="Nombre del flujo" />
        <Badge tone={flow.enabled ? "good" : "neutral"}>{flow.publishedVersion ? `v${flow.publishedVersion} ${flow.enabled ? "activa" : "pausada"}` : "Sin publicar"}</Badge>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => void save()}><Save aria-hidden className="h-4 w-4" /> Guardar</Button>
          <Button disabled={busy} onClick={() => void publish()}><CheckCircle2 aria-hidden className="h-4 w-4" /> Publicar</Button>
        </div>
      </div>
      {notice && <div className="mb-3"><Notice tone={notice.tone}>{notice.text}</Notice></div>}
      {errors.length > 0 && (
        <div className="mb-3 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-sm">
          <div className="mb-1 flex items-center gap-2 font-semibold text-amber-300"><CircleAlert aria-hidden className="h-4 w-4" /> Falta para publicar</div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-100/80">{errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[11rem_minmax(0,1fr)] xl:grid-cols-[11rem_minmax(0,1fr)_20rem]">
        <aside className="flex gap-2 overflow-x-auto lg:flex-col" aria-label="Pasos disponibles">
          {palette.map((d) => {
            const Icon = ICON[d.type];
            return (
              <button key={d.type} type="button" onClick={() => addNode(d.type)} title={d.description}
                className="flex shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-panel/80 px-3 py-2 text-left text-sm hover:border-white/25">
                <Icon aria-hidden className="h-4 w-4" style={{ color: COLOR[d.type] }} /> {d.label}
              </button>
            );
          })}
        </aside>

        <div className="h-[68dvh] min-h-[420px] overflow-hidden rounded-xl border border-white/10 bg-[#050d1c]">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)} fitView minZoom={0.2} maxZoom={1.5} colorMode="dark" deleteKeyCode={["Delete", "Backspace"]} proOptions={{ hideAttribution: true }}>
            <Background gap={22} color="rgba(255,255,255,.06)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => COLOR[(n.data as TideData).type]} maskColor="rgba(5,13,28,.7)" className="!bg-[#0b1a30]" />
          </ReactFlow>
        </div>

        <aside className="rounded-xl border border-white/10 bg-panel/80 p-4 lg:col-span-2 xl:col-span-1" aria-label="Configuración del paso">
          {!sel || !selDesc ? (
            <p className="text-sm text-white/45">Selecciona un paso para configurarlo. Conecta las salidas (puntos de la derecha) con la entrada del siguiente paso. Variables: <code>{"{{contact.name}}"}</code>, <code>{"{{vars.x}}"}</code>, <code>{"{{message.body}}"}</code>.</p>
          ) : (
            <>
              <div className="mb-3 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold" style={{ color: COLOR[sel.data.type] }}>{selDesc.label}</div>
                  <p className="text-xs text-white/45">{selDesc.description}</p>
                </div>
                <button type="button" className="text-white/40 hover:text-white" onClick={() => setSelected(null)} aria-label="Cerrar"><X aria-hidden className="h-4 w-4" /></button>
              </div>
              <ConfigForm d={selDesc} config={sel.data.config} onChange={(c) => updateConfig(sel.id, c)} />
            </>
          )}
        </aside>
      </div>
    </>
  );
}

function EditorPage() {
  const { operatorId } = useApiClient();
  const id = useSearchParams().get("id");
  if (!operatorId) return <><PageHeader title="Tide" /><NeedOperator /></>;
  if (!id) return <Notice tone="warn">Falta el flujo a editar.</Notice>;
  return <ReactFlowProvider><Editor id={id} /></ReactFlowProvider>;
}

export default function TideEditorPage() {
  return <Suspense fallback={<Spinner />}><EditorPage /></Suspense>;
}
