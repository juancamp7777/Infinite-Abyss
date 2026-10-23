import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Landing } from "@/components/landing/Landing";
import { isLandingHost, landingLinks } from "@/lib/landing";

/**
 * En el dominio de la plataforma (infinite-abyss.com) la raíz es la landing comercial; en los dominios de los casinos
 * la home es el lobby (Hub + Studios). Los juegos clásicos viven en /classic.
 */
export default async function Home() {
  const h = await headers();
  if (isLandingHost(h.get("x-forwarded-host") ?? h.get("host"))) return <Landing {...landingLinks()} />;
  redirect("/lobby");
}
