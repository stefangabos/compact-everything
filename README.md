<img src="extension/icons/icon-128.png" alt="Compact Everything" width="64" align="right">

# Compact Everything

*a Thunderbird add-on that compacts every folder in every account in one go, shows the progress while it works, and tells you how much disk space came back*

[![License](https://img.shields.io/github/license/stefangabos/compact-everything.svg)](https://github.com/stefangabos/compact-everything/blob/master/LICENSE.md)

When you delete or move messages, Thunderbird does not remove them from disk right away, it only marks them as deleted. Compacting rewrites these folders without those messages and gives the space back. Thunderbird offers the compacting options but only for one folder or one account at a time, and shows the saved space in the status bar only for a very short time so you might miss it. With many accounts and folders that gets tedious, and the result is easy to miss.

**Compact Everything** adds a button to the toolbar - click it, see how much space is likely recoverable, compact everything with one more click, and get the real numbers at the end.

## Features

- compacts every folder of every account with one click: local folders, POP accounts, RSS feeds and the offline copies of IMAP folders
- shows an estimate of the recoverable space before you start
- shows live progress: folders done, space recovered so far, and the folders being worked on right now
- reports the real result, measured on disk: total space recovered, a breakdown by account, the folders that shrank the most, and any folder that could not be compacted, with the reason
- keeps working when the popup is closed, with the progress shown as a percentage on the toolbar button
- remembers the result of the last run

## screenshots

<p>
    <img src="docs/screenshots/ready.png" alt="before compacting" width="320">
    <img src="docs/screenshots/running.png" alt="while compacting" width="320">
    <img src="docs/screenshots/done.png" alt="after compacting" width="320">
</p>

## How it works

The add-on runs the same compact routine Thunderbird uses for its own "compact" command, one folder at a time per account and up to three accounts in parallel. The space recovered is measured on disk, from the size of each folder's mailbox file and `.msf` index before and after compacting.

The estimate shown before starting comes from Thunderbird's own count of bytes taken by deleted messages, capped at the size of each folder's mailbox file. IMAP folders that are not set for offline use keep no messages on disk, so they do not count towards the estimate.

Compacting an IMAP folder also expunges it on the server, which permanently removes messages marked as deleted. This is the same as Thunderbird's own compact command.

Thunderbird's extension API has no way to compact folders, so the add-on uses an [experiment API](https://developer.thunderbird.net/add-ons/mailextensions/experiments) for that part. its code is in [`extension/api/compactor`](extension/api/compactor).

## Requirements

Thunderbird 128 to 160.

## Installation

Download the `.xpi` file from the [releases page](https://github.com/stefangabos/compact-everything/releases) and, in Thunderbird, go to *Add-ons and Themes*, click the gear icon and choose *Install Add-on From File*.

## Building

```bash
./build.sh
```

packages the `extension` folder into `compact-everything.xpi`.

## Privacy

The add-on does not collect, send or share any data. It reads folder information and file sizes on your computer, and keeps the result of the last run in the add-on's local storage.

## License

[MIT](LICENSE.md)
