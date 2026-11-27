#!/bin/sh
# packages the add-on into compact-everything.xpi next to this script: the files of the extension folder that git
# tracks, as they are in the working tree, plus CHANGELOG.md, which the popup reads to show what changed after an update
set -e

cd "$(dirname "$0")"
rm -f compact-everything.xpi

untracked=$(git ls-files --others --exclude-standard extension)
if [ -n "$untracked" ]; then
    echo 'left out, not tracked by git:'
    echo "$untracked"
fi

cd extension
git ls-files . | while read -r file; do
    if [ -f "$file" ]; then
        echo "$file"
    fi
done | zip -X -q ../compact-everything.xpi -@
cd ..
zip -X -q -j compact-everything.xpi CHANGELOG.md
echo 'built compact-everything.xpi'
