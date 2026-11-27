'use strict';

const element = id => document.getElementById(id);

const views = {
    scanning: element('view_scanning'),
    ready: element('view_ready'),
    running: element('view_running'),
    done: element('view_done'),
    changelog: element('view_changelog'),
    settings: element('view_settings'),
};

const homepage_url = 'https://github.com/stefangabos/compact-everything';
const releases_url = homepage_url + '/releases';
const default_settings = { show_label: true };

let last_result = null;
let last_state = null;
let update_notice = null;
let settings = { ...default_settings };
// settings and release notes open on top of the normal content; "back" closes the topmost one
const overlay_stack = [];

function format_bytes(bytes) {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    const negative = bytes < 0;
    let value = Math.abs(bytes || 0);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index++;
    }
    const digits = index === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
    return (negative ? '-' : '') + value.toFixed(digits) + ' ' + units[index];
}

function format_count(count, singular, plural) {
    return count.toLocaleString() + ' ' + (count === 1 ? singular : plural);
}

function format_duration(milliseconds) {
    const seconds = Math.max(1, Math.round(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours) {
        return hours + 'h ' + minutes + 'm';
    }
    if (minutes) {
        return minutes + 'm ' + rest + 's';
    }
    return rest + 's';
}

function format_date(timestamp) {
    return new Date(timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function show_view(name) {
    for (const [key, view] of Object.entries(views)) {
        view.hidden = key !== name;
    }
}

// fills a list with name / value rows, the value in a badge whose fill shows the row's share of the largest value
function fill_list(list, rows, with_share) {
    list.replaceChildren();
    const largest = rows.reduce((maximum, row) => Math.max(maximum, row.amount || 0), 0);
    for (const row of rows) {
        const item = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = row.name;
        const value = document.createElement('span');
        value.className = 'value';
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = row.value;
        if (with_share && largest > 0) {
            badge.style.setProperty('--share', Math.max(6, Math.round((row.amount / largest) * 100)) + '%');
        }
        value.append(badge);
        item.append(name, value);
        list.append(item);
    }
}

function render_summary(state) {
    const scan = state.scan;
    if (!scan) {
        element('summary').textContent = ' ';
        return;
    }
    // after a run the size on disk is the scanned size minus what the run recovered
    const recovered = state.phase === 'done' && state.result ? state.result.recovered_bytes : 0;
    element('summary').textContent =
        format_count(scan.account_count, 'account', 'accounts') + ', ' +
        format_count(scan.folder_count, 'folder', 'folders') + ', ' +
        format_bytes(scan.size_bytes - recovered) + ' on disk';
}

function render_ready(state) {
    element('ready_estimate').textContent = format_bytes(state.scan ? state.scan.recoverable_bytes : 0);
    element('start_button').disabled = !state.scan || state.scan.folder_count === 0;
    const last_run = element('last_run');
    if (last_result) {
        last_run.hidden = false;
        last_run.textContent =
            'last run ' + format_date(last_result.finished_at) + ': ' +
            format_bytes(last_result.recovered_bytes) + ' recovered' +
            (last_result.stopped ? ' (stopped early)' : '');
    } else {
        last_run.hidden = true;
    }
}

function render_running(state) {
    const progress = state.progress;
    const total = progress.total || 1;
    const percent = Math.floor((progress.done * 100) / total);
    element('running_recovered').textContent = format_bytes(progress.recovered_bytes);
    element('running_bar').style.width = percent + '%';
    element('running_count').textContent =
        progress.done.toLocaleString() + ' of ' + format_count(progress.total, 'folder', 'folders');
    element('running_percent').textContent = percent + '%';

    const current = element('running_current');
    current.replaceChildren();
    for (const entry of progress.current) {
        const item = document.createElement('li');
        item.textContent = entry.account_name + ' / ' + entry.folder_label;
        item.title = item.textContent;
        current.append(item);
    }

    const stop_button = element('stop_button');
    stop_button.disabled = state.phase === 'stopping';
    stop_button.textContent = state.phase === 'stopping' ? 'stopping after the current folders...' : 'stop';
}

function render_done(state) {
    const result = state.result;
    element('done_label').textContent = result.stopped ? 'recovered before stopping' : 'recovered';
    element('done_recovered').textContent = format_bytes(result.recovered_bytes);

    element('done_detail').textContent =
        format_count(result.folder_count, 'folder', 'folders') + ' processed in ' +
        format_duration(result.finished_at - result.started_at) + ', ' +
        (result.shrunk_count === 0
            ? 'nothing was left to compact.'
            : result.shrunk_count.toLocaleString() + ' got smaller.');

    element('done_accounts_block').hidden = result.accounts.length === 0;
    fill_list(
        element('done_accounts'),
        result.accounts.map(account => ({
            name: account.name,
            value: format_bytes(account.saved_bytes),
            amount: account.saved_bytes,
        })),
        true
    );

    element('done_folders_block').hidden = result.top_folders.length === 0;
    fill_list(
        element('done_folders'),
        result.top_folders.map(folder => ({
            name: folder.account_name + ' / ' + folder.folder_label,
            value: format_bytes(folder.saved_bytes),
            amount: folder.saved_bytes,
        })),
        true
    );

    element('done_failed_block').hidden = result.failed.length === 0;
    element('done_failed_summary').textContent =
        format_count(result.failed.length, 'folder', 'folders') + ' could not be compacted';
    fill_list(
        element('done_failed'),
        result.failed.map(folder => ({
            name: folder.account_name + ' / ' + folder.folder_label,
            value: folder.reason,
        })),
        false
    );
}

function render(state) {
    last_state = state;
    render_summary(state);
    // settings and release notes stay on screen while runs report progress, until "back" is pressed
    if (overlay_stack.length) {
        return;
    }
    if (state.phase === 'running' || state.phase === 'stopping') {
        render_running(state);
        show_view('running');
    } else if (state.phase === 'done' && state.result) {
        render_done(state);
        show_view('done');
    } else if (state.phase !== 'scanning' && state.scan) {
        render_ready(state);
        show_view('ready');
    } else {
        show_view('scanning');
    }
}

function compare_versions(first, second) {
    const first_parts = String(first).split('.').map(Number);
    const second_parts = String(second).split('.').map(Number);
    for (let index = 0; index < Math.max(first_parts.length, second_parts.length); index++) {
        const difference = (first_parts[index] || 0) - (second_parts[index] || 0);
        if (difference) {
            return difference;
        }
    }
    return 0;
}

// reads CHANGELOG.md, which build.sh packs into the add-on, into a list of { version, date, items }
async function load_changelog() {
    const response = await fetch(messenger.runtime.getURL('CHANGELOG.md'));
    if (!response.ok) {
        throw new Error('CHANGELOG.md is not in the package');
    }
    const versions = [];
    for (const line of (await response.text()).split('\n')) {
        const heading = line.match(/^## version (\S+) \((.+)\)\s*$/);
        if (heading) {
            versions.push({ version: heading[1], date: heading[2], items: [] });
            continue;
        }
        const current = versions[versions.length - 1];
        if (!current) {
            continue;
        }
        const bullet = line.match(/^- (.*)$/);
        if (bullet) {
            current.items.push(bullet[1]);
        } else if (line.trim() && current.items.length) {
            current.items[current.items.length - 1] += ' ' + line.trim();
        }
    }
    return versions;
}

// markdown links and code spans in changelog lines are shown as plain text
function plain_text(markdown) {
    return markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`([^`]+)`/g, '$1');
}

function releases_link(text) {
    const link = document.createElement('a');
    link.href = releases_url;
    link.className = 'text_link';
    link.textContent = text;
    link.addEventListener('click', event => {
        event.preventDefault();
        messenger.windows.openDefaultBrowser(releases_url);
    });
    return link;
}

function render_update_link() {
    const link = element('updated_link');
    link.hidden = !update_notice;
    if (update_notice) {
        link.textContent = 'updated to ' + update_notice.to;
    }
}

function open_overlay(name) {
    if (overlay_stack[overlay_stack.length - 1] !== name) {
        overlay_stack.push(name);
    }
    show_view(name);
}

function close_overlay() {
    overlay_stack.pop();
    if (overlay_stack.length) {
        show_view(overlay_stack[overlay_stack.length - 1]);
    } else if (last_state) {
        render(last_state);
    }
}

// replaces the content with release notes: the versions in the given range, or all of them when there is no range,
// or only the newest one
async function show_changelog(range, latest_only = false) {
    const container = element('changelog_content');
    container.replaceChildren();
    try {
        let versions = (await load_changelog()).filter(entry =>
            !range || (compare_versions(entry.version, range.from) > 0 && compare_versions(entry.version, range.to) <= 0)
        );
        if (latest_only) {
            versions = versions.slice(0, 1);
        }
        for (const entry of versions) {
            const block = document.createElement('div');
            const heading = document.createElement('h3');
            heading.textContent = 'version ' + entry.version;
            const date = document.createElement('p');
            date.className = 'muted small';
            date.textContent = entry.date;
            const list = document.createElement('ul');
            for (const item of entry.items) {
                const list_item = document.createElement('li');
                list_item.textContent = plain_text(item);
                list.append(list_item);
            }
            block.append(heading, date, list);
            container.append(block);
        }
        if (!versions.length) {
            throw new Error('no notes for these versions');
        }
    } catch (error) {
        const message = document.createElement('p');
        message.className = 'small';
        message.textContent = range ? 'updated from ' + range.from + ' to ' + range.to + '. ' : '';
        message.append(releases_link('see the release notes on GitHub'));
        container.append(message);
    }
    container.append(releases_link('all release notes'));
    open_overlay('changelog');
}

// after an update: the notes of every version since the one installed before, shown once
async function show_update_notes() {
    if (!update_notice) {
        return;
    }
    const notice = update_notice;
    update_notice = null;
    render_update_link();
    overlay_stack.length = 0;
    await show_changelog(notice);
    await messenger.storage.local.remove('update_notice');
}

function open_settings() {
    overlay_stack.length = 0;
    element('show_label_setting').checked = settings.show_label;
    element('version_value').textContent = 'version ' + messenger.runtime.getManifest().version;
    open_overlay('settings');
}

async function scan() {
    render(await messenger.compactor.scan());
}

element('start_button').addEventListener('click', async () => {
    element('start_button').disabled = true;
    render(await messenger.compactor.start());
});

element('stop_button').addEventListener('click', async () => {
    render(await messenger.compactor.stop());
});

element('updated_link').addEventListener('click', show_update_notes);

element('settings_button').addEventListener('click', () => {
    if (overlay_stack[overlay_stack.length - 1] === 'settings') {
        overlay_stack.length = 0;
        render(last_state);
    } else {
        open_settings();
    }
});

// the background page watches this setting and updates the toolbar button
element('show_label_setting').addEventListener('change', async event => {
    settings = { ...settings, show_label: event.target.checked };
    await messenger.storage.local.set({ settings });
});

element('release_notes_link').addEventListener('click', event => {
    event.preventDefault();
    show_changelog(null, true);
});

element('github_link').addEventListener('click', event => {
    event.preventDefault();
    messenger.windows.openDefaultBrowser(homepage_url);
});

element('back_button').addEventListener('click', close_overlay);
element('settings_back_button').addEventListener('click', close_overlay);

element('rescan_button').addEventListener('click', async () => {
    const stored = await messenger.storage.local.get('last_result');
    last_result = stored.last_result || null;
    await scan();
});

messenger.compactor.on_update.addListener(render);

(async () => {
    const stored = await messenger.storage.local.get(['last_result', 'update_notice', 'settings']);
    last_result = stored.last_result || null;
    update_notice = stored.update_notice || null;
    settings = { ...default_settings, ...stored.settings };
    render_update_link();
    const state = await messenger.compactor.get_state();
    render(state);
    // a fresh scan is cheap, so the numbers are rebuilt every time the popup opens while nothing is running
    if (state.phase === 'idle' || state.phase === 'ready') {
        await scan();
    }
})();
