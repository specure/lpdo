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
; Firewall rule name for LAN mode (#247) — also used to remove it again.
!define LPDO_FW_RULE "LPDO database server"
!define LPDO_PORT "7777"
; Remembers whether LAN mode is on, so a seamless upgrade (which SKIPS the
; components page, leaving SecLan unticked) doesn't silently close the server
; that the user deliberately opened.
!define LPDO_STATE_KEY "Software\LPDO"

; Poll LPDOServer.exe for writability — the definitive "the process is really
; gone" signal — for up to 30s. Pushes 1 when it unlocked (or was never there),
; 0 on timeout. Defined at file scope, NOT inside a hook macro: those macro
; bodies are expanded inside the install Section, where NSIS rejects a Function
; definition. This file is !include-d before any section, so the hooks below can
; call it.
Function WaitForServiceExeUnlock
  Push $2
  Push $3
  StrCpy $2 0
  ${Do}
    ClearErrors
    FileOpen $3 "$INSTDIR\windows\service\LPDOServer.exe" a
    ${IfNot} ${Errors}
      FileClose $3
      Pop $3
      Pop $2
      Push 1
      Return
    ${EndIf}
    Sleep 1000
    IntOp $2 $2 + 1
  ${LoopUntil} $2 >= 30
  Pop $3
  Pop $2
  Push 0
FunctionEnd

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
  ;
  ; A graceful stop is not always possible: a service entry that is marked for
  ; deletion refuses control messages ("net stop" → error 2189) while its
  ; process keeps running and keeps LPDOServer.exe locked. The wait then burns
  ; its whole timeout and extraction fails anyway with "Error opening file for
  ; writing" (observed on a real upgrade). So escalate: ask nicely, wait, and
  ; only if the file is still locked kill the process tree — /T takes the
  ; chess-db child with it. Kill is the last resort, not the default: it
  ; interrupts a DuckDB checkpoint, leaving a WAL to replay on next open.
  nsExec::Exec 'sc query LPDOServer'
  Pop $1
  ${If} $1 == 0
    nsExec::ExecToLog 'net stop LPDOServer'
    Call WaitForServiceExeUnlock
    Pop $4
    ${If} $4 == 0
      DetailPrint "The LPDO service did not release its files; stopping it forcefully."
      nsExec::ExecToLog 'taskkill /F /IM LPDOServer.exe /T'
      nsExec::ExecToLog 'taskkill /F /IM chess-db.exe /T'
      Call WaitForServiceExeUnlock
      Pop $4
      ${If} $4 == 0
        DetailPrint "LPDOServer.exe is still locked. If this install fails to replace it, reboot and run the installer again."
      ${EndIf}
    ${EndIf}
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

    ; LAN mode (#247): swap in the service descriptor that sets
    ; LPDO_BIND=0.0.0.0 (copying a shipped variant beats rewriting XML from
    ; NSIS), and allow the port through the firewall on PRIVATE networks only —
    ; a LAN bind is silently unreachable otherwise. Both are undone below when
    ; the component is not selected, so unticking it on a later upgrade really
    ; does close the server again.
    SectionGetFlags ${SecLan} $2
    IntOp $2 $2 & ${SF_SELECTED}
    ; On a seamless upgrade the user never saw the components page, so an
    ; unticked SecLan means "unknown", not "off" — carry the previous choice.
    ${If} $2 = 0
    ${AndIf} $UpdateMode = 1
      ReadRegStr $3 HKLM "${LPDO_STATE_KEY}" "LanMode"
      ${If} $3 == "1"
        StrCpy $2 1
      ${EndIf}
    ${EndIf}

    nsExec::Exec 'netsh advfirewall firewall delete rule name="${LPDO_FW_RULE}"'
    Pop $3
    ${If} $2 <> 0
      ; Replace the loopback descriptor with the LAN one. Delete+Rename, not
      ; CopyFiles: CopyFiles wraps SHFileOperation and expects directory
      ; targets, so it is unreliable for a single file. Both files are
      ; re-extracted by the next upgrade, so consuming the variant is fine.
      Delete "$INSTDIR\windows\service\LPDOServer.xml"
      Rename "$INSTDIR\windows\service\LPDOServer-lan.xml" "$INSTDIR\windows\service\LPDOServer.xml"
      nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${LPDO_FW_RULE}" dir=in action=allow protocol=TCP localport=${LPDO_PORT} profile=private'
      WriteRegStr HKLM "${LPDO_STATE_KEY}" "LanMode" "1"
      DetailPrint "LAN mode: the server listens on all interfaces and requires the access token from %ProgramData%\LPDO\access-token."
    ${Else}
      WriteRegStr HKLM "${LPDO_STATE_KEY}" "LanMode" "0"
    ${EndIf}

    ; (Re)register and start the LPDOServer system service via WinSW. Only
    ; stop+uninstall a *pre-existing* service (clean upgrade); skip on a fresh
    ; install so WinSW doesn't log a FATAL for a service that isn't there yet.
    nsExec::Exec 'sc query LPDOServer'
    Pop $1
    ${If} $1 == 0
      nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" stop'
      nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" uninstall'
      ; Wait until the SCM has really forgotten the service. A delete that can't
      ; complete (any open handle — services.msc, Task Manager's Services tab, a
      ; process still exiting) leaves the entry "marked for deletion": it keeps
      ; its old config, CreateService then fails with 1072, and even
      ; `sc config` is refused. `install` would silently fail and the following
      ; `start` would revive the STALE entry — which then runs the new binaries,
      ; so everything looks healthy while the entry is still queued for removal
      ; and its start type is stuck at Disabled. After the next reboot the
      ; deletion completes and the service is simply gone. Observed on a real
      ; upgrade over a crash-looping service.
      StrCpy $2 0
      ${Do}
        nsExec::Exec 'sc query LPDOServer'
        Pop $3
        ${If} $3 <> 0
          ${Break}                  ; 1060 "does not exist" — really gone
        ${EndIf}
        Sleep 1000
        IntOp $2 $2 + 1
      ${LoopUntil} $2 >= 30
      ${If} $2 >= 30
        DetailPrint "The old LPDO service is still queued for removal (something holds a handle to it). Reboot and re-run this installer to finish registering the server."
      ${EndIf}
    ${EndIf}
    nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" install'
    ; Belt and braces: assert the start type on the freshly created service, so
    ; an upgrade can never leave the server out of the boot sequence.
    nsExec::ExecToLog 'sc config LPDOServer start= auto'
    nsExec::ExecToLog '"$INSTDIR\windows\service\LPDOServer.exe" start'
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Drop the LAN firewall rule (no-op when it was never added).
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${LPDO_FW_RULE}"'
  Pop $1

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

    DeleteRegKey HKLM "${LPDO_STATE_KEY}"

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
