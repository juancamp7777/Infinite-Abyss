/**
 * Integraciones conectadas desde Abyss Command (servicio 'integrations.service').
 * Los módulos leen sus llaves de aquí en vez del entorno: así se conectan y cambian sin reiniciar.
 */
export interface IntegrationsPort {
  /** Valor de un campo: primero la del casino, si no la de la plataforma. undefined = no conectada. */
  value(operatorId: string | null, key: string, field: string): Promise<string | undefined>;
  /** Variables de entorno equivalentes de los proveedores de juegos conectados (para el Hub). */
  envOverlay(): Promise<Record<string, string>>;
}

/** Control de proveedores del Hub (servicio 'hub.providers'): recargar adaptadores y probar uno sin tocar los activos. */
export interface HubProvidersControl {
  reload(overlay: Record<string, string>): Promise<{ active: string[]; errors: string[] }>;
  test(providerId: string, overlay: Record<string, string>): Promise<{ ok: boolean; message: string }>;
}
