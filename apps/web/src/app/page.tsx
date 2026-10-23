import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { CasinoLanding } from "@/components/landing/CasinoLanding";
import { casinoLandingConfig, isLandingHost } from "@/lib/landing";

export const metadata: Metadata = {
  title: { absolute: "Abyss Casino · Slots, en vivo y Originals" },
  description: "Juega en otra dimensión: slots, mesas en vivo y Originals provably fair. Deposita en tu moneda y retira rápido. Solo +18.",
};

/**
 * En el dominio de la plataforma (infinite-abyss.com) la raíz es la landing del casino para jugadores (la comercial
 * vive en /plataforma); en los dominios de los casinos la home es el lobby. Los juegos clásicos viven en /classic.
 */
export default async function Home() {
  const h = await headers();
  if (isLandingHost(h.get("x-forwarded-host") ?? h.get("host"))) return <CasinoLanding {...casinoLandingConfig()} />;
  redirect("/lobby");
}
