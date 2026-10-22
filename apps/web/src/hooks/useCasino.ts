import { useState, useEffect, useCallback, useMemo } from "react";
import { casinoSDK, SpinResult } from "../lib/CasinoSDK";
import { useTheme } from "../lib/theme";
import { formatCurrency, inputToMinor, minorToInput } from "../lib/money";
import { betBounds, betSteps, defaultBetIndex, withinBetBounds } from "../lib/bets";

/**
 * Estado del casino para las páginas de juego. Los montos son bigint en unidades mínimas;
 * los inputs de texto se convierten con `toMinor` (sin floats).
 */
export function useCasino() {
  const { currency, decimals } = useTheme();
  const [state, setState] = useState({
    balance: casinoSDK.balance,
    isConnected: casinoSDK.isConnected,
  });

  const [isSpinning, setIsSpinning] = useState(false);
  const [lastResult, setLastResult] = useState<SpinResult | null>(null);

  useEffect(() => {
    casinoSDK.start();
    casinoSDK.setFormat(currency, decimals);
  }, [currency, decimals]);

  useEffect(() => {
    const sync = () => setState({ balance: casinoSDK.balance, isConnected: casinoSDK.isConnected });
    sync();
    return casinoSDK.subscribe(sync);
  }, []);

  /** "12.50" → 1250n; en COP "5000" o "5.000" → 500000n (según los decimales del ledger del operador). */
  const tryMinor = useCallback((major: string) => inputToMinor(major, currency, decimals), [currency, decimals]);
  const minor = useCallback(
    (major: string | number) => {
      const v = tryMinor(String(major));
      if (v === null) throw new Error("Monto inválido");
      return v;
    },
    [tryMinor],
  );
  /** Montos rápidos de apuesta (unidades mínimas) de la moneda del operador, dentro de min/max. */
  const presets = useMemo(() => betSteps(currency), [currency]);
  /** Apuesta fija de las páginas de demostración (segundo monto rápido del operador). */
  const demoBet = useMemo(() => BigInt(presets[Math.min(1, presets.length - 1)] ?? "0"), [presets]);
  /** Apuesta inicial como texto editable (primer monto rápido ≥ mínima). */
  const defaultBetText = useMemo(() => {
    const p = presets[defaultBetIndex(presets, betBounds().min)];
    return p ? minorToInput(BigInt(p), decimals, currency) : "";
  }, [presets, decimals, currency]);
  /** Texto → unidades mínimas solo si está dentro de minBet/maxBet del operador; si no, null. */
  const betMinorOf = useCallback(
    (text: string) => {
      const v = tryMinor(text);
      return v !== null && v > BigInt(0) && withinBetBounds(v) ? v : null;
    },
    [tryMinor],
  );
  const money = useCallback((value: bigint) => formatCurrency(value, currency, decimals), [currency, decimals]);

  const placeBet = async (type: "pleno" | "color", value: number | "red" | "black", amount: bigint) => {
    if (isSpinning) return;
    setIsSpinning(true);
    setLastResult(null);
    try {
      const res = await casinoSDK.placeRouletteBet(type, value, amount);
      // Simular tiempo de giro
      setTimeout(() => {
        setLastResult(res.result);
        setIsSpinning(false);
      }, 3000);
    } catch (e) {
      console.error(e);
      setIsSpinning(false);
    }
  };

  return {
    ...state,
    currency,
    decimals,
    minor,
    tryMinor,
    betMinorOf,
    presets,
    demoBet,
    defaultBetText,
    money,
    isSpinning,
    lastResult,
    placeBet,
  };
}
