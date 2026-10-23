'use client';
import { useT } from "@/lib/i18n";
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { useDebounce } from '@/lib/lobby/hooks';

/**
 * Búsqueda: navega a /lobby/search?q=. En escritorio busca mientras se escribe (debounce);
 * con `onSubmitted` (panel móvil) solo al confirmar, para no cerrar el panel a mitad de palabra.
 */
export function SearchBox({ onSubmitted }: { onSubmitted?: () => void }) {
  const { t } = useT();
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const live = !onSubmitted;
  const [value, setValue] = useState(sp.get('q') ?? '');
  const debounced = useDebounce(value.trim(), 400);
  const last = useRef(sp.get('q') ?? '');
  useEffect(() => {
    if (!live || debounced === last.current) return;
    last.current = debounced;
    if (debounced) router.replace(`/lobby/search?q=${encodeURIComponent(debounced)}`);
    else if (path === '/lobby/search') router.replace('/lobby/search');
  }, [live, debounced, router, path]);
  return (
    <form
      role="search" className="relative w-full"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        last.current = q;
        router.push(q ? `/lobby/search?q=${encodeURIComponent(q)}` : '/lobby/search');
        onSubmitted?.();
      }}
    >
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-60" />
      <input
        type="search" value={value} onChange={(e) => setValue(e.target.value)} enterKeyHint="search"
        placeholder={t("Buscar juegos o proveedores")} aria-label={t("Buscar juegos")} className="nf-input w-full pl-9"
      />
    </form>
  );
}
