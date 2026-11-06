export const APP_NAME = 'skymatrix' as const;

export interface HealthPayload {
  status: 'ok';
  service: string;
  uptimeSeconds: number;
  timestamp: string;
}

export function healthPayload(service: string, startedAt: number): HealthPayload {
  return {
    status: 'ok',
    service,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  };
}
