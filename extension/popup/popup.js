'use strict';

const element = id => document.getElementById(id);

const views = {
    scanning: element('view_scanning'),
    ready: element('view_ready'),
    running: element('view_running'),
    done: element('view_done'),
};

let last_result = null;

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
        result.shrunk_count.toLocaleString() + ' got smaller.';

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
    render_summary(state);
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

element('rescan_button').addEventListener('click', async () => {
    const stored = await messenger.storage.local.get('last_result');
    last_result = stored.last_result || null;
    await scan();
});

messenger.compactor.on_update.addListener(render);

(async () => {
    const stored = await messenger.storage.local.get('last_result');
    last_result = stored.last_result || null;
    const state = await messenger.compactor.get_state();
    render(state);
    // a fresh scan is cheap, so the numbers are rebuilt every time the popup opens while nothing is running
    if (state.phase === 'idle' || state.phase === 'ready') {
        await scan();
    }
})();
