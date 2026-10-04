export const IAP_BAUD_RATE = 1500000;
export const IAP_PACKET_SIZE = 1024;

export interface IapConfig {
  responseTimeoutMs: number;
  handshakeTimeoutMs: number;
  maxAttempts: number;
}

export const DEFAULT_CONFIG: IapConfig = {
  responseTimeoutMs: 5000,
  handshakeTimeoutMs: 30000,
  maxAttempts: 10,
};
