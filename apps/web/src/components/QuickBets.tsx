"use client";

import { formatCurrency } from "@/lib/money";

/** Botones de montos rápidos (unidades mínimas como string). Accesible: grupo con etiqueta. */
export function QuickBets({
  amounts,
  currency,
  decimals,
  onPick,
  disabled,
  label = "Montos rápidos",
}: {
  amounts: string[];
  currency: string;
  decimals: number;
  onPick: (minor: bigint) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {amounts.map((a) => (
        <button
          key={a}
          type="button"
          disabled={disabled}
          onClick={() => onPick(BigInt(a))}
          className="rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:border-gold-500/50 disabled:opacity-50"
        >
          {formatCurrency(BigInt(a), currency, decimals)}
        </button>
      ))}
    </div>
  );
}
