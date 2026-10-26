' Peluncur tanpa jendela hitam: jalankan CANDRA di latar belakang lalu buka jendela aplikasi (Edge mode app, tanpa tab/address bar).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
py = "pythonw"
If fso.FileExists(dir & "\python\pythonw.exe") Then py = """" & dir & "\python\pythonw.exe"""
sh.Run py & " """ & dir & "\server.py""", 0, False
WScript.Sleep 2500
sh.Run "cmd /c start """" msedge --app=http://127.0.0.1:8765", 0, False
