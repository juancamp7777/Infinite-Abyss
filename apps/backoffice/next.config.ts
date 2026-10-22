import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Prefijo bajo el que se sirve el backoffice (p. ej. /_svc/backoffice). Vacío = raíz.
const rawBase = (process.env.NEXT_PUBLIC_BASE_PATH || "").trim().replace(/\/+$/, "");
const basePath = rawBase && !rawBase.startsWith("/") ? `/${rawBase}` : rawBase;

// Origen del API interno al que Next reenvía /api-proxy/* (desde el servidor, no el navegador).
const apiInternal = (process.env.API_INTERNAL_URL || "http://localhost:4000").replace(/\/$/, "");

// Si NEXT_PUBLIC_API_URL es absoluta, hay que permitirla en connect-src.
const apiUrl = process.env.NEXT_PUBLIC_API_URL || "";
const apiOrigin = (() => {
  try {
    return /^https?:\/\//i.test(apiUrl) ? new URL(apiUrl).origin : "";
  } catch {
    return "";
  }
})();

// Orígenes extra para logos/imágenes de operadores (separados por coma o espacio).
const imgOrigins = (process.env.NEXT_PUBLIC_IMG_ORIGINS || "")
  .split(/[\s,]+/)
  .filter((o) => /^https?:\/\/[^\s;'"]+$/i.test(o));

const csp = [
  "default-src 'self'",
  `img-src ${["'self'", "data:", "blob:", ...imgOrigins].join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "font-src 'self' data:",
  `connect-src ${["'self'", apiOrigin, apiOrigin?.replace(/^http/i, "ws")].filter(Boolean).join(" ")}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Salida mínima para la imagen Docker (server.js + dependencias necesarias).
  output: "standalone",
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  // Con basePath, Next antepone el prefijo al origen del rewrite: el cliente usa `${basePath}/api-proxy`.
  async rewrites() {
    return [{ source: "/api-proxy/:path*", destination: `${apiInternal}/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
