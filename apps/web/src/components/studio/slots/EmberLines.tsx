'use client';

import type { Stage } from '../engine';
import type { StudioGameProps } from '../types';
import SlotShell from './SlotShell';
import { EmberScene } from './scenes/EmberScene';
import type { EmberOutcome } from './outcomes';

const createScene = (stage: Stage) => new EmberScene(stage);

/** Ember Lines 20: slot clásica 5x3 de 20 líneas con wild expansivo y giros gratis. */
export default function EmberLines(props: StudioGameProps) {
  return (
    <SlotShell<EmberOutcome>
      game={props}
      title="Ember Lines 20"
      accent="#ffb347"
      createScene={createScene}
      bonusBuy={null}
      description="Ember Lines 20, tragamonedas clásica de 5 rodillos, 3 filas y 20 líneas con wild expansivo y giros gratis"
    />
  );
}
