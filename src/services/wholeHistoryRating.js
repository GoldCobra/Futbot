// Whole History Rating (Rémi Coulom, 2008) for the legacy 1v1 match history in dbo.Match.
//
// The parameters reproduce the external tool that filled dbo.WhrRatingHistory until 2026-07-22.
// Recalculated against all 21,614 legacy history rows (MSC/SMS/MSBL), the median deviation was
// 0.4 / 0.4 / 2.6 Elo and the 95th percentile stayed below 5 Elo:
// - every single game counts (P1Wins / P1Losses), not only the match result
// - w² = 100 Elo² per day for the Wiener process between two playing days
// - a player's first day carries one virtual win and one virtual loss against rating 0
// - ratings are centred on 0 (the UI shows 1000 + RatingWHR) and iterated to convergence
const LN10_OVER_400 = Math.log(10) / 400;
const DIAGONAL_REGULARIZATION = 0.001;
const RATING_DECIMALS = 9;

const WHR_DEFAULTS = Object.freeze({
    w2Elo: 100,
    priorGames: 1,
    maxIterations: 10000,
    tolerance: 1e-7
});

const DIFF_TOLERANCE_ELO = 0.0005;

function roundRating(value) {
    return Number(Number(value).toFixed(RATING_DECIMALS));
}

function toFiniteInteger(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
}

function buildPlayerDays(matches) {
    const players = new Map();
    let gameCount = 0;
    let matchCount = 0;

    const getDay = (playerId, dayNumber) => {
        let player = players.get(playerId);
        if (!player) {
            player = { days: [], byDay: new Map() };
            players.set(playerId, player);
        }
        let day = player.byDay.get(dayNumber);
        if (!day) {
            day = { day: dayNumber, r: 0, wins: 0, opponents: [], isFirstDay: false };
            player.byDay.set(dayNumber, day);
            player.days.push(day);
        }
        return day;
    };

    for (const match of matches ?? []) {
        const player1 = toFiniteInteger(match.player1);
        const player2 = toFiniteInteger(match.player2);
        const dayNumber = toFiniteInteger(match.day);
        const p1Wins = Number(match.p1Wins);
        const p1Losses = Number(match.p1Losses);
        if (player1 == null || player2 == null || player1 === player2 || dayNumber == null) continue;
        if (!Number.isFinite(p1Wins) || !Number.isFinite(p1Losses) || p1Wins < 0 || p1Losses < 0) continue;
        const games = p1Wins + p1Losses;
        if (games <= 0) continue;

        const day1 = getDay(player1, dayNumber);
        const day2 = getDay(player2, dayNumber);
        day1.wins += p1Wins;
        day2.wins += p1Losses;
        day1.opponents.push([day2, games]);
        day2.opponents.push([day1, games]);
        gameCount += games;
        matchCount += 1;
    }

    for (const player of players.values()) {
        player.days.sort((a, b) => a.day - b.day);
        player.days.forEach((day, index) => {
            day.isFirstDay = index === 0;
        });
    }

    return { players, gameCount, matchCount };
}

// First and second derivative of one playing day's log-likelihood with respect to its natural rating.
function dayDerivatives(day, priorGames) {
    const gamma = Math.exp(day.r);
    let wins = day.wins;
    let firstSum = 0;
    let secondSum = 0;
    for (const [opponentDay, games] of day.opponents) {
        const opponentGamma = Math.exp(opponentDay.r);
        const denominator = gamma + opponentGamma;
        firstSum += games / denominator;
        secondSum += games * opponentGamma / (denominator * denominator);
    }
    if (day.isFirstDay && priorGames > 0) {
        wins += priorGames;
        firstSum += 2 * priorGames / (gamma + 1);
        secondSum += 2 * priorGames / ((gamma + 1) * (gamma + 1));
    }
    return [wins - gamma * firstSum, -gamma * secondSum];
}

// One Newton step over all playing days of a player; the Hessian is tridiagonal (Thomas algorithm).
function updatePlayer(player, w2, priorGames) {
    const days = player.days;
    const count = days.length;

    if (count === 1) {
        const [first, second] = dayDerivatives(days[0], priorGames);
        const step = first / (second - DIAGONAL_REGULARIZATION);
        days[0].r -= step;
        return Math.abs(step);
    }

    const sigma2 = new Array(count - 1);
    for (let index = 0; index < count - 1; index += 1) {
        sigma2[index] = Math.max(1, Math.abs(days[index + 1].day - days[index].day)) * w2;
    }

    const diagonal = new Array(count);
    const offDiagonal = new Array(count - 1);
    const gradient = new Array(count);
    for (let index = 0; index < count; index += 1) {
        const [first, second] = dayDerivatives(days[index], priorGames);
        let prior = 0;
        let priorGradient = 0;
        if (index < count - 1) {
            prior -= 1 / sigma2[index];
            priorGradient -= (days[index].r - days[index + 1].r) / sigma2[index];
            offDiagonal[index] = 1 / sigma2[index];
        }
        if (index > 0) {
            prior -= 1 / sigma2[index - 1];
            priorGradient -= (days[index].r - days[index - 1].r) / sigma2[index - 1];
        }
        diagonal[index] = second + prior - DIAGONAL_REGULARIZATION;
        gradient[index] = first + priorGradient;
    }

    const upper = new Array(count);
    const solved = new Array(count);
    upper[0] = offDiagonal[0] / diagonal[0];
    solved[0] = gradient[0] / diagonal[0];
    for (let index = 1; index < count; index += 1) {
        const denominator = diagonal[index] - offDiagonal[index - 1] * upper[index - 1];
        upper[index] = index < count - 1 ? offDiagonal[index] / denominator : 0;
        solved[index] = (gradient[index] - offDiagonal[index - 1] * solved[index - 1]) / denominator;
    }

    let maxStep = 0;
    let next = 0;
    for (let index = count - 1; index >= 0; index -= 1) {
        const step = index === count - 1 ? solved[index] : solved[index] - upper[index] * next;
        next = step;
        days[index].r -= step;
        maxStep = Math.max(maxStep, Math.abs(step));
    }
    return maxStep;
}

/**
 * Computes the full rating history of every player from scratch.
 *
 * @param {Array<{player1:number, player2:number, p1Wins:number, p1Losses:number, day:number}>} matches
 *        Must be passed in a stable order (the DAO sorts by MatchDate, Match id) for deterministic output.
 * @returns {{players: Map<number, Array<{day:number, ratingElo:number}>>, iterations:number,
 *            converged:boolean, maxStepElo:number, matchCount:number, gameCount:number}}
 */
function computeWholeHistoryRatings(matches, options = {}) {
    const { w2Elo, priorGames, maxIterations, tolerance } = { ...WHR_DEFAULTS, ...options };
    const w2 = w2Elo * LN10_OVER_400 * LN10_OVER_400;
    const { players, gameCount, matchCount } = buildPlayerDays(matches);

    let iterations = 0;
    let maxStep = players.size ? Infinity : 0;
    while (iterations < maxIterations && maxStep > tolerance) {
        maxStep = 0;
        for (const player of players.values()) {
            maxStep = Math.max(maxStep, updatePlayer(player, w2, priorGames));
        }
        iterations += 1;
    }

    const ratings = new Map();
    for (const [playerId, player] of players) {
        ratings.set(playerId, player.days.map(day => ({
            day: day.day,
            ratingElo: roundRating(day.r / LN10_OVER_400)
        })));
    }

    return {
        players: ratings,
        iterations,
        converged: maxStep <= tolerance,
        maxStepElo: maxStep / LN10_OVER_400,
        matchCount,
        gameCount
    };
}

function historyKey(playerId, day) {
    return `${playerId}:${day}`;
}

function latestRating(days) {
    return days.length ? days[days.length - 1].ratingElo : 0;
}

/**
 * Compares a freshly computed history with the stored one. Every stored PlayerStats row ends up with the
 * rating of its player's last playing day, or 0 when the player has no rated 1v1 result in this game.
 */
function diffWhrState({ computed, existingHistory = [], existingRatings = [], tolerance = DIFF_TOLERANCE_ELO }) {
    const stored = new Map();
    for (const row of existingHistory) {
        stored.set(historyKey(row.playerId, row.day), Number(row.ratingElo));
    }

    const upserts = [];
    let inserts = 0;
    let updates = 0;
    const seen = new Set();
    for (const [playerId, days] of computed) {
        for (const { day, ratingElo } of days) {
            const key = historyKey(playerId, day);
            seen.add(key);
            if (!stored.has(key)) {
                upserts.push({ playerId, day, ratingElo });
                inserts += 1;
            } else if (Math.abs(stored.get(key) - ratingElo) > tolerance) {
                upserts.push({ playerId, day, ratingElo });
                updates += 1;
            }
        }
    }

    const deletes = [];
    for (const row of existingHistory) {
        if (!seen.has(historyKey(row.playerId, row.day))) {
            deletes.push({ playerId: row.playerId, day: row.day });
        }
    }

    const ratingUpdates = [];
    const storedRatings = new Map(existingRatings.map(row => [row.playerId, Number(row.ratingElo)]));
    for (const [playerId, storedRating] of storedRatings) {
        const target = latestRating(computed.get(playerId) ?? []);
        if (!Number.isFinite(storedRating) || Math.abs(storedRating - target) > tolerance) {
            ratingUpdates.push({ playerId, ratingElo: target });
        }
    }
    for (const [playerId, days] of computed) {
        if (!storedRatings.has(playerId)) {
            ratingUpdates.push({ playerId, ratingElo: latestRating(days) });
        }
    }

    return { upserts, inserts, updates, deletes, ratingUpdates };
}

/**
 * Full target state for a rebuild: every history row, and a rating for every stored or computed player.
 */
function buildRebuildState({ computed, existingRatings = [] }) {
    const history = [];
    for (const [playerId, days] of computed) {
        for (const { day, ratingElo } of days) {
            history.push({ playerId, day, ratingElo });
        }
    }
    const ratings = new Map();
    for (const row of existingRatings) {
        ratings.set(row.playerId, 0);
    }
    for (const [playerId, days] of computed) {
        ratings.set(playerId, latestRating(days));
    }
    return {
        history,
        ratings: [...ratings].map(([playerId, ratingElo]) => ({ playerId, ratingElo }))
    };
}

function hasWhrChanges(diff) {
    return Boolean(diff.upserts.length || diff.deletes.length || diff.ratingUpdates.length);
}

module.exports = {
    WHR_DEFAULTS,
    DIFF_TOLERANCE_ELO,
    LN10_OVER_400,
    computeWholeHistoryRatings,
    diffWhrState,
    buildRebuildState,
    hasWhrChanges
};
