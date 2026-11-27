'use strict';

let last_saved_finish = null;

// toolbar badge shows the percentage while a run is going, so progress stays visible with the popup closed
function update_badge(state) {
    if ((state.phase === 'running' || state.phase === 'stopping') && state.progress) {
        const total = state.progress.total || 1;
        const percent = Math.floor((state.progress.done * 100) / total);
        messenger.browserAction.setBadgeText({ text: percent + '%' });
        messenger.browserAction.setTitle({ title: 'compacting folders: ' + state.progress.done + ' of ' + state.progress.total });
    } else {
        messenger.browserAction.setBadgeText({ text: '' });
        messenger.browserAction.setTitle({ title: 'compact everything' });
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

// after an update the popup shows an "updated to" link until the release notes have been opened once; when several
// updates happen before that, the notice keeps the oldest version so the notes cover all of them
messenger.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
    const current_version = messenger.runtime.getManifest().version;
    if (reason !== 'update' || !previousVersion || previousVersion === current_version) {
        return;
    }
    const stored = await messenger.storage.local.get('update_notice');
    const from = stored.update_notice ? stored.update_notice.from : previousVersion;
    await messenger.storage.local.set({ update_notice: { from, to: current_version } });
});

const default_settings = { show_label: true };

// the label is set explicitly: without one, the button shows its title, which changes to the progress during a run;
// an empty label leaves only the icon, with the title still shown as the tooltip
async function apply_settings() {
    const stored = await messenger.storage.local.get('settings');
    const settings = { ...default_settings, ...stored.settings };
    await messenger.browserAction.setLabel({ label: settings.show_label ? 'compact everything' : '' });
}

messenger.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
        apply_settings();
    }
});

apply_settings();

messenger.browserAction.setBadgeBackgroundColor({ color: '#2a6ad9' });

messenger.compactor.on_update.addListener(state => {
    update_badge(state);
    remember_result(state);
});
