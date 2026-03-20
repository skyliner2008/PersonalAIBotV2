using System;
using System.Runtime.InteropServices;

public class PInvoke {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("User32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    public static void Main() {
        LASTINPUTINFO lastInPut = new LASTINPUTINFO();
        lastInPut.cbSize = (uint)Marshal.SizeOf(lastInPut);
        if (GetLastInputInfo(ref lastInPut)) {
            Console.WriteLine((uint)Environment.TickCount - lastInPut.dwTime);
        } else {
            Console.WriteLine("-1");
        }
    }
}
