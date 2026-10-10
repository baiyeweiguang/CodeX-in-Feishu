param([Parameter(Mandatory=$true)][int]$ChildPid)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ConnectorJob {
  [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] public struct Basic {
    public long userTime, jobTime; public uint flags; public UIntPtr min, max;
    public uint active; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Extended {
    public Basic basic; public IO io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Start(int pid) {
    var job = CreateJobObject(IntPtr.Zero, null);
    var info = new Extended(); info.basic.flags = 0x2000;
    int size = Marshal.SizeOf(info); var ptr = Marshal.AllocHGlobal(size);
    Marshal.StructureToPtr(info, ptr, false);
    bool ok = SetInformationJobObject(job, 9, ptr, (uint)size); Marshal.FreeHGlobal(ptr);
    if (!ok) { CloseHandle(job); throw new System.ComponentModel.Win32Exception(); }
    var process = OpenProcess(0x0100 | 0x0001, false, pid);
    if (process == IntPtr.Zero || !AssignProcessToJobObject(job, process)) {
      int error = Marshal.GetLastWin32Error(); CloseHandle(process); CloseHandle(job);
      throw new System.ComponentModel.Win32Exception(error);
    }
    CloseHandle(process); return job;
  }
}
'@
$jobHandle = [ConnectorJob]::Start($ChildPid)
try {
  [Console]::WriteLine('READY')
  [Console]::Out.Flush()
  $null = [Console]::ReadLine()
} finally {
  $null = [ConnectorJob]::CloseHandle($jobHandle)
}
