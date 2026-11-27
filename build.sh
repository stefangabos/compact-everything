#!/bin/sh
# packages the extension folder into compact-everything.xpi next to this script
set -e

cd "$(dirname "$0")"
rm -f compact-everything.xpi
cd extension
zip -r -X -q ../compact-everything.xpi . -x '.*' -x '*/.*'
cd ..
# the popup reads CHANGELOG.md to show what changed after an update
zip -X -q -j compact-everything.xpi CHANGELOG.md
echo 'built compact-everything.xpi'
