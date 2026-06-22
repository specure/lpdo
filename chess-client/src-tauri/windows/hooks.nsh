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

!include "LogicLib.nsh"

!macro NSIS_HOOK_PREINSTALL
  ; On an upgrade, stop the running service before Tauri replaces the locked exe.
  ; On a fresh install LPDOServer.exe isn't extracted yet, so this is a silent
  ; no-op (nothing to stop).
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" stop'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 1. Create the system data dir for the service.
  ExpandEnvStrings $0 "%ProgramData%"
  CreateDirectory "$0\LPDO"
  CreateDirectory "$0\LPDO\logs"

  ; 2. (Re)register and start the LPDOServer system service via WinSW. Only
  ;    stop+uninstall a *pre-existing* service (clean upgrade); skip on a fresh
  ;    install so WinSW doesn't log a FATAL for a service that isn't there yet.
  nsExec::Exec 'sc query LPDOServer'
  Pop $1
  ${If} $1 == 0
    nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" stop'
    nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" uninstall'
  ${EndIf}
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" install'
  nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" start'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop + remove the service if present.
  nsExec::Exec 'sc query LPDOServer'
  Pop $1
  ${If} $1 == 0
    nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" stop'
    nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" uninstall'
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Make Tauri's "delete application data" checkbox honest: it only clears the
  ; GUI's per-user data, so when it's ticked, also remove the system database at
  ; %ProgramData%\LPDO. Unticked (default) keeps it (large / costly to rebuild).
  ; NOTE (verify on Windows): $DeleteAppDataCheckboxState is Tauri's uninstaller
  ; variable for that checkbox.
  ${If} $DeleteAppDataCheckboxState == ${BST_CHECKED}
    ExpandEnvStrings $0 "%ProgramData%"
    RMDir /r "$0\LPDO"
  ${EndIf}
!macroend
