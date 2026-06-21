; Tauri NSIS installer hooks for LPDO (Windows).
;
; Iteration 1: every install sets up the system server (WinSW service). A
; Client/Server/Both *components page* (so the server is optional) and putting
; chess-db.exe on PATH are follow-ups — the latter needs the EnVar plugin, which
; Tauri's NSIS does NOT bundle (confirmed by a CI dry-run), so it'll come with the
; custom template in iteration 2 (vendor EnVar via !addplugindir).
;
; The service is WinSW (LPDOServer.exe) supervising `chess-db serve`, data under
; %ProgramData%\LPDO. Mirrors the Linux lpdo-server package: keep data on
; uninstall (the DB is large/expensive to rebuild).
;
; NOTE (verify on Windows): the WinSW files land at $INSTDIR\windows\service\
; (Tauri resource staging) — adjust paths if the installed layout differs.

!macro NSIS_HOOK_PREINSTALL
  ; Stop the service before Tauri replaces files — a running exe is locked.
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" stop'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 1. Create the system data dir for the service.
  ExpandEnvStrings $0 "%ProgramData%"
  CreateDirectory "$0\LPDO"
  CreateDirectory "$0\LPDO\logs"

  ; 2. (Re)register and start the LPDOServer system service via WinSW.
  ;    stop+uninstall first so upgrades re-register cleanly.
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" stop'
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" uninstall'
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" install'
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" start'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop + remove the service. Keep the data (%ProgramData%\LPDO).
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" stop'
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" uninstall'
!macroend
