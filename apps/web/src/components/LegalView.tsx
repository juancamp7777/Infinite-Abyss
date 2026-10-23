"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { BrandLogo, SiteFooter } from "@/components/SiteFooter";
import { useT } from "@/lib/i18n";
import { fillLegal, LEGAL_LINKS, legalPage } from "@/lib/legal";
import { useReefSite } from "@/lib/reef";
import { useTheme } from "@/lib/theme";

/** Página legal con los datos del casino (nombre y licencia); los textos están en español. */
export function LegalView({ slug, envLicense }: { slug: string; envLicense?: string }) {
  const { t } = useT();
  const { brand, operator, status } = useTheme();
  const reef = useReefSite(status === "loading" ? null : operator.id);
  const page = legalPage(slug)!;
  const casino = reef?.config.brand.siteName || brand.displayName || operator.name || "Infinite Abyss";
  const legal = typeof brand.legal === "object" && brand.legal ? brand.legal : null;
  const licencia = reef?.config.footer.license || (typeof legal?.licenseText === "string" ? legal.licenseText : undefined) || envLicense;
  const fill = (s: string) => fillLegal(s, { casino, licencia });

  return (
    <div className="flex min-h-screen flex-col bg-jetblack text-white">
      <header className="mx-auto flex w-full max-w-4xl items-center justify-between border-b border-gold-900/30 p-6">
        <Link href="/" className="flex items-center gap-2 text-sm uppercase tracking-widest text-gold-400 hover:text-gold-300">
          <ArrowLeft aria-hidden className="h-5 w-5" />
          {t("Inicio")}
        </Link>
        <BrandLogo className="h-7" />
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">
        <nav aria-label={t("Recursos")} className="mb-8 flex flex-wrap gap-2">
          {LEGAL_LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={l.href.endsWith(slug) ? "page" : undefined}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${l.href.endsWith(slug) ? "border-gold-400 bg-gold-500/10 text-gold-300" : "border-gray-800 text-gray-300 hover:border-gold-700"}`}>
              {t(l.label)}
            </Link>
          ))}
        </nav>

        <article>
          <h1 className="font-serif text-3xl font-bold uppercase tracking-widest sm:text-4xl">{t(page.title)}</h1>
          <p className="mt-4 text-lg leading-relaxed text-gray-300">{fill(page.intro)}</p>
          {page.sections.map((s) => {
            const body = s.body.map(fill).filter((p): p is string => !!p);
            if (!body.length) return null;
            return (
              <section key={s.title} className="mt-8">
                <h2 className="text-xl font-bold text-gold-300">{s.title}</h2>
                {body.map((p) => <p key={p} className="mt-3 leading-relaxed text-gray-300">{p}</p>)}
              </section>
            );
          })}
          <p className="mt-10 text-xs text-gray-500">{t("Última actualización")}: 23/10/2026</p>
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}
