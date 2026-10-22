"use client";

/* eslint-disable @next/next/no-img-element */
import { useTheme } from "@/lib/theme";

/** Logo del operador (o su nombre si no hay imagen). */
export function BrandLogo({ className = "h-8" }: { className?: string }) {
  const { brand, operator } = useTheme();
  const name = brand.displayName || operator.name;
  return <img src={brand.logoUrl || "/brand/infinite-abyss-logo.svg"} alt={`Logotipo de ${name}`} className={`${className} w-auto`} />;
}

export function SiteFooter() {
  const { brand, operator } = useTheme();
  const name = brand.displayName || operator.name;
  const legal = brand.legal;
  const legalText = typeof legal === "string" ? legal : legal?.text;
  const links = typeof legal === "object" && legal ? [
    legal.termsUrl ? { href: legal.termsUrl, label: "Términos y condiciones" } : null,
    legal.privacyUrl ? { href: legal.privacyUrl, label: "Privacidad" } : null,
  ].filter((l): l is { href: string; label: string } => l !== null) : [];

  return (
    <footer className="w-full border-t border-gold-900/40 bg-black/40 px-6 py-6 text-center text-xs text-gray-400">
      <div className="flex flex-col items-center gap-2">
        <BrandLogo className="h-6" />
        {legalText && <p className="max-w-2xl leading-relaxed">{legalText}</p>}
        {links.length > 0 && (
          <nav aria-label="Legal" className="flex gap-4">
            {links.map((l) => (
              <a key={l.href} href={l.href} className="underline hover:text-gold-300" target="_blank" rel="noopener noreferrer">
                {l.label}
              </a>
            ))}
          </nav>
        )}
        <p>Juega con responsabilidad. Solo mayores de 18 años.</p>
        <p className="text-gray-400">
          © {new Date().getFullYear()} {name} · Plataforma Infinite Abyss
        </p>
      </div>
    </footer>
  );
}
