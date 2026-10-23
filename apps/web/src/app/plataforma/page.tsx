import type { Metadata } from "next";
import { Landing } from "@/components/landing/Landing";
import { landingLinks } from "@/lib/landing";

export const metadata: Metadata = {
  title: { absolute: "Infinite Abyss · Plataforma de casino online todo en uno" },
  description: "Casino con tu marca, cajero con IA, CRM omnicanal, bots, equipo y un operador IA 24/7. Lánzate en días.",
};

export default function LandingPage() {
  return <Landing {...landingLinks()} />;
}
