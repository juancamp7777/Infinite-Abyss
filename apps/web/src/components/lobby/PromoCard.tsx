import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

/** Tarjeta de promoción con ilustración (VIP, torneos, recompensas…). */
export function PromoCard({ title, children, href, cta, art, tone = 'gold' }: {
  title: string; children?: ReactNode; href: string; cta: string; art: string; tone?: 'gold' | 'cyan' | 'violet';
}) {
  return (
    <Link href={href} className="nf-promo group" data-tone={tone}>
      <div className="max-w-[68%] space-y-1">
        <h3 className="nf-display text-lg font-extrabold leading-tight">{title}</h3>
        {children && <div className="text-xs text-[color-mix(in_srgb,var(--nf-text)_78%,transparent)]">{children}</div>}
      </div>
      <span className="inline-flex w-fit items-center gap-1 rounded-lg bg-black/35 px-3 py-1.5 text-xs font-bold backdrop-blur group-hover:bg-black/50">
        {cta}<ArrowRight aria-hidden className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={art} alt="" aria-hidden className="nf-promo-art" />
    </Link>
  );
}
