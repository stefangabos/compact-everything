/* global ChromeUtils, Cc, Ci, Cr */
'use strict';

// Cc, Ci and Cr come from the sandbox Thunderbird loads experiment scripts into
var { ExtensionCommon } = ChromeUtils.importESModule('resource://gre/modules/ExtensionCommon.sys.mjs');
var { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
var { setTimeout, clearTimeout } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');

// accounts are compacted in parallel, the folders of one account one after the other
const MAX_PARALLEL_ACCOUNTS = 3;

// a folder whose compaction has not reported back after this long is recorded as timed out and the run moves on
const FOLDER_TIMEOUT_MS = 30 * 60 * 1000;

// minimum delay between two update events sent to the popup and the background page
const UPDATE_THROTTLE_MS = 150;

// server types whose folders cannot be compacted
const SKIPPED_SERVER_TYPES = new Set(['nntp']);

const update_listeners = new Set();

let phase = 'idle';
let scan_result = null;
let progress = null;
let run_result = null;
let stop_requested = false;
let update_timer = null;

function new_file(path) {
    const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file;
}

// size of a regular file read straight from disk, through a fresh nsIFile so no cached stat is reused
function file_size(file) {
    if (!file) {
        return 0;
    }
    try {
        const fresh = new_file(file.path);
        if (fresh.exists() && fresh.isFile()) {
            return fresh.fileSize;
        }
    } catch (error) {
        // missing or unreadable file counts as zero bytes
    }
    return 0;
}

// size of the mbox file: the messages of a local folder, or the offline store of an IMAP folder
function store_file_size(folder) {
    try {
        return file_size(folder.filePath);
    } catch (error) {
        return 0;
    }
}

function summary_file_size(folder) {
    try {
        return file_size(folder.summaryFile);
    } catch (error) {
        return 0;
    }
}

// bytes a folder takes on disk: the mbox file plus the .msf index
function folder_disk_size(folder) {
    return store_file_size(folder) + summary_file_size(folder);
}

function read_expunged_bytes(folder) {
    try {
        return Math.max(0, folder.expungedBytes);
    } catch (error) {
        return 0;
    }
}

function is_imap_folder(folder) {
    return Boolean(folder.flags & Ci.nsMsgFolderFlags.ImapBox) || folder.server.type === 'imap';
}

// bytes compaction can give back on disk. IMAP folders not set for offline use keep no messages locally, yet
// Thunderbird keeps adding deleted bytes to their counter and never resets it, so they count as zero. the counter
// of any other folder is capped at the size of the store file it refers to
function recoverable_bytes(folder, store_size) {
    try {
        if (is_imap_folder(folder) && !(folder.flags & Ci.nsMsgFolderFlags.Offline)) {
            return 0;
        }
    } catch (error) {
        return 0;
    }
    return Math.min(read_expunged_bytes(folder), store_size);
}

// mirrors the rules Thunderbird uses for its own compact command
function is_compactable(folder) {
    try {
        if (folder.isServer) {
            return false;
        }
        if (folder.flags & Ci.nsMsgFolderFlags.Virtual) {
            return false;
        }
        if (is_imap_folder(folder)) {
            return !(folder.flags & Ci.nsMsgFolderFlags.ImapNoselect);
        }
        return folder.canCompact;
    } catch (error) {
        return false;
    }
}

function folder_label(folder) {
    try {
        return folder.prettyPath || folder.prettyName || folder.name;
    } catch (error) {
        return folder.URI;
    }
}

function yield_to_event_loop() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function status_to_text(status) {
    if (status === 'timeout') {
        return 'did not finish within ' + Math.round(FOLDER_TIMEOUT_MS / 60000) + ' minutes';
    }
    if (status === 'missing') {
        return 'folder no longer exists';
    }
    if (status === Cr.NS_ERROR_FILE_NO_DEVICE_SPACE) {
        return 'not enough free disk space';
    }
    if (status === Cr.NS_ERROR_NOT_IMPLEMENTED) {
        return 'this account type does not support compacting';
    }
    if (typeof status === 'number') {
        return 'error 0x' + (status >>> 0).toString(16);
    }
    return String(status);
}

// walks every account and collects the folders that can be compacted, with their current size and expunged bytes
async function scan_accounts() {
    const accounts = [];
    let folder_count = 0;
    let size_bytes = 0;
    let recoverable_total = 0;
    let visited = 0;

    for (const account of MailServices.accounts.accounts) {
        let server = null;
        try {
            server = account.incomingServer;
        } catch (error) {
            server = null;
        }
        if (!server || SKIPPED_SERVER_TYPES.has(server.type)) {
            continue;
        }

        const account_entry = {
            key: account.key,
            name: server.prettyName,
            type: server.type,
            folders: [],
            size_bytes: 0,
            recoverable_bytes: 0,
        };

        let descendants = [];
        try {
            descendants = server.rootFolder.descendants;
        } catch (error) {
            descendants = [];
        }

        for (const folder of descendants) {
            visited++;
            if (visited % 100 === 0) {
                await yield_to_event_loop();
            }
            if (!is_compactable(folder)) {
                continue;
            }
            const store_size = store_file_size(folder);
            const folder_size = store_size + summary_file_size(folder);
            const folder_recoverable = recoverable_bytes(folder, store_size);
            account_entry.folders.push({
                uri: folder.URI,
                label: folder_label(folder),
                size_bytes: folder_size,
                recoverable_bytes: folder_recoverable,
            });
            account_entry.size_bytes += folder_size;
            account_entry.recoverable_bytes += folder_recoverable;
        }

        if (account_entry.folders.length) {
            accounts.push(account_entry);
            folder_count += account_entry.folders.length;
            size_bytes += account_entry.size_bytes;
            recoverable_total += account_entry.recoverable_bytes;
        }
    }

    return {
        accounts,
        account_count: accounts.length,
        folder_count,
        size_bytes,
        recoverable_bytes: recoverable_total,
        scanned_at: Date.now(),
    };
}

// runs nsIMsgFolder.compact() and resolves with the status reported to the url listener
function compact_folder(folder) {
    return new Promise(resolve => {
        let settled = false;
        let timer = null;
        const finish = status => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer) {
                clearTimeout(timer);
            }
            resolve(status);
        };
        const listener = {
            QueryInterface: ChromeUtils.generateQI(['nsIUrlListener']),
            OnStartRunningUrl() {},
            OnStopRunningUrl(url, status) {
                finish(status);
            },
        };
        timer = setTimeout(() => finish('timeout'), FOLDER_TIMEOUT_MS);
        try {
            // no message window: no status bar text and no modal alerts, failures arrive through the listener
            folder.compact(listener, null);
        } catch (error) {
            finish(typeof error.result === 'number' ? error.result : Cr.NS_ERROR_FAILURE);
        }
    });
}

async function compact_entry(account_entry, folder_entry) {
    const current = { account_name: account_entry.name, folder_label: folder_entry.label };
    progress.current.push(current);
    schedule_update();

    const folder = MailServices.folderLookup.getFolderForURL(folder_entry.uri);
    let status = 'missing';
    let size_before = folder_entry.size_bytes;
    let size_after = folder_entry.size_bytes;

    if (folder) {
        size_before = folder_disk_size(folder);
        status = await compact_folder(folder);
        size_after = folder_disk_size(folder);
    }

    const saved_bytes = size_before - size_after;
    progress.current.splice(progress.current.indexOf(current), 1);
    progress.done++;
    progress.size_before += size_before;
    progress.size_after += size_after;
    progress.recovered_bytes += saved_bytes;
    account_entry.saved_bytes = (account_entry.saved_bytes || 0) + saved_bytes;

    if (status !== Cr.NS_OK) {
        progress.failed.push({
            account_name: account_entry.name,
            folder_label: folder_entry.label,
            reason: status_to_text(status),
        });
    } else if (saved_bytes > 0) {
        progress.savings.push({
            account_name: account_entry.name,
            folder_label: folder_entry.label,
            saved_bytes,
        });
    }
    schedule_update();
}

async function run_compaction() {
    const queue = scan_result.accounts.slice();
    const worker = async () => {
        while (queue.length && !stop_requested) {
            const account_entry = queue.shift();
            for (const folder_entry of account_entry.folders) {
                if (stop_requested) {
                    break;
                }
                try {
                    await compact_entry(account_entry, folder_entry);
                } catch (error) {
                    progress.done++;
                    progress.failed.push({
                        account_name: account_entry.name,
                        folder_label: folder_entry.label,
                        reason: String(error && error.message ? error.message : error),
                    });
                    schedule_update();
                }
            }
        }
    };

    const worker_count = Math.min(MAX_PARALLEL_ACCOUNTS, queue.length);
    await Promise.all(Array.from({ length: worker_count }, worker));

    const accounts = scan_result.accounts
        .map(account_entry => ({ name: account_entry.name, saved_bytes: account_entry.saved_bytes || 0 }))
        .filter(account_entry => account_entry.saved_bytes > 0)
        .sort((first, second) => second.saved_bytes - first.saved_bytes);

    const top_folders = progress.savings
        .slice()
        .sort((first, second) => second.saved_bytes - first.saved_bytes)
        .slice(0, 10);

    run_result = {
        recovered_bytes: progress.recovered_bytes,
        store_size_before: scan_result.size_bytes,
        size_before: progress.size_before,
        size_after: progress.size_after,
        folder_count: progress.done,
        total_folders: progress.total,
        shrunk_count: progress.savings.length,
        accounts,
        top_folders,
        failed: progress.failed.slice(),
        started_at: progress.started_at,
        finished_at: Date.now(),
        stopped: stop_requested,
    };
    phase = 'done';
    stop_requested = false;
    emit_update();
}

function snapshot() {
    return {
        phase,
        scan: scan_result
            ? {
                  account_count: scan_result.account_count,
                  folder_count: scan_result.folder_count,
                  size_bytes: scan_result.size_bytes,
                  recoverable_bytes: scan_result.recoverable_bytes,
                  scanned_at: scan_result.scanned_at,
              }
            : null,
        progress: progress
            ? {
                  total: progress.total,
                  done: progress.done,
                  recovered_bytes: progress.recovered_bytes,
                  current: progress.current.slice(),
                  failed_count: progress.failed.length,
                  started_at: progress.started_at,
              }
            : null,
        result: run_result,
    };
}

function emit_update() {
    if (update_timer) {
        clearTimeout(update_timer);
        update_timer = null;
    }
    const state = snapshot();
    for (const fire of update_listeners) {
        try {
            fire.async(state);
        } catch (error) {
            update_listeners.delete(fire);
        }
    }
}

function schedule_update() {
    if (!update_timer) {
        update_timer = setTimeout(emit_update, UPDATE_THROTTLE_MS);
    }
}

async function do_scan() {
    phase = 'scanning';
    emit_update();
    try {
        scan_result = await scan_accounts();
    } finally {
        phase = 'ready';
        emit_update();
    }
}

this.compactor = class extends ExtensionCommon.ExtensionAPI {
    onShutdown() {
        // a compaction already handed to Thunderbird finishes on its own, nothing new is started
        stop_requested = true;
        update_listeners.clear();
        if (update_timer) {
            clearTimeout(update_timer);
            update_timer = null;
        }
    }

    getAPI(context) {
        return {
            compactor: {
                async get_state() {
                    return snapshot();
                },

                async scan() {
                    if (phase === 'running' || phase === 'stopping' || phase === 'scanning') {
                        return snapshot();
                    }
                    run_result = null;
                    progress = null;
                    await do_scan();
                    return snapshot();
                },

                async start() {
                    if (phase === 'running' || phase === 'stopping' || phase === 'scanning') {
                        return snapshot();
                    }
                    // folders may have changed since the last scan, so the list is always rebuilt right before a run
                    await do_scan();
                    stop_requested = false;
                    run_result = null;
                    progress = {
                        total: scan_result.folder_count,
                        done: 0,
                        recovered_bytes: 0,
                        size_before: 0,
                        size_after: 0,
                        current: [],
                        failed: [],
                        savings: [],
                        started_at: Date.now(),
                    };
                    for (const account_entry of scan_result.accounts) {
                        account_entry.saved_bytes = 0;
                    }
                    phase = 'running';
                    emit_update();
                    run_compaction().catch(error => {
                        console.error('compact everything: run failed', error);
                        phase = 'done';
                        emit_update();
                    });
                    return snapshot();
                },

                async stop() {
                    if (phase === 'running') {
                        stop_requested = true;
                        phase = 'stopping';
                        emit_update();
                    }
                    return snapshot();
                },

                on_update: new ExtensionCommon.EventManager({
                    context,
                    name: 'compactor.on_update',
                    register: fire => {
                        update_listeners.add(fire);
                        return () => {
                            update_listeners.delete(fire);
                        };
                    },
                }).api(),
            },
        };
    }
};
