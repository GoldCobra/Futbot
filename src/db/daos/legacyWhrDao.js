const { executeQuery, getPool, sql } = require('../sqlClient');
const { bindInputs } = require('../requests');

// WHR works on UTC days. Days are counted from this epoch in SQL and written back as midnight datetimes.
const WHR_DAY_EPOCH = '2000-01-01';

const FINGERPRINT_SELECT = `
    SELECT COUNT_BIG(*) AS MatchCount,
           MAX([Match]) AS MaxMatchId,
           CHECKSUM_AGG(BINARY_CHECKSUM([Match], Player1, Player2, P1Wins, P1Losses, MatchDate, FutureMatch)) AS MatchChecksum
    FROM dbo.Match
    WHERE GameType = @gameType`;

function toFingerprint(row) {
    if (!row) return '0:0:0';
    return `${Number(row.MatchCount ?? 0)}:${Number(row.MaxMatchId ?? 0)}:${Number(row.MatchChecksum ?? 0)}`;
}

function toJsonRows(rows, mapRow) {
    return JSON.stringify(rows.map(mapRow));
}

async function runInTransaction(work) {
    const pool = await getPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
        const result = await work(transaction);
        await transaction.commit();
        return result;
    } catch (error) {
        await transaction.rollback().catch(() => {});
        throw error;
    }
}

// Both writers use the same temp tables: #WhrHistory holds history rows, #WhrRatings final ratings.
const LOAD_TEMP_TABLES = `
    CREATE TABLE #WhrHistory (
        Player INT NOT NULL,
        MatchDate DATETIME2 NOT NULL,
        RatingWHR NUMERIC(19,9) NOT NULL,
        PRIMARY KEY (Player, MatchDate)
    );
    INSERT INTO #WhrHistory (Player, MatchDate, RatingWHR)
    SELECT Player, DATEADD(day, DayNumber, CAST('${WHR_DAY_EPOCH}' AS DATETIME2)), RatingWHR
    FROM OPENJSON(@history) WITH (Player INT '$[0]', DayNumber INT '$[1]', RatingWHR NUMERIC(19,9) '$[2]');

    CREATE TABLE #WhrRatings (
        Player INT NOT NULL PRIMARY KEY,
        RatingWHR NUMERIC(19,9) NOT NULL
    );
    INSERT INTO #WhrRatings (Player, RatingWHR)
    SELECT Player, RatingWHR
    FROM OPENJSON(@ratings) WITH (Player INT '$[0]', RatingWHR NUMERIC(19,9) '$[1]');`;

const WRITE_RATINGS = `
    INSERT INTO dbo.PlayerStats (Player, GameType)
    SELECT r.Player, @gameType
    FROM #WhrRatings r
    WHERE NOT EXISTS (
        SELECT 1 FROM dbo.PlayerStats ps WHERE ps.Player = r.Player AND ps.GameType = @gameType
    );
    SET @statsInserted = @@ROWCOUNT;

    UPDATE ps
    SET RatingWHR = r.RatingWHR
    FROM dbo.PlayerStats ps
    INNER JOIN #WhrRatings r ON r.Player = ps.Player
    WHERE ps.GameType = @gameType
      AND ps.RatingWHR <> r.RatingWHR;
    SET @ratingsUpdated = @@ROWCOUNT;`;

function normalizeCounts(row) {
    return {
        historyDeleted: Number(row?.HistoryDeleted ?? 0),
        historyUpdated: Number(row?.HistoryUpdated ?? 0),
        historyInserted: Number(row?.HistoryInserted ?? 0),
        statsInserted: Number(row?.StatsInserted ?? 0),
        ratingsUpdated: Number(row?.RatingsUpdated ?? 0)
    };
}

class LegacyWhrDao {
    async getMatchFingerprint(gameType) {
        const result = await executeQuery(FINGERPRINT_SELECT, { gameType: [sql.Int, gameType] });
        return toFingerprint(result.recordset[0]);
    }

    /**
     * Loads everything a from-scratch recalculation needs, in one batch so the fingerprint matches the matches.
     * Input rule: every reported 1v1 result of the game (all tournaments and report paths), except
     * FutureMatch rows and results without a single game.
     */
    async loadGameState(gameType) {
        const result = await executeQuery(
            `${FINGERPRINT_SELECT};

             SELECT [Match] AS MatchId,
                    Player1,
                    Player2,
                    P1Wins,
                    P1Losses,
                    DATEDIFF(day, '${WHR_DAY_EPOCH}', CAST(MatchDate AS date)) AS DayNumber
             FROM dbo.Match
             WHERE GameType = @gameType
               AND FutureMatch = 0
               AND P1Wins + P1Losses > 0
             ORDER BY MatchDate ASC, [Match] ASC;

             SELECT Player,
                    DATEDIFF(day, '${WHR_DAY_EPOCH}', CAST(MatchDate AS date)) AS DayNumber,
                    RatingWHR
             FROM dbo.WhrRatingHistory
             WHERE GameType = @gameType;

             SELECT Player, RatingWHR
             FROM dbo.PlayerStats
             WHERE GameType = @gameType;`,
            { gameType: [sql.Int, gameType] }
        );

        const [fingerprintRows = [], matchRows = [], historyRows = [], ratingRows = []] = result.recordsets ?? [];
        return {
            gameType,
            fingerprint: toFingerprint(fingerprintRows[0]),
            matches: matchRows.map(row => ({
                matchId: row.MatchId,
                player1: row.Player1,
                player2: row.Player2,
                p1Wins: row.P1Wins,
                p1Losses: row.P1Losses,
                day: row.DayNumber
            })),
            history: historyRows.map(row => ({
                playerId: row.Player,
                day: row.DayNumber,
                ratingElo: Number(row.RatingWHR)
            })),
            ratings: ratingRows.map(row => ({
                playerId: row.Player,
                ratingElo: Number(row.RatingWHR)
            }))
        };
    }

    /** Writes only the differences of a full recalculation (automatic runs). */
    async applyDiff(gameType, diff) {
        return runInTransaction(async transaction => {
            const request = bindInputs(transaction.request(), {
                gameType: [sql.Int, gameType],
                history: [sql.NVarChar(sql.MAX), toJsonRows(diff.upserts, row => [row.playerId, row.day, row.ratingElo])],
                deletes: [sql.NVarChar(sql.MAX), toJsonRows(diff.deletes, row => [row.playerId, row.day])],
                ratings: [sql.NVarChar(sql.MAX), toJsonRows(diff.ratingUpdates, row => [row.playerId, row.ratingElo])]
            });
            const result = await request.query(`
                SET XACT_ABORT ON;
                DECLARE @historyDeleted INT = 0, @historyUpdated INT = 0, @historyInserted INT = 0,
                        @statsInserted INT = 0, @ratingsUpdated INT = 0;
                ${LOAD_TEMP_TABLES}

                DELETE h
                FROM dbo.WhrRatingHistory h
                INNER JOIN OPENJSON(@deletes) WITH (Player INT '$[0]', DayNumber INT '$[1]') d
                    ON d.Player = h.Player
                   AND h.MatchDate = DATEADD(day, d.DayNumber, CAST('${WHR_DAY_EPOCH}' AS DATETIME2))
                WHERE h.GameType = @gameType;
                SET @historyDeleted = @@ROWCOUNT;

                UPDATE h
                SET RatingWHR = w.RatingWHR
                FROM dbo.WhrRatingHistory h
                INNER JOIN #WhrHistory w ON w.Player = h.Player AND w.MatchDate = h.MatchDate
                WHERE h.GameType = @gameType
                  AND h.RatingWHR <> w.RatingWHR;
                SET @historyUpdated = @@ROWCOUNT;

                INSERT INTO dbo.WhrRatingHistory (Player, GameType, MatchDate, RatingWHR)
                SELECT w.Player, @gameType, w.MatchDate, w.RatingWHR
                FROM #WhrHistory w
                WHERE NOT EXISTS (
                    SELECT 1 FROM dbo.WhrRatingHistory h
                    WHERE h.Player = w.Player AND h.GameType = @gameType AND h.MatchDate = w.MatchDate
                );
                SET @historyInserted = @@ROWCOUNT;
                ${WRITE_RATINGS}

                SELECT @historyDeleted AS HistoryDeleted, @historyUpdated AS HistoryUpdated,
                       @historyInserted AS HistoryInserted, @statsInserted AS StatsInserted,
                       @ratingsUpdated AS RatingsUpdated;`);
            return normalizeCounts(result.recordset?.[0]);
        });
    }

    /** Replaces the whole history of a game and sets the rating of every PlayerStats row (one-time rebuild). */
    async rebuildGame(gameType, rebuild) {
        return runInTransaction(async transaction => {
            const request = bindInputs(transaction.request(), {
                gameType: [sql.Int, gameType],
                history: [sql.NVarChar(sql.MAX), toJsonRows(rebuild.history, row => [row.playerId, row.day, row.ratingElo])],
                ratings: [sql.NVarChar(sql.MAX), toJsonRows(rebuild.ratings, row => [row.playerId, row.ratingElo])]
            });
            const result = await request.query(`
                SET XACT_ABORT ON;
                DECLARE @historyDeleted INT = 0, @historyUpdated INT = 0, @historyInserted INT = 0,
                        @statsInserted INT = 0, @ratingsUpdated INT = 0;
                ${LOAD_TEMP_TABLES}

                DELETE FROM dbo.WhrRatingHistory WHERE GameType = @gameType;
                SET @historyDeleted = @@ROWCOUNT;

                INSERT INTO dbo.WhrRatingHistory (Player, GameType, MatchDate, RatingWHR)
                SELECT Player, @gameType, MatchDate, RatingWHR
                FROM #WhrHistory;
                SET @historyInserted = @@ROWCOUNT;
                ${WRITE_RATINGS}

                SELECT @historyDeleted AS HistoryDeleted, @historyUpdated AS HistoryUpdated,
                       @historyInserted AS HistoryInserted, @statsInserted AS StatsInserted,
                       @ratingsUpdated AS RatingsUpdated;`);
            return normalizeCounts(result.recordset?.[0]);
        });
    }
}

module.exports = LegacyWhrDao;
module.exports.WHR_DAY_EPOCH = WHR_DAY_EPOCH;
