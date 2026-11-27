/* global ChromeUtils, Ci, Cr, IOUtils */
'use strict';

// Ci, Cr and IOUtils come from the sandbox Thunderbird loads experiment scripts into
var { ExtensionCommon } = ChromeUtils.importESModule('resource://gre/modules/ExtensionCommon.sys.mjs');
var { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
var { setTimeout, clearTimeout } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');

// accounts are processed in parallel, the folders of one account one after the other
const MAX_PARALLEL_ACCOUNTS = 3;

// a folder whose compaction has not reported back after this long is recorded as timed out
const FOLDER_TIMEOUT_MS = 30 * 60 * 1000;

// minimum delay between two update events sent to the popup and the background page
const UPDATE_THROTTLE_MS = 150;

// a scan younger than this is reused when a run starts, instead of walking all accounts again
const SCAN_REUSE_MS = 60 * 1000;

// after this many failures in a row the rest of the account is skipped, as its server usually cannot be reached
const MAX_CONSECUTIVE_FAILURES = 3;

// failures listed in the result; the total is always counted
const MAX_LISTED_FAILURES = 50;

// how many file sizes are read at the same time during a scan
const STAT_BATCH_SIZE = 64;

// server types whose folders cannot be compacted
const SKIPPED_SERVER_TYPES = new Set(['nntp']);

const update_listeners = new Set();

let phase = 'idle';
let scan_result = null;
let scan_error = null;
let progress = null;
let run_result = null;
let stop_requested = false;
let shut_down = false;
let update_timer = null;

// mail stores are rewritten one at a time, as each rewrite needs temporary free space about the size of the folder
let store_rewrite_queue = Promise.resolve();

// size of a regular file, read off the main thread; a missing or unreadable file counts as zero bytes
async function file_size(file) {
    if (!file) {
        return 0;
    }
    try {
        const info = await IOUtils.stat(file.path);
        return info.type === 'regular' ? info.size : 0;
    } catch (error) {
        return 0;
    }
}

function store_file(folder) {
    try {
        return folder.filePath;
    } catch (error) {
        return null;
    }
}

function summary_file(folder) {
    try {
        return folder.summaryFile;
    } catch (error) {
        return null;
    }
}

// bytes a folder takes on disk: the mbox file (the messages of a local folder, or the offline store of an IMAP
// folder) and the total with the .msf index
async function folder_disk_size(folder) {
    const [store, summary] = await Promise.all([file_size(store_file(folder)), file_size(summary_file(folder))]);
    return { store, total: store + summary };
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

function is_offline_imap_folder(folder) {
    return Boolean(folder.flags & Ci.nsMsgFolderFlags.Offline);
}

// bytes compaction can give back on disk. IMAP folders not set for offline use keep no messages locally, yet
// Thunderbird keeps adding deleted bytes to their counter and never resets it, so they count as zero. the counter
// of any other folder is capped at the size of the store file it refers to
function recoverable_bytes(folder, store_size) {
    try {
        if (is_imap_folder(folder) && !is_offline_imap_folder(folder)) {
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

// a local folder without deleted bytes has nothing to compact; Thunderbird skips it the same way
function has_nothing_to_compact(folder) {
    try {
        return !is_imap_folder(folder) && read_expunged_bytes(folder) === 0;
    } catch (error) {
        return false;
    }
}

// compacting rewrites a local folder or the offline store of an IMAP folder when there are deleted bytes; IMAP
// folders without offline use are only expunged on the server
function rewrites_store(folder) {
    try {
        return (!is_imap_folder(folder) || is_offline_imap_folder(folder)) && read_expunged_bytes(folder) > 0;
    } catch (error) {
        return false;
    }
}

function with_store_rewrite_slot(task) {
    const run = store_rewrite_queue.then(task);
    store_rewrite_queue = run.catch(() => {});
    return run;
}

function folder_label(folder) {
    try {
        return folder.prettyPath || folder.prettyName || folder.name;
    } catch (error) {
        return folder.URI;
    }
}

function error_text(error) {
    return String(error && error.message ? error.message : error);
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

// walks every account and collects the folders that can be compacted, then reads their sizes in batches
async function scan_accounts() {
    const accounts = [];
    const measurements = [];
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

        const account_entry = { name: server.prettyName, folders: [], saved_bytes: 0 };
        let descendants = [];
        try {
            descendants = server.rootFolder.descendants;
        } catch (error) {
            descendants = [];
        }

        for (const folder of descendants) {
            visited++;
            if (visited % 200 === 0) {
                await yield_to_event_loop();
            }
            if (!is_compactable(folder)) {
                continue;
            }
            const folder_entry = { uri: folder.URI, label: folder_label(folder), size_bytes: 0, recoverable_bytes: 0 };
            account_entry.folders.push(folder_entry);
            measurements.push({ folder, folder_entry });
        }

        if (account_entry.folders.length) {
            accounts.push(account_entry);
        }
    }

    for (let index = 0; index < measurements.length; index += STAT_BATCH_SIZE) {
        await Promise.all(measurements.slice(index, index + STAT_BATCH_SIZE).map(async ({ folder, folder_entry }) => {
            const size = await folder_disk_size(folder);
            folder_entry.size_bytes = size.total;
            folder_entry.recoverable_bytes = recoverable_bytes(folder, size.store);
        }));
    }

    let folder_count = 0;
    let size_bytes = 0;
    let recoverable_total = 0;
    for (const account_entry of accounts) {
        for (const folder_entry of account_entry.folders) {
            folder_count++;
            size_bytes += folder_entry.size_bytes;
            recoverable_total += folder_entry.recoverable_bytes;
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

// compacts one folder and resolves with { status, saved_bytes }, or { skipped: true } when the run was stopped
// before the folder started
async function compact_entry(account_entry, folder_entry) {
    const folder = MailServices.folderLookup.getFolderForURL(folder_entry.uri);
    if (!folder) {
        return { status: 'missing', saved_bytes: 0 };
    }
    if (has_nothing_to_compact(folder)) {
        return { status: Cr.NS_OK, saved_bytes: 0 };
    }

    const task = async () => {
        if (stop_requested || shut_down) {
            return { skipped: true };
        }
        const current = { account_name: account_entry.name, folder_label: folder_entry.label };
        progress.current.push(current);
        schedule_update();
        try {
            const before = await folder_disk_size(folder);
            const status = await compact_folder(folder);
            // after a timeout the compaction may still be running, so the size is not measured
            if (status === 'timeout') {
                return { status, saved_bytes: 0 };
            }
            const after = await folder_disk_size(folder);
            // only shrinkage counts as recovered: a folder with nothing to compact can still grow by a few bytes
            // while it is processed, as Thunderbird writes bookkeeping to its .msf index or new mail arrives
            return { status, saved_bytes: Math.max(0, before.total - after.total) };
        } finally {
            progress.current.splice(progress.current.indexOf(current), 1);
        }
    };

    return rewrites_store(folder) ? with_store_rewrite_slot(task) : task();
}

function record_outcome(account_entry, folder_entry, outcome) {
    progress.done++;
    progress.recovered_bytes += outcome.saved_bytes;
    account_entry.saved_bytes += outcome.saved_bytes;
    if (outcome.status !== Cr.NS_OK) {
        progress.failed_count++;
        if (progress.failed.length < MAX_LISTED_FAILURES) {
            progress.failed.push({
                account_name: account_entry.name,
                folder_label: folder_entry.label,
                reason: status_to_text(outcome.status),
            });
        }
    } else if (outcome.saved_bytes > 0) {
        progress.savings.push({
            account_name: account_entry.name,
            folder_label: folder_entry.label,
            saved_bytes: outcome.saved_bytes,
        });
    }
    schedule_update();
}

async function process_account(account_entry) {
    let consecutive_failures = 0;
    for (let index = 0; index < account_entry.folders.length; index++) {
        if (stop_requested || shut_down) {
            return;
        }
        const folder_entry = account_entry.folders[index];
        let outcome;
        try {
            outcome = await compact_entry(account_entry, folder_entry);
        } catch (error) {
            outcome = { status: error_text(error), saved_bytes: 0 };
        }
        if (outcome.skipped) {
            return;
        }
        record_outcome(account_entry, folder_entry, outcome);
        consecutive_failures = outcome.status === Cr.NS_OK ? 0 : consecutive_failures + 1;

        // a timeout, or several failures in a row, usually means the server cannot be reached
        if (outcome.status === 'timeout' || consecutive_failures >= MAX_CONSECUTIVE_FAILURES) {
            const reason = outcome.status === 'timeout'
                ? 'skipped after a folder of this account timed out'
                : 'skipped after ' + consecutive_failures + ' failures in a row in this account';
            for (const skipped_entry of account_entry.folders.slice(index + 1)) {
                record_outcome(account_entry, skipped_entry, { status: reason, saved_bytes: 0 });
            }
            return;
        }
    }
}

async function run_compaction() {
    const queue = scan_result.accounts.slice();
    const worker = async () => {
        while (queue.length && !stop_requested && !shut_down) {
            await process_account(queue.shift());
        }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_ACCOUNTS, queue.length) }, worker));

    const accounts = scan_result.accounts
        .map(account_entry => ({ name: account_entry.name, saved_bytes: account_entry.saved_bytes }))
        .filter(account_entry => account_entry.saved_bytes > 0)
        .sort((first, second) => second.saved_bytes - first.saved_bytes);

    const top_folders = progress.savings
        .slice()
        .sort((first, second) => second.saved_bytes - first.saved_bytes)
        .slice(0, 10);

    run_result = {
        recovered_bytes: progress.recovered_bytes,
        folder_count: progress.done,
        shrunk_count: progress.savings.length,
        accounts,
        top_folders,
        failed: progress.failed.slice(),
        failed_count: progress.failed_count,
        started_at: progress.started_at,
        finished_at: Date.now(),
        // a stop only counts when it actually left folders out
        stopped: stop_requested && progress.done < progress.total,
    };
    phase = 'done';
    stop_requested = false;
    emit_update();
}

function snapshot() {
    return {
        phase,
        error: scan_error,
        scan: scan_result
            ? {
                  account_count: scan_result.account_count,
                  folder_count: scan_result.folder_count,
                  size_bytes: scan_result.size_bytes,
                  recoverable_bytes: scan_result.recoverable_bytes,
              }
            : null,
        progress: progress
            ? {
                  total: progress.total,
                  done: progress.done,
                  recovered_bytes: progress.recovered_bytes,
                  current: progress.current.slice(),
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
        // a popup that closes while an update is on its way rejects the delivery, which needs no handling
        Promise.resolve(fire.async(state)).catch(() => {});
    }
}

function schedule_update() {
    if (!update_timer) {
        update_timer = setTimeout(emit_update, UPDATE_THROTTLE_MS);
    }
}

// a failed scan keeps the previous result and reports the error; "ready" is only announced when asked for, so a
// scan made right before a run goes straight from "scanning" to "running"
async function do_scan(announce_ready) {
    phase = 'scanning';
    emit_update();
    try {
        scan_result = await scan_accounts();
        scan_error = null;
    } catch (error) {
        scan_error = error_text(error);
        console.error('compact everything: scan failed', error);
    }
    phase = 'ready';
    if (announce_ready) {
        emit_update();
    }
}

this.compactor = class extends ExtensionCommon.ExtensionAPI {
    onShutdown() {
        // a compaction already handed to Thunderbird finishes on its own, nothing new is started
        shut_down = true;
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
                    if (shut_down || phase === 'running' || phase === 'stopping' || phase === 'scanning') {
                        return snapshot();
                    }
                    run_result = null;
                    progress = null;
                    await do_scan(true);
                    return snapshot();
                },

                async start() {
                    if (shut_down || phase === 'running' || phase === 'stopping' || phase === 'scanning') {
                        return snapshot();
                    }
                    // a recent scan is reused; an older one is rebuilt, as folders may have changed since
                    if (!scan_result || scan_error || Date.now() - scan_result.scanned_at > SCAN_REUSE_MS) {
                        await do_scan(false);
                    }
                    if (shut_down || scan_error || !scan_result) {
                        emit_update();
                        return snapshot();
                    }
                    stop_requested = false;
                    run_result = null;
                    progress = {
                        total: scan_result.folder_count,
                        done: 0,
                        recovered_bytes: 0,
                        current: [],
                        failed: [],
                        failed_count: 0,
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
                        stop_requested = false;
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
