export const IAP_BAUD_RATE = 1500000;

export type IapProtocol = 'ymodem' | 'iap-ymodem';

export interface IapConfig {
  protocol: IapProtocol;
  packetSize: 128 | 1024;
  responseTimeoutMs: number;
  handshakeTimeoutMs: number;
  maxAttempts: number;
  maxAppSize: number | null;
  vectorTable: { appStart: number; ramStart: number; ramSize: number } | null;
}

export interface IapSettings {
  protocol: IapProtocol;
  packetSize: '128' | '1024';
  responseTimeoutMs: string;
  handshakeTimeoutMs: string;
  maxAttempts: string;
  validation: 'size' | 'cortex-m';
  maxAppSize: string;
  appStart: string;
  ramStart: string;
  ramSize: string;
}

export const GENERIC_SETTINGS: IapSettings = {
  protocol: 'ymodem',
  packetSize: '1024',
  responseTimeoutMs: '10000',
  handshakeTimeoutMs: '30000',
  maxAttempts: '10',
  validation: 'size',
  maxAppSize: '',
  appStart: '',
  ramStart: '',
  ramSize: '',
};

// x202_015: IAP/iap.h、System/cell_info.h 和 System/uart.c
export const X202_SETTINGS: IapSettings = {
  ...GENERIC_SETTINGS,
  protocol: 'iap-ymodem',
  packetSize: '128',
  // The Bootloader retains final ACK replies for 7 seconds. Retry before it exits.
  responseTimeoutMs: '5000',
  validation: 'cortex-m',
  appStart: '0x4800',
  maxAppSize: '0xB400',
  ramStart: '0x20000000',
  ramSize: '0x2000',
};

export function resolveIapConfig(
  settings: IapSettings,
): { config: IapConfig; error: null } | { config: null; error: string } {
  try {
    const integer = (
      text: string,
      label: string,
      min = 1,
      max = 0xffffffff,
    ) => {
      if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text.trim()))
        throw new Error(`${label}请输入十进制整数或 0x 十六进制值`);
      const value = Number(text);
      if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`${label}应在 ${min}–${max} 范围内`);
      return value;
    };
    if (!['ymodem', 'iap-ymodem'].includes(settings.protocol))
      throw new Error('请选择支持的升级协议');
    if (!['size', 'cortex-m'].includes(settings.validation))
      throw new Error('请选择支持的固件校验方式');
    if (!['128', '1024'].includes(settings.packetSize))
      throw new Error('数据包应为 128 或 1024 字节');
    const config: IapConfig = {
      protocol: settings.protocol,
      packetSize: Number(settings.packetSize) as 128 | 1024,
      responseTimeoutMs: integer(
        settings.responseTimeoutMs,
        '响应超时',
        100,
        120000,
      ),
      handshakeTimeoutMs: integer(
        settings.handshakeTimeoutMs,
        '握手超时',
        100,
        300000,
      ),
      maxAttempts: integer(settings.maxAttempts, '最多尝试次数', 1, 30),
      maxAppSize: settings.maxAppSize.trim()
        ? integer(settings.maxAppSize, '应用区容量')
        : null,
      vectorTable: null,
    };
    if (settings.validation === 'cortex-m') {
      if (config.maxAppSize === null || config.maxAppSize < 8)
        throw new Error('向量表校验需要填写至少 8 字节的应用区容量');
      config.vectorTable = {
        appStart: integer(settings.appStart, '应用起始地址', 0),
        ramStart: integer(settings.ramStart, 'SRAM 起始地址', 0),
        ramSize: integer(settings.ramSize, 'SRAM 容量'),
      };
      if (
        config.vectorTable.appStart % 4 !== 0 ||
        config.vectorTable.ramStart % 4 !== 0 ||
        config.vectorTable.ramSize % 4 !== 0
      )
        throw new Error('应用起始地址、SRAM 起始地址和容量需要按 4 字节对齐');
      if (
        config.vectorTable.appStart + config.maxAppSize > 0x100000000 ||
        config.vectorTable.ramStart + config.vectorTable.ramSize > 0xffffffff
      )
        throw new Error('配置的内存范围超出 32 位地址空间');
    }
    return { config, error: null };
  } catch (error) {
    return {
      config: null,
      error: error instanceof Error ? error.message : '升级参数无效',
    };
  }
}

export const GENERIC_CONFIG = resolveIapConfig(GENERIC_SETTINGS).config!;
export const X202_CONFIG = resolveIapConfig(X202_SETTINGS).config!;
export const CW32L910_SETTINGS: IapSettings = {
  ...X202_SETTINGS,
  packetSize: '128',
  appStart: '0x4000',
  maxAppSize: '0xBA00',
  ramSize: '0x1000',
};
export const CW32L910_CONFIG = resolveIapConfig(CW32L910_SETTINGS).config!;
export const DEFAULT_SETTINGS = X202_SETTINGS;
export const DEFAULT_CONFIG = X202_CONFIG;
