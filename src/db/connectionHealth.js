// Whether the database is reachable, judged from the outcome of every query in sqlClient. A query
// that still fails after its retries because no connection could be opened (or the connection
// broke) starts an outage; the next query that succeeds ends it. Listeners receive
//   { type: 'failed', since, failures, error, at }   every query that failed during the outage
//   { type: 'recovered', since, failures, at }       the first query that worked again
// Other errors (SQL errors, request timeouts) say nothing about reachability and are ignored here.
const CONNECTION_ERROR_CODES = new Set(['ESOCKET', 'ECONNCLOSED', 'ECONNRESET', 'ENOTOPEN']);

const listeners = new Set();
let outage = null;

function isConnectionFailure(err) {
    if (!err) return false;
    if (err.name === 'ConnectionError') return true;
    return CONNECTION_ERROR_CODES.has(err.code);
}

function onConnectionHealth(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function emit(event) {
    for (const listener of listeners) {
        try {
            listener(event);
        } catch (err) {
            console.error(`[DB] connection health listener failed: ${err.message}`);
        }
    }
}

function recordQuerySuccess(at = Date.now()) {
    if (!outage) return;
    const { since, failures } = outage;
    outage = null;
    emit({ type: 'recovered', since, failures, at });
}

function recordQueryFailure(err, at = Date.now()) {
    if (!isConnectionFailure(err)) return;
    if (!outage) outage = { since: at, failures: 0 };
    outage.failures += 1;
    emit({ type: 'failed', since: outage.since, failures: outage.failures, error: err, at });
}

function currentOutage() {
    return outage ? { ...outage } : null;
}

function resetConnectionHealthForTests() {
    outage = null;
    listeners.clear();
}

module.exports = {
    isConnectionFailure,
    onConnectionHealth,
    recordQuerySuccess,
    recordQueryFailure,
    currentOutage,
    resetConnectionHealthForTests
};
