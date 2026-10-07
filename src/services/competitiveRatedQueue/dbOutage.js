// Database outages in the rated log. The tick's background jobs (season check, thread finalization
// and WHR recovery, pending DB writes) run again every minute, so a lost connection is not their
// error: instead of an ERROR per job and tick, the log gets one warning once an outage has lasted
// DB_OUTAGE_WARN_AFTER_MS and one note when queries work again. Short blips only reach the console.
// Any other error of a background job is still logged as an error.
const { isConnectionFailure, onConnectionHealth } = require('../../db/connectionHealth');
const { logRatedError, logRatedInfo, logRatedWarn } = require('./runtimeLogger');

const DEFAULT_WARN_AFTER_MS = 5 * 60_000;

let unsubscribe = null;
let warned = false;

function warnAfterMs() {
    const configured = Number(process.env.DB_OUTAGE_WARN_AFTER_MS);
    return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_WARN_AFTER_MS;
}

function minutes(ms) {
    return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

function startDbOutageLog(client) {
    if (unsubscribe) return;
    warned = false;
    unsubscribe = onConnectionHealth(event => {
        if (event.type === 'failed') {
            if (!warned && event.at - event.since >= warnAfterMs()) {
                warned = true;
                logRatedWarn(client, { all: true }, 'db.unreachable', {
                    since: new Date(event.since).toISOString(),
                    failedQueries: event.failures,
                    error: event.error?.message ?? String(event.error),
                    note: 'background jobs retry every minute'
                });
            }
            return;
        }
        if (event.type === 'recovered') {
            console.log(`[RatedQueue] database reachable again after ${minutes(event.at - event.since)} (${event.failures} failed queries)`);
            if (warned) {
                warned = false;
                logRatedInfo(client, { all: true }, 'db.reachable_again', {
                    downFor: minutes(event.at - event.since),
                    failedQueries: event.failures
                });
            }
        }
    });
}

function stopDbOutageLog() {
    unsubscribe?.();
    unsubscribe = null;
    warned = false;
}

// For the tick's background jobs: a lost database connection is reported by the outage log above,
// everything else as an error of the job.
function logBackgroundJobError(client, event, error) {
    if (isConnectionFailure(error)) {
        console.warn(`[RatedQueue] ${event}: database unreachable (${error.message}); retrying on the next tick`);
        return;
    }
    logRatedError(client, { all: true }, event, error);
}

module.exports = {
    logBackgroundJobError,
    startDbOutageLog,
    stopDbOutageLog
};
