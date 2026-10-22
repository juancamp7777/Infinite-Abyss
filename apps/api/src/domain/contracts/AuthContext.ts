export type BackofficeRoleName =
  | 'PLATFORM_ADMIN'
  | 'OPERATOR_ADMIN'
  | 'OPERATOR_SUPPORT'
  | 'OPERATOR_FINANCE';

/** Jugador autenticado: el userId SIEMPRE sale del token, nunca del cliente. */
export interface PlayerAuth {
  kind: 'player';
  userId: string;
  operatorId: string;
  currency: string;
  isDemo: boolean;
}

/** Usuario de backoffice. operatorId es null solo para PLATFORM_ADMIN. */
export interface BackofficeAuth {
  kind: 'backoffice';
  backofficeUserId: string;
  operatorId: string | null;
  role: BackofficeRoleName;
}

export type AuthContext = PlayerAuth | BackofficeAuth;
