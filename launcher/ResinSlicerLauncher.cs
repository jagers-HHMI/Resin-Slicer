using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace ResinSlicerLauncher
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string root = AppDomain.CurrentDomain.BaseDirectory;
            string portableExe = Path.Combine(root, "dist", "ResinSlicer", "ResinSlicer.exe");
            if (File.Exists(portableExe))
            {
                if (StartProcess(portableExe, "", Path.GetDirectoryName(portableExe), false))
                {
                    return;
                }
            }

            string electronExe = Path.Combine(root, "node_modules", "electron", "dist", "electron.exe");
            string electronApp = Path.Combine(root, "electron");

            if (File.Exists(electronExe) && Directory.Exists(electronApp))
            {
                if (StartProcess(electronExe, Quote(root), root, false))
                {
                    return;
                }
            }

            string python = FindPython();
            if (python != null && StartProcess(python, "-m resin_slicer.gui", root, false))
            {
                if (!File.Exists(electronExe))
                {
                    MessageBox.Show(
                        "Electron dependencies are not installed, so Resin Slicer opened the fallback Python GUI.\n\n" +
                        "To enable the 3D Electron viewer, install Node.js/npm, then run `npm install` in:\n" + root,
                        "Resin Slicer",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information
                    );
                }
                return;
            }

            MessageBox.Show(
                "Resin Slicer could not start.\n\n" +
                "Use the packaged app at:\n" + portableExe + "\n\n" +
                "Or install Python 3.10+ / Electron dependencies in:\n" + root,
                "Resin Slicer",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }

        private static string FindPython()
        {
            string env = Environment.GetEnvironmentVariable("PYTHON");
            if (!String.IsNullOrWhiteSpace(env) && File.Exists(env))
            {
                return env;
            }

            string local = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "Python",
                "Python310",
                "python.exe"
            );
            if (File.Exists(local))
            {
                return local;
            }

            return "python";
        }

        private static bool StartProcess(string fileName, string arguments, string workingDirectory, bool shell)
        {
            try
            {
                var info = new ProcessStartInfo
                {
                    FileName = fileName,
                    Arguments = arguments,
                    WorkingDirectory = workingDirectory,
                    UseShellExecute = shell,
                    CreateNoWindow = true
                };
                Process.Start(info);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
