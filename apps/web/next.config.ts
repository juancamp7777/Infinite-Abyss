import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/** Lista separada por espacios o comas → arreglo de orígenes. */
const list = (v?: string) => (v ?? "").split(/[\s,]+/).filter(Boolean);

const apiUrl = (process.env.NEXT_PUBLIC_API_URL || "/api-proxy").replace(/\/+$/, "");
/** Origen absoluto del API si NEXT_PUBLIC_API_URL no es relativa (same-origin no necesita más permisos). */
const apiOrigin = /^https?:\/\//i.test(apiUrl) ? new URL(apiUrl).origin : null;
const socketOrigin = process.env.NEXT_PUBLIC_SOCKET_URL ? new URL(process.env.NEXT_PUBLIC_SOCKET_URL).origin : null;
const frameOrigins = list(process.env.NEXT_PUBLIC_GAME_FRAME_ORIGINS);
/** Sitios que pueden embeber el webchat (/webchat) en un iframe; por defecto, cualquiera. */
const webchatAncestors = list(process.env.WEBCHAT_FRAME_ANCESTORS);

/** http(s) → ws(s) del mismo host, para connect-src. */
const wsOf = (origin: string) => origin.replace(/^http/i, "ws");

const connectSrc = ["'self'"];
for (const o of [apiOrigin, socketOrigin]) if (o) connectSrc.push(o, wsOf(o));
// Misma-origen: ws:/wss: del propio host los cubre 'self' en navegadores modernos; se añaden por compatibilidad.
if (!apiOrigin && !socketOrigin) connectSrc.push("ws:", "wss:");

const baseCsp = (frameAncestors: string) =>
  [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:" + (apiOrigin ? ` ${apiOrigin}` : ""),
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
    `connect-src ${connectSrc.join(" ")}`,
    `frame-src ${["'self'", ...(apiOrigin ? [apiOrigin] : []), ...frameOrigins].join(" ")}`,
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");

const commonHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), fullscreen=(self)" },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    const target = (process.env.API_INTERNAL_URL || "http://localhost:4000").replace(/\/+$/, "");
    // Incluye /api-proxy/socket.io/ (la API sirve Socket.io en /socket.io).
    return [{ source: "/api-proxy/:path*", destination: `${target}/:path*` }];
  },
  async headers() {
    return [
      // Todo salvo los juegos: no se puede embeber.
      {
        source: "/((?!studio/|webchat).*)",
        headers: [
          ...commonHeaders,
          { key: "Content-Security-Policy", value: baseCsp("'none'") },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      // Webchat embebible (public/webchat.js) en las webs del operador.
      {
        source: "/webchat",
        headers: [...commonHeaders, { key: "Content-Security-Policy", value: baseCsp(webchatAncestors.length ? webchatAncestors.join(" ") : "*") }],
      },
      // Juegos de Studios (grupo (games)): se cargan en el iframe del lobby, mismo origen.
      {
        source: "/studio/:path*",
        headers: [
          ...commonHeaders,
          { key: "Content-Security-Policy", value: baseCsp("'self'") },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};

export default nextConfig;
