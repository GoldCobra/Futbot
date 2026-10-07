// A competitive write that can never succeed because its row is in another state (for
// example a result for a match that was cancelled meanwhile). Retrying it would only block
// the pending-write queue, so callers drop it and log it instead.
class RatedMatchStateError extends Error {
    constructor(message, { ratedMatchId = null, status = null } = {}) {
        super(message);
        this.name = 'RatedMatchStateError';
        this.ratedMatchId = ratedMatchId;
        this.status = status;
    }
}

// THROW numbers raised by our own T-SQL batches for data that contradicts what is stored.
const CONFLICTING_DATA_ERROR_NUMBERS = new Set([
    51020 // RatedMatchGame already exists with different result data
]);

function isPermanentDbWriteError(err) {
    if (!err) return false;
    if (err instanceof RatedMatchStateError) return true;
    return CONFLICTING_DATA_ERROR_NUMBERS.has(Number(err.number));
}

module.exports = {
    RatedMatchStateError,
    isPermanentDbWriteError
};
