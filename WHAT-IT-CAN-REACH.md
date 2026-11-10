# What NLC Node can and cannot reach

Only folders the user adds in the NLC Node window. Nothing else on the computer is read or changed.

- The whole home folder and system folders cannot be added.
- Deleting moves the item to the folder "NLC Trash" in the user's home folder; it can be restored. Nothing is deleted permanently.
- It holds no API keys, no passwords and no AI models. One connection credential for the customer's own NLC, stored in the program's own settings folder. A local list of actions (time, tool, folder, path, result; never file contents).
- A background program (NLC Node Host) and a small launcher. The window the user sees is a page served only on 127.0.0.1.

## Where it installs

- Mac: ~/Library/Application Support/NLC Node/app/NLC Node.app; ~/Library/Application Support/NLC Node (its own settings and state); ~/Library/LaunchAgents/com.nlc.node.plist (start at login).
- Windows: %LOCALAPPDATA%\Programs\NLC Node (NLC Node.exe, NLC Node Host.exe); %LOCALAPPDATA%\NLC Node (its own settings and state); HKCU\Software\Microsoft\Windows\CurrentVersion\Run, value "NLC Node" (start at login).

It needs no administrator rights, no sudo and no password.

## Network

| Host | When | Why |
| --- | --- | --- |
| <the customer's own NLC address> | installing, updating, and always while connected | Download the installer and the program; keep the live connection to the customer's own NLC; pair using the connection link. |
| 127.0.0.1 | always | The NLC Node window and its health answer. Not reachable from other computers. |
| huggingface.co | only the first time the user asks for captions from audio | Downloads one speech model file (about 148 MB), checked against a fixed SHA-256 before use. Nothing is uploaded. |
| (none) | video tools (ffmpeg) | ffmpeg runs on the computer and makes no network calls. |

It contacts nothing else.
