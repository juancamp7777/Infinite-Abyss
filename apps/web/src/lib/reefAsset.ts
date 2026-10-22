const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "/api-proxy").replace(/\/+$/, "");

/** Las imágenes subidas a Reef se guardan como ruta del API (/reef/v1/assets/…): el navegador las pide a través del API. */
export const reefAssetUrl = <T extends string | undefined>(v: T): T =>
  (v && v.startsWith("/reef/v1/assets/") ? `${API_BASE}${v}` : v) as T;
