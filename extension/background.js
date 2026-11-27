'use strict';

/* global shared */

const busy_phases = new Set(['running', 'stopping', 'scanning']);

let last_saved_finish = null;
let last_badge_text = null;
let last_title = null;
let update_waiting = false;

function log_error(error) {
    console.error('compact everything:', error);
}

// toolbar badge shows the percentage while a run is going, so progress stays visible with the popup closed; the
// button is only touched when the text actually changes
function update_badge(state) {
    const running = (state.phase === 'running' || state.phase === 'stopping') && state.progress;
    const badge_text = running ? shared.percent_done(state.progress) + '%' : '';
    const title = running
        ? 'compacting folders: ' + state.progress.done + ' of ' + state.progress.total
        : shared.label;
    if (badge_text !== last_badge_text) {
        last_badge_text = badge_text;
        messenger.browserAction.setBadgeText({ text: badge_text }).catch(log_error);
    }
    if (title !== last_title) {
        last_title = title;
        messenger.browserAction.setTitle({ title }).catch(log_error);
    }
}

// the result of the last finished run is kept in storage so it survives a restart of Thunderbird
async function remember_result(state) {
    if (state.phase !== 'done' || !state.result || state.result.finished_at === last_saved_finish) {
        return;
    }
    last_saved_finish = state.result.finished_at;
    await messenger.storage.local.set({
        last_result: {
            recovered_bytes: state.result.recovered_bytes,
            folder_count: state.result.folder_count,
            finished_at: state.result.finished_at,
            stopped: state.result.stopped,
        },
    });
}

// a downloaded update of the add-on is installed only while nothing is running, so it never cuts a run short;
// Thunderbird holds the update back for as long as this listener exists and the add-on has not reloaded
function install_update_when_idle(state) {
    if (update_waiting && !busy_phases.has(state.phase)) {
        messenger.runtime.reload();
    }
}

messenger.runtime.onUpdateAvailable.addListener(() => {
    update_waiting = true;
    messenger.compactor.get_state().then(install_update_when_idle).catch(log_error);
});

// after an update the popup shows an "updated to" link until the release notes have been opened once; when several
// updates happen before that, the notice keeps the oldest version so the notes cover all of them
messenger.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
    const current_version = messenger.runtime.getManifest().version;
    if (reason !== 'update' || !previousVersion || shared.compare_versions(current_version, previousVersion) <= 0) {
        return;
    }
    messenger.storage.local.get('update_notice')
        .then(stored => {
            const from = stored.update_notice ? stored.update_notice.from : previousVersion;
            return messenger.storage.local.set({ update_notice: { from, to: current_version } });
        })
        .catch(log_error);
});

// the label is set explicitly: without one, the button shows its title, which changes to the progress during a run;
// an empty label leaves only the icon, with the title still shown as the tooltip
async function apply_settings() {
    const stored = await messenger.storage.local.get('settings');
    const settings = { ...shared.default_settings, ...stored.settings };
    await messenger.browserAction.setLabel({ label: settings.show_label ? shared.label : '' });
}

messenger.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
        apply_settings().catch(log_error);
    }
});

apply_settings().catch(log_error);

messenger.browserAction.setBadgeBackgroundColor({ color: '#2a6ad9' }).catch(log_error);

messenger.compactor.on_update.addListener(state => {
    update_badge(state);
    remember_result(state).catch(log_error);
    install_update_when_idle(state);
});
