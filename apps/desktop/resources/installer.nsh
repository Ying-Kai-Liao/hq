; Removing Codync takes its background host with it (the sign-in entry and the running host).
; An update reinstalls over the old version, and the new app starts the host again itself.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\resources\codync-host.exe" uninstall'
  ${endIf}
!macroend
