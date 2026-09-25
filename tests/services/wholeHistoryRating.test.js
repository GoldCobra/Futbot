const {
    LN10_OVER_400,
    computeWholeHistoryRatings,
    diffWhrState,
    buildRebuildState,
    hasWhrChanges
} = require('../../src/services/wholeHistoryRating');

function createRandom(seed) {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
    };
}

function syntheticMatches({ players = 6, days = 40, perDay = 3, seed = 7 } = {}) {
    const random = createRandom(seed);
    const strength = Array.from({ length: players }, (_, index) => (index - players / 2) * 0.4);
    const matches = [];
    for (let day = 0; day < days; day += 1) {
        for (let n = 0; n < perDay; n += 1) {
            if (random() < 0.4) continue;
            const a = Math.floor(random() * players);
            let b = Math.floor(random() * players);
            if (a === b) b = (b + 1) % players;
            const pA = 1 / (1 + Math.exp(strength[b] - strength[a]));
            let p1Wins = 0;
            let p1Losses = 0;
            while (p1Wins < 2 && p1Losses < 2) {
                if (random() < pA) p1Wins += 1; else p1Losses += 1;
            }
            matches.push({ player1: a + 1, player2: b + 1, p1Wins, p1Losses, day: 9000 + day * 3 });
        }
    }
    return matches;
}

// Gradient of the WHR log-posterior per playing day, written independently of the implementation.
function posteriorGradients(matches, result, { w2Elo = 100, priorGames = 1 } = {}) {
    const w2 = w2Elo * LN10_OVER_400 * LN10_OVER_400;
    const ratings = new Map();
    for (const [playerId, days] of result.players) {
        ratings.set(playerId, new Map(days.map(day => [day.day, day.ratingElo * LN10_OVER_400])));
    }
    const gradients = [];
    for (const [playerId, byDay] of ratings) {
        const days = [...byDay.keys()].sort((a, b) => a - b);
        days.forEach((day, index) => {
            const r = byDay.get(day);
            const gamma = Math.exp(r);
            let gradient = 0;
            for (const match of matches) {
                if (match.day !== day || match.p1Wins + match.p1Losses <= 0 || match.player1 === match.player2) continue;
                const games = match.p1Wins + match.p1Losses;
                if (match.player1 === playerId) {
                    const opponent = Math.exp(ratings.get(match.player2).get(day));
                    gradient += match.p1Wins - games * gamma / (gamma + opponent);
                } else if (match.player2 === playerId) {
                    const opponent = Math.exp(ratings.get(match.player1).get(day));
                    gradient += match.p1Losses - games * gamma / (gamma + opponent);
                }
            }
            if (index === 0) gradient += priorGames - 2 * priorGames * gamma / (gamma + 1);
            if (index > 0) gradient -= (r - byDay.get(days[index - 1])) / (Math.max(1, day - days[index - 1]) * w2);
            if (index < days.length - 1) gradient -= (r - byDay.get(days[index + 1])) / (Math.max(1, days[index + 1] - day) * w2);
            gradients.push(gradient);
        });
    }
    return gradients;
}

function rating(result, playerId, day) {
    const days = result.players.get(playerId);
    return day == null ? days[days.length - 1].ratingElo : days.find(entry => entry.day === day).ratingElo;
}

describe('computeWholeHistoryRatings', () => {
    it('converges to the maximum of the WHR posterior on every playing day', () => {
        const matches = syntheticMatches();
        const result = computeWholeHistoryRatings(matches);

        expect(result.converged).toBe(true);
        expect(result.players.size).toBe(6);
        const gradients = posteriorGradients(matches, result);
        expect(gradients.length).toBeGreaterThan(40);
        for (const gradient of gradients) {
            expect(Math.abs(gradient)).toBeLessThan(1e-5);
        }
    });

    it('is symmetric and centred on 0 for two players', () => {
        const result = computeWholeHistoryRatings([{ player1: 1, player2: 2, p1Wins: 2, p1Losses: 1, day: 100 }]);

        expect(rating(result, 1)).toBeGreaterThan(0);
        expect(rating(result, 1)).toBeCloseTo(-rating(result, 2), 3);
    });

    it('keeps two players with an even result at 0', () => {
        const result = computeWholeHistoryRatings([{ player1: 1, player2: 2, p1Wins: 1, p1Losses: 1, day: 100 }]);

        expect(rating(result, 1)).toBeCloseTo(0, 3);
        expect(rating(result, 2)).toBeCloseTo(0, 3);
    });

    it('counts every single game, so a 3-0 weighs more than a 3-2', () => {
        const clean = computeWholeHistoryRatings([{ player1: 1, player2: 2, p1Wins: 3, p1Losses: 0, day: 100 }]);
        const close = computeWholeHistoryRatings([{ player1: 1, player2: 2, p1Wins: 3, p1Losses: 2, day: 100 }]);

        expect(rating(clean, 1)).toBeGreaterThan(rating(close, 1));
        expect(rating(close, 1)).toBeGreaterThan(0);
    });

    it('ignores results without games, self matches and invalid days', () => {
        const result = computeWholeHistoryRatings([
            { player1: 1, player2: 2, p1Wins: 0, p1Losses: 0, day: 100 },
            { player1: 3, player2: 3, p1Wins: 2, p1Losses: 0, day: 100 },
            { player1: 4, player2: 5, p1Wins: 2, p1Losses: 0, day: null },
            { player1: 6, player2: 7, p1Wins: 2, p1Losses: 1, day: 100 }
        ]);

        expect([...result.players.keys()]).toEqual([6, 7]);
        expect(result.matchCount).toBe(1);
        expect(result.gameCount).toBe(3);
    });

    it('lets a rating move further across a longer break', () => {
        const withGap = gap => computeWholeHistoryRatings([
            { player1: 1, player2: 2, p1Wins: 3, p1Losses: 0, day: 100 },
            { player1: 1, player2: 2, p1Wins: 0, p1Losses: 3, day: 100 + gap }
        ]);
        const swing = result => rating(result, 1, 100) - rating(result, 1, result.players.get(1)[1].day);

        expect(swing(withGap(365))).toBeGreaterThan(swing(withGap(1)));
    });

    it('returns one entry per playing day, sorted by day', () => {
        const result = computeWholeHistoryRatings([
            { player1: 1, player2: 2, p1Wins: 2, p1Losses: 0, day: 105 },
            { player1: 1, player2: 3, p1Wins: 2, p1Losses: 1, day: 101 },
            { player1: 1, player2: 2, p1Wins: 0, p1Losses: 2, day: 105 }
        ]);

        expect(result.players.get(1).map(entry => entry.day)).toEqual([101, 105]);
        expect(result.players.get(2).map(entry => entry.day)).toEqual([105]);
    });

    it('is deterministic', () => {
        const matches = syntheticMatches({ seed: 42 });
        const first = computeWholeHistoryRatings(matches);
        const second = computeWholeHistoryRatings(matches);

        expect([...second.players]).toEqual([...first.players]);
    });

    it('reports when the iteration limit stops it before convergence', () => {
        const result = computeWholeHistoryRatings(syntheticMatches(), { maxIterations: 1 });

        expect(result.iterations).toBe(1);
        expect(result.converged).toBe(false);
    });

    it('handles an empty history', () => {
        const result = computeWholeHistoryRatings([]);

        expect(result.players.size).toBe(0);
        expect(result.converged).toBe(true);
    });
});

describe('diffWhrState', () => {
    const computed = new Map([
        [1, [{ day: 10, ratingElo: 50 }, { day: 12, ratingElo: 60 }]],
        [2, [{ day: 10, ratingElo: -50 }]]
    ]);

    it('inserts missing days, updates moved values, deletes days without a result', () => {
        const diff = diffWhrState({
            computed,
            existingHistory: [
                { playerId: 1, day: 10, ratingElo: 50.0001 },
                { playerId: 2, day: 10, ratingElo: -40 },
                { playerId: 2, day: 11, ratingElo: -45 }
            ],
            existingRatings: [
                { playerId: 1, ratingElo: 60 },
                { playerId: 2, ratingElo: -40 },
                { playerId: 3, ratingElo: 25 }
            ]
        });

        expect(diff.upserts).toEqual([
            { playerId: 1, day: 12, ratingElo: 60 },
            { playerId: 2, day: 10, ratingElo: -50 }
        ]);
        expect(diff.inserts).toBe(1);
        expect(diff.updates).toBe(1);
        expect(diff.deletes).toEqual([{ playerId: 2, day: 11 }]);
        expect(diff.ratingUpdates).toEqual([
            { playerId: 2, ratingElo: -50 },
            { playerId: 3, ratingElo: 0 }
        ]);
        expect(hasWhrChanges(diff)).toBe(true);
    });

    it('also rates computed players that have no PlayerStats row yet', () => {
        const diff = diffWhrState({ computed, existingHistory: [], existingRatings: [] });

        expect(diff.ratingUpdates).toEqual([
            { playerId: 1, ratingElo: 60 },
            { playerId: 2, ratingElo: -50 }
        ]);
    });

    it('reports no changes when the stored state already matches', () => {
        const rebuild = buildRebuildState({ computed, existingRatings: [] });
        const diff = diffWhrState({ computed, existingHistory: rebuild.history, existingRatings: rebuild.ratings });

        expect(hasWhrChanges(diff)).toBe(false);
    });

    it('turns any stored state into exactly the rebuild state', () => {
        const matches = syntheticMatches({ seed: 3 });
        const result = computeWholeHistoryRatings(matches);
        const random = createRandom(11);
        const existingHistory = [];
        for (const [playerId, days] of result.players) {
            days.forEach(({ day, ratingElo }, index) => {
                if (index % 3 !== 0) existingHistory.push({ playerId, day, ratingElo: ratingElo + (random() - 0.5) * 40 });
            });
        }
        existingHistory.push({ playerId: 1, day: 1, ratingElo: 12 }, { playerId: 99, day: 5, ratingElo: 30 });
        const existingRatings = [{ playerId: 1, ratingElo: 400 }, { playerId: 99, ratingElo: 30 }, { playerId: 100, ratingElo: 0 }];

        const diff = diffWhrState({ computed: result.players, existingHistory, existingRatings });
        const history = new Map(existingHistory.map(row => [`${row.playerId}:${row.day}`, row.ratingElo]));
        for (const row of diff.deletes) history.delete(`${row.playerId}:${row.day}`);
        for (const row of diff.upserts) history.set(`${row.playerId}:${row.day}`, row.ratingElo);
        const ratings = new Map(existingRatings.map(row => [row.playerId, row.ratingElo]));
        for (const row of diff.ratingUpdates) ratings.set(row.playerId, row.ratingElo);

        const rebuild = buildRebuildState({ computed: result.players, existingRatings });
        expect(history.size).toBe(rebuild.history.length);
        for (const row of rebuild.history) {
            expect(history.get(`${row.playerId}:${row.day}`)).toBeCloseTo(row.ratingElo, 3);
        }
        expect(ratings.size).toBe(rebuild.ratings.length);
        for (const row of rebuild.ratings) {
            expect(ratings.get(row.playerId)).toBeCloseTo(row.ratingElo, 3);
        }
        expect(ratings.get(99)).toBe(0);
    });
});
