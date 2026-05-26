const { executeQuery, getPool, sql } = require('../sqlClient');
const { competitiveTable, PLACEMENT_GAMES_REQUIRED } = require('../../utils/competitiveConstants');
const {
    advanceRewardProgress,
    createInitialRewardProgress,
    getRewardTierForRank,
    normalizeRewardProgress,
    shouldCountRewardWin,
    shouldEnsureRewardProgress
} = require('../../utils/competitiveSeasonRewards');
const {
    getSeasonAwardDefinition,
    formatAwardMetric
} = require('../../utils/competitiveSeasonAwards');

const T = {
    game: competitiveTable('CompetitiveGame'),
    mode: competitiveTable('CompetitiveMode'),
    season: competitiveTable('CompetitiveSeason'),
    threshold: competitiveTable('CompetitiveRankThreshold'),
    rating: competitiveTable('CompetitivePlayerRating'),
    change: competitiveTable('CompetitiveRatingChange'),
    snapshot: competitiveTable('CompetitiveSeasonSnapshot'),
    ratedMatch: competitiveTable('RatedMatch'),
    ratedParticipant: competitiveTable('RatedMatchParticipant'),
    ratedGame: competitiveTable('RatedMatchGame'),
    rollback: competitiveTable('CompetitiveMatchRollback'),
    rollbackSnapshot: competitiveTable('CompetitiveMatchRollbackChangeSnapshot'),
    rewardProgress: competitiveTable('CompetitiveSeasonRewardProgress'),
    rewardEarned: competitiveTable('CompetitiveSeasonRewardEarned'),
    awardResult: competitiveTable('CompetitiveSeasonAwardResult'),
    awardResultPlayer: competitiveTable('CompetitiveSeasonAwardResultPlayer'),
    leaderboard: competitiveTable('CompetitiveLeaderboard')
};

const SEASON_END_GRACE_MINUTES = 60;

function bindInputs(request, inputs = {}) {
    for (const [key, value] of Object.entries(inputs)) {
        if (Array.isArray(value)) {
            request.input(key, value[0], value[1]);
        } else {
            request.input(key, value);
        }
    }
    return request;
}

async function runRequest(runner, query, inputs = {}) {
    const request = bindInputs(runner.request(), inputs);
    return request.query(query);
}

function toNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizeChangeRow(change) {
    const placementAfter = toNumber(change.PlacementAfter);
    const placementComplete = placementAfter >= PLACEMENT_GAMES_REQUIRED;
    return {
        discordId: change.DiscordId ?? change.DiscordID,
        playerId: change.PlayerId,
        teamNumber: toNumber(change.TeamNumber),
        outcome: change.Outcome,
        eloBefore: toNumber(change.EloBefore),
        eloAfter: toNumber(change.EloAfter),
        eloDelta: toNumber(change.EloDelta),
        rankBefore: toNumber(change.RankBefore),
        rankAfter: toNumber(change.RankAfter),
        placementBefore: toNumber(change.PlacementBefore),
        placementAfter,
        placementComplete,
        placementGamesLeft: placementComplete ? 0 : PLACEMENT_GAMES_REQUIRED - placementAfter
    };
}

function normalizeRewardChange(change) {
    return {
        ratedMatchId: change.RatedMatchId ?? change.ratedMatchId,
        seasonId: change.SeasonId ?? change.seasonId,
        playerId: change.PlayerId ?? change.playerId,
        gameId: change.GameId ?? change.gameId ?? change.gameType,
        modeCode: change.ModeCode ?? change.modeCode ?? change.mode,
        outcome: change.Outcome ?? change.outcome,
        rankAfter: toNumber(change.RankAfter ?? change.rankAfter),
        eloAfter: toNumber(change.EloAfter ?? change.eloAfter),
        placementBefore: toNumber(change.PlacementBefore ?? change.placementBefore),
        placementAfter: toNumber(change.PlacementAfter ?? change.placementAfter)
    };
}

function rankForEloFromThresholds(elo, thresholds) {
    const rank = thresholds
        .filter(row => row.IsActive !== false && toNumber(row.RankNumber) > 0 && toNumber(row.MinElo) <= elo)
        .reduce((highest, row) => Math.max(highest, toNumber(row.RankNumber)), 1);
    return rank || 1;
}

class CompetitiveRatingDao {
    async getActiveSeason() {
        const result = await executeQuery(
            `SELECT TOP 1 Id, SeasonNumber, DisplayName,
                    StartDateUtc AS StartDate, EndDateUtc AS EndDate,
                    StartDateUtc, EndDateUtc, SoftResetFactor,
                    LifecycleStatus, EndingStartedAtUtc, FinalizeAfterUtc,
                    FinalizedAtUtc, ActivatedAtUtc
             FROM ${T.season}
             WHERE IsActive = 1
               AND LifecycleStatus = 'active'
             ORDER BY Id DESC`
        );
        return result.recordset[0] ?? null;
    }

    async getSeasonById(seasonId, runner = null) {
        const query = `SELECT TOP 1 Id, SeasonNumber, DisplayName,
                              StartDateUtc AS StartDate, EndDateUtc AS EndDate,
                              StartDateUtc, EndDateUtc, SoftResetFactor,
                              IsActive, IsCompleted, LifecycleStatus,
                              EndingStartedAtUtc, FinalizeAfterUtc,
                              FinalizedAtUtc, ActivatedAtUtc
                       FROM ${T.season}
                       WHERE Id = @seasonId`;
        const result = runner
            ? await runRequest(runner, query, { seasonId })
            : await executeQuery(query, { seasonId });
        return result.recordset[0] ?? null;
    }

    async getSeasonQueueAvailability() {
        const current = await executeQuery(
            `SELECT TOP 1 Id, SeasonNumber, DisplayName, StartDateUtc, EndDateUtc,
                    IsActive, IsCompleted, LifecycleStatus, FinalizeAfterUtc
             FROM ${T.season}
             WHERE LifecycleStatus IN ('active','ending')
             ORDER BY CASE WHEN LifecycleStatus = 'active' THEN 0 ELSE 1 END, Id DESC`
        );
        const season = current.recordset[0];
        if (season?.LifecycleStatus === 'active' && season.IsActive && new Date(season.EndDateUtc).getTime() > Date.now()) {
            return {
                canQueue: true,
                status: 'active',
                season,
                message: null
            };
        }
        if (season?.LifecycleStatus === 'ending' || season) {
            return {
                canQueue: false,
                status: 'ending',
                season,
                message: 'Season ended. New Season will start soon.'
            };
        }

        const upcoming = await executeQuery(
            `SELECT TOP 1 Id, SeasonNumber, DisplayName, StartDateUtc, EndDateUtc,
                    IsActive, IsCompleted, LifecycleStatus
             FROM ${T.season}
             WHERE LifecycleStatus = 'scheduled'
               AND IsCompleted = 0
             ORDER BY StartDateUtc ASC, Id ASC`
        );
        return {
            canQueue: false,
            status: upcoming.recordset[0] ? 'scheduled' : 'unavailable',
            season: upcoming.recordset[0] ?? null,
            message: 'Season ended. New Season will start soon.'
        };
    }

    async _acquireSeasonTransitionLock(transaction) {
        const result = await runRequest(
            transaction,
            `DECLARE @LockResult INT;
             EXEC @LockResult = sys.sp_getapplock
                @Resource = 'competitive-season-transition',
                @LockMode = 'Exclusive',
                @LockOwner = 'Transaction',
                @LockTimeout = 0;
             SELECT @LockResult AS LockResult;`
        );
        const lockResult = Number(result.recordset[0]?.LockResult ?? -999);
        if (lockResult < 0) {
            return false;
        }
        return true;
    }

    async beginDueSeasonEnding() {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        try {
            if (!await this._acquireSeasonTransitionLock(transaction)) {
                await transaction.commit();
                return null;
            }

            const result = await runRequest(
                transaction,
                `UPDATE ${T.season}
                 SET LifecycleStatus = 'ending',
                     IsActive = 0,
                     EndingStartedAtUtc = COALESCE(EndingStartedAtUtc, SYSUTCDATETIME()),
                     FinalizeAfterUtc = COALESCE(FinalizeAfterUtc, DATEADD(minute, @graceMinutes, EndDateUtc)),
                     TransitionLastAttemptAtUtc = SYSUTCDATETIME(),
                     TransitionAttemptCount = TransitionAttemptCount + 1,
                     TransitionLastError = NULL
                 OUTPUT INSERTED.*
                 WHERE Id = (
                    SELECT TOP 1 Id
                    FROM ${T.season} WITH (UPDLOCK, HOLDLOCK)
                    WHERE LifecycleStatus = 'active'
                      AND IsActive = 1
                      AND EndDateUtc <= SYSUTCDATETIME()
                    ORDER BY EndDateUtc ASC, Id ASC
                 )`,
                { graceMinutes: SEASON_END_GRACE_MINUTES }
            );

            await transaction.commit();
            return result.recordset[0] ?? null;
        } catch (err) {
            await transaction.rollback().catch(() => {});
            throw err;
        }
    }

    async finalizeDueEndingSeason() {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        try {
            if (!await this._acquireSeasonTransitionLock(transaction)) {
                await transaction.commit();
                return null;
            }

            const seasonResult = await runRequest(
                transaction,
                `SELECT TOP 1 *
                 FROM ${T.season} WITH (UPDLOCK, HOLDLOCK)
                 WHERE LifecycleStatus = 'ending'
                   AND FinalizeAfterUtc <= SYSUTCDATETIME()
                 ORDER BY FinalizeAfterUtc ASC, Id ASC`
            );
            const season = seasonResult.recordset[0];
            if (!season) {
                await transaction.commit();
                return null;
            }

            const cancelledResult = await runRequest(
                transaction,
                `DECLARE @CancelledMatches TABLE (
                    Id INT,
                    MatchCode NVARCHAR(100),
                    GameId TINYINT,
                    ModeCode VARCHAR(10),
                    MatchNumber INT,
                    SeasonMatchNumber INT,
                    ThreadId NVARCHAR(30),
                    ThreadUrl NVARCHAR(300)
                 );

                 UPDATE rm
                 SET Status = 'cancelled',
                     CancelReason = 'season_end_cancelled',
                     CancelledAtUtc = SYSUTCDATETIME()
                 OUTPUT INSERTED.Id,
                        INSERTED.MatchCode,
                        INSERTED.GameId,
                        INSERTED.ModeCode,
                        INSERTED.MatchNumber,
                        INSERTED.SeasonMatchNumber,
                        INSERTED.ThreadId,
                        INSERTED.ThreadUrl
                 INTO @CancelledMatches
                 FROM ${T.ratedMatch} rm
                 WHERE rm.SeasonId = @seasonId
                   AND rm.Status IN ('creating','active');

                 SELECT cancelled.*,
                        game.Code AS GameType
                 FROM @CancelledMatches cancelled
                 INNER JOIN ${T.game} game ON game.Id = cancelled.GameId
                 ORDER BY cancelled.Id ASC;`,
                { seasonId: season.Id }
            );

            await runRequest(
                transaction,
                `INSERT INTO ${T.snapshot} (
                    SeasonId, PlayerId, GameId, ModeCode, FinalElo, FinalRankNumber,
                    PeakElo, PeakRankNumber, TotalWins, TotalLosses
                 )
                 SELECT SeasonId, PlayerId, GameId, ModeCode, Elo, RankNumber,
                        PeakElo, PeakRankNumber, MatchWins, MatchLosses
                 FROM ${T.rating} rating
                 WHERE SeasonId = @seasonId
                   AND NOT EXISTS (
                       SELECT 1
                       FROM ${T.snapshot} existing
                       WHERE existing.SeasonId = rating.SeasonId
                         AND existing.PlayerId = rating.PlayerId
                         AND existing.GameId = rating.GameId
                         AND existing.ModeCode = rating.ModeCode
                   )`,
                { seasonId: season.Id }
            );

            const partitionsResult = await runRequest(
                transaction,
                `SELECT game.Id AS GameId, mode.Code AS ModeCode
                 FROM ${T.game} game
                 CROSS JOIN ${T.mode} mode
                 WHERE game.IsActive = 1
                   AND mode.IsActive = 1
                 ORDER BY game.SortOrder ASC, mode.SortOrder ASC`
            );

            const rewardResults = [];
            const awardResults = [];
            for (const partition of partitionsResult.recordset) {
                rewardResults.push({
                    gameId: partition.GameId,
                    mode: partition.ModeCode,
                    ...await this._rebuildRewardPartition(transaction, {
                        seasonId: season.Id,
                        gameId: partition.GameId,
                        mode: partition.ModeCode,
                        writeFinalEarned: true
                    })
                });
                awardResults.push({
                    gameId: partition.GameId,
                    mode: partition.ModeCode,
                    ...await this._rebuildAwardPartition(transaction, {
                        seasonId: season.Id,
                        gameId: partition.GameId,
                        mode: partition.ModeCode
                    })
                });
            }

            const completedResult = await runRequest(
                transaction,
                `UPDATE ${T.season}
                 SET LifecycleStatus = 'completed',
                     IsActive = 0,
                     IsCompleted = 1,
                     FinalizedAtUtc = COALESCE(FinalizedAtUtc, SYSUTCDATETIME()),
                     TransitionLastAttemptAtUtc = SYSUTCDATETIME(),
                     TransitionAttemptCount = TransitionAttemptCount + 1,
                     TransitionLastError = NULL
                 OUTPUT INSERTED.*
                 WHERE Id = @seasonId`,
                { seasonId: season.Id }
            );

            await transaction.commit();
            return {
                season: completedResult.recordset[0] ?? season,
                cancelledMatches: cancelledResult.recordset,
                rewardResults,
                awardResults
            };
        } catch (err) {
            await transaction.rollback().catch(() => {});
            throw err;
        }
    }

    async activateDueSeason() {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        try {
            if (!await this._acquireSeasonTransitionLock(transaction)) {
                await transaction.commit();
                return null;
            }

            const activeOrEnding = await runRequest(
                transaction,
                `SELECT TOP 1 Id
                 FROM ${T.season} WITH (UPDLOCK, HOLDLOCK)
                 WHERE LifecycleStatus IN ('active','ending')
                    OR IsActive = 1`
            );
            if (activeOrEnding.recordset[0]) {
                await transaction.commit();
                return null;
            }

            const nextResult = await runRequest(
                transaction,
                `SELECT TOP 1 *
                 FROM ${T.season} WITH (UPDLOCK, HOLDLOCK)
                 WHERE LifecycleStatus = 'scheduled'
                   AND IsCompleted = 0
                   AND StartDateUtc <= SYSUTCDATETIME()
                 ORDER BY StartDateUtc ASC, Id ASC`
            );
            const nextSeason = nextResult.recordset[0];
            if (!nextSeason) {
                await transaction.commit();
                return null;
            }

            const previousResult = await runRequest(
                transaction,
                `SELECT TOP 1 Id
                 FROM ${T.season}
                 WHERE LifecycleStatus = 'completed'
                   AND IsCompleted = 1
                 ORDER BY EndDateUtc DESC, Id DESC`
            );
            const previousSeasonId = previousResult.recordset[0]?.Id ?? null;
            if (previousSeasonId) {
                const defaultRating = await this.getDefaultRating(transaction);
                await runRequest(
                    transaction,
                    `INSERT INTO ${T.rating} (
                        SeasonId, PlayerId, GameId, ModeCode, Elo, RankNumber,
                        PlacementPlayed, PlacementComplete, PeakElo, PeakRankNumber
                     )
                     SELECT @newSeasonId, PlayerId, GameId, ModeCode,
                            @defaultRating + (Elo - @defaultRating) * @softResetFactor, 0,
                            0, 0,
                            @defaultRating + (Elo - @defaultRating) * @softResetFactor, 0
                     FROM ${T.rating} oldRating
                     WHERE SeasonId = @oldSeasonId
                       AND NOT EXISTS (
                           SELECT 1
                           FROM ${T.rating} newRating
                           WHERE newRating.SeasonId = @newSeasonId
                             AND newRating.PlayerId = oldRating.PlayerId
                             AND newRating.GameId = oldRating.GameId
                             AND newRating.ModeCode = oldRating.ModeCode
                       )`,
                    {
                        newSeasonId: nextSeason.Id,
                        oldSeasonId: previousSeasonId,
                        defaultRating,
                        softResetFactor: nextSeason.SoftResetFactor
                    }
                );
            }

            await runRequest(
                transaction,
                `INSERT INTO ${T.seasonMatchSequence} (SeasonId, GameId, ModeCode, NextSeasonMatchNumber)
                 SELECT @newSeasonId, game.Id, mode.Code, 1
                 FROM ${T.game} game
                 CROSS JOIN ${T.mode} mode
                 WHERE game.IsActive = 1
                   AND mode.IsActive = 1
                   AND NOT EXISTS (
                       SELECT 1
                       FROM ${T.seasonMatchSequence} existing
                       WHERE existing.SeasonId = @newSeasonId
                         AND existing.GameId = game.Id
                         AND existing.ModeCode = mode.Code
                   )`,
                { newSeasonId: nextSeason.Id }
            );

            const activated = await runRequest(
                transaction,
                `UPDATE ${T.season}
                 SET LifecycleStatus = 'active',
                     IsActive = 1,
                     IsCompleted = 0,
                     ActivatedAtUtc = COALESCE(ActivatedAtUtc, SYSUTCDATETIME()),
                     TransitionLastAttemptAtUtc = SYSUTCDATETIME(),
                     TransitionAttemptCount = TransitionAttemptCount + 1,
                     TransitionLastError = NULL
                 OUTPUT INSERTED.*
                 WHERE Id = @newSeasonId`,
                { newSeasonId: nextSeason.Id }
            );

            await transaction.commit();
            return activated.recordset[0] ?? null;
        } catch (err) {
            await transaction.rollback().catch(() => {});
            throw err;
        }
    }

    async getPlayerIdByDiscordId(discordId) {
        const result = await executeQuery(
            'SELECT Id FROM dbo.Player WHERE DiscordID = @discordId',
            { discordId }
        );
        return result.recordset[0]?.Id ?? null;
    }

    async getDiscordIdByPlayerId(playerId) {
        const result = await executeQuery(
            'SELECT DiscordID FROM dbo.Player WHERE Id = @playerId',
            { playerId }
        );
        return result.recordset[0]?.DiscordID ?? null;
    }

    async getPlayerRating(discordId, gameType, seasonId, mode = '1v1') {
        const result = await executeQuery(
            `SELECT cpr.*,
                    cpr.GameId AS GameType,
                    cpr.ModeCode AS Mode,
                    cpr.RankNumber AS Rank,
                    cpr.PeakRankNumber AS PeakRank,
                    crt.Name AS RankName,
                    crt.Tier AS RankTier,
                    crt.DiscordRoleId
             FROM ${T.rating} cpr
             INNER JOIN dbo.Player p ON cpr.PlayerId = p.Id
             LEFT JOIN ${T.threshold} crt
                ON cpr.RankNumber = crt.RankNumber AND crt.IsActive = 1
             WHERE p.DiscordID = @discordId
               AND cpr.GameId = @gameType
               AND cpr.SeasonId = @seasonId
               AND cpr.ModeCode = @mode`,
            { discordId, gameType, seasonId, mode }
        );
        return result.recordset[0] ?? null;
    }

    async getPlayerRatingsByGame(discordId, gameType, seasonId) {
        const result = await executeQuery(
            `SELECT cpr.*,
                    cpr.GameId AS GameType,
                    cpr.ModeCode AS Mode,
                    cpr.RankNumber AS Rank,
                    cpr.PeakRankNumber AS PeakRank,
                    crt.Name AS RankName,
                    crt.Tier AS RankTier,
                    crt.DiscordRoleId
             FROM ${T.rating} cpr
             INNER JOIN dbo.Player p ON cpr.PlayerId = p.Id
             LEFT JOIN ${T.threshold} crt
                ON cpr.RankNumber = crt.RankNumber AND crt.IsActive = 1
             WHERE p.DiscordID = @discordId
               AND cpr.GameId = @gameType
               AND cpr.SeasonId = @seasonId`,
            { discordId, gameType, seasonId }
        );
        return result.recordset;
    }

    async getActiveGames() {
        const result = await executeQuery(
            `SELECT Id, Code, DisplayName, ShortName, SortOrder
             FROM ${T.game}
             WHERE IsActive = 1
             ORDER BY SortOrder ASC, Id ASC`
        );
        return result.recordset;
    }

    async getActiveModes() {
        const result = await executeQuery(
            `SELECT Code, DisplayName, TeamCount, PlayersPerTeam, TotalPlayers, SortOrder
             FROM ${T.mode}
             WHERE IsActive = 1
             ORDER BY SortOrder ASC, Code ASC`
        );
        return result.recordset;
    }

    async getAllRankThresholds() {
        const result = await executeQuery(
            `SELECT * FROM ${T.threshold} WHERE IsActive = 1 ORDER BY RankNumber`
        );
        return result.recordset;
    }

    async getDefaultRating(runner = null) {
        const query = `
            SELECT TOP 1 MinElo
            FROM ${T.threshold}
            WHERE IsActive = 1 AND RankNumber = 0`;
        const result = runner
            ? await runRequest(runner, query)
            : await executeQuery(query);
        const defaultRating = Number(result.recordset[0]?.MinElo);
        if (!Number.isFinite(defaultRating)) {
            throw new Error('CompetitiveRankThreshold rank 0 is missing; cannot determine default competitive rating');
        }
        return defaultRating;
    }

    async getRankNumberForElo(elo, runner = null) {
        const query = `
            SELECT ISNULL(MAX(RankNumber), 1) AS RankNumber
            FROM ${T.threshold}
            WHERE IsActive = 1 AND RankNumber > 0 AND MinElo <= @elo`;
        const result = runner
            ? await runRequest(runner, query, { elo })
            : await executeQuery(query, { elo });
        return result.recordset[0]?.RankNumber ?? 1;
    }

    async getLeaderboard(gameType, seasonId, mode = '1v1') {
        const result = await executeQuery(
            `SELECT *
             FROM ${T.leaderboard}
             WHERE SeasonId = @seasonId
               AND GameType = @gameType
               AND Mode = @mode
             ORDER BY Position ASC`,
            { seasonId, gameType, mode }
        );
        return result.recordset;
    }

    async getAllLeaderboards(seasonId) {
        const result = await executeQuery(
            `SELECT *
             FROM ${T.leaderboard}
             WHERE SeasonId = @seasonId
             ORDER BY GameType ASC, Mode ASC, Position ASC`,
            { seasonId }
        );
        return result.recordset;
    }

    async getBestCompletedOneVOneRank(playerId, seasonId) {
        const result = await executeQuery(
            `SELECT MAX(RankNumber) AS HighestRank
             FROM ${T.rating}
             WHERE PlayerId = @playerId
               AND SeasonId = @seasonId
               AND ModeCode = '1v1'
               AND PlacementComplete = 1`,
            { playerId, seasonId }
        );
        return result.recordset[0]?.HighestRank ?? 0;
    }

    async getSeasonHistory(discordId, gameType) {
        const result = await executeQuery(
            `SELECT css.*,
                    css.GameId AS GameType,
                    css.ModeCode AS Mode,
                    cs.DisplayName AS SeasonName,
                    crt.Name AS PeakRankName,
                    crt.Tier AS PeakRankTier
             FROM ${T.snapshot} css
             INNER JOIN dbo.Player p ON css.PlayerId = p.Id
             INNER JOIN ${T.season} cs ON css.SeasonId = cs.Id
             LEFT JOIN ${T.threshold} crt
                ON css.PeakRankNumber = crt.RankNumber AND crt.IsActive = 1
             WHERE p.DiscordID = @discordId
               AND css.GameId = @gameType
             ORDER BY css.SeasonId DESC, css.ModeCode ASC`,
            { discordId, gameType }
        );
        return result.recordset;
    }

    async recordMatchCompletion({
        ratedMatchId,
        matchCode,
        seasonId,
        gameType,
        mode,
        winnerTeamNumber,
        team1Score,
        team2Score,
        homeTeamNumber,
        awayTeamNumber
    }, calculateDelta) {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);

        await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
        try {
            const matchResult = await runRequest(
                transaction,
                `SELECT TOP 1 Id, SeasonId, GameId, ModeCode
                 FROM ${T.ratedMatch} WITH (UPDLOCK, HOLDLOCK)
                 WHERE (@ratedMatchId IS NOT NULL AND Id = @ratedMatchId)
                    OR (@ratedMatchId IS NULL AND MatchCode = @matchCode)`,
                { ratedMatchId: ratedMatchId ?? null, matchCode }
            );
            const match = matchResult.recordset[0];
            const resolvedRatedMatchId = match?.Id;
            if (!resolvedRatedMatchId) {
                throw new Error(`RatedMatch not found for ${matchCode}`);
            }
            const resolvedSeasonId = match.SeasonId;
            const resolvedGameType = match.GameId;
            const resolvedMode = match.ModeCode;
            if (seasonId != null && Number(seasonId) !== Number(resolvedSeasonId)) {
                throw new Error(`RatedMatch ${resolvedRatedMatchId} belongs to SeasonId ${resolvedSeasonId}, not ${seasonId}`);
            }

            const participantsResult = await runRequest(
                transaction,
                `SELECT rmp.Id AS RatedMatchParticipantId,
                        rmp.RatedMatchId,
                        rmp.PlayerId,
                        rmp.DiscordId,
                        rmp.TeamNumber,
                        rmp.IsRepresentative
                 FROM ${T.ratedParticipant} rmp
                 WHERE rmp.RatedMatchId = @ratedMatchId`,
                { ratedMatchId: resolvedRatedMatchId }
            );
            const participants = participantsResult.recordset;
            if (!participants.length) {
                throw new Error(`No RatedMatch participants found for ${matchCode}`);
            }

            const existingChangesResult = await runRequest(
                transaction,
                `SELECT crc.*,
                        crc.GameId AS GameType,
                        crc.ModeCode AS Mode,
                        p.DiscordID AS DiscordId
                 FROM ${T.change} crc WITH (HOLDLOCK)
                 INNER JOIN dbo.Player p ON crc.PlayerId = p.Id
                 WHERE crc.RatedMatchId = @ratedMatchId
                 ORDER BY crc.Id ASC`,
                { ratedMatchId: resolvedRatedMatchId }
            );
            if (existingChangesResult.recordset.length > 0) {
                if (existingChangesResult.recordset.length !== participants.length) {
                    throw new Error(`Partial CompetitiveRatingChange rows found for ${matchCode}`);
                }
                await transaction.commit();
                return existingChangesResult.recordset.map(normalizeChangeRow);
            }

            const defaultRating = await this.getDefaultRating(transaction);
            const ratingRows = [];
            for (const participant of participants) {
                const rating = await this._getOrCreateRatingForUpdate(transaction, {
                    seasonId: resolvedSeasonId,
                    playerId: participant.PlayerId,
                    gameType: resolvedGameType,
                    mode: resolvedMode,
                    defaultRating
                });
                ratingRows.push({ participant, rating });
            }

            const teamAverages = new Map();
            for (const teamNumber of [1, 2]) {
                const teamRows = ratingRows.filter(row => row.participant.TeamNumber === teamNumber);
                if (!teamRows.length) {
                    throw new Error(`No team ${teamNumber} participants found for ${matchCode}`);
                }
                const average = teamRows.reduce((total, row) => total + Number(row.rating.Elo), 0) / teamRows.length;
                teamAverages.set(teamNumber, average);
            }

            const changes = [];
            for (const row of ratingRows) {
                const isWinner = row.participant.TeamNumber === winnerTeamNumber;
                const rating = row.rating;
                const eloBefore = Number(rating.Elo);
                const rankBefore = Number(rating.RankNumber ?? 0);
                const placementBefore = Number(rating.PlacementPlayed ?? 0);
                const placementCompleteBefore = Boolean(rating.PlacementComplete);
                const opponentTeamNumber = row.participant.TeamNumber === 1 ? 2 : 1;
                const delta = calculateDelta(eloBefore, teamAverages.get(opponentTeamNumber), isWinner ? 1 : 0, !placementCompleteBefore);
                const eloAfter = Math.max(eloBefore + delta, defaultRating);
                const placementAfter = placementBefore + 1;
                const placementCompleteAfter = placementCompleteBefore || placementAfter >= PLACEMENT_GAMES_REQUIRED;
                const rankAfter = placementCompleteAfter
                    ? await this.getRankNumberForElo(eloAfter, transaction)
                    : 0;
                const peakEloAfter = eloAfter > Number(rating.PeakElo) ? eloAfter : Number(rating.PeakElo);
                const peakRankAfter = eloAfter > Number(rating.PeakElo)
                    ? rankAfter
                    : Number(rating.PeakRankNumber ?? 0);

                await runRequest(
                    transaction,
                    `UPDATE ${T.rating}
                     SET Elo = @eloAfter,
                         RankNumber = @rankAfter,
                         MatchWins = MatchWins + @winIncrement,
                         MatchLosses = MatchLosses + @lossIncrement,
                         PlacementPlayed = @placementAfter,
                         PlacementComplete = @placementCompleteAfter,
                         PeakElo = @peakEloAfter,
                         PeakRankNumber = @peakRankAfter,
                         UpdatedAtUtc = SYSUTCDATETIME()
                     WHERE Id = @ratingId`,
                    {
                        ratingId: rating.Id,
                        eloAfter,
                        rankAfter,
                        winIncrement: isWinner ? 1 : 0,
                        lossIncrement: isWinner ? 0 : 1,
                        placementAfter,
                        placementCompleteAfter: placementCompleteAfter ? 1 : 0,
                        peakEloAfter,
                        peakRankAfter
                    }
                );

                await runRequest(
                    transaction,
                    `INSERT INTO ${T.change} (
                        RatedMatchId, RatedMatchParticipantId, SeasonId, PlayerId, GameId, ModeCode,
                        TeamNumber, Outcome, EloBefore, EloAfter, EloDelta,
                        RankBefore, RankAfter, PlacementBefore, PlacementAfter
                     ) VALUES (
                        @ratedMatchId, @ratedMatchParticipantId, @seasonId, @playerId, @gameId, @modeCode,
                        @teamNumber, @outcome, @eloBefore, @eloAfter, @eloDelta,
                        @rankBefore, @rankAfter, @placementBefore, @placementAfter
                     )`,
                    {
                        ratedMatchId: resolvedRatedMatchId,
                        ratedMatchParticipantId: row.participant.RatedMatchParticipantId,
                        seasonId: resolvedSeasonId,
                        playerId: row.participant.PlayerId,
                        gameId: resolvedGameType,
                        modeCode: resolvedMode,
                        teamNumber: row.participant.TeamNumber,
                        outcome: isWinner ? 'win' : 'loss',
                        eloBefore,
                        eloAfter,
                        eloDelta: eloAfter - eloBefore,
                        rankBefore,
                        rankAfter,
                        placementBefore,
                        placementAfter
                    }
                );

                changes.push({
                    ratedMatchId: resolvedRatedMatchId,
                    seasonId: resolvedSeasonId,
                    gameId: resolvedGameType,
                    modeCode: resolvedMode,
                    discordId: row.participant.DiscordId,
                    playerId: row.participant.PlayerId,
                    teamNumber: row.participant.TeamNumber,
                    outcome: isWinner ? 'win' : 'loss',
                    eloBefore,
                    eloAfter,
                    eloDelta: eloAfter - eloBefore,
                    rankBefore,
                    rankAfter,
                    placementBefore,
                    placementAfter,
                    placementComplete: placementCompleteAfter,
                    placementGamesLeft: placementCompleteAfter ? 0 : PLACEMENT_GAMES_REQUIRED - placementAfter
                });
            }

            await this._applySeasonRewardProgressForChanges(transaction, changes);

            await runRequest(
                transaction,
                `UPDATE ${T.ratedMatch}
                 SET Status = 'completed',
                     Team1Score = @team1Score,
                     Team2Score = @team2Score,
                     HomeTeamNumber = @homeTeamNumber,
                     AwayTeamNumber = @awayTeamNumber,
                     WinnerTeamNumber = @winnerTeamNumber,
                     CompletedAtUtc = SYSUTCDATETIME(),
                     CancelledAtUtc = NULL,
                     CancelReason = NULL
                 WHERE (@ratedMatchId IS NOT NULL AND Id = @ratedMatchId)
                    OR (@ratedMatchId IS NULL AND MatchCode = @matchCode)`,
                {
                    ratedMatchId: resolvedRatedMatchId,
                    matchCode,
                    team1Score,
                    team2Score,
                    homeTeamNumber,
                    awayTeamNumber,
                    winnerTeamNumber
                }
            );

            await transaction.commit();
            return changes;
        } catch (err) {
            await transaction.rollback().catch(() => {});
            throw err;
        }
    }

    async rollbackMatchByNumber({ gameId, mode, matchNumber, reason, rolledBackByDiscordId }, calculateDelta) {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        try {
            const matchResult = await runRequest(
                transaction,
                `SELECT TOP 1 rm.*,
                        rm.GameId AS GameType,
                        rm.ModeCode AS Mode,
                        game.Code AS GameCode,
                        game.ShortName AS GameShortName
                 FROM ${T.ratedMatch} rm WITH (UPDLOCK, HOLDLOCK)
                 INNER JOIN ${T.game} game ON game.Id = rm.GameId
                 WHERE rm.GameId = @gameId
                   AND rm.ModeCode = @mode
                   AND rm.MatchNumber = @matchNumber`,
                { gameId, mode, matchNumber }
            );
            const match = matchResult.recordset[0];
            if (!match) {
                await transaction.commit();
                return null;
            }

            await this._acquirePartitionLock(transaction, match.SeasonId, match.GameType, match.Mode);

            if (match.Status === 'rolled_back') {
                const rollback = await this._getRollbackRow(transaction, match.Id);
                if (!rollback) {
                    throw new Error(`Match ${match.GameCode} ${match.Mode} #${match.MatchNumber} is rolled back but has no rollback audit row`);
                }
                const summary = await this._getRollbackSummary(transaction, match, rollback, {
                    alreadyRolledBack: true,
                    snapshotCount: 0,
                    replayedMatchCount: 0,
                    recalculatedChangeCount: 0
                });
                await transaction.commit();
                return summary;
            }

            if (match.Status !== 'completed') {
                throw new Error(`Match ${match.GameCode} ${match.Mode} #${match.MatchNumber} cannot be rolled back because its status is '${match.Status}'`);
            }

            const targetChanges = await this._getMatchChanges(transaction, match.Id);
            if (!targetChanges.length) {
                throw new Error(`Match ${match.GameCode} ${match.Mode} #${match.MatchNumber} has no rating changes to roll back`);
            }

            const rollbackResult = await runRequest(
                transaction,
                `INSERT INTO ${T.rollback} (
                    RatedMatchId, SeasonId, GameId, ModeCode, MatchNumber,
                    RolledBackByDiscordId, Reason
                 )
                 OUTPUT INSERTED.*
                 VALUES (
                    @ratedMatchId, @seasonId, @gameId, @mode, @matchNumber,
                    @rolledBackByDiscordId, @reason
                 )`,
                {
                    ratedMatchId: match.Id,
                    seasonId: match.SeasonId,
                    gameId: match.GameType,
                    mode: match.Mode,
                    matchNumber: match.MatchNumber,
                    rolledBackByDiscordId,
                    reason
                }
            );
            const rollback = rollbackResult.recordset[0];

            const snapshotResult = await runRequest(
                transaction,
                `INSERT INTO ${T.rollbackSnapshot} (
                    RollbackId, CompetitiveRatingChangeId, RatedMatchId, RatedMatchParticipantId,
                    SeasonId, PlayerId, GameId, ModeCode, TeamNumber, Outcome,
                    EloBefore, EloAfter, EloDelta, RankBefore, RankAfter,
                    PlacementBefore, PlacementAfter, OriginalCreatedAtUtc
                 )
                 SELECT @rollbackId, crc.Id, crc.RatedMatchId, crc.RatedMatchParticipantId,
                        crc.SeasonId, crc.PlayerId, crc.GameId, crc.ModeCode, crc.TeamNumber, crc.Outcome,
                        crc.EloBefore, crc.EloAfter, crc.EloDelta, crc.RankBefore, crc.RankAfter,
                        crc.PlacementBefore, crc.PlacementAfter, crc.CreatedAtUtc
                 FROM ${T.change} crc
                 WHERE crc.SeasonId = @seasonId
                   AND crc.GameId = @gameId
                   AND crc.ModeCode = @mode
                   AND NOT EXISTS (
                       SELECT 1
                       FROM ${T.rollbackSnapshot} existing
                       WHERE existing.RollbackId = @rollbackId
                         AND existing.CompetitiveRatingChangeId = crc.Id
                   );
                 SELECT @@ROWCOUNT AS SnapshotCount;`,
                {
                    rollbackId: rollback.Id,
                    seasonId: match.SeasonId,
                    gameId: match.GameType,
                    mode: match.Mode
                }
            );
            const snapshotCount = snapshotResult.recordset[0]?.SnapshotCount ?? 0;

            await runRequest(
                transaction,
                `UPDATE ${T.ratedMatch}
                 SET Status = 'rolled_back'
                 WHERE Id = @ratedMatchId`,
                { ratedMatchId: match.Id }
            );

            const seasonStatus = await runRequest(
                transaction,
                `SELECT TOP 1 IsCompleted FROM ${T.season} WHERE Id = @seasonId`,
                { seasonId: match.SeasonId }
            );
            const seasonCompleted = Boolean(seasonStatus.recordset[0]?.IsCompleted);
            const rebuild = await this._rebuildRatingPartition(transaction, {
                seasonId: match.SeasonId,
                gameId: match.GameType,
                mode: match.Mode,
                calculateDelta,
                writeFinalRewards: seasonCompleted
            });
            const awardRebuild = seasonCompleted
                ? await this._rebuildAwardPartition(transaction, {
                    seasonId: match.SeasonId,
                    gameId: match.GameType,
                    mode: match.Mode
                })
                : null;
            const summary = await this._getRollbackSummary(transaction, {
                ...match,
                Status: 'rolled_back'
            }, rollback, {
                alreadyRolledBack: false,
                snapshotCount,
                replayedMatchCount: rebuild.replayedMatchCount,
                recalculatedChangeCount: rebuild.recalculatedChangeCount,
                recalculatedRewardCount: rebuild.recalculatedRewardCount,
                recalculatedAwardResultCount: awardRebuild?.insertedAwardResults ?? 0,
                originalChanges: targetChanges
            });

            await transaction.commit();
            return summary;
        } catch (err) {
            await transaction.rollback().catch(() => {});
            throw err;
        }
    }

    async updateRollbackThreadStatus({ rollbackId, threadNoticeMessageId = null, threadFinalizeStatus }) {
        await executeQuery(
            `UPDATE ${T.rollback}
             SET ThreadNoticeMessageId = COALESCE(@threadNoticeMessageId, ThreadNoticeMessageId),
                 ThreadFinalizeStatus = @threadFinalizeStatus
             WHERE Id = @rollbackId`,
            { rollbackId, threadNoticeMessageId, threadFinalizeStatus }
        );
    }

    async rebuildSeasonRewardProgress({ seasonId, gameId, mode }) {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        try {
            await this._acquirePartitionLock(transaction, seasonId, gameId, mode);
            const result = await this._rebuildRewardPartition(transaction, {
                seasonId,
                gameId,
                mode,
                writeFinalEarned: false
            });
            await transaction.commit();
            return result;
        } catch (err) {
            await transaction.rollback().catch(() => {});
            throw err;
        }
    }

    async finalizeSeasonRewards({ seasonId, gameId, mode }) {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        try {
            await this._assertSeasonCompleted(transaction, seasonId);
            await this._acquirePartitionLock(transaction, seasonId, gameId, mode);
            const result = await this._rebuildRewardPartition(transaction, {
                seasonId,
                gameId,
                mode,
                writeFinalEarned: true
            });
            await transaction.commit();
            return result;
        } catch (err) {
            await transaction.rollback().catch(() => {});
            throw err;
        }
    }

    async rebuildSeasonRewards({ seasonId, gameId, mode }) {
        return this.finalizeSeasonRewards({ seasonId, gameId, mode });
    }

    async finalizeSeasonRewardsForSeason(seasonId) {
        const partitions = await executeQuery(
            `SELECT season.Id AS SeasonId, game.Id AS GameId, mode.Code AS ModeCode
             FROM ${T.season} season
             CROSS JOIN ${T.game} game
             CROSS JOIN ${T.mode} mode
             WHERE season.Id = @seasonId
               AND season.IsCompleted = 1
             ORDER BY game.SortOrder ASC, mode.SortOrder ASC`,
            { seasonId }
        );
        if (!partitions.recordset.length) {
            await this._assertSeasonCompleted(null, seasonId);
        }

        const results = [];
        for (const partition of partitions.recordset) {
            const result = await this.finalizeSeasonRewards({
                seasonId: partition.SeasonId,
                gameId: partition.GameId,
                mode: partition.ModeCode
            });
            results.push({
                seasonId: partition.SeasonId,
                gameId: partition.GameId,
                mode: partition.ModeCode,
                ...result
            });
        }
        return results;
    }

    async rebuildAllSeasonRewards() {
        const seasons = await executeQuery(
            `SELECT Id
             FROM ${T.season}
             WHERE IsCompleted = 1
             ORDER BY Id ASC`
        );
        const results = [];
        for (const season of seasons.recordset) {
            const seasonResults = await this.finalizeSeasonRewardsForSeason(season.Id);
            results.push(...seasonResults);
        }
        return results;
    }

    async rebuildSeasonAwards({ seasonId, gameId, mode }) {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        try {
            await this._assertSeasonCompleted(transaction, seasonId);
            await this._acquireSeasonAwardLock(transaction, seasonId, gameId, mode);
            const result = await this._rebuildAwardPartition(transaction, { seasonId, gameId, mode });
            await transaction.commit();
            return result;
        } catch (err) {
            await transaction.rollback().catch(() => {});
            throw err;
        }
    }

    async rebuildSeasonAwardsForSeason(seasonId) {
        const partitions = await executeQuery(
            `SELECT season.Id AS SeasonId, game.Id AS GameId, mode.Code AS ModeCode
             FROM ${T.season} season
             CROSS JOIN ${T.game} game
             CROSS JOIN ${T.mode} mode
             WHERE season.Id = @seasonId
               AND season.IsCompleted = 1
             ORDER BY game.SortOrder ASC, mode.SortOrder ASC`,
            { seasonId }
        );
        if (!partitions.recordset.length) {
            await this._assertSeasonCompleted(null, seasonId);
        }

        const results = [];
        for (const partition of partitions.recordset) {
            const result = await this.rebuildSeasonAwards({
                seasonId: partition.SeasonId,
                gameId: partition.GameId,
                mode: partition.ModeCode
            });
            results.push({
                seasonId: partition.SeasonId,
                gameId: partition.GameId,
                mode: partition.ModeCode,
                ...result
            });
        }
        return results;
    }

    async _assertSeasonCompleted(runner, seasonId) {
        const result = runner
            ? await runRequest(
                runner,
                `SELECT TOP 1 Id, IsCompleted FROM ${T.season} WHERE Id = @seasonId`,
                { seasonId }
            )
            : await executeQuery(
                `SELECT TOP 1 Id, IsCompleted FROM ${T.season} WHERE Id = @seasonId`,
                { seasonId }
            );
        const season = result.recordset[0];
        if (!season) {
            throw new Error(`Competitive season ${seasonId} does not exist`);
        }
        if (!season.IsCompleted) {
            throw new Error(`Competitive season ${seasonId} is not completed; final rewards and awards cannot be rebuilt`);
        }
        return season;
    }

    async rebuildAllSeasonAwards() {
        const partitions = await executeQuery(
            `SELECT DISTINCT rm.SeasonId, rm.GameId, rm.ModeCode
             FROM ${T.ratedMatch} rm
             INNER JOIN ${T.season} season ON season.Id = rm.SeasonId
             WHERE rm.Status = 'completed'
               AND season.IsCompleted = 1
             ORDER BY rm.SeasonId, rm.GameId, rm.ModeCode`
        );
        const results = [];
        for (const partition of partitions.recordset) {
            const result = await this.rebuildSeasonAwards({
                seasonId: partition.SeasonId,
                gameId: partition.GameId,
                mode: partition.ModeCode
            });
            results.push({
                seasonId: partition.SeasonId,
                gameId: partition.GameId,
                mode: partition.ModeCode,
                ...result
            });
        }
        return results;
    }

    async _acquirePartitionLock(transaction, seasonId, gameId, mode) {
        const result = await runRequest(
            transaction,
            `DECLARE @LockResult INT;
             EXEC @LockResult = sys.sp_getapplock
                @Resource = @resource,
                @LockMode = 'Exclusive',
                @LockOwner = 'Transaction',
                @LockTimeout = 15000;
             SELECT @LockResult AS LockResult;`,
            { resource: `competitive-rating-rebuild:${seasonId}:${gameId}:${mode}` }
        );
        const lockResult = Number(result.recordset[0]?.LockResult ?? -999);
        if (lockResult < 0) {
            throw new Error(`Could not acquire competitive rating rebuild lock (${lockResult})`);
        }
    }

    async _acquireSeasonAwardLock(transaction, seasonId, gameId, mode) {
        const result = await runRequest(
            transaction,
            `DECLARE @LockResult INT;
             EXEC @LockResult = sys.sp_getapplock
                @Resource = @resource,
                @LockMode = 'Exclusive',
                @LockOwner = 'Transaction',
                @LockTimeout = 15000;
             SELECT @LockResult AS LockResult;`,
            { resource: `competitive-season-awards:${seasonId}:${gameId}:${mode}` }
        );
        const lockResult = Number(result.recordset[0]?.LockResult ?? -999);
        if (lockResult < 0) {
            throw new Error(`Could not acquire competitive season award lock (${lockResult})`);
        }
    }

    async _getRollbackRow(transaction, ratedMatchId) {
        const result = await runRequest(
            transaction,
            `SELECT TOP 1 *
             FROM ${T.rollback}
             WHERE RatedMatchId = @ratedMatchId`,
            { ratedMatchId }
        );
        return result.recordset[0] ?? null;
    }

    async _getMatchChanges(transaction, ratedMatchId) {
        const result = await runRequest(
            transaction,
            `SELECT crc.*,
                    crc.GameId AS GameType,
                    crc.ModeCode AS Mode,
                    p.DiscordID AS DiscordId,
                    p.Name AS PlayerName
             FROM ${T.change} crc
             INNER JOIN dbo.Player p ON p.Id = crc.PlayerId
             WHERE crc.RatedMatchId = @ratedMatchId
             ORDER BY crc.TeamNumber ASC, crc.Id ASC`,
            { ratedMatchId }
        );
        return result.recordset;
    }

    async _getRollbackSummary(transaction, match, rollback, stats = {}) {
        const defaultRating = await this.getDefaultRating(transaction);
        const changes = stats.originalChanges ?? await this._getMatchChanges(transaction, match.Id);
        const ratingsResult = await runRequest(
            transaction,
            `SELECT rmp.PlayerId,
                    rmp.DiscordId,
                    rmp.TeamNumber,
                    p.Name AS PlayerName,
                    cpr.Elo AS CurrentElo,
                    cpr.RankNumber AS CurrentRankNumber
             FROM ${T.ratedParticipant} rmp
             INNER JOIN dbo.Player p ON p.Id = rmp.PlayerId
             LEFT JOIN ${T.rating} cpr
                ON cpr.SeasonId = @seasonId
               AND cpr.PlayerId = rmp.PlayerId
               AND cpr.GameId = @gameId
               AND cpr.ModeCode = @mode
             WHERE rmp.RatedMatchId = @ratedMatchId
             ORDER BY rmp.TeamNumber ASC, rmp.Id ASC`,
            {
                seasonId: match.SeasonId,
                gameId: match.GameType,
                mode: match.Mode,
                ratedMatchId: match.Id
            }
        );

        return {
            status: stats.alreadyRolledBack ? 'already_rolled_back' : 'rolled_back',
            alreadyRolledBack: Boolean(stats.alreadyRolledBack),
            rollbackId: rollback.Id,
            seasonId: match.SeasonId,
            gameId: match.GameType,
            gameCode: match.GameCode,
            mode: match.Mode,
            matchId: match.Id,
            matchCode: match.MatchCode,
            matchNumber: match.MatchNumber,
            threadId: match.ThreadId,
            threadUrl: match.ThreadUrl,
            reason: rollback.Reason,
            rolledBackByDiscordId: rollback.RolledBackByDiscordId,
            threadNoticeMessageId: rollback.ThreadNoticeMessageId ?? null,
            threadFinalizeStatus: rollback.ThreadFinalizeStatus ?? 'pending',
            snapshotCount: stats.snapshotCount ?? 0,
            replayedMatchCount: stats.replayedMatchCount ?? 0,
            recalculatedChangeCount: stats.recalculatedChangeCount ?? 0,
            recalculatedRewardCount: stats.recalculatedRewardCount ?? 0,
            recalculatedAwardResultCount: stats.recalculatedAwardResultCount ?? 0,
            changes: changes.map(normalizeChangeRow),
            currentRatings: ratingsResult.recordset.map(row => ({
                playerId: row.PlayerId,
                discordId: row.DiscordId,
                playerName: row.PlayerName,
                teamNumber: toNumber(row.TeamNumber),
                currentElo: toNumber(row.CurrentElo, defaultRating),
                currentRankNumber: toNumber(row.CurrentRankNumber, 0)
            }))
        };
    }

    async _rebuildAwardPartition(transaction, { seasonId, gameId, mode }) {
        await runRequest(
            transaction,
            `DELETE playerRows
             FROM ${T.awardResultPlayer} playerRows
             INNER JOIN ${T.awardResult} result
                ON result.Id = playerRows.AwardResultId
             WHERE result.SeasonId = @seasonId
               AND result.GameId = @gameId
               AND result.ModeCode = @mode;

             DELETE FROM ${T.awardResult}
             WHERE SeasonId = @seasonId
               AND GameId = @gameId
               AND ModeCode = @mode;`,
            { seasonId, gameId, mode }
        );

        const partition = { seasonId, gameId, mode };
        let insertedAwardResults = 0;
        insertedAwardResults += await this._insertTop10Awards(transaction, partition);
        insertedAwardResults += await this._insertRatingMetricAward(transaction, partition, {
            awardCode: 'MOST_WINS',
            metricExpression: 'MatchWins',
            whereClause: 'MatchWins > 0',
            metricSuffix: 'wins'
        });
        insertedAwardResults += await this._insertBiggestUpsetAwards(transaction, partition);
        insertedAwardResults += await this._insertMatchCountAward(transaction, partition, {
            awardCode: 'CLUTCH_PLAYER',
            condition: `(
                CASE WHEN rm.WinnerTeamNumber = 1 THEN rm.Team2Score ELSE rm.Team1Score END
            ) = rm.FirstTo - 1`,
            metricSuffix: 'clutch wins'
        });
        insertedAwardResults += await this._insertMatchCountAward(transaction, partition, {
            awardCode: 'SWEEP_SPECIALIST',
            condition: `rm.FirstTo > 1 AND (
                CASE WHEN rm.WinnerTeamNumber = 1 THEN rm.Team2Score ELSE rm.Team1Score END
            ) <= rm.FirstTo - 2`,
            metricSuffix: 'sweeps'
        });
        insertedAwardResults += await this._insertMatchCountAward(transaction, partition, {
            awardCode: 'COMEBACK_KING',
            condition: `EXISTS (
                SELECT 1
                FROM ${T.ratedGame} firstGame
                WHERE firstGame.RatedMatchId = rm.Id
                  AND firstGame.GameNumber = 1
                  AND firstGame.WinnerTeamNumber <> rm.WinnerTeamNumber
            )`,
            metricSuffix: 'comeback wins'
        });
        insertedAwardResults += await this._insertRatingMetricAward(transaction, partition, {
            awardCode: 'MOST_ACTIVE',
            metricExpression: 'MatchWins + MatchLosses',
            whereClause: 'MatchWins + MatchLosses > 0',
            metricSuffix: 'matches'
        });
        insertedAwardResults += await this._insertRatingMetricAward(transaction, partition, {
            awardCode: 'IRON_PLAYER',
            metricExpression: 'MatchWins + MatchLosses',
            whereClause: 'MatchWins + MatchLosses > 0 AND MatchWins * 2 >= MatchWins + MatchLosses',
            metricSuffix: 'matches'
        });
        if (mode === '2v2') {
            insertedAwardResults += await this._insertDuoOfTheSeasonAwards(transaction, partition);
        }

        return { insertedAwardResults };
    }

    async _insertSeasonAwardResult(transaction, partition, {
        awardCode,
        rankPosition = 1,
        metricValue,
        metricLabel,
        ratedMatchId = null,
        playerIds
    }) {
        if (!playerIds?.length) return 0;
        const award = getSeasonAwardDefinition(awardCode);
        if (!award) {
            throw new Error(`Unknown competitive season award code '${awardCode}'`);
        }
        const result = await runRequest(
            transaction,
            `INSERT INTO ${T.awardResult} (
                SeasonId, GameId, ModeCode, AwardCode, AwardName,
                RankPosition, MetricValue, MetricLabel, RatedMatchId
             )
             OUTPUT INSERTED.Id
             VALUES (
                @seasonId, @gameId, @mode, @awardCode, @awardName,
                @rankPosition, @metricValue, @metricLabel, @ratedMatchId
             )`,
            {
                ...partition,
                awardCode,
                awardName: award.name,
                rankPosition,
                metricValue: Number(metricValue ?? 0),
                metricLabel: metricLabel ?? null,
                ratedMatchId
            }
        );
        const awardResultId = result.recordset[0]?.Id;
        for (const [index, playerId] of playerIds.entries()) {
            await runRequest(
                transaction,
                `INSERT INTO ${T.awardResultPlayer} (AwardResultId, PlayerId, SlotNumber)
                 VALUES (@awardResultId, @playerId, @slotNumber)`,
                {
                    awardResultId,
                    playerId,
                    slotNumber: index + 1
                }
            );
        }
        return 1;
    }

    async _insertTop10Awards(transaction, partition) {
        const result = await runRequest(
            transaction,
            `WITH ranked AS (
                SELECT
                    ROW_NUMBER() OVER (
                        ORDER BY Elo DESC, MatchWins DESC, MatchLosses ASC, UpdatedAtUtc ASC, PlayerId ASC
                    ) AS Position,
                    PlayerId,
                    Elo
                FROM ${T.rating}
                WHERE SeasonId = @seasonId
                  AND GameId = @gameId
                  AND ModeCode = @mode
                  AND PlacementComplete = 1
                  AND MatchWins + MatchLosses > 0
             )
             SELECT Position, PlayerId, CAST(Elo AS DECIMAL(19,4)) AS MetricValue
             FROM ranked
             WHERE Position <= 10
             ORDER BY Position ASC`,
            partition
        );
        let count = 0;
        for (const row of result.recordset) {
            count += await this._insertSeasonAwardResult(transaction, partition, {
                awardCode: 'TOP_10',
                rankPosition: row.Position,
                metricValue: row.MetricValue,
                metricLabel: formatAwardMetric(row.MetricValue, 'ELO'),
                playerIds: [row.PlayerId]
            });
        }
        return count;
    }

    async _insertRatingMetricAward(transaction, partition, {
        awardCode,
        metricExpression,
        whereClause,
        metricSuffix
    }) {
        const result = await runRequest(
            transaction,
            `WITH candidates AS (
                SELECT PlayerId, CAST(${metricExpression} AS DECIMAL(19,4)) AS MetricValue
                FROM ${T.rating}
                WHERE SeasonId = @seasonId
                  AND GameId = @gameId
                  AND ModeCode = @mode
                  AND ${whereClause}
             ),
             best AS (
                SELECT MAX(MetricValue) AS MetricValue FROM candidates
             )
             SELECT candidates.PlayerId, candidates.MetricValue
             FROM candidates
             CROSS JOIN best
             WHERE best.MetricValue IS NOT NULL
               AND candidates.MetricValue = best.MetricValue
             ORDER BY candidates.PlayerId ASC`,
            partition
        );
        let count = 0;
        for (const row of result.recordset) {
            count += await this._insertSeasonAwardResult(transaction, partition, {
                awardCode,
                metricValue: row.MetricValue,
                metricLabel: formatAwardMetric(row.MetricValue, metricSuffix),
                playerIds: [row.PlayerId]
            });
        }
        return count;
    }

    async _insertBiggestUpsetAwards(transaction, partition) {
        const result = await runRequest(
            transaction,
            `WITH teamAverages AS (
                SELECT RatedMatchId, TeamNumber, AVG(EloBefore) AS AverageEloBefore
                FROM ${T.change}
                WHERE SeasonId = @seasonId
                  AND GameId = @gameId
                  AND ModeCode = @mode
                GROUP BY RatedMatchId, TeamNumber
             ),
             upsets AS (
                SELECT
                    crc.PlayerId,
                    rm.Id AS RatedMatchId,
                    CAST(loser.AverageEloBefore - winner.AverageEloBefore AS DECIMAL(19,4)) AS MetricValue
                FROM ${T.ratedMatch} rm
                INNER JOIN ${T.change} crc
                    ON crc.RatedMatchId = rm.Id
                   AND crc.TeamNumber = rm.WinnerTeamNumber
                   AND crc.Outcome = 'win'
                INNER JOIN teamAverages winner
                    ON winner.RatedMatchId = rm.Id
                   AND winner.TeamNumber = rm.WinnerTeamNumber
                INNER JOIN teamAverages loser
                    ON loser.RatedMatchId = rm.Id
                   AND loser.TeamNumber <> rm.WinnerTeamNumber
                WHERE rm.SeasonId = @seasonId
                  AND rm.GameId = @gameId
                  AND rm.ModeCode = @mode
                  AND rm.Status = 'completed'
                  AND loser.AverageEloBefore > winner.AverageEloBefore
             ),
             best AS (
                SELECT MAX(MetricValue) AS MetricValue FROM upsets
             )
             SELECT upsets.PlayerId, upsets.RatedMatchId, upsets.MetricValue
             FROM upsets
             CROSS JOIN best
             WHERE best.MetricValue IS NOT NULL
               AND upsets.MetricValue = best.MetricValue
             ORDER BY upsets.RatedMatchId ASC, upsets.PlayerId ASC`,
            partition
        );
        let count = 0;
        for (const row of result.recordset) {
            count += await this._insertSeasonAwardResult(transaction, partition, {
                awardCode: 'BIGGEST_UPSET',
                metricValue: row.MetricValue,
                metricLabel: formatAwardMetric(row.MetricValue, 'ELO underdog'),
                ratedMatchId: row.RatedMatchId,
                playerIds: [row.PlayerId]
            });
        }
        return count;
    }

    async _insertMatchCountAward(transaction, partition, {
        awardCode,
        condition,
        metricSuffix
    }) {
        const result = await runRequest(
            transaction,
            `WITH candidates AS (
                SELECT crc.PlayerId, CAST(COUNT(*) AS DECIMAL(19,4)) AS MetricValue
                FROM ${T.ratedMatch} rm
                INNER JOIN ${T.change} crc
                    ON crc.RatedMatchId = rm.Id
                   AND crc.TeamNumber = rm.WinnerTeamNumber
                   AND crc.Outcome = 'win'
                WHERE rm.SeasonId = @seasonId
                  AND rm.GameId = @gameId
                  AND rm.ModeCode = @mode
                  AND rm.Status = 'completed'
                  AND ${condition}
                GROUP BY crc.PlayerId
             ),
             best AS (
                SELECT MAX(MetricValue) AS MetricValue FROM candidates
             )
             SELECT candidates.PlayerId, candidates.MetricValue
             FROM candidates
             CROSS JOIN best
             WHERE best.MetricValue IS NOT NULL
               AND candidates.MetricValue = best.MetricValue
             ORDER BY candidates.PlayerId ASC`,
            partition
        );
        let count = 0;
        for (const row of result.recordset) {
            count += await this._insertSeasonAwardResult(transaction, partition, {
                awardCode,
                metricValue: row.MetricValue,
                metricLabel: formatAwardMetric(row.MetricValue, metricSuffix),
                playerIds: [row.PlayerId]
            });
        }
        return count;
    }

    async _insertDuoOfTheSeasonAwards(transaction, partition) {
        const result = await runRequest(
            transaction,
            `WITH winningPairs AS (
                SELECT
                    CASE WHEN p1.PlayerId < p2.PlayerId THEN p1.PlayerId ELSE p2.PlayerId END AS PlayerId1,
                    CASE WHEN p1.PlayerId < p2.PlayerId THEN p2.PlayerId ELSE p1.PlayerId END AS PlayerId2
                FROM ${T.ratedMatch} rm
                INNER JOIN ${T.ratedParticipant} p1
                    ON p1.RatedMatchId = rm.Id
                   AND p1.TeamNumber = rm.WinnerTeamNumber
                INNER JOIN ${T.ratedParticipant} p2
                    ON p2.RatedMatchId = rm.Id
                   AND p2.TeamNumber = rm.WinnerTeamNumber
                   AND p2.PlayerId <> p1.PlayerId
                WHERE rm.SeasonId = @seasonId
                  AND rm.GameId = @gameId
                  AND rm.ModeCode = @mode
                  AND rm.Status = 'completed'
                  AND rm.ModeCode = '2v2'
             ),
             candidates AS (
                SELECT PlayerId1, PlayerId2, CAST(COUNT(*) / 2 AS DECIMAL(19,4)) AS MetricValue
                FROM winningPairs
                GROUP BY PlayerId1, PlayerId2
             ),
             best AS (
                SELECT MAX(MetricValue) AS MetricValue FROM candidates
             )
             SELECT candidates.PlayerId1, candidates.PlayerId2, candidates.MetricValue
             FROM candidates
             CROSS JOIN best
             WHERE best.MetricValue IS NOT NULL
               AND candidates.MetricValue = best.MetricValue
               AND candidates.MetricValue > 0
             ORDER BY candidates.PlayerId1 ASC, candidates.PlayerId2 ASC`,
            partition
        );
        let count = 0;
        for (const row of result.recordset) {
            count += await this._insertSeasonAwardResult(transaction, partition, {
                awardCode: 'DUO_OF_THE_SEASON',
                metricValue: row.MetricValue,
                metricLabel: formatAwardMetric(row.MetricValue, 'duo wins'),
                playerIds: [row.PlayerId1, row.PlayerId2]
            });
        }
        return count;
    }

    async _getRewardProgressForUpdate(transaction, change) {
        const existing = await runRequest(
            transaction,
            `SELECT TOP 1 *
             FROM ${T.rewardProgress} WITH (UPDLOCK, HOLDLOCK)
             WHERE SeasonId = @seasonId
               AND PlayerId = @playerId
               AND GameId = @gameId
               AND ModeCode = @modeCode`,
            change
        );
        if (existing.recordset[0]) {
            return normalizeRewardProgress(existing.recordset[0]);
        }

        const initial = createInitialRewardProgress();
        const inserted = await runRequest(
            transaction,
            `INSERT INTO ${T.rewardProgress} (
                SeasonId, PlayerId, GameId, ModeCode,
                HighestEarnedTier, HighestEarnedTierOrder,
                CurrentTargetTier, CurrentTargetTierOrder,
                CurrentTargetWins, RequiredWins
             )
             OUTPUT INSERTED.*
             VALUES (
                @seasonId, @playerId, @gameId, @modeCode,
                @highestEarnedTier, @highestEarnedTierOrder,
                @currentTargetTier, @currentTargetTierOrder,
                @currentTargetWins, @requiredWins
             )`,
            {
                ...change,
                highestEarnedTier: initial.highestEarnedTier,
                highestEarnedTierOrder: initial.highestEarnedTierOrder,
                currentTargetTier: initial.currentTargetTier,
                currentTargetTierOrder: initial.currentTargetTierOrder,
                currentTargetWins: initial.currentTargetWins,
                requiredWins: initial.requiredWins
            }
        );
        return normalizeRewardProgress(inserted.recordset[0]);
    }

    async _saveRewardProgress(transaction, change, progress) {
        await runRequest(
            transaction,
            `UPDATE ${T.rewardProgress}
             SET HighestEarnedTier = @highestEarnedTier,
                 HighestEarnedTierOrder = @highestEarnedTierOrder,
                 CurrentTargetTier = @currentTargetTier,
                 CurrentTargetTierOrder = @currentTargetTierOrder,
                 CurrentTargetWins = @currentTargetWins,
                 RequiredWins = @requiredWins,
                 UpdatedAtUtc = SYSUTCDATETIME()
             WHERE SeasonId = @seasonId
               AND PlayerId = @playerId
               AND GameId = @gameId
               AND ModeCode = @modeCode`,
            {
                ...change,
                highestEarnedTier: progress.highestEarnedTier,
                highestEarnedTierOrder: progress.highestEarnedTierOrder,
                currentTargetTier: progress.currentTargetTier,
                currentTargetTierOrder: progress.currentTargetTierOrder,
                currentTargetWins: progress.currentTargetWins,
                requiredWins: progress.requiredWins
            }
        );
    }

    async _insertRewardEarned(transaction, change, earnedTier) {
        const result = await runRequest(
            transaction,
            `INSERT INTO ${T.rewardEarned} (
                SeasonId, PlayerId, GameId, ModeCode,
                Tier, TierOrder, RatedMatchId, RankAfter, EloAfter
             )
             SELECT @seasonId, @playerId, @gameId, @modeCode,
                    @tier, @tierOrder, @ratedMatchId, @rankAfter, @eloAfter
             WHERE NOT EXISTS (
                SELECT 1
                FROM ${T.rewardEarned}
                WHERE SeasonId = @seasonId
                  AND PlayerId = @playerId
                  AND GameId = @gameId
                  AND ModeCode = @modeCode
                  AND Tier = @tier
             )`,
            {
                ...change,
                tier: earnedTier.tier,
                tierOrder: earnedTier.order
            }
        );
        return result.rowsAffected?.[0] ?? 0;
    }

    async _applySeasonRewardProgressForChanges(transaction, rawChanges, thresholds = null, options = {}) {
        if (!rawChanges?.length) {
            return { progressRowsTouched: 0, earnedRowsInserted: 0 };
        }
        const writeFinalEarned = Boolean(options.writeFinalEarned);

        const resolvedThresholds = thresholds ?? (await runRequest(
            transaction,
            `SELECT RankNumber, Tier, Name, IsActive
             FROM ${T.threshold}
             WHERE IsActive = 1
             ORDER BY RankNumber ASC`
        )).recordset;

        let progressRowsTouched = 0;
        let earnedRowsInserted = 0;
        for (const rawChange of rawChanges) {
            const change = normalizeRewardChange(rawChange);
            if (!shouldEnsureRewardProgress(change)) {
                continue;
            }

            let progress = await this._getRewardProgressForUpdate(transaction, change);
            progressRowsTouched += 1;
            if (!shouldCountRewardWin(change)) {
                continue;
            }

            const qualifyingTier = getRewardTierForRank(change.rankAfter, resolvedThresholds);
            const advanced = advanceRewardProgress(progress, qualifyingTier?.order);
            if (!advanced.counted) {
                continue;
            }

            progress = advanced.progress;
            if (advanced.earnedTier && writeFinalEarned) {
                earnedRowsInserted += await this._insertRewardEarned(transaction, change, advanced.earnedTier);
            }
            await this._saveRewardProgress(transaction, change, progress);
        }

        return { progressRowsTouched, earnedRowsInserted };
    }

    async _rebuildRewardPartition(transaction, { seasonId, gameId, mode, writeFinalEarned = false }) {
        const deleteFinalRows = writeFinalEarned
            ? `DELETE FROM ${T.rewardEarned}
               WHERE SeasonId = @seasonId
                 AND GameId = @gameId
                 AND ModeCode = @mode;`
            : '';
        await runRequest(
            transaction,
            `${deleteFinalRows}
             DELETE FROM ${T.rewardProgress}
             WHERE SeasonId = @seasonId
               AND GameId = @gameId
               AND ModeCode = @mode;`,
            { seasonId, gameId, mode }
        );

        const thresholds = (await runRequest(
            transaction,
            `SELECT RankNumber, Tier, Name, IsActive
             FROM ${T.threshold}
             WHERE IsActive = 1
             ORDER BY RankNumber ASC`
        )).recordset;
        const changes = await runRequest(
            transaction,
            `SELECT crc.RatedMatchId,
                    crc.SeasonId,
                    crc.PlayerId,
                    crc.GameId,
                    crc.ModeCode,
                    crc.Outcome,
                    crc.RankAfter,
                    crc.EloAfter,
                    crc.PlacementBefore,
                    crc.PlacementAfter
             FROM ${T.change} crc
             INNER JOIN ${T.ratedMatch} rm ON rm.Id = crc.RatedMatchId
             WHERE crc.SeasonId = @seasonId
               AND crc.GameId = @gameId
               AND crc.ModeCode = @mode
               AND rm.Status = 'completed'
             ORDER BY rm.CompletedAtUtc ASC, rm.Id ASC, crc.Id ASC`,
            { seasonId, gameId, mode }
        );
        return this._applySeasonRewardProgressForChanges(transaction, changes.recordset, thresholds, { writeFinalEarned });
    }

    async _rebuildRatingPartition(transaction, { seasonId, gameId, mode, calculateDelta, writeFinalRewards = false }) {
        const defaultRating = await this.getDefaultRating(transaction);
        const thresholdsResult = await runRequest(
            transaction,
            `SELECT RankNumber, MinElo, IsActive
             FROM ${T.threshold}
             WHERE IsActive = 1
             ORDER BY RankNumber ASC`
        );
        const thresholds = thresholdsResult.recordset;
        const allChangesResult = await runRequest(
            transaction,
            `SELECT crc.*,
                    rm.CompletedAtUtc,
                    rm.Id AS MatchSortId
             FROM ${T.change} crc WITH (HOLDLOCK)
             INNER JOIN ${T.ratedMatch} rm ON rm.Id = crc.RatedMatchId
             WHERE crc.SeasonId = @seasonId
               AND crc.GameId = @gameId
               AND crc.ModeCode = @mode
             ORDER BY rm.CompletedAtUtc ASC, rm.Id ASC, crc.Id ASC`,
            { seasonId, gameId, mode }
        );
        const states = new Map();
        const ensureState = (playerId, base = null) => {
            if (!states.has(playerId)) {
                const baseElo = toNumber(base?.EloBefore, defaultRating);
                const baseRank = toNumber(base?.RankBefore, 0);
                const basePlacement = toNumber(base?.PlacementBefore, 0);
                states.set(playerId, {
                    playerId,
                    elo: baseElo,
                    rank: baseRank,
                    wins: 0,
                    losses: 0,
                    placementPlayed: basePlacement,
                    placementComplete: basePlacement >= PLACEMENT_GAMES_REQUIRED,
                    peakElo: baseElo,
                    peakRank: baseRank
                });
            }
            return states.get(playerId);
        };

        for (const change of allChangesResult.recordset) {
            ensureState(change.PlayerId, change);
        }

        const matchesResult = await runRequest(
            transaction,
            `SELECT Id, SeasonId, GameId AS GameType, ModeCode AS Mode,
                    WinnerTeamNumber, Team1Score, Team2Score, CompletedAtUtc, MatchNumber
             FROM ${T.ratedMatch} WITH (HOLDLOCK)
             WHERE SeasonId = @seasonId
               AND GameId = @gameId
               AND ModeCode = @mode
               AND Status = 'completed'
             ORDER BY CompletedAtUtc ASC, Id ASC`,
            { seasonId, gameId, mode }
        );
        const participantsResult = await runRequest(
            transaction,
            `SELECT rmp.Id AS RatedMatchParticipantId,
                    rmp.RatedMatchId,
                    rmp.PlayerId,
                    rmp.DiscordId,
                    rmp.TeamNumber
             FROM ${T.ratedParticipant} rmp
             INNER JOIN ${T.ratedMatch} rm ON rm.Id = rmp.RatedMatchId
             WHERE rm.SeasonId = @seasonId
               AND rm.GameId = @gameId
               AND rm.ModeCode = @mode
               AND rm.Status = 'completed'
             ORDER BY rm.CompletedAtUtc ASC, rm.Id ASC, rmp.TeamNumber ASC, rmp.Id ASC`,
            { seasonId, gameId, mode }
        );
        const participantsByMatch = new Map();
        for (const participant of participantsResult.recordset) {
            if (!participantsByMatch.has(participant.RatedMatchId)) {
                participantsByMatch.set(participant.RatedMatchId, []);
            }
            participantsByMatch.get(participant.RatedMatchId).push(participant);
            ensureState(participant.PlayerId);
        }

        let recalculatedChangeCount = 0;
        for (const match of matchesResult.recordset) {
            const participants = participantsByMatch.get(match.Id) ?? [];
            if (!participants.length) {
                throw new Error(`Completed match ${match.Id} has no participants during rating rebuild`);
            }

            const teamAverages = new Map();
            for (const teamNumber of [1, 2]) {
                const teamRows = participants.filter(row => Number(row.TeamNumber) === teamNumber);
                if (!teamRows.length) {
                    throw new Error(`Completed match ${match.Id} has no team ${teamNumber} participants during rating rebuild`);
                }
                const average = teamRows.reduce((total, row) => total + ensureState(row.PlayerId).elo, 0) / teamRows.length;
                teamAverages.set(teamNumber, average);
            }

            const nextStates = [];
            for (const participant of participants) {
                const state = ensureState(participant.PlayerId);
                const isWinner = Number(participant.TeamNumber) === Number(match.WinnerTeamNumber);
                const opponentTeamNumber = Number(participant.TeamNumber) === 1 ? 2 : 1;
                const eloBefore = state.elo;
                const rankBefore = state.rank;
                const placementBefore = state.placementPlayed;
                const delta = calculateDelta(eloBefore, teamAverages.get(opponentTeamNumber), isWinner ? 1 : 0, !state.placementComplete);
                const eloAfter = Math.max(eloBefore + delta, defaultRating);
                const placementAfter = placementBefore + 1;
                const placementCompleteAfter = state.placementComplete || placementAfter >= PLACEMENT_GAMES_REQUIRED;
                const rankAfter = placementCompleteAfter
                    ? rankForEloFromThresholds(eloAfter, thresholds)
                    : 0;
                const peakEloAfter = eloAfter > state.peakElo ? eloAfter : state.peakElo;
                const peakRankAfter = eloAfter > state.peakElo ? rankAfter : state.peakRank;

                const updateResult = await runRequest(
                    transaction,
                    `UPDATE ${T.change}
                     SET RatedMatchParticipantId = @ratedMatchParticipantId,
                         SeasonId = @seasonId,
                         GameId = @gameId,
                         ModeCode = @mode,
                         TeamNumber = @teamNumber,
                         Outcome = @outcome,
                         EloBefore = @eloBefore,
                         EloAfter = @eloAfter,
                         EloDelta = @eloDelta,
                         RankBefore = @rankBefore,
                         RankAfter = @rankAfter,
                         PlacementBefore = @placementBefore,
                         PlacementAfter = @placementAfter
                     WHERE RatedMatchId = @ratedMatchId
                       AND PlayerId = @playerId`,
                    {
                        ratedMatchParticipantId: participant.RatedMatchParticipantId,
                        seasonId,
                        gameId,
                        mode,
                        teamNumber: participant.TeamNumber,
                        outcome: isWinner ? 'win' : 'loss',
                        eloBefore,
                        eloAfter,
                        eloDelta: eloAfter - eloBefore,
                        rankBefore,
                        rankAfter,
                        placementBefore,
                        placementAfter,
                        ratedMatchId: match.Id,
                        playerId: participant.PlayerId
                    }
                );
                if ((updateResult.rowsAffected?.[0] ?? 0) !== 1) {
                    throw new Error(`Missing CompetitiveRatingChange for match ${match.Id}, player ${participant.PlayerId} during rating rebuild`);
                }
                recalculatedChangeCount += 1;
                nextStates.push({
                    state,
                    eloAfter,
                    rankAfter,
                    placementAfter,
                    placementCompleteAfter,
                    peakEloAfter,
                    peakRankAfter,
                    isWinner
                });
            }

            for (const next of nextStates) {
                next.state.elo = next.eloAfter;
                next.state.rank = next.rankAfter;
                next.state.placementPlayed = next.placementAfter;
                next.state.placementComplete = next.placementCompleteAfter;
                next.state.peakElo = next.peakEloAfter;
                next.state.peakRank = next.peakRankAfter;
                next.state.wins += next.isWinner ? 1 : 0;
                next.state.losses += next.isWinner ? 0 : 1;
            }
        }

        for (const state of states.values()) {
            await runRequest(
                transaction,
                `IF EXISTS (
                    SELECT 1 FROM ${T.rating}
                    WHERE SeasonId = @seasonId
                      AND PlayerId = @playerId
                      AND GameId = @gameId
                      AND ModeCode = @mode
                 )
                 BEGIN
                    UPDATE ${T.rating}
                    SET Elo = @elo,
                        RankNumber = @rank,
                        MatchWins = @wins,
                        MatchLosses = @losses,
                        PlacementPlayed = @placementPlayed,
                        PlacementComplete = @placementComplete,
                        PeakElo = @peakElo,
                        PeakRankNumber = @peakRank,
                        UpdatedAtUtc = SYSUTCDATETIME()
                    WHERE SeasonId = @seasonId
                      AND PlayerId = @playerId
                      AND GameId = @gameId
                      AND ModeCode = @mode;
                 END
                 ELSE
                 BEGIN
                    INSERT INTO ${T.rating} (
                        SeasonId, PlayerId, GameId, ModeCode, Elo, RankNumber,
                        MatchWins, MatchLosses, PlacementPlayed, PlacementComplete,
                        PeakElo, PeakRankNumber
                    )
                    VALUES (
                        @seasonId, @playerId, @gameId, @mode, @elo, @rank,
                        @wins, @losses, @placementPlayed, @placementComplete,
                        @peakElo, @peakRank
                    );
                 END`,
                {
                    seasonId,
                    playerId: state.playerId,
                    gameId,
                    mode,
                    elo: state.elo,
                    rank: state.rank,
                    wins: state.wins,
                    losses: state.losses,
                    placementPlayed: state.placementPlayed,
                    placementComplete: state.placementComplete ? 1 : 0,
                    peakElo: state.peakElo,
                    peakRank: state.peakRank
                }
            );
        }

        const rewards = await this._rebuildRewardPartition(transaction, {
            seasonId,
            gameId,
            mode,
            writeFinalEarned: writeFinalRewards
        });

        return {
            replayedMatchCount: matchesResult.recordset.length,
            recalculatedChangeCount,
            recalculatedRewardProgressCount: rewards.progressRowsTouched,
            recalculatedRewardEarnedCount: rewards.earnedRowsInserted,
            recalculatedRewardCount: writeFinalRewards ? rewards.earnedRowsInserted : rewards.progressRowsTouched
        };
    }

    async _getOrCreateRatingForUpdate(transaction, { seasonId, playerId, gameType, mode, defaultRating }) {
        const ratingStart = Number(defaultRating);
        if (!Number.isFinite(ratingStart)) {
            throw new Error('Default competitive rating is not available');
        }
        const existing = await runRequest(
            transaction,
            `SELECT TOP 1 *
             FROM ${T.rating} WITH (UPDLOCK, HOLDLOCK)
             WHERE SeasonId = @seasonId
               AND PlayerId = @playerId
               AND GameId = @gameType
               AND ModeCode = @mode`,
            { seasonId, playerId, gameType, mode }
        );
        if (existing.recordset[0]) return existing.recordset[0];

        await runRequest(
            transaction,
            `INSERT INTO ${T.rating} (
                SeasonId, PlayerId, GameId, ModeCode,
                Elo, RankNumber, PeakElo, PeakRankNumber
             )
             VALUES (
                @seasonId, @playerId, @gameType, @mode,
                @defaultRating, 0, @defaultRating, 0
             )`,
            { seasonId, playerId, gameType, mode, defaultRating: ratingStart }
        );
        const created = await runRequest(
            transaction,
            `SELECT TOP 1 *
             FROM ${T.rating} WITH (UPDLOCK, HOLDLOCK)
             WHERE SeasonId = @seasonId
               AND PlayerId = @playerId
               AND GameId = @gameType
               AND ModeCode = @mode`,
            { seasonId, playerId, gameType, mode }
        );
        return created.recordset[0];
    }
}

module.exports = CompetitiveRatingDao;
