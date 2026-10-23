"use client";

/* eslint-disable @next/next/no-img-element */
import { LanguageSwitcher, useT } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";
import { safeHref, useReefSite } from "@/lib/reef";
import { LEGAL_LINKS } from "@/lib/legal";
import Link from "next/link";

const SOCIAL_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", x: "X", tiktok: "TikTok", telegram: "Telegram", whatsapp: "WhatsApp", youtube: "YouTube" };

/** Logo del operador (o su nombre si no hay imagen). */
export function BrandLogo({ className = "h-8" }: { className?: string }) {
  const { brand, operator } = useTheme();
  const name = brand.displayName || operator.name;
  return <img src={brand.logoUrl || "/brand/infinite-abyss-logo.svg"} alt={`Logotipo de ${name}`} className={`${className} w-auto`} />;
}

export function SiteFooter() {
  const { t } = useT();
  const { brand, operator, status } = useTheme();
  const reef = useReefSite(status === "loading" ? null : operator.id);
  if (reef) return <ReefFooter site={reef.config} />;
  const name = brand.displayName || operator.name;
  const legal = brand.legal;
  const legalText = typeof legal === "string" ? legal : legal?.text;

  return (
    <footer className="w-full border-t border-gold-900/40 bg-black/40 px-6 py-6 text-center text-xs text-gray-400">
      <div className="flex flex-col items-center gap-2">
        <BrandLogo className="h-6" />
        {legalText && <p className="max-w-2xl leading-relaxed">{legalText}</p>}
        <LegalNav />
        <p>{t("Juega con responsabilidad. Solo mayores de 18 años.")}</p>
        <div className="mt-3 flex justify-center"><LanguageSwitcher /></div>
        <p className="text-gray-400">
          © {new Date().getFullYear()} {name} · Plataforma Infinite Abyss
        </p>
      </div>
    </footer>
  );
}

/** Recursos legales del casino: términos, KYC y AML, juego responsable, antispam, reembolsos y privacidad. */
export function LegalNav() {
  const { t } = useT();
  return (
    <nav aria-label={t("Recursos")} className="flex max-w-3xl flex-wrap justify-center gap-x-4 gap-y-1">
      {LEGAL_LINKS.map((l) => (
        <Link key={l.href} href={l.href} className="underline-offset-2 hover:text-gold-300 hover:underline">{t(l.label)}</Link>
      ))}
    </nav>
  );
}

/** Footer de la plantilla Reef publicada: texto, redes, aviso legal y licencia del operador. */
function ReefFooter({ site }: { site: NonNullable<ReturnType<typeof useReefSite>>["config"] }) {
  const { t } = useT();
  const { brand, footer } = site;
  return (
    <footer className="w-full border-t border-white/10 px-6 py-8 text-center text-xs text-gray-400" style={{ background: site.colors.background }}>
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3">
        {brand.logoUrl ? <img src={brand.logoUrl} alt={`Logotipo de ${brand.siteName}`} className="h-8 w-auto" /> : <p className="text-base font-bold" style={{ color: site.colors.primary }}>{brand.siteName}</p>}
        {footer.about && <p className="leading-relaxed">{footer.about}</p>}
        {footer.socials.length > 0 && (
          <nav aria-label={t("Redes sociales")} className="flex flex-wrap justify-center gap-4">
            {footer.socials.map((s) => (
              <a key={s.url} href={safeHref(s.url)} className="font-semibold underline-offset-2 hover:underline" style={{ color: site.colors.primary }} target="_blank" rel="noopener noreferrer">{SOCIAL_LABEL[s.type] ?? s.type}</a>
            ))}
          </nav>
        )}
        {footer.legal && <p className="whitespace-pre-line leading-relaxed">{footer.legal}</p>}
        {footer.license && <p>{footer.license}</p>}
        {!footer.legal && <p>{t("Juega con responsabilidad. Solo mayores de 18 años.")}</p>}
        <LegalNav />
        <p>© {new Date().getFullYear()} {brand.siteName}</p>
      </div>
    </footer>
  );
}
