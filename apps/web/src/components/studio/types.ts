/** Props comunes de todos los juegos de Nymfo Studios. */
export interface StudioGameProps {
  gameId: string;
  mode: 'real' | 'demo';
  /** Token de sesión del Hub (opcional): se envía como X-Studio-Session. */
  session?: string;
}
