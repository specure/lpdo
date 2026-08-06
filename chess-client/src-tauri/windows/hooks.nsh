; Tauri NSIS installer hooks for LPDO (Windows).
;
; Works with the vendored custom template (installer.nsi, pinned to
; tauri-cli 2.11.4 — see TEMPLATE-NOTES.md), which adds a components page with
; one optional component: `SecServer` ("Background database server"). The
; template handles seamless upgrades (a newer version installs over the old
; one, /UPDATE-style: no reinstall prompt, no uninstaller run, data untouched);
; these hooks handle the LPDO-specific pieces:
;
;   - the WinSW system service (LPDOServer supervising `chess-db serve`),
;     registered only when the SecServer component is selected (#67)
;   - chess-db.exe on the system PATH (#67) — registry-based, no NSIS plugin
;   - keeping the %ProgramData%\LPDO database on upgrade, wiping it on a real
;     uninstall only if the user explicitly ticks "delete application data"
;
; The service is WinSW (LPDOServer.exe) supervising `chess-db serve`, data
; under %ProgramData%\LPDO. Mirrors the Linux lpdo-server package: keep data on
; uninstall (the DB is large/expensive to rebuild).
;
; NOTE (verify on Windows): the WinSW files land at $INSTDIR\windows\service\
; (Tauri resource staging) — adjust paths if the installed layout differs.

!include "LogicLib.nsh"
!include "Sections.nsh"
!include "WinMessages.nsh"

; System (per-machine) environment key — we install perMachine, so PATH edits
; go to HKLM and apply to all users.
!define LPDO_ENV_KEY "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"

!macro NSIS_HOOK_PREINSTALL
  ; On an upgrade, stop the running service before Tauri replaces the locked
  ; exes. On a fresh install LPDOServer.exe isn't extracted yet → silent no-op.
  ;
  ; Stop must WAIT, not fire-and-forget: with seamless upgrades the installer
  ; copies over the live files moments later, and `chess-db serve` shuts down
  ; gracefully (a DuckDB checkpoint of a multi-GB database takes seconds,
  ; especially on Windows) — losing that race yields "Error opening file for
  ; writing". `net stop` blocks until the SCM reports stopped; then poll the
  ; service exe for writability (the definitive unlock signal) up to ~60s.
  nsExec::Exec 'sc query LPDOServer'
  Pop $1
  ${If} $1 == 0
    nsExec::ExecToLog 'net stop LPDOServer'
    StrCpy $2 0
    ${Do}
      ClearErrors
      FileOpen $3 "$INSTDIR\windows\service\LPDOServer.exe" a
      ${IfNot} ${Errors}
        FileClose $3
        ${Break}
      ${EndIf}
      Sleep 1000
      IntOp $2 $2 + 1
    ${LoopUntil} $2 >= 60
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 1. chess-db.exe on the system PATH (#67) — only when the "Command-line
  ;    tools" component is selected. Append $INSTDIR if not present.
  ;    Registry-based (WriteRegExpandStr + settings-change broadcast): Tauri's
  ;    NSIS bundles no EnVar plugin, and this avoids vendoring binary DLLs.
  ;    SAFETY: if the PATH value exceeds NSIS's string limit, ReadRegStr sets
  ;    the error flag and returns "" — writing back would then WIPE the system
  ;    PATH, so skip the edit entirely in that case (chess-db just won't be on
  ;    PATH; everything else works).
  SectionGetFlags ${SecCli} $1
  IntOp $1 $1 & ${SF_SELECTED}
  ${If} $1 <> 0
    ClearErrors
    ReadRegStr $0 HKLM "${LPDO_ENV_KEY}" "Path"
    ${If} ${Errors}
    ${OrIf} $0 == ""
      DetailPrint "PATH not modified (value unreadable or too long for NSIS)."
    ${Else}
      ${StrLoc} $1 $0 "$INSTDIR" ">"
      ${If} $1 == ""
        WriteRegExpandStr HKLM "${LPDO_ENV_KEY}" "Path" "$0;$INSTDIR"
        SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; 2. The background database server — only when its component is selected.
  SectionGetFlags ${SecServer} $1
  IntOp $1 $1 & ${SF_SELECTED}
  ${If} $1 <> 0
    ; Create the system data dir for the service.
    ExpandEnvStrings $0 "%ProgramData%"
    CreateDirectory "$0\LPDO"
    CreateDirectory "$0\LPDO\logs"

    ; (Re)register and start the LPDOServer system service via WinSW. Only
    ; stop+uninstall a *pre-existing* service (clean upgrade); skip on a fresh
    ; install so WinSW doesn't log a FATAL for a service that isn't there yet.
    nsExec::Exec 'sc query LPDOServer'
    Pop $1
    ${If} $1 == 0
      nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" stop'
      nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" uninstall'
    ${EndIf}
    nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" install'
    nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" start'
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop + remove the service if present (regardless of components: a service
  ; from any earlier install must not survive its files being removed).
  nsExec::Exec 'sc query LPDOServer'
  Pop $1
  ${If} $1 == 0
    nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" stop'
    nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" uninstall'
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Skip everything during an update-mode uninstall (belt-and-braces: the
  ; seamless-upgrade path never runs the uninstaller at all, but if one is ever
  ; invoked with /UPDATE, it must neither strip PATH nor touch the database).
  ${If} $UpdateMode <> 1
    ; Remove $INSTDIR from the system PATH (drop the ";$INSTDIR" we appended).
    ; Same SAFETY guard as the install side: never write back an unreadable /
    ; truncated value — that would wipe the system PATH.
    ClearErrors
    ReadRegStr $0 HKLM "${LPDO_ENV_KEY}" "Path"
    ${If} ${Errors}
    ${OrIf} $0 == ""
      DetailPrint "PATH not modified (value unreadable or too long for NSIS)."
    ${Else}
      ${un.WordReplace} $0 ";$INSTDIR" "" "+" $0
      WriteRegExpandStr HKLM "${LPDO_ENV_KEY}" "Path" "$0"
      SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}

    ; Make Tauri's "delete application data" checkbox honest: it only clears
    ; the GUI's per-user data, so when it's ticked, also remove the system
    ; database at %ProgramData%\LPDO. Unticked (default) keeps it (large /
    ; costly to rebuild).
    ${If} $DeleteAppDataCheckboxState == ${BST_CHECKED}
      ExpandEnvStrings $0 "%ProgramData%"
      RMDir /r "$0\LPDO"
    ${EndIf}
  ${EndIf}
!macroend
