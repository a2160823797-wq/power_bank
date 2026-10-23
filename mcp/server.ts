import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SerialPort } from 'serialport';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBatteryState } from '../lib/battery-protocol';
import { DeviceSerialSession } from '../lib/device-session';
import {
  DEFAULT_CONFIG,
  IAP_APP_MAX_SIZE,
  IAP_BAUD_RATE,
} from '../lib/iap-config';
import {
  BootState,
  IapSerialSession,
  crc32,
  validateFirmware,
  type SerialPortLike,
} from '../lib/iap-protocol';
import { SharedSerialTransport } from '../lib/shared-serial';
import { LocalSerialPort, releaseUsbSerialPort } from './serial-port';

type Mode = 'battery' | 'ntc' | 'iap';
type UpgradeStage = 'handshake' | 'writing' | 'verifying';
type UpgradeState = 'running' | 'succeeded' | 'failed' | 'cancelled';

interface Connection {
  port: string;
  physical: LocalSerialPort;
  mode: Mode;
  device: DeviceSerialSession | null;
  transport: SharedSerialTransport | null;
  battery: ReturnType<typeof createBatteryState>;
  error: string | null;
}

interface UpgradeJob {
  id: string;
  port: string;
  path: string;
  size: number;
  crc32: string;
  state: UpgradeState;
  stage: UpgradeStage;
  percent: number;
  sent: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  cancelRequested: boolean;
  verified: boolean;
  applicationResponding: boolean;
}

const server = new McpServer(
  { name: 'powerbank', version: '0.1.0' },
  {
    instructions:
      '通过本地串口使用 PowerBank 上位机的原始协议。先 list_ports，再用明确的端口 connect。外部程序占用目标串口时，可用 release_port 断开该端口的连接；Windows 会重启指定 USB 串口设备，不得在升级中使用。IAP 使用 APP .bin，iap_start 返回任务 ID，必须用 iap_status 等待终态。仅 succeeded 表示状态、长度及 CRC32 均已通过设备确认。不要在失败或取消后自动重发固件。完成后 disconnect。',
  },
);
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
const changesDevice = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};
const bootStates = [
  'ready',
  'app_error',
  'request_upgrade',
  'updating',
  'update_ready',
  'jump_app',
  'app',
];
let connection: Connection | null = null;
let operationBusy = false;
let job: UpgradeJob | null = null;
let upgradeSession: IapSerialSession | null = null;
let upgradeTask: Promise<void> | null = null;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function result(value: object) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  if (operationBusy || job?.state === 'running')
    throw new Error('设备正在执行命令或 IAP 升级，请先查询状态');
  operationBusy = true;
  try {
    return await operation();
  } finally {
    operationBusy = false;
  }
}

function connected() {
  if (
    !connection ||
    !(connection.device?.isOpen || connection.transport?.isOpen)
  ) {
    throw new Error(connection?.error ?? '请先连接设备');
  }
  return connection;
}

async function disconnect() {
  if (!connection) return;
  await connection.device?.close();
  await connection.transport?.close();
  connection = null;
}

async function withIap<T>(
  cur_connection: Connection,
  operation: (session: IapSerialSession) => Promise<T>,
) {
  const run = async (port: SerialPortLike) => {
    const session = new IapSerialSession(port);
    try {
      await session.open();
      return await operation(session);
    } finally {
      await session.close();
    }
  };
  return cur_connection.device
    ? cur_connection.device.withUpgrade(run)
    : run(cur_connection.transport!.createChannel());
}

async function reconnectAfterReset(cur_connection: Connection) {
  await cur_connection.transport!.close();
  for (let attempt = 1; ; attempt++) {
    const physical = new LocalSerialPort(cur_connection.port);
    const transport = new SharedSerialTransport(physical, (error) => {
      cur_connection.error = message(error);
    });
    try {
      await transport.open();
      cur_connection.physical = physical;
      cur_connection.transport = transport;
      cur_connection.error = null;
      break;
    } catch (error) {
      await transport.close();
      if (attempt >= DEFAULT_CONFIG.maxAttempts) throw error;
      await delay(350);
    }
  }
  const option = await withIap(cur_connection, (session) =>
    session.readBootOptionWithRetry(),
  );
  if (
    option.state !== BootState.AppRequestUpgrade &&
    option.state !== BootState.AppUpdate
  ) {
    throw new Error('连接已恢复，但设备未进入升级模式；未重发固件');
  }
}

async function firmware(path: string) {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== '.bin')
    throw new Error('请提供 APP .bin 的绝对路径');
  const info = await stat(path);
  if (!info.isFile() || info.size < 8 || info.size > IAP_APP_MAX_SIZE)
    throw new Error('APP 文件须为 8～40448 字节');
  const data = new Uint8Array(await readFile(path));
  const error = validateFirmware(data);
  if (error) throw new Error(error);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    data,
    info: {
      path,
      name: basename(path),
      size: data.length,
      crc32: `0x${crc32(data).toString(16).padStart(8, '0').toUpperCase()}`,
      initialStack: `0x${view.getUint32(0, true).toString(16)}`,
      resetVector: `0x${view.getUint32(4, true).toString(16)}`,
    },
  };
}

server.registerTool(
  'list_ports',
  {
    description:
      '枚举本机串口，标注 MKLink 控制口及 RS485 口；不要将控制口选作目标 UART',
    annotations: readOnly,
  },
  async () =>
    result({
      ports: (await SerialPort.list()).map((port) => ({
        ...port,
        role: /python console|MI_04/i.test(`${port.friendlyName} ${port.pnpId}`)
          ? 'probe_console'
          : /RS485|MI_06/i.test(`${port.friendlyName} ${port.pnpId}`)
            ? 'rs485'
            : 'uart',
      })),
    }),
);

server.registerTool(
  'connect',
  {
    description:
      '连接明确指定的串口并确认设备身份。battery 启动电池监测，ntc 连接温度模拟器，iap 仅连接升级协议。波特率固定 1500000；外部程序占用时可先 release_port',
    inputSchema: {
      port: z.string().min(1),
      mode: z.enum(['battery', 'ntc', 'iap']).default('battery'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async ({ port, mode }) =>
    exclusive(async () => {
      if (connection) throw new Error('已有连接，请先 disconnect');
      const available = (await SerialPort.list()).find(
        (item) => item.path.toLowerCase() === port.toLowerCase(),
      );
      if (!available) throw new Error('串口不存在，请先 list_ports');
      if (
        /python console|MI_04/i.test(
          `${available.friendlyName} ${available.pnpId}`,
        )
      )
        throw new Error('这是 MKLink 控制口，请选择目标 UART 口');
      const physical = new LocalSerialPort(available.path);
      const cur_connection: Connection = {
        port: available.path,
        physical,
        mode,
        device: null,
        transport: null,
        battery: createBatteryState(),
        error: null,
      };
      connection = cur_connection;
      try {
        if (mode === 'iap') {
          cur_connection.transport = new SharedSerialTransport(
            physical,
            (error) => {
              cur_connection.error = message(error);
            },
          );
          await cur_connection.transport.open();
          await withIap(cur_connection, (session) => session.identify());
        } else {
          cur_connection.device = new DeviceSerialSession(
            physical,
            {
              onData: (_, state) => {
                cur_connection.battery = state;
              },
              onError: (_, error) => {
                cur_connection.error = error;
              },
              onDisconnect: (_, error) => {
                cur_connection.error = message(error);
              },
            },
            mode,
          );
          await cur_connection.device.open();
          await cur_connection.device.identify(2200);
          if (mode === 'battery') await cur_connection.device.synchronizeClock();
        }
        return result({
          connected: true,
          port: cur_connection.port,
          mode,
          baudRate: IAP_BAUD_RATE,
        });
      } catch (error) {
        try {
          await disconnect();
        } catch (closeError) {
          throw new Error(
            `${message(error)}；串口释放失败：${message(closeError)}`,
          );
        }
        throw error;
      }
    }),
);

server.registerTool(
  'disconnect',
  {
    description: '断开并释放本 MCP 持有的串口。升级中先取消并等待任务结束',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async () =>
    exclusive(async () => {
      await disconnect();
      return result({ connected: false });
    }),
);

server.registerTool(
  'release_port',
  {
    description:
      '释放明确指定的目标串口。本 MCP 持有时正常关闭；外部程序占用时，Windows 重启该 USB 串口设备使其连接断开，并实际打开/关闭端口确认释放。会中断该端口通信，不得在任何程序升级过程中调用；不支持下载器或系统串口',
    inputSchema: { port: z.string().min(1) },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  async ({ port }) =>
    exclusive(async () => {
      const available = (await SerialPort.list()).find(
        (item) => item.path.toLowerCase() === port.toLowerCase(),
      );
      if (!available) throw new Error('串口不存在，请先 list_ports');
      if (connection?.port.toLowerCase() === available.path.toLowerCase()) {
        await disconnect();
        return result({ port: available.path, released: true, method: 'mcp_disconnect' });
      }
      return result(await releaseUsbSerialPort(available));
    }),
);

server.registerTool(
  'device_status',
  {
    description:
      '读取当前连接、缓存数据更新时间和最近升级任务状态，不发送串口命令',
    annotations: readOnly,
  },
  async () =>
    result({
      connected: !!(
        connection?.device?.isOpen || connection?.transport?.isOpen
      ),
      port: connection?.port ?? null,
      mode: connection?.mode ?? null,
      error: connection?.error ?? null,
      busy: operationBusy || job?.state === 'running',
      lastReceivedAt: connection?.battery.lastReceivedAt ?? null,
      upgrade: job ? { ...job } : null,
    }),
);

server.registerTool(
  'serial_trace',
  {
    description:
      '读取当前连接最近的串口收发批次，最多128批，每批预览128字节。用于定位IAP握手、NAK或CAN，不发送数据',
    inputSchema: { limit: z.number().int().min(1).max(128).default(32) },
    annotations: readOnly,
  },
  async ({ limit }) => {
    if (!connection) throw new Error('当前没有连接');
    return result({
      port: connection.port,
      entries: connection.physical.getTrace(limit),
    });
  },
);

server.registerTool(
  'battery_read',
  {
    description:
      '获取 battery 模式下的当前缓存电池数据，含数据接收时间；未收到的字段为 null，不能解释为 0',
    annotations: readOnly,
  },
  async () => {
    const cur_connection = connected();
    if (cur_connection.mode !== 'battery')
      throw new Error('需要以 battery 模式连接');
    return result({ port: cur_connection.port, state: cur_connection.battery });
  },
);

server.registerTool(
  'battery_history',
  {
    description:
      '请求设备上传历史异常记录；用 battery_read 查看接收进度和完整性',
    annotations: readOnly,
  },
  async () =>
    exclusive(async () => {
      const cur_connection = connected();
      if (cur_connection.mode !== 'battery')
        throw new Error('需要以 battery 模式连接');
      await cur_connection.device!.requestHistory();
      return result({ requested: true, state: cur_connection.battery });
    }),
);

server.registerTool(
  'set_cell_info',
  {
    description:
      '写入单个电芯信息字段并由原上位机协议确认结果。model 为型号，code 为编码',
    inputSchema: {
      field: z.enum(['model', 'code']),
      value: z.string().regex(/^[A-Z0-9-]{1,24}$/),
    },
    annotations: changesDevice,
  },
  async ({ field, value }) =>
    exclusive(async () => {
      const cur_connection = connected();
      if (cur_connection.mode !== 'battery')
        throw new Error('需要以 battery 模式连接');
      await cur_connection.device!.setCellInfo(
        field === 'model' ? 0 : 1,
        value,
      );
      return result({ field, value, confirmed: true });
    }),
);

server.registerTool(
  'set_temperature',
  {
    description:
      '设置温度模拟器温度，必须为 -25～125℃ 整数；返回设备确认值及电阻参数',
    inputSchema: { temperature: z.number().int().min(-25).max(125) },
    annotations: changesDevice,
  },
  async ({ temperature }) =>
    exclusive(async () => {
      const cur_connection = connected();
      if (!cur_connection.device)
        throw new Error('需要以 battery 或 ntc 模式连接');
      const reply = await cur_connection.device.setTemperature(
        temperature,
        1000,
      );
      if (reply.status !== 0)
        throw new Error(`设备拒绝设置温度，状态码 ${reply.status}`);
      return result(reply);
    }),
);

server.registerTool(
  'inspect_firmware',
  {
    description: '读取本地 APP .bin 的大小、CRC32 和向量，不连接设备',
    inputSchema: { path: z.string() },
    annotations: readOnly,
  },
  async ({ path }) => result((await firmware(path)).info),
);

server.registerTool(
  'iap_read_option',
  {
    description: '查询设备 IAP 状态、固件长度和 CRC32。升级传输期间不可调用',
    annotations: readOnly,
  },
  async () =>
    exclusive(async () => {
      const option = await withIap(connected(), (session) =>
        session.readBootOption(),
      );
      return result({
        ...option,
        stateName: bootStates[option.state],
        crc32: `0x${option.crc.toString(16).padStart(8, '0').toUpperCase()}`,
      });
    }),
);

server.registerTool(
  'iap_start',
  {
    description:
      '开始实际 IAP 升级，会复位设备并重写 APP。复用 PowerBank 原始升级代码，返回异步任务 ID；随后必须查询 iap_status，发送完不等于升级成功',
    inputSchema: { path: z.string() },
    annotations: changesDevice,
  },
  async ({ path }) =>
    exclusive(async () => {
      const cur_connection = connected();
      const image = await firmware(path);
      const cur_job: UpgradeJob = {
        id: randomUUID(),
        port: cur_connection.port,
        path,
        size: image.info.size,
        crc32: image.info.crc32,
        state: 'running',
        stage: 'handshake',
        percent: 0,
        sent: 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        cancelRequested: false,
        verified: false,
        applicationResponding: false,
      };
      job = cur_job;
      upgradeTask = (async () => {
        try {
          const before =
            cur_connection.mode === 'iap'
              ? await withIap(cur_connection, (session) =>
                  session.readBootOption(),
                )
              : null;
          const runUpgrade = () =>
            withIap(cur_connection, async (session) => {
              upgradeSession = session;
              if (cur_job.cancelRequested) {
                await session.cancel();
                throw new Error('升级已取消');
              }
              await session.upgrade(
                image.info.name,
                image.data,
                (percent, sent) => {
                  cur_job.percent = percent;
                  cur_job.sent = sent;
                },
                (stage) => {
                  cur_job.stage = stage;
                },
              );
              cur_job.verified = true;
              // 成功须由设备确认状态、长度及 CRC32；随后确认 APP 已恢复响应
              const option = await session.readBootOptionWithRetry();
              cur_job.applicationResponding = option.state === BootState.App;
            });
          try {
            await runUpgrade();
          } catch (error) {
            // 只恢复APP进入Bootloader时的断链，尚未发送任何固件数据
            if (
              before?.state !== BootState.App ||
              cur_job.stage !== 'handshake' ||
              cur_job.sent !== 0 ||
              cur_connection.transport?.isOpen !== false ||
              cur_job.cancelRequested
            )
              throw error;
            await reconnectAfterReset(cur_connection);
            await runUpgrade();
          }
          cur_job.state = 'succeeded';
        } catch (error) {
          cur_job.state = cur_job.cancelRequested ? 'cancelled' : 'failed';
          cur_job.error = message(error);
        } finally {
          upgradeSession = null;
          cur_job.finishedAt = new Date().toISOString();
        }
      })();
      return result({ ...cur_job });
    }),
);

server.registerTool(
  'iap_status',
  {
    description:
      '查询指定升级任务的阶段、进度、终态和报错。succeeded 才表示设备确认升级，applicationResponding 表示之后已收到 APP 状态',
    inputSchema: { id: z.string() },
    annotations: readOnly,
  },
  async ({ id }) => {
    if (!job || job.id !== id)
      throw new Error('任务不存在；本服务保留最近一次升级任务');
    return result({ ...job });
  },
);

server.registerTool(
  'iap_cancel',
  {
    description:
      '取消本 MCP 当前升级任务并发送 YMODEM CAN；已擦写的数据不会恢复。用 iap_status 等待任务终态',
    inputSchema: { id: z.string() },
    annotations: changesDevice,
  },
  async ({ id }) => {
    if (!job || job.id !== id) throw new Error('任务不存在');
    if (job.state !== 'running') return result({ ...job });
    job.cancelRequested = true;
    await upgradeSession?.cancel();
    return result({ ...job });
  },
);

async function shutdown() {
  if (job?.state === 'running') {
    job.cancelRequested = true;
    await upgradeSession?.cancel();
    await upgradeTask;
  }
  await disconnect();
}

server.server.onclose = () => {
  void shutdown().catch((error) => console.error(message(error)));
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
await server.connect(new StdioServerTransport());
