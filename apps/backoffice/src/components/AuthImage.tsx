"use client";

import { useEffect, useState } from "react";
import { fetchObjectUrl } from "@/lib/api";
import { useOperator } from "@/lib/hooks";

/** Imagen protegida por el token del backoffice (no se puede pedir con un <img src> directo). */
export function AuthImage({ path, alt, className = "" }: { path: string; alt: string; className?: string }) {
  const { operatorId } = useOperator();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    let current: string | null = null;
    fetchObjectUrl(path, { operatorId: operatorId ?? undefined })
      .then((u) => {
        if (revoked) URL.revokeObjectURL(u);
        else { current = u; setUrl(u); }
      })
      .catch(() => !revoked && setFailed(true));
    return () => {
      revoked = true;
      if (current) URL.revokeObjectURL(current);
    };
  }, [path, operatorId]);
  if (failed) return <div className={`grid place-items-center rounded-lg bg-white/5 text-xs text-white/40 ${className}`}>Imagen no disponible</div>;
  if (!url) return <div className={`animate-pulse rounded-lg bg-white/5 ${className}`} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={alt} className={`rounded-lg object-contain ${className}`} /></a>;
}
