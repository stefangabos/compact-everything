'use strict';

// values and helpers used by both the background page and the popup
const shared = {
    default_settings: { show_label: true },

    label: 'compact everything',

    homepage_url: messenger.runtime.getManifest().homepage_url,

    // compares dotted version numbers part by part; a part like "3b1" compares by its number
    compare_versions(first, second) {
        const first_parts = String(first).split('.').map(part => parseInt(part, 10) || 0);
        const second_parts = String(second).split('.').map(part => parseInt(part, 10) || 0);
        for (let index = 0; index < Math.max(first_parts.length, second_parts.length); index++) {
            const difference = (first_parts[index] || 0) - (second_parts[index] || 0);
            if (difference) {
                return difference;
            }
        }
        return 0;
    },

    percent_done(progress) {
        return progress.total ? Math.floor((progress.done * 100) / progress.total) : 0;
    },
};
