"use client";

import { useState } from "react";
import { useApiClient, useCurrency } from "@/lib/hooks";
import { dateTime, money, sampleMinor } from "@/lib/format";
import { ResourceManager } from "@/components/ResourceManager";
import { Badge, NeedOperator, PageHeader } from "@/components/ui";

const G = "/gamification/v1/admin";

interface Tournament { id?: string; name: string; metric: string; startsAt: number | string; endsAt: number | string; derivedStatus?: string; buyIn?: string; prizes?: Array<{ position: number; amount: string }> }

const TONE: Record<string, "good" | "warn" | "neutral" | "bad"> = { live: "good", running: "good", scheduled: "warn", finished: "neutral", cancelled: "bad" };

export default function TournamentsPage() {
  const { operatorId } = useApiClient();
  const cur = useCurrency();
  const [now] = useState(() => Date.now());
  if (!operatorId) return <><PageHeader title="Torneos" /><NeedOperator /></>;
  return (
    <>
      <PageHeader title="Torneos" subtitle="Leaderboards por multiplicador, puntos o volumen, con premios. Solo se editan torneos programados." />
      <ResourceManager<Tournament>
        noun="torneo"
        listPath={`${G}/tournaments`}
        template={{
          name: "Torneo semanal de slots",
          categories: ["slots"],
          gameIds: [],
          metric: "highest_multiplier",
          startsAt: new Date(now + 3600_000).toISOString(),
          endsAt: new Date(now + 7 * 86400_000).toISOString(),
          minBet: sampleMinor(0.1, cur),
          buyIn: "0",
          prizes: [{ position: 1, amount: sampleMinor(1000, cur) }, { position: 2, amount: sampleMinor(500, cur) }, { position: 3, amount: sampleMinor(200, cur) }],
        }}
        updateMethod="PUT"
        allowDelete
        editView={(t) => {
          const { id: _i, ...rest } = t as Tournament & Record<string, unknown>;
          void _i;
          delete rest.derivedStatus;
          delete rest.operatorId;
          delete rest.status;
          return { ...rest, startsAt: new Date(t.startsAt).toISOString(), endsAt: new Date(t.endsAt).toISOString() };
        }}
        columns={[
          { key: "name", label: "Torneo" },
          { key: "metric", label: "Métrica" },
          { key: "derivedStatus", label: "Estado", render: (t) => <Badge tone={TONE[t.derivedStatus ?? ""] ?? "neutral"}>{t.derivedStatus ?? "—"}</Badge> },
          { key: "startsAt", label: "Inicio", render: (t) => dateTime(t.startsAt) },
          { key: "endsAt", label: "Fin", render: (t) => dateTime(t.endsAt) },
          { key: "prizes", label: "Premios", render: (t) => (t.prizes ?? []).map((p) => `#${p.position}: ${money(p.amount, cur)}`).join(" · ") || "—" },
        ]}
      />
    </>
  );
}

