import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { LegalView } from "@/components/LegalView";
import { casinoLandingConfig } from "@/lib/landing";
import { LEGAL_PAGES, legalPage } from "@/lib/legal";

export function generateStaticParams() {
  return LEGAL_PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const page = legalPage((await params).slug);
  return { title: page ? page.title : "Legal" };
}

/** Páginas legales del casino (/legal/terminos-y-condiciones, /legal/kyc-aml…). */
export default async function LegalPageRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!legalPage(slug)) notFound();
  return <LegalView slug={slug} envLicense={casinoLandingConfig().license} />;
}
