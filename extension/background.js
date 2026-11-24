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

messenger.browserAction.setBadgeBackgroundColor({ color: '#2a6ad9' });

messenger.compactor.on_update.addListener(state => {
    update_badge(state);
    remember_result(state);
});
