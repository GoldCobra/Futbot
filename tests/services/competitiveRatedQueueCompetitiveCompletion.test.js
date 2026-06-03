const { ChannelType } = require('discord.js');

process.env.COMPETITIVE_DB_SCHEMA = 'rocci121_toby';

const mockExecuteQuery = jest.fn(async () => ({ recordset: [] }));
const mockRecordCompetitiveResult = jest.fn();
const mockGetPlayerRating = jest.fn(async () => null);
const mockGetActiveSeason = jest.fn(async () => ({ Id: 2, DisplayName: 'Burst Season 2026' }));
const mockGetDefaultCompetitiveRating = jest.fn(async () => 500);
const mockRunPendingCompetitiveWhrRunner = jest.fn(async () => ({
    status: 'idle',
    partitions: [],
    updatedRows: 0
}));
const mockRatedMatchDao = {
    createMatchHeader: jest.fn(async () => ({ id: 101, matchNumber: 1, seasonMatchNumber: 1 })),
    activateMatch: jest.fn(async ({ participants }) => participants.map((participant, index) => ({
        Id: 7000 + index,
        PlayerId: participant.playerId,
        DiscordId: participant.discordId,
        TeamNumber: participant.teamNumber,
        IsRepresentative: participant.isRepresentative
    }))),
    cancelMatchById: jest.fn(async () => {}),
    recordGame: jest.fn(async () => {}),
    completeMatch: jest.fn(async () => {}),
    cancelMatch: jest.fn(async () => {}),
    getPendingCompletedThreadFinalizations: jest.fn(async () => []),
    markThreadFinalizationSucceeded: jest.fn(async () => {}),
    markThreadFinalizationFailed: jest.fn(async () => {})
};

jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: (...args) => mockExecuteQuery(...args)
}));

jest.mock('../../src/services/competitiveRating', () => ({
    recordCompetitiveResult: (...args) => mockRecordCompetitiveResult(...args),
    getPlayerRating: (...args) => mockGetPlayerRating(...args),
    getActiveSeason: (...args) => mockGetActiveSeason(...args),
    getDefaultCompetitiveRating: (...args) => mockGetDefaultCompetitiveRating(...args)
}));

jest.mock('../../src/services/competitiveWhrRunner', () => ({
    runPendingCompetitiveWhrRunner: (...args) => mockRunPendingCompetitiveWhrRunner(...args)
}));

jest.mock('../../src/db/daos/ratedMatchDao', () => jest.fn().mockImplementation(() => mockRatedMatchDao));

const competitiveRatedQueue = require('../../src/services/competitiveRatedQueue');

function createMatchClientMock() {
    let threadMessageCounter = 0;
    const sentThreadMessages = new Map();
    const thread = {
        id: 'thread-1',
        name: '1v1 #1 | Home VS Away',
        url: 'https://discord.com/channels/guild-1/thread-1',
        send: jest.fn(async payload => {
            const message = {
                id: `thread-message-${++threadMessageCounter}`,
                payload,
                content: payload.content,
                components: payload.components,
                edit: jest.fn(async nextPayload => {
                    message.payload = {
                        ...message.payload,
                        ...nextPayload
                    };
                    message.content = message.payload.content;
                    message.components = message.payload.components;
                    return message;
                }),
                delete: jest.fn(async () => {
                    sentThreadMessages.delete(message.id);
                })
            };
            sentThreadMessages.set(message.id, message);
            return message;
        }),
        messages: {
            fetch: jest.fn(async messageId => {
                const message = sentThreadMessages.get(messageId);
                if (!message) {
                    throw new Error('not found');
                }
                return message;
            })
        },
        __sentMessages: sentThreadMessages,
        members: {
            add: jest.fn(async () => {})
        },
        setName: jest.fn(async nextName => {
            thread.name = nextName;
            return thread;
        }),
        setLocked: jest.fn(async () => thread),
        setArchived: jest.fn(async () => thread)
    };

    const issueSupportChannel = {
        id: '1509130945003913246',
        threads: {
            create: jest.fn(async () => ({
                id: 'issue-thread-1',
                url: 'https://discord.com/channels/guild-1/issue-thread-1',
                send: jest.fn(async payload => ({
                    id: 'issue-thread-message-1',
                    payload,
                    content: payload.content
                })),
                members: {
                    add: jest.fn(async () => {})
                }
            }))
        }
    };

    const logThread = {
        send: jest.fn(async () => ({
            id: 'log-message-1'
        }))
    };

    const channel = {
        id: '1501486517464600657',
        type: ChannelType.GuildText,
        guild: {
            id: 'guild-1',
            members: {
                me: {
                    id: 'bot-user'
                }
            },
            roles: {
                everyone: {
                    id: 'everyone'
                }
            }
        },
        client: {
            user: {
                id: 'bot-user'
            }
        }
    };

    const client = {
        user: {
            id: 'bot-user'
        },
        channels: {
            fetch: jest.fn(async channelId => {
                if (channelId === 'thread-1') return thread;
                if (channelId === '1501486517464600657') return channel;
                if (channelId === issueSupportChannel.id) return issueSupportChannel;
                return logThread;
            })
        }
    };

    channel.client = client;

    return { client, thread };
}

function createButtonInteractionMock({ customId, userId = 'button-user', client }) {
    const interaction = {
        customId,
        user: {
            id: userId,
            toString: () => `<@${userId}>`
        },
        client,
        replied: false,
        deferred: false,
        isButton: () => true,
        isModalSubmit: () => false,
        isStringSelectMenu: () => false,
        deferReply: jest.fn(async () => {
            interaction.deferred = true;
        }),
        deferUpdate: jest.fn(async () => {
            interaction.deferred = true;
        }),
        reply: jest.fn(async payload => {
            interaction.replied = true;
            return {
                id: 'reply-message',
                payload,
                edit: jest.fn()
            };
        }),
        editReply: jest.fn(async payload => {
            interaction.editReplyPayload = payload;
            return {
                id: 'edit-reply-message',
                payload,
                edit: jest.fn()
            };
        }),
        followUp: jest.fn(async payload => ({
            id: 'follow-up-message',
            payload,
            edit: jest.fn(async () => {})
        })),
        deleteReply: jest.fn(async () => {})
    };

    return interaction;
}

function getButtonComponents(payload) {
    return (payload.components ?? []).flatMap(row => row.toJSON().components);
}

function getButtonCustomIdByLabel(payload, label) {
    return getButtonComponents(payload).find(component => component.label === label)?.custom_id;
}

function findThreadPayload(thread, predicate) {
    return thread.send.mock.calls.map(([payload]) => payload).find(predicate);
}

function createMatchFixture(overrides = {}) {
    return {
        id: 'match-1',
        threadId: 'thread-1',
        threadUrl: 'https://discord.com/channels/guild-1/thread-1',
        threadName: '1v1 #1 | Home VS Away',
        mode: '1v1',
        gameType: 'MSC',
        firstTo: 1,
        homeTeamIndex: 1,
        awayTeamIndex: 2,
        ratedMatchId: 101,
        score: {
            team1: 0,
            team2: 0
        },
        stage: 'awaiting_winner',
        controlVersion: 0,
        selectedStadium: 'Magma Fields',
        selectedCaptain: 'Mario',
        rulesImageMessageId: null,
        startClickedUserIds: [],
        gameBlocks: [],
        controlMessageId: null,
        pendingResultGameNumber: null,
        loserAdvantagePromptShown: false,
        timeoutPhase: null,
        timeoutDeadlineAt: null,
        participantIdByDiscordId: new Map([
            ['home-user', 7000],
            ['away-user', 7001]
        ]),
        teams: [
            {
                teamIndex: 1,
                repUserId: 'home-user',
                repMention: '<@home-user>',
                memberIds: ['home-user'],
                members: [
                    {
                        id: 'home-user',
                        mention: '<@home-user>',
                        username: 'Home',
                        ratingProfile: {
                            elo: 1000,
                            doublesElo: 1000
                        }
                    }
                ]
            },
            {
                teamIndex: 2,
                repUserId: 'away-user',
                repMention: '<@away-user>',
                memberIds: ['away-user'],
                members: [
                    {
                        id: 'away-user',
                        mention: '<@away-user>',
                        username: 'Away',
                        ratingProfile: {
                            elo: 1000,
                            doublesElo: 1000
                        }
                    }
                ]
            }
        ],
        notificationInteractions: new Map(),
        ...overrides
    };
}

describe('competitiveRatedQueue competitive completion flow', () => {
    beforeEach(() => {
        mockExecuteQuery.mockClear();
        mockRecordCompetitiveResult.mockReset();
        mockGetPlayerRating.mockClear();
        mockGetActiveSeason.mockClear();
        mockGetDefaultCompetitiveRating.mockClear();
        mockRunPendingCompetitiveWhrRunner.mockClear();
        mockRatedMatchDao.createMatchHeader.mockClear();
        mockRatedMatchDao.activateMatch.mockClear();
        mockRatedMatchDao.cancelMatchById.mockClear();
        mockRatedMatchDao.recordGame.mockClear();
        mockRatedMatchDao.completeMatch.mockClear();
        mockRatedMatchDao.cancelMatch.mockClear();
        mockRatedMatchDao.getPendingCompletedThreadFinalizations.mockReset();
        mockRatedMatchDao.getPendingCompletedThreadFinalizations.mockResolvedValue([]);
        mockRatedMatchDao.markThreadFinalizationSucceeded.mockClear();
        mockRatedMatchDao.markThreadFinalizationFailed.mockClear();
        competitiveRatedQueue.__resetState();
    });

    it('keeps the competitive summary as the final visible completion post', async () => {
        const { client, thread } = createMatchClientMock();
        const match = createMatchFixture();
        mockRecordCompetitiveResult.mockResolvedValue({
            seasonName: 'Burst Season 2026',
            changes: [
                {
                    discordId: 'home-user',
                    teamNumber: 1,
                    outcome: 'win',
                    eloDelta: 24,
                    eloAfter: 1124,
                    rankAfter: 0,
                    placementGamesLeft: 4
                },
                {
                    discordId: 'away-user',
                    teamNumber: 2,
                    outcome: 'loss',
                    eloDelta: -24,
                    eloAfter: 976,
                    rankAfter: 0,
                    placementGamesLeft: 4
                }
            ]
        });
        competitiveRatedQueue.__seedStateForTests({
            activeMatches: [match],
            cachedOptionsByGameType: { MSC: { thresholdOptions: [], bestOfOptions: [1] } }
        });

        await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
            customId: 'rated:competitive:match:winner:match-1:1',
            userId: 'home-user',
            client
        }));
        const confirmPayload = findThreadPayload(thread, payload =>
            getButtonComponents(payload).some(component => component.label === 'Confirm Game Loss')
        );

        await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
            customId: getButtonCustomIdByLabel(confirmPayload, 'Confirm Game Loss'),
            userId: 'away-user',
            client
        }));

        const winnerPayload = findThreadPayload(thread, payload =>
            payload.content?.includes('WINS THE MATCH!')
        );
        const ratingPayload = findThreadPayload(thread, payload =>
            payload.content?.includes('<@home-user> +24 <:arrow:1501606527188865114>')
        );
        const completionPayload = findThreadPayload(thread, payload =>
            getButtonComponents(payload).some(component => component.label === 'Report Issue')
        );

        expect(mockRatedMatchDao.recordGame).toHaveBeenCalledTimes(1);
        expect(mockRatedMatchDao.recordGame).toHaveBeenCalledWith(expect.objectContaining({
            reportedByParticipantId: 7000,
            confirmedByParticipantId: 7001
        }));
        expect(mockRecordCompetitiveResult).toHaveBeenCalledTimes(1);
        expect(winnerPayload.content).toContain('WINS THE MATCH');
        expect(winnerPayload.content).toContain('Result:');
        expect(ratingPayload.content).toContain('<@home-user> +24 <:arrow:1501606527188865114> <:cr_unranked:1504559021670137906> **1124**');
        expect(ratingPayload.content).toContain('<@away-user> -24 <:arrow:1501606527188865114> <:cr_unranked:1504559021670137906> **976**');
        expect(ratingPayload.content).not.toContain('Competitive Rating');
        expect(completionPayload.content).toContain('**MATCH COMPLETE!** Thanks for playing.');
        expect(getButtonComponents(completionPayload).some(component => component.label === 'Report Issue')).toBe(true);
    });
});
