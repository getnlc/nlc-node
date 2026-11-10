Unicode true
; Per-user install: no administrator rights and no UAC prompt. Everything lives under the current user's profile and HKCU.
RequestExecutionLevel user
Name "NLC Node"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\NLC Node"
ShowInstDetails show
ShowUnInstDetails show

!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NLC Node"

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install NLC Node"
  IfFileExists "$INSTDIR\NLC Node Host.exe" 0 install_files
  ; $PLUGINSDIR does not exist until it is initialised; without this the helper is extracted somewhere else and cannot be run.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=NLC Node Update Helper.exe" "${HOST}"
  nsExec::ExecToStack '"$PLUGINSDIR\NLC Node Update Helper.exe" --stop'
  Pop $0
  Pop $1
  StrCmp $0 "0" update_ready
  MessageBox MB_ICONSTOP|MB_OK "NLC Node could not stop safely for this update. Close NLC Node and retry installation." /SD IDOK
  Abort
  update_ready:
  Delete "$PLUGINSDIR\NLC Node Update Helper.exe"
  ; The tray part of the old version is the launcher itself; it must be gone before the file is replaced.
  nsExec::ExecToStack 'taskkill /F /IM "NLC Node.exe"'
  Pop $0
  Pop $1
  Goto install_files
  install_files:
  ; Old test builds registered a scheduled task; remove it so only the Run entry starts the Node at login.
  nsExec::ExecToStack 'schtasks.exe /Delete /TN "NLC Node Central Connector" /F'
  Pop $0
  Pop $1
  SetOutPath "$INSTDIR"
  Delete "$INSTDIR\install.complete"
  File "/oname=NLC Node.exe" "${LAUNCHER}"
  File "/oname=NLC Node Host.exe" "${HOST}"
  ; The video and captioning programs (and their notices), laid out where the Node looks for them. Present when built with /DTOOLS_DIR.
  !ifdef TOOLS_DIR
    File /r "${TOOLS_DIR}\*.*"
  !endif
  ; The setup zip from the customer's NLC carries origin.txt beside this program: keep it so the Node knows its server.
  IfFileExists "$EXEDIR\origin.txt" 0 origin_done
  CreateDirectory "$LOCALAPPDATA\NLC Node"
  CopyFiles /SILENT "$EXEDIR\origin.txt" "$LOCALAPPDATA\NLC Node\origin.txt"
  origin_done:
  WriteUninstaller "$INSTDIR\Uninstall NLC Node.exe"
  CreateDirectory "$SMPROGRAMS\NLC Node"
  CreateShortcut "$SMPROGRAMS\NLC Node\NLC Node.lnk" "$INSTDIR\NLC Node.exe"
  CreateShortcut "$SMPROGRAMS\NLC Node\NLC Node Diagnostics.lnk" "$INSTDIR\NLC Node.exe" "--diagnose"

  ; Launch at login for this user only.
  WriteRegStr HKCU "${RUN_KEY}" "NLC Node" '"$INSTDIR\NLC Node.exe" --background'

  ; Start again by itself if it ever stops: the Host registers its own per-user task (removed again on uninstall).
  nsExec::ExecToStack '"$INSTDIR\NLC Node Host.exe" --install-supervision'
  Pop $0
  Pop $1

  ; Settings > Apps entry for this user.
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "NLC Node"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "NLC"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall NLC Node.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  FileOpen $0 "$INSTDIR\install.complete" w
  FileWrite $0 "nlc-node.install/v1$\r$\n"
  FileClose $0
  IfSilent skip_launch
  ; First run: start the Node, show its tray icon and open its window.
  Exec '"$INSTDIR\NLC Node.exe"'
  skip_launch:
SectionEnd

Section "Uninstall"
  ; Only NLC Node's own files are removed. The customer's shared folders and the NLC Trash folder in their home folder are never touched.
  IfFileExists "$INSTDIR\NLC Node Host.exe" 0 state_cleanup
  ; The restart supervisor goes first, or it would start the Node again right after it is stopped.
  nsExec::ExecToStack '"$INSTDIR\NLC Node Host.exe" --remove-supervision'
  Pop $0
  Pop $1
  nsExec::ExecToStack '"$INSTDIR\NLC Node Host.exe" --stop'
  Pop $0
  Pop $1
  StrCmp $0 "0" host_stopped
  MessageBox MB_ICONSTOP|MB_OK "NLC Node could not stop safely. Close NLC Node and retry uninstall." /SD IDOK
  Abort
  host_stopped:
  nsExec::ExecToStack 'taskkill /F /IM "NLC Node.exe"'
  Pop $0
  Pop $1
  state_cleanup:
  nsExec::ExecToStack 'schtasks.exe /Delete /TN "NLC Node" /F'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'schtasks.exe /Delete /TN "NLC Node Central Connector" /F'
  Pop $0
  Pop $1
  DeleteRegValue HKCU "${RUN_KEY}" "NLC Node"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  Delete "$LOCALAPPDATA\NLC Node\ready.json"
  Delete "$LOCALAPPDATA\NLC Node\instance.lock"
  Delete "$LOCALAPPDATA\NLC Node\stop.request"
  Delete "$LOCALAPPDATA\NLC Node\token"
  Delete "$LOCALAPPDATA\NLC Node\NLC-Node-Diagnostics.json"
  RMDir /r "$LOCALAPPDATA\NLC Node"
  Delete "$SMPROGRAMS\NLC Node\NLC Node.lnk"
  Delete "$SMPROGRAMS\NLC Node\NLC Node Diagnostics.lnk"
  RMDir "$SMPROGRAMS\NLC Node"
  Delete "$DESKTOP\NLC Node.lnk"
  Delete "$INSTDIR\NLC Node.exe"
  Delete "$INSTDIR\NLC Node Host.exe"
  Delete "$INSTDIR\install.complete"
  Delete "$INSTDIR\Uninstall NLC Node.exe"
  RMDir /r "$INSTDIR\ffmpeg"
  RMDir /r "$INSTDIR\whisper"
  Delete "$INSTDIR\NOTICE-*.txt"
  Delete "$INSTDIR\LICENSE-*.txt"
  RMDir "$INSTDIR"
SectionEnd
