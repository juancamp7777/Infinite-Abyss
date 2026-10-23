/** Dominios donde la raíz muestra la landing comercial (el resto de dominios son casinos y van al lobby). */
export function isLandingHost(host: string | null | undefined): boolean {
  const hosts = (process.env.LANDING_HOSTS || "infinite-abyss.com,www.infinite-abyss.com").split(/[\s,]+/).filter(Boolean).map((h) => h.toLowerCase());
  const h = (host ?? "").toLowerCase().replace(/:\d+$/, "");
  return hosts.includes(h);
}

/** A dónde llevan los botones: la demo del casino y el contacto comercial (configurables por entorno). */
export function landingLinks(): { demoUrl: string; contactUrl: string } {
  return {
    demoUrl: process.env.LANDING_DEMO_URL || "/lobby",
    contactUrl: process.env.LANDING_CONTACT_URL || "/webchat",
  };
}

/** Textos opcionales de la landing del casino: sin configurar no se muestra oferta ni licencia (nunca se inventan). */
export function casinoLandingConfig(): { bonus?: string; license?: string } {
  return {
    bonus: process.env.LANDING_BONUS?.trim() || undefined,
    license: process.env.LANDING_LICENSE?.trim() || undefined,
  };
}
