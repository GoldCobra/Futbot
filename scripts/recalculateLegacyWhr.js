/**
 * Manual control over the legacy WHR (dbo.WhrRatingHistory, dbo.PlayerStats.RatingWHR).
 *
 *   node scripts/recalculateLegacyWhr.js                     dry run: full recalculation, prints what would change
 *   node scripts/recalculateLegacyWhr.js --apply             writes the differences (same as the bot does)
 *   node scripts/recalculateLegacyWhr.js --rebuild --apply   replaces the whole history of each game
 *   node scripts/recalculateLegacyWhr.js --game=MSBL         limits the run to one game (MSC, SMS, MSBL or 1-3)
 *   node scripts/recalculateLegacyWhr.js --backup            copies the affected tables into *_Backup_<yyyymmdd>
 *   node scripts/recalculateLegacyWhr.js --legacy-stats [--apply]
 *                                                            counts futbot's legacy mirrors into PlayerStats
 */
const { closePool, executeQuery, sql } = require('../src/db/sqlClient');
const LegacyWhrDao = require('../src/db/daos/legacyWhrDao');
const CompetitiveWhrSyncDao = require('../src/db/daos/competitiveWhrSyncDao');
const { competitiveTable } = require('../src/utils/competitiveConstants');
const { computeWholeHistoryRatings, diffWhrState, buildRebuildState } = require('../src/services/wholeHistoryRating');
const { WHR_GAME_TYPES } = require('../src/services/competitiveWhrRunner');

const GAME_CODES = { 1: 'MSC', 2: 'SMS', 3: 'MSBL' };

function parseArgs(argv) {
    const args = new Set(argv.filter(arg => arg.startsWith('--') && !arg.includes('=')));
    const gameArg = argv.find(arg => arg.startsWith('--game='))?.split('=')[1];
    let gameTypes = [...WHR_GAME_TYPES];
    if (gameArg) {
        const byCode = Object.entries(GAME_CODES).find(([, code]) => code === gameArg.toUpperCase());
        const gameType = byCode ? Number(byCode[0]) : Number(gameArg);
        if (!WHR_GAME_TYPES.includes(gameType)) throw new Error(`Unknown game '${gameArg}'`);
        gameTypes = [gameType];
    }
    return {
        apply: args.has('--apply'),
        rebuild: args.has('--rebuild'),
        backup: args.has('--backup'),
        legacyStats: args.has('--legacy-stats'),
        gameTypes
    };
}

function quantile(sorted, fraction) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function backupTables() {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const tables = [
        ['dbo.WhrRatingHistory', `dbo.WhrRatingHistory_Backup_${stamp}`],
        ['dbo.PlayerStats', `dbo.PlayerStats_Backup_${stamp}`],
        ['dbo.Match', `dbo.Match_Backup_${stamp}`],
        [competitiveTable('CompetitiveWhrSync'), competitiveTable(`CompetitiveWhrSync_Backup_${stamp}`)]
    ];
    const guards = tables.map(([, target]) => (
        `IF OBJECT_ID(N'${target}', 'U') IS NOT NULL THROW 51000, 'Backup table ${target} already exists.', 1;`
    )).join('\n');
    const copies = tables.map(([source, target]) => `SELECT * INTO ${target} FROM ${source};`).join('\n');
    const counts = tables.map(([source, target]) => (
        `SELECT N'${target}' AS BackupTable, (SELECT COUNT(*) FROM ${source}) AS SourceRows, (SELECT COUNT(*) FROM ${target}) AS BackupRows`
    )).join('\nUNION ALL\n');

    const result = await executeQuery(`
        SET XACT_ABORT ON;
        ${guards}
        BEGIN TRANSACTION;
        ${copies}
        COMMIT TRANSACTION;
        ${counts};
    `);
    console.table(result.recordset);
}

async function runLegacyStats(apply) {
    const syncTable = competitiveTable('CompetitiveWhrSync');
    const preview = await executeQuery(`
        SELECT sync.ModeCode,
               COUNT(*) AS PendingRows,
               SUM(CASE
                       WHEN sync.ModeCode = '1v1' AND legacy.Notes = CONCAT('CompetitiveRatedMatch:', sync.RatedMatchId) THEN 1
                       WHEN sync.ModeCode = '2v2' AND legacyMulti.Tournament = 'Competitive Rated'
                            AND legacyMulti.Channel = CONCAT('Competitive Rated ', game.Code, ' ', sync.ModeCode, ' #', sync.MatchNumber) THEN 1
                       ELSE 0
                   END) AS MirrorsToCount
        FROM ${syncTable} sync
        INNER JOIN ${competitiveTable('CompetitiveGame')} game ON game.Id = sync.GameId
        LEFT JOIN dbo.Match legacy ON legacy.[Match] = sync.LegacyMatchId
        LEFT JOIN dbo.MultiMatch legacyMulti ON legacyMulti.ID = sync.LegacyMultiMatchId
        WHERE sync.SyncStatus = 'synced'
          AND sync.LegacyStatsAppliedAtUtc IS NULL
        GROUP BY sync.ModeCode`);
    console.log('Legacy stats still to apply (rows not yet stamped):');
    console.table(preview.recordset);

    if (!apply) {
        console.log('Dry run. Re-run with --legacy-stats --apply to count them into PlayerStats.');
        return;
    }
    const result = await new CompetitiveWhrSyncDao().applyPendingLegacyStats();
    console.log('Applied:', result);
}

async function loadPlayerNames(playerIds) {
    if (!playerIds.length) return new Map();
    const result = await executeQuery(
        `SELECT p.ID, p.Name
         FROM dbo.Player p
         INNER JOIN OPENJSON(@ids) WITH (Id INT '$') ids ON ids.Id = p.ID`,
        { ids: [sql.NVarChar(sql.MAX), JSON.stringify(playerIds)] }
    );
    return new Map(result.recordset.map(row => [row.ID, row.Name]));
}

async function recalculateGame(dao, gameType, { apply, rebuild }) {
    const code = GAME_CODES[gameType];
    const startedAt = Date.now();
    const state = await dao.loadGameState(gameType);
    const computed = computeWholeHistoryRatings(state.matches);
    const computeMs = Date.now() - startedAt;
    const diff = diffWhrState({
        computed: computed.players,
        existingHistory: state.history,
        existingRatings: state.ratings
    });

    const storedHistory = new Map(state.history.map(row => [`${row.playerId}:${row.day}`, row.ratingElo]));
    const deltas = [];
    for (const [playerId, days] of computed.players) {
        for (const { day, ratingElo } of days) {
            const stored = storedHistory.get(`${playerId}:${day}`);
            if (stored != null) deltas.push(Math.abs(stored - ratingElo));
        }
    }
    deltas.sort((a, b) => a - b);

    const storedRatings = new Map(state.ratings.map(row => [row.playerId, row.ratingElo]));
    const movers = diff.ratingUpdates
        .map(update => ({ playerId: update.playerId, before: storedRatings.get(update.playerId) ?? null, after: update.ratingElo }))
        .map(row => ({ ...row, change: row.after - (row.before ?? 0) }))
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
        .slice(0, 10);
    const names = await loadPlayerNames(movers.map(row => row.playerId));

    console.log(`\n=== ${code} (GameType ${gameType})`);
    console.table([{
        matches: computed.matchCount,
        games: computed.gameCount,
        players: computed.players.size,
        iterations: computed.iterations,
        converged: computed.converged,
        computeMs,
        historyRows: [...computed.players.values()].reduce((sum, days) => sum + days.length, 0),
        storedHistoryRows: state.history.length,
        inserts: diff.inserts,
        updates: diff.updates,
        deletes: diff.deletes.length,
        ratingUpdates: diff.ratingUpdates.length,
        medianDeltaElo: Number(quantile(deltas, 0.5).toFixed(3)),
        p95DeltaElo: Number(quantile(deltas, 0.95).toFixed(3)),
        maxDeltaElo: Number((deltas[deltas.length - 1] ?? 0).toFixed(3))
    }]);
    if (movers.length) {
        console.log('Largest rating changes (shown as 1000 + RatingWHR):');
        console.table(movers.map(row => ({
            player: names.get(row.playerId) ?? row.playerId,
            before: row.before == null ? null : Math.round(1000 + row.before),
            after: Math.round(1000 + row.after),
            change: Number(row.change.toFixed(1))
        })));
    }

    if (!computed.converged) {
        throw new Error(`${code}: WHR did not converge after ${computed.iterations} iterations; nothing written.`);
    }
    if (!apply) return;

    const written = rebuild
        ? await dao.rebuildGame(gameType, buildRebuildState({ computed: computed.players, existingRatings: state.ratings }))
        : await dao.applyDiff(gameType, diff);
    console.log(`${code}: ${rebuild ? 'rebuilt' : 'applied'}`, written);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.backup) {
        await backupTables();
        return;
    }
    if (options.legacyStats) {
        await runLegacyStats(options.apply);
        return;
    }

    const dao = new LegacyWhrDao();
    for (const gameType of options.gameTypes) {
        await recalculateGame(dao, gameType, options);
    }
    if (!options.apply) {
        console.log(`\nDry run. Re-run with --apply${options.rebuild ? ' --rebuild' : ''} to write.`);
    }
}

main().catch(error => {
    console.error(`Legacy WHR recalculation failed: ${error.message}`);
    process.exitCode = 1;
}).finally(closePool);
