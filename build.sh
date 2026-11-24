#!/bin/sh
# packages the extension folder into compact-everything.xpi next to this script
set -e

cd "$(dirname "$0")"
rm -f compact-everything.xpi
cd extension
zip -r -X -q ../compact-everything.xpi . -x '.*' -x '*/.*'
cd ..
echo 'built compact-everything.xpi'
