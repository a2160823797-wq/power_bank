export const IAP_BAUD_RATE = 1500000;
export const IAP_PACKET_SIZE = 1024;
export const IAP_APP_MAX_SIZE = 0x9e00;
export const IAP_COMMAND_TIMEOUT_MS = 2200;

export interface IapConfig {
  responseTimeoutMs: number;
  handshakeTimeoutMs: number;
  maxAttempts: number;
}

export const DEFAULT_CONFIG: IapConfig = {
  responseTimeoutMs: 5000,
  handshakeTimeoutMs: 30000,
  maxAttempts: 5,
};
