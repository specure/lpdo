# NSIS template notes — vendored from tauri-cli-v2.11.4

Source: github.com/tauri-apps/tauri, tag `tauri-cli-v2.11.4` (commit 8909f221d1515955fc843808032bdc5d62209c96),
path `crates/tauri-bundler/src/bundle/windows/nsis/`. Matches `@tauri-apps/cli@2.11.4` (npm) — same
commit is tagged `@tauri-apps/cli-v2.11.4`.

Vendored files (byte-identical to upstream at that tag):

- `installer.nsi` (32007 bytes) — main template, Handlebars-processed by tauri-bundler at build time.
- `utils.nsh` (6163 bytes) — `SetContext`, `CheckIfAppIsRunning`, shortcut/AppUserModelId helpers. Included at installer.nsi:26.
- `FileAssociation.nsh` (5379 bytes) — `APP_ASSOCIATE`/`APP_UNASSOCIATE` macros. Included at installer.nsi:27.

To activate the vendored template, `bundle.windows.nsis.template` in `tauri.windows.conf.json` must be
pointed at `windows/installer.nsi` (NOT done yet — this vendoring is groundwork only).

## Includes: template-relative vs NSIS-stock

Template-relative (must be vendored alongside installer.nsi; bundler compiles with the template's dir
on the include path):

- line 26: `!include "utils.nsh"`
- line 27: `!include "FileAssociation.nsh"`

NSIS-stock (ship with the NSIS distribution, do NOT vendor):

- line 22: `MUI2.nsh`
- line 23: `FileFunc.nsh`
- line 24: `x64.nsh`
- line 25: `WordFunc.nsh`
- line 28: `Win\COM.nsh`
- line 29: `Win\Propkey.nsh`
- line 30: `StrFunc.nsh`
- line 127: `MultiUser.nsh` (only compiled when INSTALLMODE == "both")

Handlebars-generated includes (bundler-provided paths, not files in this dir):

- lines 34–36: `{{#if installer_hooks}} !include "{{installer_hooks}}" {{/if}}` — this is how our
  `windows/hooks.nsh` gets pulled in (`installerHooks` in tauri.windows.conf.json).
- lines 473–475: `{{#each language_files}} !include "{{this}}" {{/each}}` — bundler-extracted
  language .nsh files.

Plugin dirs: line 19 `!addplugindir "{{signed_plugins_path}}"` (inside `{{#if signed_plugins_path}}`,
lines 18–20) and line 97 `!addplugindir "${ADDITIONALPLUGINSPATH}"`. The template already relies on the
`nsis_tauri_utils` plugin (lines 233, 420, 751; utils.nsh lines 26–36), which the bundler downloads
into the additional-plugins path.

## 1. Previous-version detection, PageReinstall / PageLeaveReinstall, old-uninstaller invocation

- Line 186: `Var ReinstallPageCheck`; line 187: `Page custom PageReinstall PageLeaveReinstall`.
- Lines 188–301: `Function PageReinstall`.
  - Lines 200–215: WiX (old MSI) detection loop over `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`.
  - Lines 217–220: NSIS previous-install detection — `ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""` and
    `ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"`; aborts (skips page) if both empty.
    `UNINSTKEY` is defined at line 66 as `Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}`.
    Note it reads via SHCTX, not a hard-coded hive — see MultiUser section below.
  - Lines 227/229: previous `DisplayVersion` read; line 233: `nsis_tauri_utils::SemverCompare "${VERSION}" $R0`
    → $R0 = 0 same / 1 upgrading / -1 downgrading (lines 236–259 set the page texts accordingly).
- Lines 302–309: `PageReinstallUpdateSelection` (radio state → $ReinstallPageCheck).
- Lines 310–385: `Function PageLeaveReinstall`.
  - Line 314–316: WixMode always uninstalls; lines 319–321: `$UpdateMode = 1` (updater `/UPDATE` flag)
    skips uninstall entirely and proceeds.
  - Lines 347–361: `reinst_uninstall:` — the old uninstaller invocation:
    - WiX branch (lines 351–353): `ReadRegStr $R1 HKLM "$R6" "UninstallString"` then `ExecWait '$R1' $0`.
    - NSIS branch (lines 354–361): reads previous $INSTDIR from `SHCTX "${MANUPRODUCTKEY}" ""` into $4
      (line 355), reads `UninstallString` from `SHCTX "${UNINSTKEY}"` into $R1 (line 356), then:
      - line 357: appends ` /UPDATE` if $UpdateMode = 1
      - line 358: appends ` /P` if $PassiveMode = 1
      - line 359: appends ` _?=$4` (runs the uninstaller in-process from the old install dir so
        ExecWait actually waits and an exit code is returned)
      - line 360: `ExecWait '$R1' $0`
    - **`/S` (silent) is NEVER passed** — only `/UPDATE` and `/P`. In interactive GUI upgrades neither
      is set, so the full old-uninstaller GUI (including its confirm page + Delete-app-data checkbox)
      is shown to the user. The registry uninstall string lives in $R1 (NOT $R0; $R0 holds the
      SemverCompare result at this point).
  - Lines 365–383: error handling — nonzero exit code or main exe still on disk → MessageBox + Abort
    back to the reinstall page (exit code 1 = user cancelled NSIS uninstaller, 1602 = cancelled MSI).

## 2. Uninstaller "Delete application data" checkbox

- Line 425: `Var DeleteAppDataCheckbox`; line 426: `Var DeleteAppDataCheckboxState`.
- Lines 428–457: `Function un.ConfirmShow` (hooked via `MUI_PAGE_CUSTOMFUNCTION_SHOW`, line 428) —
  creates the checkbox with a raw `user32::CreateWindowEx` call (line 453) on the MUI_UNPAGE_CONFIRM
  page (inserted at line 463), DPI-scaled, label `$(deleteAppData)`.
- Lines 458–461: `Function un.ConfirmLeave` — `BM_GETCHECK` → `$DeleteAppDataCheckboxState` (line 460).
- Consumption: lines 870–884 in `Section Uninstall` — `${If} $DeleteAppDataCheckboxState = 1`
  `${AndIf} $UpdateMode <> 1` then deletes `${MANUPRODUCTKEY}` install-location key, installer-language
  values, and `RmDir /r "$APPDATA\${BUNDLEID}"` + `RmDir /r "$LOCALAPPDATA\${BUNDLEID}"` (lines 882–883,
  after `SetShellVarContext current` at line 881). Note: silent/passive uninstall never shows the page,
  so the state stays 0 and app data is preserved.

## 3. Install Sections and NSIS_HOOK_* injection points

Sections (all unnamed/hidden — no Components page exists in the template; NSIS shows a components
page only if `!insertmacro MUI_PAGE_COMPONENTS` is added among the pages, lines 167–417):

- Line 527–544: `Section EarlyChecks` (silent-downgrade abort).
- Line 546–636: `Section WebView2` (runtime detection/bootstrap; skipped when $UpdateMode).
- Line 638–741: `Section Install` — the single monolithic payload section:
  - line 648: main exe `File "${MAINBINARYSRCPATH}"`
  - lines 651–656: resources ({{#each resources_dirs}} / {{#each resources}}) — this is where our
    `windows/service/LPDOServer.exe|.xml` land
  - lines 659–661: external binaries ({{#each binaries}}) — this is where `chess-db.exe` lands
  - lines 679–719: uninstaller + Add/Remove Programs registry
- Line 776–895: `Section Uninstall`.

For a Client / Server / Both components page: add `!insertmacro MUI_PAGE_COMPONENTS` (with a
`SkipIfPassive` pre-function) between the reinstall page (line 385) and MUI_PAGE_DIRECTORY (line 389),
and split/flag work out of `Section Install` (lines 638–741) into named optional sections (e.g.
`Section "Server" SecServer`). Beware: resources/binaries File lines are Handlebars-generated, so a
split must key off the generated file names.

Hook injection (these consume the macros from our `hooks.nsh`, included via lines 34–36):

- Lines 641–643: `NSIS_HOOK_PREINSTALL` (top of Section Install, right after `SetOutPath $INSTDIR`).
- Lines 733–735: `NSIS_HOOK_POSTINSTALL` (end of Section Install, before passive autoclose).
- Lines 778–780: `NSIS_HOOK_PREUNINSTALL` (top of Section Uninstall).
- Lines 886–888: `NSIS_HOOK_POSTUNINSTALL` (end of Section Uninstall).

All four are `!ifmacrodef`-guarded, so hooks.nsh keeps working unchanged with the vendored template.

## 4. PATH manipulation / env-var plugin

The template contains NO PATH or environment-variable handling and references no env plugin
(no EnVar, no `WriteRegExpandStr ...Environment...`, no SendMessage WM_SETTINGCHANGE). Plan:

- Vendor `EnVar.dll` (x86-unicode build) and add `!addplugindir` for it near line 97 (a second
  `!addplugindir` alongside `${ADDITIONALPLUGINSPATH}` is fine), or drop the DLL into a dir we pass
  via `additional_plugins_path`. EnVar targets HKLM automatically when `EnVar::SetHKLM` is called —
  required since our installMode is perMachine.
- Add `EnVar::AddValue "PATH" "$INSTDIR"` in the POSTINSTALL area (around line 733) or in
  `NSIS_HOOK_POSTINSTALL` in hooks.nsh (preferred — keeps the template diff minimal), and
  `EnVar::DeleteValue "PATH" "$INSTDIR"` in PREUNINSTALL/POSTUNINSTALL (guard with `$UpdateMode <> 1`
  like lines 823/864 do for shortcuts/autostart).

## 5. Handlebars placeholders that MUST be preserved

The bundler renders this file with Handlebars before compiling; every `{{...}}` must survive edits.
Simple value placeholders (all consumed in lines 9–71 `!define` block unless noted):

`{{compression}}` (9,13), `{{signed_plugins_path}}` (18–20, with `{{#if}}`), `{{installer_hooks}}`
(34–36, with `{{#if}}`), `{{manufacturer}}`, `{{product_name}}`, `{{version}}`,
`{{version_with_build}}`, `{{homepage}}`, `{{install_mode}}`, `{{license}}`, `{{installer_icon}}`,
`{{sidebar_image}}`, `{{header_image}}`, `{{uninstaller_icon}}`, `{{uninstaller_header_image}}`,
`{{main_binary_name}}`, `{{main_binary_path}}`, `{{bundle_id}}`, `{{copyright}}`, `{{out_file}}`,
`{{arch}}`, `{{additional_plugins_path}}`, `{{allow_downgrades}}`, `{{display_language_selector}}`,
`{{install_webview2_mode}}`, `{{webview2_installer_args}}`, `{{webview2_bootstrapper_path}}`,
`{{webview2_installer_path}}`, `{{minimum_webview2_version}}`, `{{uninstaller_sign_cmd}}`,
`{{estimated_size}}`, `{{start_menu_folder}}`.

Block helpers (structure must be preserved exactly, including `~` whitespace control and the custom
`no-escape`, `or`, `association-description` helpers registered by tauri-bundler):

- lines 469–471: `{{#each languages}}` → MUI_LANGUAGE
- lines 473–475: `{{#each language_files}}` → !include
- lines 651–653: `{{#each resources_dirs}}` (install)
- lines 654–656: `{{#each resources}}` with `{{this.[1]}}` / `{{no-escape @key}}` (install)
- lines 659–661: `{{#each binaries}}` with `{{no-escape @key}}` (install)
- lines 664–668: `{{#each file_associations}}` / nested `{{#each association.ext}}` (install)
- lines 671–676: `{{#each deep_link_protocols}}` (install)
- lines 789–791: `{{#each resources}}` (uninstall deletes)
- lines 794–796: `{{#each binaries}}` (uninstall deletes)
- lines 799–803: `{{#each file_associations}}` (uninstall)
- lines 806–811: `{{#each deep_link_protocols}}` (uninstall)
- lines 817–819: `{{#each resources_ancestors}}` (uninstall RMDir)

Also `utils.nsh` line 26–30 contains literal `{{product_name}}` strings used by
`nsis_tauri_utils::StrReplace` at runtime — those are NOT Handlebars (the .nsh files are not
template-rendered; only installer.nsi is). Keep them verbatim.

## 6. installMode / MultiUser mechanics and the registry hive

`INSTALLMODE` is `!define`d from `{{install_mode}}` at line 45 and branches at NSIS **compile time**:

- Lines 105–107: `perMachine` → `RequestExecutionLevel admin`.
- Lines 109–111: `currentUser` → `RequestExecutionLevel user`.
- Lines 113–128: `both` → full MultiUser.nsh setup (MULTIUSER_INSTALLMODE_COMMANDLINE,
  DEFAULT_REGISTRY_KEY = UNINSTKEY, EXECUTIONLEVEL Highest) + `!include MultiUser.nsh` (line 127),
  `MULTIUSER_PAGE_INSTALLMODE` page at lines 179–182, `MULTIUSER_INIT` at line 522,
  `MULTIUSER_UNINIT` at line 760, mode persisted at lines 684–688.
- Hive selection: all install/uninstall registry access uses `SHCTX`, which resolves per
  `SetShellVarContext` — set by the `SetContext` macro (utils.nsh lines 3–19, invoked at
  installer.nsi lines 497 and 757): `currentUser` → `SetShellVarContext current` → SHCTX = HKCU;
  `perMachine` → `SetShellVarContext all` → SHCTX = HKLM; `both` → MultiUser.nsh sets it from the
  user's page choice / persisted value. `SetContext` also sets `SetRegView 64` for x64/arm64.
- Default $INSTDIR: lines 499–518 (`perMachine` → $PROGRAMFILES64/$PROGRAMFILES, `currentUser` →
  $LOCALAPPDATA), overridden by `RestorePreviousInstallLocation` (lines 897–901) which reads the
  previous dir from `SHCTX "${MANUPRODUCTKEY}"`.
- Uninstall registry cleanup is the one place with hard-coded hives: lines 852–858 delete UNINSTKEY
  from HKLM for `perMachine`, HKCU otherwise, SHCTX for `both`.

Implication of currentUser → perMachine switch: reinstall detection (lines 218–219, 229, 355–356)
reads SHCTX, which becomes HKLM. A previous currentUser install registered under HKCU would then be
**invisible** to PageReinstall — no upgrade-uninstall would run and the old HKCU entry + old
$LOCALAPPDATA install would be orphaned. **Our build already uses `"installMode": "perMachine"`**
(`tauri.windows.conf.json` line 11), so SHCTX = HKLM today and detection is consistent; but any
migration logic for old per-user installs would need an explicit HKCU probe added near lines 217–220.
