'use client';

import type { Stage } from '../engine';
import type { StudioGameProps } from '../types';
import SlotShell from './SlotShell';
import { VerdantScene } from './scenes/VerdantScene';
import type { VerdantOutcome } from './outcomes';

const createScene = (stage: Stage) => new VerdantScene(stage);

/** Verdant Grid: slot de clusters 7x7 con casillas marcadas y multiplicadores de posición que crecen. */
export default function VerdantGrid(props: StudioGameProps) {
  return (
    <SlotShell<VerdantOutcome>
      game={props}
      title="Verdant Grid"
      accent="#7cf0b0"
      createScene={createScene}
      bonusBuy={{ cost: 100 }}
      description="Verdant Grid, tragamonedas de clusters 7x7 con casillas marcadas y multiplicadores de posición acumulables"
    />
  );
}
