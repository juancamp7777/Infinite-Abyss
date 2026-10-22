'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Skin } from '@/lib/lobby/types';
import { assetUrl } from '@/lib/lobby/api';

const INTERVAL_MS = 6500;

/**
 * Hero del lobby. Dos modos por banner: `imageUrl` = foto de portada (banners del operador) o `art` = ilustración
 * flotante (banners por defecto). Fundido entre diapositivas, autoplay con barra de progreso que se pausa
 * con el puntero o el foco, y las diapositivas ocultas quedan fuera del orden de tabulación.
 */
export function BannerCarousel({ banners }: { banners: Skin['banners'] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const n = banners.length;
  useEffect(() => { setReduced(window.matchMedia('(prefers-reduced-motion: reduce)').matches); }, []);
  useEffect(() => {
    if (paused || reduced || n < 2) return;
    const t = setTimeout(() => setI((c) => (c + 1) % n), INTERVAL_MS);
    return () => clearTimeout(t);
  }, [paused, reduced, n, i]);
  if (n === 0) return null;
  const cur = i % n;
  return (
    <section
      aria-roledescription="carrusel" aria-label="Promociones"
      className="nf-hero-banner relative h-full min-h-[260px] overflow-hidden rounded-2xl border border-[var(--nf-border)] sm:min-h-[300px]"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
    >
      {banners.map((b, k) => {
        const on = k === cur;
        const cover = assetUrl(b.imageUrl);
        return (
          <div
            key={k} role="group" aria-roledescription="diapositiva" aria-label={`${k + 1} de ${n}: ${b.title}`}
            aria-hidden={!on} inert={!on} className={`nf-slide ${on ? 'is-on' : ''}`}
            style={cover ? { backgroundImage: `linear-gradient(90deg, rgb(3 8 20 / .85) 0%, rgb(3 8 20 / .35) 55%, transparent), url(${cover})` } : undefined}
          >
            <div className="relative z-10 flex h-full max-w-[34rem] flex-col justify-center gap-3 px-6 py-8 sm:px-10">
              <h2 className="nf-display text-2xl font-extrabold leading-tight drop-shadow sm:text-4xl">{b.title}</h2>
              {b.subtitle && <p className="max-w-sm text-sm text-[color-mix(in_srgb,var(--nf-text)_82%,transparent)] sm:text-base">{b.subtitle}</p>}
              <Link href={b.href} className="nf-btn nf-btn-primary nf-shine mt-1 w-fit px-5 py-2.5 text-[15px]" tabIndex={on ? 0 : -1}>
                {b.cta || 'Descubrir'}<ArrowRight aria-hidden className="h-4 w-4" />
              </Link>
            </div>
            {!cover && b.art && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={b.art} alt="" aria-hidden className="nf-float pointer-events-none absolute -right-6 bottom-0 top-0 my-auto h-[78%] max-h-64 w-auto opacity-30 sm:right-8 sm:opacity-100 lg:right-14" />
            )}
          </div>
        );
      })}
      {n > 1 && (
        <div className="absolute bottom-4 left-6 right-4 z-20 flex items-center gap-3 sm:left-10">
          <div className="flex flex-1 gap-1.5" role="tablist" aria-label="Elegir promoción">
            {banners.map((b, k) => (
              <button
                key={k} type="button" role="tab" aria-selected={k === cur} aria-label={`Ir a ${b.title}`} onClick={() => setI(k)}
                className="nf-progress" data-on={k === cur} data-paused={paused || reduced}
                style={{ ['--nf-dur' as string]: `${INTERVAL_MS}ms` }}
              ><span key={k === cur ? `on-${i}` : 'off'} /></button>
            ))}
          </div>
          <button type="button" aria-label="Promoción anterior" className="nf-square-btn" onClick={() => setI((cur - 1 + n) % n)}><ChevronLeft aria-hidden className="h-4 w-4" /></button>
          <button type="button" aria-label="Promoción siguiente" className="nf-square-btn" onClick={() => setI((cur + 1) % n)}><ChevronRight aria-hidden className="h-4 w-4" /></button>
        </div>
      )}
    </section>
  );
}
