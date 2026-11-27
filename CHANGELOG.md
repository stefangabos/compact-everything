## version 1.3 (November 27, 2026)

- an update of the add-on that arrives during a run waits until the run is over
- disabling or updating the add-on right after starting a run no longer leaves the run going unseen
- local mail stores are rewritten one at a time, so compacting needs less free disk space at once
- an account is skipped after 3 failures in a row, for example when its server cannot be reached
- folder sizes are read without blocking Thunderbird, local folders with nothing to compact are skipped, and a recent scan is reused when a run starts
- a scan that fails shows the error and a "try again" button
- the list of folders that could not be compacted shows at most 50, plus a count of the rest
- updates are checked against a checksum of the release file

## version 1.2 (November 27, 2026)

- fixed negative numbers for the recovered space when running again with nothing left to compact
- after an update, an "updated to X.X" link next to the title shows what changed since the previous version
- added a settings page behind the gear icon, with an option to show only the icon on the toolbar button
- the toolbar button uses the colored icon

## version 1.1 (November 26, 2026)

- the add-on now updates itself from the GitHub repository, as it cannot be listed on addons.thunderbird.net for now
- new icon, an envelope being compacted
- removed the maximum supported Thunderbird version, which only addons.thunderbird.net required

## version 1.0 (November 24, 2026)

- initial release
