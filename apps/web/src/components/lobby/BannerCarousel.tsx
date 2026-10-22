'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Skin } from '@/lib/lobby/types';
import { assetUrl } from '@/lib/lobby/api';

export function BannerCarousel({ banners }: { banners: Skin['banners'] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const n = banners.length;
  useEffect(() => {
    if (paused || n < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => setI((c) => (c + 1) % n), 6000);
    return () => clearInterval(t);
  }, [paused, n]);
  if (n === 0) return null;
  const cur = banners[i % n];
  const img = assetUrl(cur.imageUrl);
  return (
    <section aria-roledescription="carrusel" aria-label="Promociones" className="nf-banner relative overflow-hidden rounded-2xl"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
      style={img ? { backgroundImage: `linear-gradient(90deg,rgba(0,0,0,.65),transparent),url(${img})` } : undefined}>
      <div aria-live={paused ? 'polite' : 'off'} className="flex min-h-40 flex-col justify-center gap-2 p-6 sm:min-h-52 sm:p-10">
        <h2 className="text-2xl font-extrabold sm:text-4xl">{cur.title}</h2>
        {cur.subtitle && <p className="max-w-md opacity-90">{cur.subtitle}</p>}
        <Link href={cur.href} className="nf-btn nf-btn-primary w-fit">Descubrir</Link>
      </div>
      {n > 1 && (
        <>
          <button type="button" aria-label="Anterior" className="nf-icon-btn absolute left-2 top-1/2 -translate-y-1/2" onClick={() => setI((i - 1 + n) % n)}><ChevronLeft aria-hidden className="h-5 w-5" /></button>
          <button type="button" aria-label="Siguiente" className="nf-icon-btn absolute right-2 top-1/2 -translate-y-1/2" onClick={() => setI((i + 1) % n)}><ChevronRight aria-hidden className="h-5 w-5" /></button>
          <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-2">
            {banners.map((b, k) => <button key={k} type="button" aria-label={`Ir a ${b.title}`} aria-current={k === i % n} onClick={() => setI(k)} className={`h-2 w-2 rounded-full ${k === i % n ? 'bg-white' : 'bg-white/40'}`} />)}
          </div>
        </>
      )}
    </section>
  );
}
