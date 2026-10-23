// 通过父Hub的单一端口重新枚举目标串口，不重启整个Hub
export const cycleUsbPortScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
$deviceId = $env:POWERBANK_RELEASE_DEVICE_ID
$parent = (Get-PnpDeviceProperty -InstanceId $deviceId -KeyName DEVPKEY_Device_Parent).Data
$portIndex = [uint32](Get-PnpDeviceProperty -InstanceId $deviceId -KeyName DEVPKEY_Device_Address).Data
$service = (Get-PnpDeviceProperty -InstanceId $parent -KeyName DEVPKEY_Device_Service).Data
if ($service -notmatch '^USBHUB3?$' -or $portIndex -lt 1 -or $portIndex -gt 255) {
  throw 'Target is not directly attached to an identifiable USB hub port'
}
$guid = '{f18a0e88-c30c-11d0-8815-00a0c906bed8}'
$hubPath = '\\?\' + $parent.Replace('\', '#') + '#' + $guid
$interfaces = & "$env:SystemRoot\System32\pnputil.exe" /enum-interfaces /class $guid /enabled | Out-String
if ($LASTEXITCODE -ne 0 -or $interfaces.IndexOf($hubPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
  throw 'The parent USB hub interface could not be verified'
}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PowerBankUsbPort {
  [StructLayout(LayoutKind.Sequential)]
  public struct CycleParams { public uint ConnectionIndex; public uint StatusReturned; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share,
    IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DeviceIoControl(SafeFileHandle handle, uint code,
    ref CycleParams input, uint inputSize, out CycleParams output, uint outputSize,
    out uint returned, IntPtr overlapped);
  public static void Cycle(string path, uint port) {
    using (var handle = CreateFile(path, 0x40000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      var request = new CycleParams { ConnectionIndex = port };
      CycleParams result;
      uint returned;
      // usbioctl.h: CTL_CODE(FILE_DEVICE_USB, USB_HUB_CYCLE_PORT=273, 0, 0)
      if (!DeviceIoControl(handle, 0x220444, ref request, 8, out result, 8,
          out returned, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (result.StatusReturned != 0) throw new Exception("USB cycle status: 0x" + result.StatusReturned.ToString("X8"));
    }
  }
}
'@
[PowerBankUsbPort]::Cycle($hubPath, $portIndex)
@{ parent = $parent; portIndex = $portIndex } | ConvertTo-Json -Compress
`;
