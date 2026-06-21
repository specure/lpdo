; Tauri NSIS installer hooks for LPDO (Windows).
;
; Iteration 1: every install also sets up the system server (WinSW service) and
; puts chess-db.exe on PATH. A Client/Server/Both *components page* (so the
; server is optional) is a follow-up that needs a custom NSIS template.
;
; The service is WinSW (LPDOServer.exe) supervising `chess-db serve`, data under
; %ProgramData%\LPDO. Mirrors the Linux lpdo-server package: keep data on
; uninstall (the DB is large/expensive to rebuild).
;
; NOTE (verify on Windows): the EnVar plugin ships with Tauri's NSIS; the WinSW
; files land at $INSTDIR\windows\service\ (Tauri resource staging) — adjust paths
; if the installed layout differs.

!macro NSIS_HOOK_PREINSTALL
  ; Stop the service before Tauri replaces files — a running exe is locked.
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" stop'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 1. Put chess-db.exe (next to the app exe) on the system PATH.
  EnVar::SetHKLM
  EnVar::AddValue "Path" "$INSTDIR"

  ; 2. Create the system data dir for the service.
  ExpandEnvStrings $0 "%ProgramData%"
  CreateDirectory "$0\LPDO"
  CreateDirectory "$0\LPDO\logs"

  ; 3. (Re)register and start the LPDOServer system service via WinSW.
  ;    stop+uninstall first so upgrades re-register cleanly.
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" stop'
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" uninstall'
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" install'
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" start'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop + remove the service; remove our PATH entry. Keep the data.
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" stop'
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" uninstall'
  EnVar::SetHKLM
  EnVar::DeleteValue "Path" "$INSTDIR"
  ; Deliberately keep %ProgramData%\LPDO (the database).
!macroend
