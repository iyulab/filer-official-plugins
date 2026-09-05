using System.Runtime.InteropServices;

namespace VideoComposer.PluginHost;

/// <summary>
/// On Windows, the host (filer-ui's `plugin-process-runtime-manager.ts`) can only stop this
/// process by terminating it — Node's `child.kill()` never delivers an actual POSIX signal on
/// Windows regardless of the signal argument passed, it always calls TerminateProcess. That ends
/// this process, but not `ffmpeg.exe`, a process this one spawns as its own child: Windows does
/// not cascade termination to a killed process's children, so ffmpeg keeps rendering and can still
/// write the output file after the caller has already reported a timeout failure — and a retry
/// then collides with this plugin's own "output already exists" refusal.
///
/// A Job Object closes that gap at the OS level, not by having this process cooperate. Windows
/// automatically adds every child process this one spawns to the same job it belongs to (unless a
/// child explicitly opts out via CREATE_BREAKAWAY_FROM_JOB, which .NET's Process.Start never
/// sets) — with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, the kernel kills every process still in the
/// job the moment the job's last handle closes, which happens automatically when Windows tears
/// down this process's own handle table on exit, including an external TerminateProcess. No code
/// in this process needs to run at that moment for ffmpeg to die with it.
/// </summary>
internal static partial class WindowsJobObject
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectExtendedLimitInformation = 9;

    /// <summary>
    /// No-op on any platform other than Windows, and best-effort even there — a failure here means
    /// only that a future timeout-kill can orphan ffmpeg as before, not that this process can't run.
    /// </summary>
    public static void EnsureChildProcessesDieWithThisProcess()
    {
        if (!OperatingSystem.IsWindows()) return;

        var job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            Console.Error.WriteLine($"[WindowsJobObject] CreateJobObjectW failed (Win32 error {Marshal.GetLastPInvokeError()}) — a future timeout-kill may orphan ffmpeg.");
            return;
        }

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE },
        };
        var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var infoPtr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, infoPtr, fDeleteOld: false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, infoPtr, (uint)size))
            {
                Console.Error.WriteLine($"[WindowsJobObject] SetInformationJobObject failed (Win32 error {Marshal.GetLastPInvokeError()}) — a future timeout-kill may orphan ffmpeg.");
                return;
            }
            if (!AssignProcessToJobObject(job, GetCurrentProcess()))
            {
                Console.Error.WriteLine($"[WindowsJobObject] AssignProcessToJobObject failed (Win32 error {Marshal.GetLastPInvokeError()}) — a future timeout-kill may orphan ffmpeg.");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(infoPtr);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [LibraryImport("kernel32.dll", EntryPoint = "CreateJobObjectW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string? lpName);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetInformationJobObject(IntPtr hJob, int jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [LibraryImport("kernel32.dll")]
    private static partial IntPtr GetCurrentProcess();
}
