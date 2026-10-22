/**
 * Conversión fichas ↔ unidades mínimas. La tasa vive SOLO en Operator.chipMinorUnitsPerChip.
 * Si el operador no usa fichas, la tasa es 1 (la UI muestra dinero directamente).
 */
export class ChipConversion {
  constructor(
    private readonly chipsEnabled: boolean,
    private readonly minorUnitsPerChip: bigint | null,
  ) {
    if (chipsEnabled && (minorUnitsPerChip === null || minorUnitsPerChip <= 0n)) {
      throw new Error('chipsEnabled requires chipMinorUnitsPerChip > 0');
    }
  }

  static fromOperator(op: { chipsEnabled: boolean; chipMinorUnitsPerChip: bigint | null }): ChipConversion {
    return new ChipConversion(op.chipsEnabled, op.chipMinorUnitsPerChip);
  }

  get rate(): bigint {
    return this.chipsEnabled ? (this.minorUnitsPerChip as bigint) : 1n;
  }

  chipsToMinor(chips: bigint): bigint {
    return chips * this.rate;
  }

  /** Fichas enteras (se descarta el resto hacia abajo). */
  minorToChips(minor: bigint): bigint {
    return minor / this.rate;
  }
}
