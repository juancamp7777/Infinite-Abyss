'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { useDebounce } from '@/lib/lobby/hooks';

/** Búsqueda con debounce: navega a /lobby/search?q=. */
export function SearchBox() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [value, setValue] = useState(sp.get('q') ?? '');
  const debounced = useDebounce(value.trim(), 400);
  const last = useRef(sp.get('q') ?? '');
  useEffect(() => {
    if (debounced === last.current) return;
    last.current = debounced;
    if (debounced) router.replace(`/lobby/search?q=${encodeURIComponent(debounced)}`);
    else if (path === '/lobby/search') router.replace('/lobby/search');
  }, [debounced, router, path]);
  return (
    <form role="search" className="relative w-full max-w-md" onSubmit={(e) => { e.preventDefault(); last.current = value.trim(); router.push(`/lobby/search?q=${encodeURIComponent(value.trim())}`); }}>
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-60" />
      <input type="search" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Buscar juegos o proveedores" aria-label="Buscar juegos" className="nf-input w-full pl-9" />
    </form>
  );
}
