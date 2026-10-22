"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { registerModuleOperator } from "./modules";
import { api, decimalsFor, type BrandResponse, type BrandInfo, type OperatorInfo } from "./api";

export const NYMFO_BRAND: BrandResponse = {
  operator: {
    slug: "nymfo-casino",
    name: "Infinite Abyss",
    // La moneda real llega de /api/operator/brand; mientras carga no se asume ninguna.
    currencies: [],
    defaultCurrency: "",
    currencyDecimals: 2,
    chipsEnabled: false,
    chipMinorUnitsPerChip: null,
  },
  brand: {
    displayName: "Infinite Abyss",
    logoUrl: null,
    colors: {},
    fontFamily: null,
    legal: null,
  },
};

type ThemeState = {
  status: "loading" | "ready" | "error";
  operator: OperatorInfo;
  brand: BrandInfo;
  currency: string;
  decimals: number;
  error: string | null;
  reload: () => void;
};

const ThemeContext = createContext<ThemeState | null>(null);

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9\s,.%]+\)|hsla?\([0-9\s,.%deg]+\))$/;
const FONT_RE = /^[A-Za-z0-9 ,'"_-]{1,120}$/;

/** Aplica la marca como variables CSS en <html>. Valores no válidos se ignoran (se mantiene el defecto). */
export function applyBrand(brand: BrandInfo) {
  const root = document.documentElement;
  const map: Array<[string, string | undefined]> = [
    ["--brand-primary", brand.colors?.primary],
    ["--brand-secondary", brand.colors?.secondary],
    ["--brand-accent", brand.colors?.accent],
    ["--brand-background", brand.colors?.background],
    ["--brand-surface", brand.colors?.surface],
    ["--brand-text", brand.colors?.text],
  ];
  for (const [name, value] of map) {
    if (value && COLOR_RE.test(value.trim())) root.style.setProperty(name, value.trim());
    else root.style.removeProperty(name);
  }
  if (brand.fontFamily && FONT_RE.test(brand.fontFamily)) {
    root.style.setProperty("--brand-font", `${brand.fontFamily}, var(--font-geist-sans)`);
  } else {
    root.style.removeProperty("--brand-font");
  }
  if (brand.displayName) document.title = brand.displayName;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<BrandResponse>(NYMFO_BRAND);
  const [status, setStatus] = useState<ThemeState["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    api
      .get<BrandResponse>("/api/operator/brand", { scope: "none", signal: controller.signal })
      .then((res) => {
        setData(res);
        registerModuleOperator(res.operator);
        applyBrand(res.brand);
        setError(null);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        // Se mantiene la marca Infinite Abyss por defecto y se informa del fallo.
        setError(e instanceof Error ? e.message : "No se pudo cargar la marca");
        setStatus("error");
      });
    return () => controller.abort();
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const value = useMemo<ThemeState>(() => {
    const currency = data.operator.defaultCurrency;
    return {
      status,
      operator: data.operator,
      brand: data.brand,
      currency,
      decimals: decimalsFor(data.operator, currency),
      error,
      reload,
    };
  }, [data, status, error, reload]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme debe usarse dentro de ThemeProvider");
  return ctx;
}
