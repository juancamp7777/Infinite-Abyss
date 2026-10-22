'use client';

import type { StudioGameProps } from '../types';
import SlotShell from './SlotShell';
import { StarfallScene } from './scenes/StarfallScene';
import type { StarfallOutcome } from './outcomes';

const createScene = (stage: import('../engine').Stage) => new StarfallScene(stage);

/** Starfall Nymphs: slot 6x5 pay anywhere con cascadas, orbes multiplicadores en free spins y bonus buy. */
export default function Starfall(props: StudioGameProps) {
  return (
    <SlotShell<StarfallOutcome>
      game={props}
      title="Starfall Nymphs"
      accent="#ffd86b"
      createScene={createScene}
      bonusBuy={{ cost: 100 }}
      description="Starfall Nymphs, tragamonedas de 6 columnas y 5 filas con 8 o más símbolos iguales en cualquier posición, cascadas y giros gratis con multiplicadores"
    />
  );
}
