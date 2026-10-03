const englishMessages = new Map<string, string>([
  ['监测帧数据过长', 'Monitoring frame payload is too long'],
  [
    '串口会话已关闭，请重新连接',
    'The serial session is closed. Please reconnect',
  ],
  ['串口读写通道不可用', 'The serial read/write channels are unavailable'],
  ['设备已断开连接', 'The device has disconnected'],
  ['请先连接设备', 'Please connect the device first'],
  ['串口已关闭', 'The serial port is closed'],
  ['设备响应超时', 'The device response timed out'],
  ['固件文件不能为空', 'The firmware file cannot be empty'],
  [
    '固件大小超出 32 位长度范围',
    'The firmware size exceeds the 32-bit length limit',
  ],
  [
    '固件至少需要包含 8 字节向量表',
    'The firmware must contain at least an 8-byte vector table',
  ],
  [
    '栈顶地址不在配置的 SRAM 范围内，或未按 4 字节对齐',
    'The stack address is outside the configured SRAM range or is not 4-byte aligned',
  ],
  ['串口不可读', 'The serial port is not readable'],
  ['串口已断开', 'The serial port has disconnected'],
  ['升级已取消', 'The upgrade was cancelled'],
  ['串口不可写', 'The serial port is not writable'],
  ['未收到有效的 IAP 命令响应', 'No valid IAP command response was received'],
  ['设备取消了升级', 'The device cancelled the upgrade'],
  ['设备要求重传', 'The device requested retransmission'],
  [
    '等待 YMODEM 接收请求，请让设备进入 Bootloader 接收模式',
    'Waiting for a YMODEM receive request. Put the device into Bootloader receive mode',
  ],
  ['YMODEM 接收端已就绪', 'The YMODEM receiver is ready'],
  ['正在确认设备在线', 'Checking whether the device is online'],
  ['设备在线确认失败', 'The device did not confirm that it is online'],
  ['设备握手成功', 'Device handshake completed'],
  ['正在切换到 Bootloader', 'Switching to Bootloader'],
  ['设备拒绝进入升级模式', 'The device refused to enter upgrade mode'],
  ['正在下发固件校验信息', 'Sending firmware verification information'],
  [
    'Bootloader 拒绝了固件大小或 CRC32',
    'Bootloader rejected the firmware size or CRC32',
  ],
  ['文件头', 'File header'],
  ['传输结束', 'End of transfer'],
  ['结束文件头', 'Final file header'],
  ['正在写入固件', 'Writing firmware'],
  [
    '正在等待设备确认传输结束',
    'Waiting for the device to confirm the end of transfer',
  ],
  [
    '固件传输完成，请确认设备运行状态',
    'Firmware transfer completed. Please check the device status',
  ],
  [
    '设备已确认接收，固件校验与启动由 Bootloader 完成',
    'The device confirmed receipt. Bootloader will verify and start the firmware',
  ],
  [
    '升级器已就绪 · 等待选择 .bin 固件',
    'Updater ready · Select a .bin firmware file',
  ],
  ['请选择原始 .bin 固件文件', 'Please select a raw .bin firmware file'],
  ['无法读取固件文件', 'Unable to read the firmware file'],
  [
    '当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge',
    'This browser does not support Web Serial. Please use desktop Chrome or Edge',
  ],
  ['串口已连接，正在准备升级', 'Serial port connected. Preparing the upgrade'],
  ['升级过程中发生未知错误', 'An unknown error occurred during the upgrade'],
  [
    '当前没有正在进行的固件升级',
    'No firmware upgrade is currently in progress',
  ],
  [
    '无法释放串口，请重试断开连接',
    'Unable to release the serial port. Please try disconnecting again',
  ],
  ['串口连接失败', 'Unable to connect to the serial port'],
  ['未找到可用的电池设备，请点击“选择设备”连接', 'No compatible battery device found. Click Select Device to connect.'],
  ['找到多台电池设备，请点击“选择设备”确认', 'Multiple battery devices found. Click Select Device to choose.'],
  ['无法识别电池设备，请确认设备连接后重试', 'Battery device not recognized. Check the connection and try again.'],
]);

function englishPacketLabel(label: string) {
  return (
    englishMessages.get(label) ?? `Data block ${label.slice('数据块 '.length)}`
  );
}

// Translate messages only when rendering, keeping stored errors and logs unchanged.
export function localizeProtocolMessage(
  message: string,
  language: 'en' | 'zh',
): string {
  if (language === 'zh') return message;

  const prefix = message.match(/^[✓!›] /)?.[0] ?? '';
  const content = message.slice(prefix.length);
  let translated = englishMessages.get(content);

  if (!translated) {
    let match;
    if ((match = content.match(/^固件超过配置的应用区容量 (\d+) 字节$/))) {
      translated = `The firmware exceeds the configured application capacity of ${match[1]} bytes`;
    } else if (
      (match = content.match(
        /^复位向量无效，请确认固件链接地址与应用区 (0x[0-9A-F]+) 匹配，且入口位于固件文件范围内$/,
      ))
    ) {
      translated = `Invalid reset vector. Check that the firmware link address matches application address ${match[1]} and that the entry point is within the firmware file`;
    } else if (
      (match = content.match(
        /^(文件头|结束文件头|传输结束|数据块 \d+) 连续 (\d+) 次尝试失败$/,
      ))
    ) {
      translated = `${englishPacketLabel(match[1])} failed after ${match[2]} consecutive attempts`;
    } else if (
      (match = content.match(
        /^(文件头|结束文件头|传输结束|数据块 \d+) 未确认，正在重试 (\d+)\/(\d+)$/,
      ))
    ) {
      translated = `${englishPacketLabel(match[1])} was not acknowledged. Retrying ${match[2]}/${match[3]}`;
    } else if ((match = content.match(/^已加载 ([\s\S]+)$/))) {
      translated = `Loaded ${match[1]}`;
    } else if (
      (match = content.match(
        /^大小 (\d+(?:\.\d+)? (?:B|KiB)) · CRC32 (0x[0-9A-F]{8})$/,
      ))
    ) {
      translated = `Size ${match[1]} · CRC32 ${match[2]}`;
    }
  }

  return prefix + (translated ?? content);
}
