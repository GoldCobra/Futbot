const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const customIds = require('../../src/services/competitiveRatedQueue/customIds');
const formatting = require('../../src/services/competitiveRatedQueue/formatting');
const matchLogic = require('../../src/services/competitiveRatedQueue/matchLogic');
const matchState = require('../../src/services/competitiveRatedQueue/matchState');
const matchTransitions = require('../../src/services/competitiveRatedQueue/matchTransitions');
const messages = require('../../src/services/competitiveRatedQueue/messages');
const privatePrompts = require('../../src/services/competitiveRatedQueue/privatePrompts');
const runtimeState = require('../../src/services/competitiveRatedQueue/runtimeState');
const competitiveRatedQueue = require('../../src/services/competitiveRatedQueue');

describe('competitiveRatedQueue internal modules', () => {
    it('keeps the public competitiveRatedQueue facade API stable', () => {
        expect(Object.keys(competitiveRatedQueue).sort()).toEqual([
            '__createCompetitiveRatedMatchForTests',
            '__flushOutputQueuesForTests',
            '__flushRuntimeLogsForTests',
            '__getStateSnapshot',
            '__resetState',
            '__runMatchmakingForTests',
            '__runRuntimeLogCleanupForTests',
            '__runSeasonTransitionsForTests',
            '__seedStateForTests',
            '__tickForTests',
            'applyLoserChoice',
            'areSinglesSearchesCompatible',
            'buildBalancedDoublesTeams',
            'buildCaptainSelectionConfirmationPayload',
            'buildInitialGameSetupPayloads',
            'buildLeavePoolLabel',
            'buildMatchComponents',
            'buildMatchFoundPayload',
            'buildPanelMessage',
            'buildSearchExpiredPayload',
            'buildSearchExpiryWarningPayload',
            'buildStadiumSelectionConfirmationPayload',
            'buildStartPayload',
            'buildStatusMessageContent',
            'buildThreadUrl',
            'clearMatchedInteractionResponse',
            'computeFirstTo',
            'enforcePanelMessagePolicy',
            'ensureCompetitiveRatedQueue',
            'getCompetitiveRatedBusyReason',
            'getGameImagePath',
            'getPlayerQueueProfile',
            'handleInteraction',
            'isCompetitiveRatedInteraction',
            'isManagedPanelChannel',
            'isUserInLiveQueue',
            'normalizeDiscordId',
            'renderFinalMatchResultMessage',
            'renderGameResultMessage',
            'resetCompetitiveRatedQueue'
        ]);
    });

    it('builds and parses match custom ids with optional action tokens', () => {
        const stadiumId = customIds.stadiumButtonCustomId('match-1', 'lava pit', 2);
        const extendId = customIds.extendSearchCustomId('search-1', 15, 'warn-token');

        expect(stadiumId).toBe('rated:competitive:match:stadium:match-1:lava%20pit:2');
        expect(customIds.parseIdFromCustomId(stadiumId)).toBe('match-1');
        expect(customIds.parseOptionValueFromCustomId(stadiumId)).toBe('lava pit');
        expect(customIds.parseActionTokenFromCustomId(stadiumId)).toBe('2');
        expect(customIds.actionTokenMatches(stadiumId, 2)).toBe(true);
        expect(customIds.actionTokenMatches(stadiumId, 3)).toBe(false);

        expect(extendId).toBe('rated:competitive:search:extend:search-1:15:warn-token');
        expect(customIds.parseIdFromCustomId(extendId)).toBe('search-1');
        expect(customIds.parseActionTokenFromCustomId(extendId)).toBe('warn-token');
    });

    it('normalizes terminal thread names and quote formatting', () => {
        expect(formatting.stripThreadTerminalPrefix('🚫 CANCELLED | ✅ 1v1 #4 | A VS B'))
            .toBe('1v1 #4 | A VS B');
        expect(formatting.buildTerminalThreadName({ threadName: '✅ 1v1 #4 | A VS B' }, '🚫'))
            .toBe('🚫 1v1 #4 | A VS B');
        expect(formatting.formatRelativeTimestampFromMs(1_005_000))
            .toBe('<t:1005:R>');
        expect(formatting.renderCountdownLine(1_005_000, '**5 mins**'))
            .toBe('<:bltime:986232783569551360> Time remaining: <t:1005:R>.');
        expect(formatting.quoteThreadLines('Line one\n\n> Line two'))
            .toBe('> Line one\n>\n> Line two');
        expect(formatting.quoteThreadBlock('Block\nText'))
            .toBe('>>> Block\nText');
    });

    it('clamps game image paths to the available rated match images', () => {
        expect(messages.getGameImagePath(0).replace(/\\/g, '/')).toContain('/rated-matches/g1.png');
        expect(messages.getGameImagePath(9).replace(/\\/g, '/')).toContain('/rated-matches/g3.png');
    });

    it('keeps match flow helpers deterministic', () => {
        expect(matchLogic.computeFirstTo(3, 5, 5, 7)).toBe(3);
        expect(matchLogic.applyLoserChoice(1, 2, 'home')).toEqual({ homeTeamIndex: 2, awayTeamIndex: 1 });
        expect(matchLogic.applyLoserChoice(1, 2, 'captain')).toEqual({ homeTeamIndex: 1, awayTeamIndex: 2 });
    });

    it('tracks match action tokens and pending results outside the service facade', () => {
        const match = {
            id: 'match-1',
            controlVersion: 2,
            score: { team1: 1, team2: 0 },
            stage: 'awaiting_winner',
            teams: [
                { repMention: '<@home-user>' },
                { repMention: '<@away-user>' }
            ]
        };

        expect(matchState.requiresSetup('MSC')).toBe(true);
        expect(matchState.requiresSetup('MSBL')).toBe(false);
        expect(matchState.getNextGameNumber(match)).toBe(2);
        expect(matchState.getMatchActionToken(match, 2)).toBe('2.2');
        expect(matchState.matchActionTokenMatches(match, 'rated:competitive:match:winner:match-1:2.2', 2)).toBe(true);
        expect(matchState.matchActionTokenMatches(match, 'rated:competitive:match:winner:match-1:2.1', 2)).toBe(false);

        matchState.setPendingResult(match, {
            gameNumber: 2,
            winnerTeamIndex: 1,
            winnerMention: '<@home-user>',
            loserTeamIndex: 2
        });
        expect(matchState.getPendingResultGameNumber(match)).toBe(2);
        expect(matchState.getPendingResultLoserTeamIndex(match)).toBe(2);
        expect(matchState.getPendingResultWinnerMention(match)).toBe('<@home-user>');
        matchState.clearPendingResult(match);
        expect(match.pendingResult).toBeNull();
        expect(match.loserTeamIndex).toBeNull();
    });

    it('acknowledges a match transition before running the queued transition', async () => {
        const calls = [];
        const interaction = { customId: 'rated:competitive:match:winner:match-1', user: { id: 'user-1' } };
        const match = { id: 'match-1' };

        await matchTransitions.runMatchTransition({
            interaction,
            match,
            matchAction: 'winner',
            lockKey: 'match:match-1',
            ensureDeferredReply: async () => calls.push('ack'),
            ensureDeferredUpdate: async () => calls.push('update'),
            rememberPrivateDeliveryInteraction: () => calls.push('remember'),
            withInteractionLock: async (_key, callback) => {
                calls.push('lock');
                return await callback();
            },
            transition: async () => {
                calls.push('transition');
                return true;
            }
        });

        expect(calls).toEqual(['ack', 'remember', 'lock', 'transition']);
    });

    it('does not run a match transition when interaction acknowledgement fails', async () => {
        const calls = [];
        const interaction = { customId: 'rated:competitive:match:start:match-1', user: { id: 'user-1' } };
        const match = { id: 'match-1' };

        await matchTransitions.runMatchTransition({
            interaction,
            match,
            matchAction: 'start',
            lockKey: 'match:match-1',
            ensureDeferredReply: async () => {
                calls.push('ack_failed');
                return false;
            },
            ensureDeferredUpdate: async () => calls.push('update'),
            rememberPrivateDeliveryInteraction: () => calls.push('remember'),
            withInteractionLock: async (_key, callback) => {
                calls.push('lock');
                return await callback();
            },
            transition: async () => {
                calls.push('transition');
                return true;
            }
        });

        expect(calls).toEqual(['ack_failed']);
    });

    it('clears winner waiting prompts without throwing on stale replies', async () => {
        const match = {
            privatePromptHandles: {
                winnerWaiting: {
                    message: { delete: jest.fn(async () => {}) },
                    interaction: { deleteReply: jest.fn(async () => {}) }
                }
            }
        };

        await privatePrompts.clearWinnerWaitingPrompt(match);

        expect(match.privatePromptHandles.winnerWaiting).toBeNull();
    });

    it('persists runtime matches without restoring stale timers', async () => {
        const previousRuntimeDir = process.env.FUTBOT_RUNTIME_DIR;
        const previousRuntimeTestFlag = process.env.FUTBOT_RUNTIME_STATE_TEST;
        const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'futbot-runtime-'));
        process.env.FUTBOT_RUNTIME_DIR = runtimeDir;
        process.env.FUTBOT_RUNTIME_STATE_TEST = '1';

        try {
            await runtimeState.saveCompetitiveRatedRuntimeState({
                activeMatches: [{
                    id: 'match-1',
                    threadId: 'thread-1',
                    teams: [{ memberIds: ['home-user'] }, { memberIds: ['away-user'] }],
                    score: { team1: 1, team2: 0 },
                    stage: 'awaiting_winner',
                    timeoutPhase: 'game',
                    timeoutDeadlineAt: 12345,
                    timeoutTimer: { ignored: true },
                    participantIdByDiscordId: new Map([['home-user', 7000]])
                }],
                pendingCompetitiveDbOps: [{
                    key: 'record_game:5000:1',
                    type: 'record_game',
                    payload: { ratedMatchId: 5000, gameNumber: 1 }
                }]
            });

            const loaded = await runtimeState.loadCompetitiveRatedRuntimeState();
            expect(loaded.activeMatches).toHaveLength(1);
            expect(loaded.activeMatches[0].participantIdByDiscordId.get('home-user')).toBe(7000);
            expect(loaded.activeMatches[0].timeoutPhase).toBeNull();
            expect(loaded.activeMatches[0].timeoutDeadlineAt).toBeNull();
            expect(loaded.activeMatches[0].recoveredRuntimeTimeoutPhase).toBe('game');
            expect(loaded.pendingCompetitiveDbOps).toHaveLength(1);
        } finally {
            if (previousRuntimeDir === undefined) {
                delete process.env.FUTBOT_RUNTIME_DIR;
            } else {
                process.env.FUTBOT_RUNTIME_DIR = previousRuntimeDir;
            }
            if (previousRuntimeTestFlag === undefined) {
                delete process.env.FUTBOT_RUNTIME_STATE_TEST;
            } else {
                process.env.FUTBOT_RUNTIME_STATE_TEST = previousRuntimeTestFlag;
            }
            await fs.rm(runtimeDir, { recursive: true, force: true });
        }
    });
});
