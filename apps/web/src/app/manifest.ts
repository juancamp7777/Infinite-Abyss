import type { MetadataRoute } from "next";

/** App instalable (PWA): íconos generados desde el ícono oficial de la marca (public/brand/app-icon-*). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Infinite Abyss",
    short_name: "Abyss",
    description: "Casino en línea con originals provably fair, slots, torneos y VIP. Solo mayores de 18 años.",
    start_url: "/lobby",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#050d1c",
    theme_color: "#050d1c",
    lang: "es",
    categories: ["games", "entertainment"],
    icons: [
      { src: "/brand/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/app-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
