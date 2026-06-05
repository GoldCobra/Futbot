const { ChannelType, MessageFlags } = require('discord.js');

const mockPlayerIdsByDiscordId = new Map();
let mockNextPlayerId = 1000;
let mockNextRatedMatchId = 5000;
const mockMatchNumbersByScope = new Map();
const ADMIN_ROLE_ID = '1070908166725967942';
const mockRatedMatchDao = {
    createMatchHeader: jest.fn(async ({ gameId, modeCode }) => {
        const scope = `${gameId}:${modeCode}`;
        const matchNumber = mockMatchNumbersByScope.get(scope) ?? 1;
        mockMatchNumbersByScope.set(scope, matchNumber + 1);
        const id = mockNextRatedMatchId;
        mockNextRatedMatchId += 1;
        return {
            id,
            matchNumber,
            seasonMatchNumber: matchNumber
        };
    }),
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
    getReportableMatchSnapshot: jest.fn(async () => null),
    getPendingCompletedThreadFinalizations: jest.fn(async () => []),
    markThreadFinalizationSucceeded: jest.fn(async () => {}),
    markThreadFinalizationFailed: jest.fn(async () => {})
};
const mockRecordCompetitiveResult = jest.fn(async ({ winnerTeamNumber }) => ({
    seasonName: 'Burst Season 2026',
    changes: [
        {
            discordId: winnerTeamNumber === 1 ? 'home-user' : 'away-user',
            playerId: 1,
            teamNumber: winnerTeamNumber,
            outcome: 'win',
            eloBefore: 1000,
            eloAfter: 1024,
            eloDelta: 24,
            rankBefore: 0,
            rankAfter: 0,
            placementBefore: 0,
            placementAfter: 1,
            placementComplete: false,
            placementGamesLeft: 4
        },
        {
            discordId: winnerTeamNumber === 1 ? 'away-user' : 'home-user',
            playerId: 2,
            teamNumber: winnerTeamNumber === 1 ? 2 : 1,
            outcome: 'loss',
            eloBefore: 1000,
            eloAfter: 976,
            eloDelta: -24,
            rankBefore: 0,
            rankAfter: 0,
            placementBefore: 0,
            placementAfter: 1,
            placementComplete: false,
            placementGamesLeft: 4
        }
    ]
}));
const mockGetPlayerRating = jest.fn(async (discordId) => {
    if (discordId === 'ranked-user') {
        return {
            RankNumber: 7,
            Rank: 7,
            Elo: 1300
        };
    }
    if (discordId === 'placement-user') {
        return {
            RankNumber: 0,
            Rank: 0,
            Elo: 1085,
            PlacementPlayed: 3,
            PlacementComplete: false
        };
    }
    return null;
});
const mockGetActiveSeason = jest.fn(async () => ({ Id: 2, DisplayName: 'Burst Season 2026' }));
const mockGetDefaultCompetitiveRating = jest.fn(async () => 500);
const mockGetSeasonQueueAvailability = jest.fn(async () => ({
    canQueue: true,
    status: 'active',
    message: null
}));
const mockRunPendingCompetitiveWhrRunner = jest.fn(async () => ({
    status: 'idle',
    partitions: [],
    updatedRows: 0
}));
const mockExecuteQuery = jest.fn(async (query, params = {}) => {
    const sql = String(query);
    if (sql.includes('COUNT(*) AS QueueCount')) {
        return { recordset: [{ QueueCount: 0 }] };
    }
    if (sql.includes('SELECT TOP 1 ID AS Id') && sql.includes('FROM dbo.Player')) {
        const id = mockPlayerIdsByDiscordId.get(String(params.discordId));
        return { recordset: id ? [{ Id: id }] : [] };
    }
    if (sql.includes('INSERT INTO dbo.Player')) {
        const id = mockNextPlayerId;
        mockNextPlayerId += 1;
        mockPlayerIdsByDiscordId.set(String(params.discordId), id);
        return { recordset: [{ Id: id }] };
    }
    if (sql.includes('SELECT TOP 1') && sql.includes('p.ID AS PlayerId') && sql.includes('FROM dbo.Player p')) {
        return { recordset: [{ PlayerId: params.playerId, Club: null }] };
    }
    if (sql.includes('SELECT Id FROM dbo.Player WHERE DiscordID = @discordId')) {
        const key = String(params.discordId);
        if (!mockPlayerIdsByDiscordId.has(key)) {
            mockPlayerIdsByDiscordId.set(key, mockNextPlayerId);
            mockNextPlayerId += 1;
        }
        return { recordset: [{ Id: mockPlayerIdsByDiscordId.get(key) }] };
    }
    if (sql.includes('[rocci121_toby].[RatedMatch]') && sql.includes('WHERE MatchCode = @matchCode') && sql.includes('SELECT TOP 1 Id')) {
        return { recordset: [] };
    }
    if (sql.includes('INSERT INTO [rocci121_toby].[RatedMatch]')) {
        const id = mockNextRatedMatchId;
        mockNextRatedMatchId += 1;
        return { recordset: [{ Id: id }] };
    }
    if (sql.includes('INSERT INTO [rocci121_toby].[RatedMatchParticipant]')) {
        return { recordset: [] };
    }
    if (sql.includes('SELECT TOP 1 Id') && sql.includes('[rocci121_toby].[RatedMatchParticipant]')) {
        return { recordset: [{ Id: 1 }] };
    }
    if (sql.includes('INSERT INTO [rocci121_toby].[RatedMatchGame]')) {
        return { recordset: [] };
    }
    if (sql.includes('UPDATE [rocci121_toby].[RatedMatch]')) {
        return { recordset: [] };
    }
    if (sql.includes('[rocci121_toby].[CompetitiveSeason]') && sql.includes('IsActive = 1')) {
        return { recordset: [{ Id: 2, DisplayName: 'Burst Season 2026' }] };
    }
    if (sql.includes('[rocci121_toby].[CompetitivePlayerRating]') && params.discordId === 'ranked-user') {
        return {
            recordset: [{
                RankNumber: 7,
                Rank: 7
            }]
        };
    }
    return { recordset: [] };
});

jest.mock('../../src/db/sqlClient', () => ({
    executeQuery: (...args) => mockExecuteQuery(...args)
}));

jest.mock('../../src/services/competitiveRating', () => ({
    recordCompetitiveResult: (...args) => mockRecordCompetitiveResult(...args),
    getPlayerRating: (...args) => mockGetPlayerRating(...args),
    getPlayerRatingForSeason: (...args) => mockGetPlayerRating(...args),
    getActiveSeason: (...args) => mockGetActiveSeason(...args),
    getDefaultCompetitiveRating: (...args) => mockGetDefaultCompetitiveRating(...args),
    getSeasonQueueAvailability: (...args) => mockGetSeasonQueueAvailability(...args),
    recoverPendingCompetitiveWhrSync: jest.fn(async () => []),
    beginDueSeasonEnding: jest.fn(async () => null),
    finalizeDueEndingSeason: jest.fn(async () => null),
    activateDueSeason: jest.fn(async () => null)
}));

jest.mock('../../src/services/competitiveWhrRunner', () => ({
    runPendingCompetitiveWhrRunner: (...args) => mockRunPendingCompetitiveWhrRunner(...args)
}));

jest.mock('../../src/db/daos/ratedMatchDao', () => jest.fn().mockImplementation(() => mockRatedMatchDao));

const competitiveRatedQueue = require('../../src/services/competitiveRatedQueue');
const { formatLogLine } = require('../../src/services/competitiveRatedQueue/runtimeLogger');
const { COMP_RANK_EMOJIS, COMP_RANK_NAMES, PLACEMENT_GAMES_REQUIRED } = require('../../src/utils/competitiveConstants');

const RATED_LOG_THREAD_IDS = {
    SMS_1V1: '1503758084550426766',
    SMS_2V2: '1503758128678965250',
    MSC_1V1: '1503758199638196255',
    MSC_2V2: '1503758261008994427',
    MSBL_1V1: '1503758336439357541',
    MSBL_2V2: '1503758435450355782'
};

async function flushAsyncTasks() {
    for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
    }
}

async function flushScheduledTasks() {
    for (let index = 0; index < 3; index += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
        await flushAsyncTasks();
    }
}

function createSinglesSearch({ minBestOf, maxBestOf, threshold, elo }) {
    return {
        options: {
            minBestOf,
            maxBestOf,
            threshold
        },
        ratingProfile: {
            elo
        }
    };
}

function createDoublesSearch({ id, playerId, ratingTs, clubId }) {
    return {
        id,
        ratingProfile: {
            playerId,
            ratingTs,
            clubId
        }
    };
}

function createCompetitiveRatedSearch({ id, userId, username, createdAt, channelId = '1501486517464600657', gameType = 'MSC', playerId = 1 }) {
    return {
        id,
        channelId,
        gameType,
        mode: '1v1',
        userId,
        mention: `<@${userId}>`,
        username,
        createdAt,
        options: {
            minBestOf: 3,
            maxBestOf: 3,
            threshold: null
        },
        ratingProfile: {
            elo: 1000,
            playerId,
            ratingTs: 1000,
            clubId: 1
        },
        expiresAt: Date.now() + 15 * 60000,
        warningAt: Date.now() + 13 * 60000,
        hasWarnedExpiry: false,
        notificationInteraction: {
            deferred: true,
            replied: false,
            editReply: jest.fn(async () => {}),
            deleteReply: jest.fn(async () => {}),
            followUp: jest.fn(async payload => ({
                id: 'private-warning-message',
                payload,
                edit: jest.fn()
            }))
        },
        warningMessage: null,
        warningMessageId: null,
        warningToken: null
    };
}

function createMatchClientMock() {
    let threadMessageCounter = 0;
    let channelMessageCounter = 0;
    let logMessageCounter = 0;
    let issueThreadCounter = 0;
    const sentChannelMessages = new Map();
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
        },
        threads: {
            create: jest.fn(async () => thread),
            fetchActive: jest.fn(async () => ({ threads: new Map() })),
            fetchArchived: jest.fn(async () => ({ threads: new Map() }))
        },
        send: jest.fn(async payload => {
            const message = {
                id: `channel-message-${++channelMessageCounter}`,
                payload,
                content: payload.content,
                components: payload.components,
                author: {
                    id: 'bot-user'
                },
                attachments: {
                    some: () => false
                },
                createdTimestamp: Date.now(),
                edit: jest.fn(async () => message),
                delete: jest.fn(async () => {
                    sentChannelMessages.delete(message.id);
                })
            };
            sentChannelMessages.set(message.id, message);
            return message;
        }),
        messages: {
            fetch: jest.fn(async arg => {
                if (typeof arg === 'string') {
                    const message = sentChannelMessages.get(arg);
                    if (!message) {
                        throw new Error('not found');
                    }
                    return message;
                }
                return new Map(sentChannelMessages.entries());
            })
        },
        permissionOverwrites: {
            edit: jest.fn(async () => {})
        }
    };

    const createLogThread = id => ({
        id,
        send: jest.fn(async payload => ({
            id: `log-message-${++logMessageCounter}`,
            payload,
            content: payload.content,
            delete: jest.fn(async () => {})
        })),
        messages: {
            fetch: jest.fn(async () => new Map())
        },
        bulkDelete: jest.fn(async messages => messages)
    });
    const logThreads = new Map(Object.values(RATED_LOG_THREAD_IDS).map(id => [id, createLogThread(id)]));

    const issueSupportChannel = {
        id: '1509130945003913246',
        type: ChannelType.GuildText,
        threads: {
            create: jest.fn(async payload => ({
                id: `issue-thread-${++issueThreadCounter}`,
                name: payload.name,
                url: `https://discord.com/channels/guild-1/issue-thread-${issueThreadCounter}`,
                payload,
                send: jest.fn(async messagePayload => ({
                    id: `issue-thread-message-${issueThreadCounter}`,
                    payload: messagePayload,
                    content: messagePayload.content
                })),
                members: {
                    add: jest.fn(async () => {})
                }
            }))
        }
    };

    const client = {
        user: {
            id: 'bot-user'
        },
        channels: {
            cache: new Map([[channel.id, channel], [issueSupportChannel.id, issueSupportChannel]]),
            fetch: jest.fn(async channelId => {
                if (channelId === thread.id) return thread;
                if (channelId === issueSupportChannel.id) return issueSupportChannel;
                if (logThreads.has(channelId)) return logThreads.get(channelId);
                return channel;
            })
        }
    };

    return { channel, client, issueSupportChannel, logThreads, thread };
}

function createThreadMock(id = 'thread-rematch', name = '1v1 #2 | Home VS Away') {
    let threadMessageCounter = 0;
    const sentThreadMessages = new Map();
    const thread = {
        id,
        name,
        url: `https://discord.com/channels/guild-1/${id}`,
        send: jest.fn(async payload => {
            const message = {
                id: `${id}-message-${++threadMessageCounter}`,
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
    return thread;
}

function createButtonInteractionMock({ customId, userId = 'button-user', client, roleIds = [] }) {
    const interaction = {
        customId,
        user: {
            id: userId,
            toString: () => `<@${userId}>`
        },
        member: {
            roles: {
                cache: new Map(roleIds.map(roleId => [roleId, { id: roleId }]))
            }
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

function createPanelMessageFixtures() {
    const panelImageMessage = {
        id: 'panel-image-message',
        author: {
            id: 'bot-user'
        },
        attachments: {
            some: callback => callback({ name: 'rm-msc.png' })
        },
        components: [],
        createdTimestamp: 1,
        edit: jest.fn(),
        delete: jest.fn(async () => {})
    };
    const panelMessage = {
        id: 'panel-message',
        author: {
            id: 'bot-user'
        },
        attachments: {
            some: () => false
        },
        components: competitiveRatedQueue.buildPanelMessage('1501486517464600657').components,
        createdTimestamp: 2,
        edit: jest.fn(),
        delete: jest.fn(async () => {})
    };
    const smsPanelImageMessage = {
        id: 'sms-panel-image-message',
        author: {
            id: 'bot-user'
        },
        attachments: {
            some: callback => callback({ name: 'rm-sms.png' })
        },
        components: [],
        createdTimestamp: 1,
        edit: jest.fn(),
        delete: jest.fn(async () => {})
    };
    const smsPanelMessage = {
        id: 'sms-panel-message',
        author: {
            id: 'bot-user'
        },
        attachments: {
            some: () => false
        },
        components: competitiveRatedQueue.buildPanelMessage('1504056016629927966').components,
        createdTimestamp: 2,
        edit: jest.fn(),
        delete: jest.fn(async () => {})
    };
    const msblPanelImageMessage = {
        id: 'msbl-panel-image-message',
        author: {
            id: 'bot-user'
        },
        attachments: {
            some: callback => callback({ name: 'rm-msbl.png' })
        },
        components: [],
        createdTimestamp: 1,
        edit: jest.fn(),
        delete: jest.fn(async () => {})
    };
    const msblPanelMessage = {
        id: 'msbl-panel-message',
        author: {
            id: 'bot-user'
        },
        attachments: {
            some: () => false
        },
        components: competitiveRatedQueue.buildPanelMessage('1502350088431992852').components,
        createdTimestamp: 2,
        edit: jest.fn(),
        delete: jest.fn(async () => {})
    };

    return { panelImageMessage, panelMessage, smsPanelImageMessage, smsPanelMessage, msblPanelImageMessage, msblPanelMessage };
}

function getFirstButtonCustomId(payload) {
    return payload.components[0].toJSON().components[0].custom_id;
}

function getButtonComponents(payload) {
    return (payload.components ?? []).flatMap(row => row.toJSON().components);
}

function getButtonCustomIds(payload) {
    return getButtonComponents(payload)
        .map(component => component.custom_id)
        .filter(Boolean);
}

function getButtonCustomIdByLabel(payload, label) {
    return getButtonComponents(payload).find(component => component.label === label)?.custom_id;
}

function findThreadPayload(thread, predicate) {
    return thread.send.mock.calls.map(([payload]) => payload).find(predicate);
}

function findThreadMessage(thread, predicate) {
    return [...thread.__sentMessages.values()].find(message => predicate(message.payload));
}

function findThreadPayloadIndex(thread, predicate) {
    return thread.send.mock.calls.findIndex(([payload]) => predicate(payload));
}

function countThreadPayloads(thread, predicate) {
    return thread.send.mock.calls.filter(([payload]) => predicate(payload)).length;
}

function threadPayloadHasFile(payload, imageName) {
    return (payload.files ?? []).some(file => file.name === imageName);
}

function expectFileImmediatelyBefore(thread, previousImageName, imageName) {
    const imageIndex = findThreadPayloadIndex(thread, payload => threadPayloadHasFile(payload, imageName));
    expect(imageIndex).toBeGreaterThan(0);
    expect(threadPayloadHasFile(thread.send.mock.calls[imageIndex - 1][0], previousImageName)).toBe(true);
}

function expectFileNotImmediatelyBefore(thread, previousImageName, imageName) {
    const imageIndex = findThreadPayloadIndex(thread, payload => threadPayloadHasFile(payload, imageName));
    expect(imageIndex).toBeGreaterThanOrEqual(0);
    if (imageIndex > 0) {
        expect(threadPayloadHasFile(thread.send.mock.calls[imageIndex - 1][0], previousImageName)).toBe(false);
    }
}

function expectFileNotImmediatelyAfter(thread, previousImageName, imageName) {
    const imageIndex = findThreadPayloadIndex(thread, payload => threadPayloadHasFile(payload, previousImageName));
    expect(imageIndex).toBeGreaterThanOrEqual(0);
    if (imageIndex < thread.send.mock.calls.length - 1) {
        expect(threadPayloadHasFile(thread.send.mock.calls[imageIndex + 1][0], imageName)).toBe(false);
    }
}

function expectThreadRenameBeforeClose(thread) {
    expect(thread.setLocked).toHaveBeenCalled();
    expect(thread.setArchived).toHaveBeenCalled();
    expect(thread.setName).toHaveBeenCalled();

    const renameOrder = thread.setName.mock.invocationCallOrder.at(-1);
    expect(renameOrder).toBeLessThan(thread.setLocked.mock.invocationCallOrder.at(-1));
    expect(renameOrder).toBeLessThan(thread.setArchived.mock.invocationCallOrder.at(-1));
}

function expectPublicThreadTextIsQuoted(thread) {
    for (const [payload] of thread.send.mock.calls) {
        if (payload.content) {
            expect(payload.content.trimStart().startsWith('>')).toBe(true);
        }
    }
}

function threadHasPublicSelectionButtons(thread) {
    return thread.send.mock.calls.some(([payload]) =>
        getButtonCustomIds(payload).some(customId =>
            customId.includes(':match:stadium:') || customId.includes(':match:captain:')
        )
    );
}

function threadHasImagePayload(thread, imageName) {
    return thread.send.mock.calls.some(([payload]) =>
        threadPayloadHasFile(payload, imageName)
    );
}

async function flushRuntimeLogs() {
    await competitiveRatedQueue.__flushRuntimeLogsForTests();
    await flushAsyncTasks();
}

function relativeTimestamp(deadlineMs) {
    return `<t:${Math.ceil(deadlineMs / 1000)}:R>`;
}

function getLogContents(logThreads, threadId) {
    return logThreads.get(threadId).send.mock.calls.map(([payload]) => payload.content);
}

function createMatchFixture(overrides = {}) {
    return {
        id: 'match-1',
        ratedMatchId: 5000,
        threadId: 'thread-1',
        threadUrl: 'https://discord.com/channels/guild-1/thread-1',
        threadName: '1v1 #1 | Home VS Away',
        mode: '1v1',
        gameType: 'MSC',
        firstTo: 2,
        homeTeamIndex: 1,
        awayTeamIndex: 2,
        score: {
            team1: 0,
            team2: 0
        },
        stage: 'awaiting_start',
        selectedStadium: null,
        selectedCaptain: null,
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

async function prepareLoserAdvantagePrompt(client) {
    const match = createMatchFixture({
        stage: 'awaiting_winner'
    });
    competitiveRatedQueue.__seedStateForTests({
        activeMatches: [match],
        cachedOptionsByGameType: { MSC: createMatchOptions() }
    });

    const winnerInteraction = createButtonInteractionMock({
        customId: 'rated:competitive:match:winner:match-1',
        userId: 'home-user',
        client
    });
    await competitiveRatedQueue.handleInteraction(winnerInteraction);

    const loserConfirmInteraction = createButtonInteractionMock({
        customId: 'rated:competitive:match:loser_confirm:match-1',
        userId: 'away-user',
        client
    });
    await competitiveRatedQueue.handleInteraction(loserConfirmInteraction);

    const advantagePayload = loserConfirmInteraction.editReply.mock.calls.at(-1)[0];
    return {
        match,
        winnerInteraction,
        loserConfirmInteraction,
        chooseHomeCustomId: getButtonCustomIdByLabel(advantagePayload, 'Choose Home'),
        chooseCaptainCustomId: getButtonCustomIdByLabel(advantagePayload, 'Choose Captain First')
    };
}

function createMatchOptions() {
    return {
        stadiums: [
            { value: 1, code: 'bowser', description: 'Bowser Stadium' },
            { value: 2, code: 'classroom', description: 'The Classroom' },
            { value: 3, code: 'crystal', description: 'Crystal Canyon' },
            { value: 4, code: 'lava', description: 'Lava Pit' }
        ],
        captains: [
            { value: 10, code: 'mario', description: 'Mario' },
            { value: 11, code: 'peach', description: 'Peach' },
            { value: 12, code: 'dk', description: 'DK' },
            { value: 13, code: 'waluigi', description: 'Waluigi' }
        ]
    };
}

describe('competitiveRatedQueue', () => {
    beforeEach(() => {
        mockExecuteQuery.mockClear();
        mockRecordCompetitiveResult.mockClear();
        mockGetPlayerRating.mockClear();
        mockGetActiveSeason.mockClear();
        mockGetDefaultCompetitiveRating.mockClear();
        mockGetSeasonQueueAvailability.mockClear();
        mockGetSeasonQueueAvailability.mockResolvedValue({
            canQueue: true,
            status: 'active',
            message: null
        });
        mockRunPendingCompetitiveWhrRunner.mockClear();
        mockRatedMatchDao.createMatchHeader.mockClear();
        mockRatedMatchDao.activateMatch.mockClear();
        mockRatedMatchDao.cancelMatchById.mockClear();
        mockRatedMatchDao.recordGame.mockClear();
        mockRatedMatchDao.completeMatch.mockClear();
        mockRatedMatchDao.cancelMatch.mockClear();
        mockRatedMatchDao.getReportableMatchSnapshot.mockReset();
        mockRatedMatchDao.getReportableMatchSnapshot.mockResolvedValue(null);
        mockRatedMatchDao.getPendingCompletedThreadFinalizations.mockReset();
        mockRatedMatchDao.getPendingCompletedThreadFinalizations.mockResolvedValue([]);
        mockRatedMatchDao.markThreadFinalizationSucceeded.mockClear();
        mockRatedMatchDao.markThreadFinalizationFailed.mockClear();
        mockPlayerIdsByDiscordId.clear();
        mockMatchNumbersByScope.clear();
        mockNextPlayerId = 1000;
        mockNextRatedMatchId = 5000;
        competitiveRatedQueue.__resetState();
    });

    afterEach(() => {
        competitiveRatedQueue.__resetState();
    });

    it('builds the panel message for the requested test channel', () => {
        const message = competitiveRatedQueue.buildPanelMessage('1501486517464600657');
        const components = message.components[0].toJSON().components;

        expect(message.content).toBeUndefined();
        expect(components[0].custom_id).toBe('rated:competitive:join:1501486517464600657:1v1');
        expect(components[1].custom_id).toBe('rated:competitive:join:1501486517464600657:2v2');
        expect(components[0].label).toBe('Search 1vs1');
        expect(components[1].label).toBe('Search 2vs2');
        expect(components[0].disabled).not.toBe(true);
        expect(components[1].disabled).not.toBe(true);
    });

    it('keeps panel buttons clickable when queue availability is blocked', () => {
        const message = competitiveRatedQueue.buildPanelMessage('1501486517464600657', {
            canQueue: false,
            message: 'Season has not started yet. Rated matches open soon.'
        });
        const components = message.components[0].toJSON().components;

        expect(message.content).toBeUndefined();
        expect(components[0].disabled).not.toBe(true);
        expect(components[1].disabled).not.toBe(true);
    });

    it('does not edit existing panel image or button messages during reconcile', async () => {
        const { channel, client } = createMatchClientMock();
        const { panelImageMessage, panelMessage, smsPanelImageMessage, smsPanelMessage, msblPanelImageMessage, msblPanelMessage } = createPanelMessageFixtures();
        channel.messages.fetch = jest.fn(async arg => {
            if (typeof arg === 'string') {
                throw new Error('not found');
            }
            return new Map([
                [panelImageMessage.id, panelImageMessage],
                [panelMessage.id, panelMessage],
                [smsPanelImageMessage.id, smsPanelImageMessage],
                [smsPanelMessage.id, smsPanelMessage],
                [msblPanelImageMessage.id, msblPanelImageMessage],
                [msblPanelMessage.id, msblPanelMessage]
            ]);
        });

        await competitiveRatedQueue.ensureCompetitiveRatedQueue(client);
        competitiveRatedQueue.__resetState();

        expect(mockRunPendingCompetitiveWhrRunner).toHaveBeenCalledTimes(1);
        expect(channel.send).not.toHaveBeenCalled();
        const botOverwrite = channel.permissionOverwrites.edit.mock.calls
            .find(([target]) => target === 'bot-user');
        expect(botOverwrite?.[1]).toEqual(expect.objectContaining({
            CreatePublicThreads: true,
            SendMessagesInThreads: true,
            ManageThreads: true
        }));
        expect(botOverwrite?.[1]).not.toHaveProperty('CreatePrivateThreads');
        expect(panelImageMessage.edit).not.toHaveBeenCalled();
        expect(panelMessage.edit).not.toHaveBeenCalled();
        expect(smsPanelImageMessage.edit).not.toHaveBeenCalled();
        expect(smsPanelMessage.edit).not.toHaveBeenCalled();
        expect(msblPanelImageMessage.edit).not.toHaveBeenCalled();
        expect(msblPanelMessage.edit).not.toHaveBeenCalled();
    });

    it('recreates stale unavailable panel messages instead of editing them', async () => {
        const { channel, client } = createMatchClientMock();
        const { panelImageMessage, panelMessage } = createPanelMessageFixtures();
        panelMessage.content = 'Season has not started yet. Rated matches open soon.';
        panelMessage.payload = {
            content: panelMessage.content,
            components: panelMessage.components
        };
        channel.messages.fetch = jest.fn(async arg => {
            if (typeof arg === 'string') {
                throw new Error('not found');
            }
            return new Map([
                [panelImageMessage.id, panelImageMessage],
                [panelMessage.id, panelMessage]
            ]);
        });

        await competitiveRatedQueue.ensureCompetitiveRatedQueue(client);
        competitiveRatedQueue.__resetState();

        expect(panelMessage.edit).not.toHaveBeenCalled();
        expect(panelMessage.delete).toHaveBeenCalledTimes(1);
        const sentPanelPayload = channel.send.mock.calls.find(([payload]) =>
            payload.components?.[0]?.toJSON?.().components?.some(component =>
                component.custom_id === 'rated:competitive:join:1501486517464600657:1v1'
            )
        )?.[0];
        expect(sentPanelPayload).toEqual(expect.objectContaining({
            components: expect.any(Array)
        }));
        expect(sentPanelPayload.content).toBeUndefined();
        const sentButtons = sentPanelPayload.components[0].toJSON().components;
        expect(sentButtons[0].disabled).not.toBe(true);
        expect(sentButtons[1].disabled).not.toBe(true);
    });

    it('returns the season-start message on join while keeping panel buttons enabled', async () => {
        const { client } = createMatchClientMock();
        mockGetSeasonQueueAvailability.mockResolvedValue({
            canQueue: false,
            status: 'scheduled',
            message: 'Season has not started yet. Rated matches open soon.'
        });
        const interaction = createButtonInteractionMock({
            customId: 'rated:competitive:join:1501486517464600657:1v1',
            userId: '12345',
            client
        });

        await competitiveRatedQueue.handleInteraction(interaction);

        expect(interaction.reply).toHaveBeenCalledWith({
            content: 'Joining the 1vs1 pool...',
            components: [],
            flags: MessageFlags.Ephemeral
        });
        expect(interaction.editReply).toHaveBeenCalledWith({
            content: 'Season has not started yet. Rated matches open soon.',
            components: [],
            flags: MessageFlags.Ephemeral
        });
        expect(mockExecuteQuery).not.toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO dbo.Player'),
            expect.anything()
        );
        expect(competitiveRatedQueue.__getStateSnapshot().activeSearchCount).toBe(0);
    });

    it('builds mode-specific leave pool labels', () => {
        expect(competitiveRatedQueue.buildLeavePoolLabel('1v1')).toBe('Leave 1vs1');
        expect(competitiveRatedQueue.buildLeavePoolLabel('2v2')).toBe('Leave 2vs2');
    });

    it('joins the pool directly for the fixed 15 minute live search window', async () => {
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        try {
            const { client } = createMatchClientMock();
            const interaction = createButtonInteractionMock({
                customId: 'rated:competitive:join:1501486517464600657:1v1',
                userId: '12345',
                client
            });

            await competitiveRatedQueue.handleInteraction(interaction);

            const replyPayload = interaction.editReply.mock.calls.at(-1)[0];
            const leaveButton = replyPayload.components[0].toJSON().components[0];
            expect(interaction.reply).toHaveBeenCalledWith({
                content: 'Joining the 1vs1 pool...',
                components: [],
                flags: MessageFlags.Ephemeral
            });
            expect(replyPayload.content).toBe(
                `You joined the 1vs1 pool.\n${COMP_RANK_EMOJIS[0]} **Unranked 0/${PLACEMENT_GAMES_REQUIRED}** (500)\n<:bltime:986232783569551360> Time remaining: ${relativeTimestamp(1_900_000)}.`
            );
            expect(replyPayload.content).not.toContain('Choose how long');
            expect(leaveButton.label).toBe('Leave 1vs1');
            expect(competitiveRatedQueue.__getStateSnapshot().activeSearchCount).toBe(1);

            const playerInsertCall = mockExecuteQuery.mock.calls.find(([query]) =>
                String(query).includes('INSERT INTO dbo.Player')
            );
            expect(String(playerInsertCall[0])).toContain('(Name, DiscordID)');
            expect(String(playerInsertCall[0])).not.toContain('Ping');
            expect(playerInsertCall[1]).toEqual({
                discordId: '12345',
                name: 'Player 12345'
            });
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('posts pool status with the game LFG role mention enabled', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);
        try {
            const { channel, client } = createMatchClientMock();
            const interaction = createButtonInteractionMock({
                customId: 'rated:competitive:join:1501486517464600657:1v1',
                userId: '12345',
                client
            });

            await competitiveRatedQueue.handleInteraction(interaction);
            jest.advanceTimersByTime(500);
            await flushAsyncTasks();

            const statusPayload = channel.send.mock.calls
                .map(([payload]) => payload)
                .find(payload => String(payload.content || '').includes('Players in 1vs1 Pool'));

            expect(statusPayload).toEqual(expect.objectContaining({
                content: '<@&680810288605298744>\nPlayers in 1vs1 Pool: **👤 1**',
                components: [],
                allowedMentions: {
                    parse: [],
                    roles: ['680810288605298744']
                }
            }));
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('shows current competitive rank in pool join reply when a rating row exists', async () => {
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        try {
            const { client } = createMatchClientMock();
            const interaction = createButtonInteractionMock({
                customId: 'rated:competitive:join:1501486517464600657:1v1',
                userId: 'ranked-user',
                client
            });

            await competitiveRatedQueue.handleInteraction(interaction);

            const replyPayload = interaction.editReply.mock.calls.at(-1)[0];
            expect(replyPayload.content).toContain(
                `${COMP_RANK_EMOJIS[7]} **${COMP_RANK_NAMES[7]}** (1300)`
            );
            expect(replyPayload.content).toContain(`Time remaining: ${relativeTimestamp(1_900_000)}`);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('shows placement progress next to Unranked in pool join reply', async () => {
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        try {
            const { client } = createMatchClientMock();
            const interaction = createButtonInteractionMock({
                customId: 'rated:competitive:join:1501486517464600657:1v1',
                userId: 'placement-user',
                client
            });

            await competitiveRatedQueue.handleInteraction(interaction);

            const replyPayload = interaction.editReply.mock.calls.at(-1)[0];
            expect(replyPayload.content).toContain(
                `${COMP_RANK_EMOJIS[0]} **Unranked 3/${PLACEMENT_GAMES_REQUIRED}** (1085)`
            );
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('queues duplicate Search clicks for the same user and creates only one pool entry', async () => {
        const { client } = createMatchClientMock();
        const firstInteraction = createButtonInteractionMock({
            customId: 'rated:competitive:join:1501486517464600657:1v1',
            userId: '12345',
            client
        });
        const duplicateInteraction = createButtonInteractionMock({
            customId: 'rated:competitive:join:1501486517464600657:1v1',
            userId: '12345',
            client
        });

        await Promise.all([
            competitiveRatedQueue.handleInteraction(firstInteraction),
            competitiveRatedQueue.handleInteraction(duplicateInteraction)
        ]);

        expect(competitiveRatedQueue.__getStateSnapshot().activeSearchCount).toBe(1);
        expect(firstInteraction.editReply.mock.calls.at(-1)[0].content).toContain('joined the 1vs1 pool');
        const duplicatePayload = duplicateInteraction.editReply.mock.calls.at(-1)[0];
        expect(duplicatePayload.content).toContain('Your 1vs1 pool entry is still active.');
        expect(duplicatePayload.components[0].toJSON().components[0].label).toBe('Leave 1vs1');
        expect(duplicateInteraction.deleteReply).not.toHaveBeenCalled();
    });

    it('replays the private leave button when a queued player clicks Search again', async () => {
        const { client } = createMatchClientMock();
        const firstInteraction = createButtonInteractionMock({
            customId: 'rated:competitive:join:1501486517464600657:2v2',
            userId: '12345',
            client
        });
        const replayInteraction = createButtonInteractionMock({
            customId: 'rated:competitive:join:1501486517464600657:2v2',
            userId: '12345',
            client
        });

        await competitiveRatedQueue.handleInteraction(firstInteraction);
        await competitiveRatedQueue.handleInteraction(replayInteraction);

        expect(competitiveRatedQueue.__getStateSnapshot().activeSearchCount).toBe(1);
        const replayPayload = replayInteraction.editReply.mock.calls.at(-1)[0];
        expect(replayPayload.content).toContain('Your 2vs2 pool entry is still active.');
        expect(replayPayload.content).toContain('Time remaining:');
        const leaveButton = replayPayload.components[0].toJSON().components[0];
        expect(leaveButton.label).toBe('Leave 2vs2');
        expect(leaveButton.custom_id).toContain(':search:cancel:');
        expect(replayInteraction.deleteReply).not.toHaveBeenCalled();
    });

    it('does not join the pool when the Search interaction could not be acknowledged', async () => {
        const { channel, client } = createMatchClientMock();
        const interaction = createButtonInteractionMock({
            customId: 'rated:competitive:join:1501486517464600657:1v1',
            userId: '12345',
            client
        });
        interaction.reply.mockRejectedValueOnce(new Error('Interaction has already been acknowledged.'));
        interaction.deferReply.mockRejectedValueOnce(new Error('Interaction has already been acknowledged.'));

        await competitiveRatedQueue.handleInteraction(interaction);

        expect(competitiveRatedQueue.__getStateSnapshot().activeSearchCount).toBe(0);
        expect(channel.threads.create).not.toHaveBeenCalled();
        expect(interaction.editReply).not.toHaveBeenCalled();
        expect(interaction.followUp).not.toHaveBeenCalled();
    });

    it('creates exactly one match thread from simultaneous compatible Search clicks', async () => {
        const { channel, client } = createMatchClientMock();
        const firstInteraction = createButtonInteractionMock({
            customId: 'rated:competitive:join:1501486517464600657:1v1',
            userId: 'player-one',
            client
        });
        const secondInteraction = createButtonInteractionMock({
            customId: 'rated:competitive:join:1501486517464600657:1v1',
            userId: 'player-two',
            client
        });

        await Promise.all([
            competitiveRatedQueue.handleInteraction(firstInteraction),
            competitiveRatedQueue.handleInteraction(secondInteraction)
        ]);
        await competitiveRatedQueue.__runMatchmakingForTests(channel.id, client);
        await flushAsyncTasks();

        expect(channel.threads.create).toHaveBeenCalledTimes(1);
        expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
        expect(competitiveRatedQueue.__getStateSnapshot().activeSearchCount).toBe(0);
    });

    it('writes routed runtime logs with labels and mentions disabled', async () => {
        const { client, logThreads } = createMatchClientMock();
        const interaction = createButtonInteractionMock({
            customId: 'rated:competitive:join:1501486517464600657:1v1',
            userId: 'log-user',
            client
        });

        await competitiveRatedQueue.handleInteraction(interaction);
        await flushRuntimeLogs();

        const mscOneVsOneLogs = getLogContents(logThreads, RATED_LOG_THREAD_IDS.MSC_1V1);
        expect(mscOneVsOneLogs.join('\n')).toContain('[info]');
        expect(mscOneVsOneLogs.join('\n')).toContain('MSC 1v1');
        expect(mscOneVsOneLogs.join('\n')).toContain('queue.joined');
        expect(logThreads.get(RATED_LOG_THREAD_IDS.MSC_2V2).send).not.toHaveBeenCalled();
        const firstPayload = logThreads.get(RATED_LOG_THREAD_IDS.MSC_1V1).send.mock.calls[0][0];
        expect(firstPayload.allowedMentions).toEqual({ parse: [] });
    });

    it('prefixes runtime warning and error log labels with emojis', () => {
        const route = { gameType: 'MSC', mode: '1v1' };

        expect(formatLogLine('warn', route, 'queue.warning'))
            .toContain('⚠️ [warn]');
        expect(formatLogLine('error', route, 'queue.error'))
            .toContain('❗ [ERROR]');
    });

    it('auto expires a pool entry without another user action', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);

        try {
            const { client } = createMatchClientMock();
            const interaction = createButtonInteractionMock({
                customId: 'rated:competitive:join:1501486517464600657:2v2',
                userId: 'auto-expire-user',
                client
            });

            await competitiveRatedQueue.handleInteraction(interaction);
            expect(competitiveRatedQueue.__getStateSnapshot().activeSearchCount).toBe(1);

            jest.advanceTimersByTime(13 * 60_000);
            await flushAsyncTasks();
            expect(interaction.followUp.mock.calls.some(([payload]) =>
                payload.content === `Your 2vs2 pool entry is still active.\n<:bltime:986232783569551360> Time remaining: ${relativeTimestamp(1_900_000)}.`
            )).toBe(true);
            expect(competitiveRatedQueue.__getStateSnapshot().activeSearchCount).toBe(1);

            jest.advanceTimersByTime(2 * 60_000);
            await flushAsyncTasks();
            expect(interaction.followUp.mock.calls.some(([payload]) =>
                payload.content === '<:blx:1502366790116708382> Your 2vs2 pool entry **expired**. You were removed from the pool!'
            )).toBe(true);
            expect(competitiveRatedQueue.__getStateSnapshot().activeSearchCount).toBe(0);
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('cleans only old rated runtime log messages and posts cleanup completion', async () => {
        const { client, logThreads } = createMatchClientMock();
        const now = Date.UTC(2026, 4, 27, 12, 0, 0);
        const oldTimestamp = now - (8 * 24 * 60 * 60 * 1000);
        const recentTimestamp = now - (2 * 24 * 60 * 60 * 1000);
        const mscLogThread = logThreads.get(RATED_LOG_THREAD_IDS.MSC_1V1);
        const firstMessage = {
            id: 'log-old-1',
            createdTimestamp: oldTimestamp,
            delete: jest.fn(async () => {})
        };
        const secondMessage = {
            id: 'log-old-2',
            createdTimestamp: oldTimestamp,
            delete: jest.fn(async () => {})
        };
        const recentMessage = {
            id: 'log-recent-1',
            createdTimestamp: recentTimestamp,
            delete: jest.fn(async () => {})
        };
        const starterMessage = {
            id: mscLogThread.id,
            createdTimestamp: oldTimestamp,
            delete: jest.fn(async () => {})
        };
        const collection = new Map([
            [firstMessage.id, firstMessage],
            [secondMessage.id, secondMessage],
            [recentMessage.id, recentMessage],
            [starterMessage.id, starterMessage]
        ]);
        mscLogThread.messages.fetch
            .mockResolvedValueOnce(collection)
            .mockResolvedValue(new Map());
        mscLogThread.bulkDelete.mockResolvedValueOnce(new Map([[firstMessage.id, firstMessage]]));

        await competitiveRatedQueue.__runRuntimeLogCleanupForTests(client, now);

        expect(mscLogThread.bulkDelete).toHaveBeenCalledTimes(1);
        expect([...mscLogThread.bulkDelete.mock.calls[0][0].keys()].sort()).toEqual(['log-old-1', 'log-old-2']);
        expect(mscLogThread.bulkDelete).toHaveBeenCalledWith(expect.any(Map), true);
        expect(secondMessage.delete).toHaveBeenCalled();
        expect(recentMessage.delete).not.toHaveBeenCalled();
        expect(starterMessage.delete).not.toHaveBeenCalled();
        for (const thread of logThreads.values()) {
            const cleanupLog = thread.send.mock.calls.map(([payload]) => payload.content).join('\n');
            expect(cleanupLog).toContain('[info]');
            expect(cleanupLog).toContain('cleanup.complete');
        }
    });

    it('ignores obsolete duration buttons from the removed search-window flow', async () => {
        const { client } = createMatchClientMock();
        const interaction = createButtonInteractionMock({
            customId: 'rated:competitive:duration:1501486517464600657:1v1:30',
            userId: '12345',
            client
        });

        const handled = await competitiveRatedQueue.handleInteraction(interaction);

        expect(handled).toBe(false);
        expect(interaction.reply).not.toHaveBeenCalled();
        expect(interaction.deferReply).not.toHaveBeenCalled();
        expect(competitiveRatedQueue.__getStateSnapshot().activeSearchCount).toBe(0);
    });

    it('renders a counts-only status message', () => {
        expect(competitiveRatedQueue.buildStatusMessageContent({ '1v1': 2, '2v2': 1 }))
            .toBe('Players in 1vs1 Pool: **👤 2**\nPlayers in 2vs2 Pool: **👥 1**');
    });

    it('prefixes status messages with the panel game LFG role mention', () => {
        expect(competitiveRatedQueue.buildStatusMessageContent({ '1v1': 1, '2v2': 0 }, '1501486517464600657'))
            .toBe('<@&680810288605298744>\nPlayers in 1vs1 Pool: **👤 1**');
        expect(competitiveRatedQueue.buildStatusMessageContent({ '1v1': 1, '2v2': 0 }, '1504056016629927966'))
            .toBe('<@&781487757176209428>\nPlayers in 1vs1 Pool: **👤 1**');
        expect(competitiveRatedQueue.buildStatusMessageContent({ '1v1': 1, '2v2': 1 }, '1502350088431992852'))
            .toBe('<@&944150830972538923>\nPlayers in 1vs1 Pool: **👤 1**\nPlayers in 2vs2 Pool: **👥 1**');
    });

    it('omits zero-count pool lines from the status message', () => {
        expect(competitiveRatedQueue.buildStatusMessageContent({ '1v1': 2, '2v2': 0 }))
            .toBe('Players in 1vs1 Pool: **👤 2**');
    });

    it('renders no status content when both pools are empty', () => {
        expect(competitiveRatedQueue.buildStatusMessageContent({ '1v1': 0, '2v2': 0 }))
            .toBe('');
    });

    it('builds match-found payloads with a Go to Match link button', () => {
        const threadUrl = competitiveRatedQueue.buildThreadUrl('guild-1', 'thread-1');
        const payload = competitiveRatedQueue.buildMatchFoundPayload('1v1', threadUrl, ['<@home-user>', '<@away-user>']);
        const button = payload.components[0].toJSON().components[0];

        expect(threadUrl).toBe('https://discord.com/channels/guild-1/thread-1');
        expect(payload.content).toBe('<:blcheck:1502370767906803893> Opponent found!\n<@home-user> VS <@away-user>');
        expect(button.label).toBe('Go to Match');
        expect(button.style).toBe(5);
        expect(button.url).toBe(threadUrl);
    });

    it('clears matched duration interactions without another match-found reply', async () => {
        const interaction = {
            deleteReply: jest.fn(async () => {})
        };

        await competitiveRatedQueue.clearMatchedInteractionResponse(interaction);

        expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
    });

    it('sends ephemeral match-found notifications to each participant before thread setup', async () => {
        competitiveRatedQueue.__seedStateForTests({
            cachedOptionsByGameType: {
                MSC: createMatchOptions()
            }
        });
        const { channel, client, thread } = createMatchClientMock();
        const searches = [
            createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1, playerId: 101 }),
            createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2, playerId: 102 })
        ];

        const match = await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
            { channelId: channel.id, gameType: 'MSC' },
            searches,
            client,
            { skipReconcile: true }
        );

        expect(channel.threads.create).toHaveBeenCalledTimes(1);
        expect(channel.threads.create.mock.calls[0][0]).toEqual(expect.objectContaining({
            type: ChannelType.PublicThread
        }));
        expect(channel.threads.create.mock.calls[0][0]).not.toHaveProperty('invitable');
        expect(channel.send).not.toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Opponent found')
        }));
        expect(mockRatedMatchDao.activateMatch).toHaveBeenCalledWith(expect.objectContaining({
            participants: [
                expect.objectContaining({ discordId: 'home-user', playerId: 101 }),
                expect.objectContaining({ discordId: 'away-user', playerId: 102 })
            ]
        }));
        expect(match.participantIdByDiscordId.get('home-user')).toBe(7000);
        expect(match.participantIdByDiscordId.get('away-user')).toBe(7001);
        for (const search of searches) {
            expect(search.notificationInteraction.editReply).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: '<:blcheck:1502370767906803893> Opponent found!\n<@home-user> VS <@away-user>'
                })
            );
            expect(search.notificationInteraction.editReply.mock.invocationCallOrder[0])
                .toBeLessThan(thread.send.mock.invocationCallOrder[0]);
        }
    });

    it('allocates independent DB-backed match numbers for every game and mode', async () => {
        async function createMatchName(gameType, mode, index) {
            const { channel, client } = createMatchClientMock();
            const searches = Array.from({ length: mode === '2v2' ? 4 : 2 }, (_, playerIndex) => {
                const search = createCompetitiveRatedSearch({
                    id: `${gameType}-${mode}-${index}-${playerIndex}`,
                    userId: `${gameType}-${mode}-${index}-${playerIndex}`,
                    username: `${gameType}${mode}${index}${playerIndex}`,
                    createdAt: index * 10 + playerIndex,
                    gameType
                });
                search.mode = mode;
                return search;
            });

            await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType },
                searches,
                client,
                { skipReconcile: true }
            );

            return channel.threads.create.mock.calls[0][0].name;
        }

        await expect(createMatchName('MSC', '1v1', 1)).resolves.toMatch(/^1v1 #1 \| /);
        await expect(createMatchName('MSC', '1v1', 2)).resolves.toMatch(/^1v1 #2 \| /);
        await expect(createMatchName('MSC', '2v2', 1)).resolves.toMatch(/^2v2 #1 \| /);
        await expect(createMatchName('SMS', '1v1', 1)).resolves.toMatch(/^1v1 #1 \| /);
        await expect(createMatchName('SMS', '2v2', 1)).resolves.toMatch(/^2v2 #1 \| /);
        await expect(createMatchName('MSBL', '1v1', 1)).resolves.toMatch(/^1v1 #1 \| /);
        await expect(createMatchName('MSBL', '2v2', 1)).resolves.toMatch(/^2v2 #1 \| /);
    });

    it('reserves searches before thread creation so concurrent match creation cannot create duplicate threads', async () => {
        competitiveRatedQueue.__seedStateForTests({
            cachedOptionsByGameType: {
                MSC: createMatchOptions()
            }
        });
        const { channel, client } = createMatchClientMock();
        const searches = [
            createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
            createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2 })
        ];

        const [firstMatch, secondMatch] = await Promise.all([
            competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSC' },
                searches,
                client,
                { skipReconcile: true }
            ),
            competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSC' },
                searches,
                client,
                { skipReconcile: true }
            )
        ]);

        expect(firstMatch).toEqual(expect.objectContaining({ threadId: 'thread-1' }));
        expect(secondMatch).toBeNull();
        expect(channel.threads.create).toHaveBeenCalledTimes(1);
        expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
    });

    it('releases match reservations when thread creation fails so the pool can retry', async () => {
        competitiveRatedQueue.__seedStateForTests({
            cachedOptionsByGameType: {
                MSC: createMatchOptions()
            }
        });
        const { channel, client } = createMatchClientMock();
        const searches = [
            createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
            createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2 })
        ];
        competitiveRatedQueue.__seedStateForTests({ activeSearches: searches });
        channel.threads.create.mockRejectedValueOnce(new Error('missing thread permission'));

        const failedMatch = await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
            { channelId: channel.id, gameType: 'MSC' },
            searches,
            client,
            { skipReconcile: true }
        );

        expect(failedMatch).toBeNull();
        expect(competitiveRatedQueue.__getStateSnapshot().activeSearchCount).toBe(2);
        expect(searches.every(search => !search.matchmakingReservedBy)).toBe(true);

        const recoveredMatch = await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
            { channelId: channel.id, gameType: 'MSC' },
            searches,
            client,
            { skipReconcile: true }
        );

        expect(recoveredMatch).toEqual(expect.objectContaining({ threadId: 'thread-1' }));
        expect(channel.threads.create).toHaveBeenCalledTimes(2);
        expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
    });

    it('falls back to private follow-up for match-found notifications when the original pool reply is gone', async () => {
        competitiveRatedQueue.__seedStateForTests({
            cachedOptionsByGameType: {
                MSC: createMatchOptions()
            }
        });
        const { channel, client } = createMatchClientMock();
        const searches = [
            createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
            createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2 })
        ];
        searches[0].notificationInteraction.editReply.mockRejectedValueOnce(new Error('expired interaction token'));

        await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
            { channelId: channel.id, gameType: 'MSC' },
            searches,
            client,
            { skipReconcile: true }
        );

        expect(searches[0].notificationInteraction.followUp).toHaveBeenCalledWith(expect.objectContaining({
            content: '<:blcheck:1502370767906803893> Opponent found!\n<@home-user> VS <@away-user>',
            flags: MessageFlags.Ephemeral
        }));
        expect(searches[1].notificationInteraction.editReply).toHaveBeenCalled();
    });

    it('uses DB-backed match numbers instead of rebuilding counters from Discord thread names', async () => {
        const { channel, client } = createMatchClientMock();
        channel.threads.fetchActive = jest.fn(async () => ({
            threads: new Map([
                ['done-1v1', { name: '✅ 1v1 #4 | Alpha VS Beta' }],
                ['cancelled-2v2', { name: '🚫 2v2 #3' }],
                ['legacy-1v1', { name: 'CANCELLED | 1v1 #5 | Gamma VS Delta' }]
            ])
        }));

        await competitiveRatedQueue.ensureCompetitiveRatedQueue(client);

        const searches = [
            createCompetitiveRatedSearch({ id: 'search-counter-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
            createCompetitiveRatedSearch({ id: 'search-counter-2', userId: 'away-user', username: 'Away', createdAt: 2 })
        ];

        await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
            { channelId: channel.id, gameType: 'MSC' },
            searches,
            client,
            { skipReconcile: true }
        );

        expect(channel.threads.create).toHaveBeenCalledWith(expect.objectContaining({
            name: expect.stringMatching(/^1v1 #1 \| (Home|Away) VS (Home|Away)$/)
        }));
        expect(mockRatedMatchDao.createMatchHeader).toHaveBeenCalledWith(expect.objectContaining({
            gameId: 1,
            modeCode: '1v1'
        }));
    });

    it('auto cancels and closes a match when the start gate times out', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);

        try {
            competitiveRatedQueue.__seedStateForTests({
                cachedOptionsByGameType: {
                    MSC: createMatchOptions()
                }
            });
            const { channel, client, thread } = createMatchClientMock();
            const searches = [
                createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
                createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2 })
            ];

            await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSC' },
                searches,
                client,
                { skipReconcile: true }
            );
            expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);

            jest.advanceTimersByTime(5 * 60_000);
            await competitiveRatedQueue.__tickForTests(client);
            await flushAsyncTasks();

            const cancelPayload = findThreadPayload(thread, payload => payload.content?.includes('Game 1 was not started within the allowed time.'));
            const cancelNoticePayload = findThreadPayload(thread, payload => payload.content?.includes('**MATCH CANCELLED.**'));
            expect(cancelPayload.content).toContain('Game 1 was not started within the allowed time.');
            expect(cancelPayload.content).toContain('automatically ended because players were inactive');
            expect(cancelPayload.content).not.toContain('MATCH CANCELLED DUE TO INACTIVITY');
            expect(cancelPayload.content).toMatch(/^>>> /);
            expect(cancelNoticePayload?.content).toContain('**MATCH CANCELLED.**');
            expect(thread.setName).toHaveBeenCalledWith(expect.stringMatching(/^🚫 1v1 #1 \| (Home|Away) VS (Home|Away)$/));
            expect(thread.setLocked).toHaveBeenCalledWith(true, 'MSC competitive match inactivity timeout');
            expect(thread.setArchived).toHaveBeenCalledWith(true, 'MSC competitive match inactivity timeout');
            expectThreadRenameBeforeClose(thread);
            expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(0);
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('auto cancels and closes a match when the WIN GAME phase times out', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.6);

        try {
            competitiveRatedQueue.__seedStateForTests({
                cachedOptionsByGameType: {
                    MSC: createMatchOptions()
                }
            });
            const { channel, client, thread } = createMatchClientMock();
            const searches = [
                createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
                createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2 })
            ];

            await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSC' },
                searches,
                client,
                { skipReconcile: true }
            );

            const setupPayload = findThreadPayload(thread, payload =>
                payload.components?.[0]?.toJSON().components[0].custom_id.includes(':match:start:')
            );
            const startCustomId = getFirstButtonCustomId(setupPayload);

            // HOME clicks Start → gets stadium buttons in ephemeral
            const homeStartInteraction = createButtonInteractionMock({ customId: startCustomId, userId: 'home-user', client });
            await competitiveRatedQueue.handleInteraction(homeStartInteraction);
            const stadiumCustomId = homeStartInteraction.editReply.mock.calls.at(-1)[0].components[0].toJSON().components[0].custom_id;

            // AWAY clicks Start → gets captain buttons in ephemeral
            const awayStartInteraction = createButtonInteractionMock({ customId: startCustomId, userId: 'away-user', client });
            await competitiveRatedQueue.handleInteraction(awayStartInteraction);
            const captainCustomId = awayStartInteraction.editReply.mock.calls.at(-1)[0].components[0].toJSON().components[0].custom_id;

            await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
                customId: stadiumCustomId,
                userId: 'home-user',
                client
            }));

            await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
                customId: captainCustomId,
                userId: 'away-user',
                client
            }));

            expect(findThreadPayload(thread, payload => payload.components?.[0]?.toJSON().components[0].label === 'GAME WIN'))
                .toBeDefined();

            jest.advanceTimersByTime(30 * 60_000);
            await competitiveRatedQueue.__tickForTests(client);
            await flushAsyncTasks();

            const cancelPayload = findThreadPayload(thread, payload => payload.content?.includes('Game 1 was not completed within the allowed time.'));
            const cancelNoticePayload = findThreadPayload(thread, payload => payload.content?.includes('**MATCH CANCELLED.**'));
            expect(cancelPayload.content).toContain('Game 1 was not completed within the allowed time.');
            expect(cancelPayload.content).not.toContain('MATCH CANCELLED DUE TO INACTIVITY');
            expect(cancelPayload.content).toMatch(/^>>> /);
            expect(cancelNoticePayload?.content).toContain('**MATCH CANCELLED.**');
            expect(thread.setName).toHaveBeenCalledWith('🚫 1v1 #1 | Home VS Away');
            expect(thread.setLocked).toHaveBeenCalledWith(true, 'MSC competitive match inactivity timeout');
            expect(thread.setArchived).toHaveBeenCalledWith(true, 'MSC competitive match inactivity timeout');
            expectThreadRenameBeforeClose(thread);
            expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(0);
        } finally {
            randomSpy.mockRestore();
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('sends stadium ephemeral to HOME and captain ephemeral to AWAY on Start click', async () => {
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9); // >= 0.5 → search[0] (home-user) is HOME
        try {
            jest.useFakeTimers({ doNotFake: ['performance'] });
            jest.setSystemTime(1_000_000);
            competitiveRatedQueue.__seedStateForTests({
                cachedOptionsByGameType: {
                    MSC: createMatchOptions()
                }
            });
            const { channel, client, thread } = createMatchClientMock();
            const searches = [
                createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
                createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2 })
            ];

            await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSC' },
                searches,
                client,
                { skipReconcile: true }
            );

            const setupPayload = findThreadPayload(thread, payload =>
                payload.components?.[0]?.toJSON().components[0].custom_id.includes(':match:start:')
            );
            const setupMessage = findThreadMessage(thread, payload =>
                payload.components?.[0]?.toJSON().components[0].custom_id.includes(':match:start:')
            );
            const startCustomId = getFirstButtonCustomId(setupPayload);

            const outsiderStart = createButtonInteractionMock({ customId: startCustomId, userId: 'outsider-user', client });
            await competitiveRatedQueue.handleInteraction(outsiderStart);
            expect(outsiderStart.editReply.mock.calls.at(-1)[0].content).toContain('HOME');

            const homeStart = createButtonInteractionMock({ customId: startCustomId, userId: 'home-user', client });
            await competitiveRatedQueue.handleInteraction(homeStart);
            expect(homeStart.editReply.mock.calls.at(-1)[0].content).toContain('STADIUM');
            expect(homeStart.editReply.mock.calls.at(-1)[0].content).toContain('Time remaining:');
            expect(homeStart.editReply.mock.calls.at(-1)[0].content).toContain(relativeTimestamp(1_120_000));
            expect(homeStart.editReply.mock.calls.at(-1)[0].components[0].toJSON().components[0].custom_id)
                .toContain(':match:stadium:');
            expect(findThreadPayload(thread, payload =>
                payload.components?.[0]?.toJSON().components[0]?.custom_id?.includes(':match:stadium:')
            )).toBeUndefined();

            const awayStart = createButtonInteractionMock({ customId: startCustomId, userId: 'away-user', client });
            await competitiveRatedQueue.handleInteraction(awayStart);
            expect(awayStart.editReply.mock.calls.at(-1)[0].content).toContain('CAPTAIN');
            expect(awayStart.editReply.mock.calls.at(-1)[0].content).toContain('Time remaining:');
            expect(awayStart.editReply.mock.calls.at(-1)[0].content).toContain(relativeTimestamp(1_120_000));
            expect(awayStart.editReply.mock.calls.at(-1)[0].components[0].toJSON().components[0].custom_id)
                .toContain(':match:captain:');
            expect(findThreadPayload(thread, payload =>
                payload.components?.[0]?.toJSON().components[0]?.custom_id?.includes(':match:captain:')
            )).toBeUndefined();
            expect(threadHasImagePayload(thread, 'g1.png')).toBe(true);
            expectFileNotImmediatelyBefore(thread, 'sep.png', 'g1.png');
            expectPublicThreadTextIsQuoted(thread);
            expect(setupMessage.delete).toHaveBeenCalled();
            expect(setupMessage.edit).not.toHaveBeenCalled();
        } finally {
            randomSpy.mockRestore();
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('shows Battle Dome as The Battle Dome in SMS stadium buttons', async () => {
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9);
        try {
            competitiveRatedQueue.__seedStateForTests({
                cachedOptionsByGameType: {
                    SMS: {
                        ...createMatchOptions(),
                        stadiums: [
                            { value: 'battledome', code: '930869139516559431', description: 'Battle Dome' },
                            { value: 'bowserstadium', code: '930869106893279332', description: 'Bowser Stadium' },
                            { value: 'craterfield', code: '930869067936567317', description: 'Crater Field' },
                            { value: 'kongacoliseum', code: '930869207174897725', description: 'Konga Coliseum' },
                            { value: 'palace', code: '930852684884480011', description: 'The Palace' },
                            { value: 'pipeline', code: '930852734704431194', description: 'Pipeline Central' },
                            { value: 'underground', code: '940276774191923231', description: 'The Underground' }
                        ]
                    }
                }
            });
            const { channel, client, thread } = createMatchClientMock();
            const searches = [
                createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1, gameType: 'SMS' }),
                createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2, gameType: 'SMS' })
            ];

            await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'SMS' },
                searches,
                client,
                { skipReconcile: true }
            );

            const setupPayload = findThreadPayload(thread, payload =>
                payload.components?.[0]?.toJSON().components[0].custom_id.includes(':match:start:')
            );
            const homeStart = createButtonInteractionMock({
                customId: getFirstButtonCustomId(setupPayload),
                userId: 'home-user',
                client
            });
            await competitiveRatedQueue.handleInteraction(homeStart);

            const labels = getButtonComponents(homeStart.editReply.mock.calls.at(-1)[0])
                .map(component => component.label);
            expect(labels[0]).toBe('THE BATTLE DOME');
            expect(labels).toContain('BOWSER STADIUM');
            expect(labels).toContain('THE UNDERGROUND');
        } finally {
            randomSpy.mockRestore();
            competitiveRatedQueue.__resetState();
        }
    });

    it('processes simultaneous Start Match clicks from both players without a shared lock warning', async () => {
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9);
        try {
            competitiveRatedQueue.__seedStateForTests({
                cachedOptionsByGameType: {
                    MSC: createMatchOptions()
                }
            });
            const { channel, client, thread } = createMatchClientMock();
            const searches = [
                createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
                createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2 })
            ];

            await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSC' },
                searches,
                client,
                { skipReconcile: true }
            );

            const setupPayload = findThreadPayload(thread, payload =>
                payload.components?.[0]?.toJSON().components[0].custom_id.includes(':match:start:')
            );
            const startCustomId = getFirstButtonCustomId(setupPayload);
            const homeStart = createButtonInteractionMock({ customId: startCustomId, userId: 'home-user', client });
            const awayStart = createButtonInteractionMock({ customId: startCustomId, userId: 'away-user', client });

            await Promise.all([
                competitiveRatedQueue.handleInteraction(homeStart),
                competitiveRatedQueue.handleInteraction(awayStart)
            ]);

            const replyContents = [
                ...homeStart.reply.mock.calls,
                ...awayStart.reply.mock.calls
            ].map(([payload]) => payload.content);
            expect(replyContents).not.toContain('That action is already being processed.');
            expect(homeStart.editReply.mock.calls.at(-1)[0].content).toContain('STADIUM');
            expect(awayStart.editReply.mock.calls.at(-1)[0].content).toContain('CAPTAIN');
            expect(threadHasImagePayload(thread, 'g1.png')).toBe(true);
            expectFileNotImmediatelyBefore(thread, 'sep.png', 'g1.png');
            expect(threadHasPublicSelectionButtons(thread)).toBe(false);
        } finally {
            randomSpy.mockRestore();
            competitiveRatedQueue.__resetState();
        }
    });

    it('falls back to a new private follow-up when a Start Match private setup edit cannot reuse the old ephemeral message', async () => {
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            competitiveRatedQueue.__seedStateForTests({
                cachedOptionsByGameType: {
                    MSC: createMatchOptions()
                }
            });
            const { channel, client, thread } = createMatchClientMock();
            const searches = [
                createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
                createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2 })
            ];

            await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSC' },
                searches,
                client,
                { skipReconcile: true }
            );

            const setupPayload = findThreadPayload(thread, payload =>
                payload.components?.[0]?.toJSON().components[0].custom_id.includes(':match:start:')
            );
            const startCustomId = getFirstButtonCustomId(setupPayload);
            const homeStart = createButtonInteractionMock({ customId: startCustomId, userId: 'home-user', client });
            homeStart.editReply.mockRejectedValueOnce(new Error('expired interaction token'));

            await competitiveRatedQueue.handleInteraction(homeStart);

            expect(homeStart.followUp).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('STADIUM'),
                flags: MessageFlags.Ephemeral
            }));
            expect(findThreadPayload(thread, payload =>
                payload.content?.includes('MATCH CANCELLED DUE TO SETUP ERROR')
            )).toBeUndefined();
            expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
        } finally {
            randomSpy.mockRestore();
            warnSpy.mockRestore();
            competitiveRatedQueue.__resetState();
        }
    });

    it('silently ignores a duplicate Start Match click from the same player', async () => {
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9);
        try {
            competitiveRatedQueue.__seedStateForTests({
                cachedOptionsByGameType: {
                    MSC: createMatchOptions()
                }
            });
            const { channel, client, thread } = createMatchClientMock();
            const searches = [
                createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
                createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2 })
            ];

            await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSC' },
                searches,
                client,
                { skipReconcile: true }
            );

            const setupPayload = findThreadPayload(thread, payload =>
                payload.components?.[0]?.toJSON().components[0].custom_id.includes(':match:start:')
            );
            const startCustomId = getFirstButtonCustomId(setupPayload);
            const firstStart = createButtonInteractionMock({ customId: startCustomId, userId: 'home-user', client });
            const duplicateStart = createButtonInteractionMock({ customId: startCustomId, userId: 'home-user', client });

            await Promise.all([
                competitiveRatedQueue.handleInteraction(firstStart),
                competitiveRatedQueue.handleInteraction(duplicateStart)
            ]);

            expect(firstStart.editReply.mock.calls.at(-1)[0].content).toContain('STADIUM');
            expect(duplicateStart.editReply).not.toHaveBeenCalled();
            expect(duplicateStart.deleteReply).toHaveBeenCalled();
            expect(threadHasImagePayload(thread, 'g1.png')).toBe(false);
        } finally {
            randomSpy.mockRestore();
            competitiveRatedQueue.__resetState();
        }
    });

    it('acknowledges Start Match before loading setup options', async () => {
        let resolveOptions;
        mockExecuteQuery.mockImplementationOnce(async () => new Promise(resolve => {
            resolveOptions = () => resolve({
                recordset: [
                    { Type: 'mscstadium', Value: 1, Code: 'bowser', Description: 'Bowser Stadium' },
                    { Type: 'msccaptain', Value: 10, Code: 'mario', Description: 'Mario' }
                ]
            });
        }));
        const { client } = createMatchClientMock();
        const match = createMatchFixture({
            stage: 'awaiting_start'
        });
        competitiveRatedQueue.__seedStateForTests({ activeMatches: [match] });
        const interaction = createButtonInteractionMock({
            customId: 'rated:competitive:match:start:match-1:1',
            userId: 'home-user',
            client
        });

        const pending = competitiveRatedQueue.handleInteraction(interaction);
        await flushAsyncTasks();

        expect(interaction.reply).toHaveBeenCalledWith({
            content: 'Preparing match controls...',
            components: [],
            flags: MessageFlags.Ephemeral
        });
        expect(interaction.editReply).not.toHaveBeenCalled();

        resolveOptions();
        await pending;

        expect(interaction.editReply.mock.calls.at(-1)[0].content).toContain('STADIUM');
    });

    it('does not process Start Match when the interaction could not be acknowledged', async () => {
        const { client, thread } = createMatchClientMock();
        const match = createMatchFixture({
            stage: 'awaiting_start'
        });
        competitiveRatedQueue.__seedStateForTests({
            activeMatches: [match],
            cachedOptionsByGameType: { MSC: createMatchOptions() }
        });
        const interaction = createButtonInteractionMock({
            customId: 'rated:competitive:match:start:match-1:1',
            userId: 'home-user',
            client
        });
        interaction.reply.mockRejectedValueOnce(new Error('Interaction has already been acknowledged.'));
        interaction.deferReply.mockRejectedValueOnce(new Error('Interaction has already been acknowledged.'));

        await competitiveRatedQueue.handleInteraction(interaction);

        expect(interaction.editReply).not.toHaveBeenCalled();
        expect(interaction.followUp).not.toHaveBeenCalled();
        expect(match.startClickedUserIds).toEqual([]);
        expect(threadHasImagePayload(thread, 'g1.png')).toBe(false);
    });

    it('auto-starts MSBL matches without Start Match or setup selections', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);
        try {
            const { channel, client, thread } = createMatchClientMock();
            const searches = [
                createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1, gameType: 'MSBL' }),
                createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2, gameType: 'MSBL' })
            ];

            await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSBL' },
                searches,
                client,
                { skipReconcile: true }
            );

            expect(threadHasImagePayload(thread, 'rules-msbl.png')).toBe(true);
            expect(threadHasImagePayload(thread, 'g1.png')).toBe(true);
            expectFileNotImmediatelyBefore(thread, 'sep.png', 'g1.png');
            expectFileNotImmediatelyAfter(thread, 'g1.png', 'sep.png');
            expect(findThreadPayload(thread, payload =>
                getButtonComponents(payload).some(component => component.label === 'Start Match')
            )).toBeUndefined();
            const winnerPayload = findThreadPayload(thread, payload =>
                getButtonComponents(payload).some(component => component.label === 'GAME WIN')
            );
            expect(winnerPayload).toBeDefined();
            expect(winnerPayload.content).toContain('Press **GAME WIN** when the game is over.');
            expect(winnerPayload.content).toContain('Time remaining:');
            expect(winnerPayload.content).toContain(relativeTimestamp(2_800_000));
            expect(threadHasPublicSelectionButtons(thread)).toBe(false);
            expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('waits for MSBL Confirm Game Loss before posting the game result and next game', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);
        try {
            const { channel, client, logThreads, thread } = createMatchClientMock();
            const searches = [
                createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1, gameType: 'MSBL' }),
                createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2, gameType: 'MSBL' })
            ];

            await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSBL' },
                searches,
                client,
                { skipReconcile: true }
            );

            const gameWinPayload = findThreadPayload(thread, payload =>
                getButtonComponents(payload).some(component => component.label === 'GAME WIN')
            );
            const gameWinCustomId = getButtonCustomIdByLabel(gameWinPayload, 'GAME WIN');
            await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
                customId: gameWinCustomId,
                userId: 'home-user',
                client
            }));

            const confirmMessage = findThreadMessage(thread, message =>
                getButtonComponents(message).some(component => component.label === 'Confirm Game Loss')
            );
            expect(confirmMessage).toBeDefined();
            expect(confirmMessage.content).not.toContain('WINS GAME 1');
            expect(confirmMessage.content).not.toContain('Result:');
            expect(confirmMessage.content).toContain('press **Confirm Game Loss**');
            expect(confirmMessage.content).toContain('Time remaining:');
            expect(confirmMessage.content).toContain(relativeTimestamp(1_120_000));
            expect(getButtonComponents(confirmMessage.payload).some(component => component.label === 'Confirm Game Loss')).toBe(true);
            expect(countThreadPayloads(thread, payload => payload.content?.includes('WINS GAME 1'))).toBe(0);
            expect(threadHasImagePayload(thread, 'g2.png')).toBe(false);
            expect(threadHasPublicSelectionButtons(thread)).toBe(false);

            const confirmCustomId = getButtonCustomIdByLabel(confirmMessage.payload, 'Confirm Game Loss');
            const confirmInteraction = createButtonInteractionMock({
                customId: confirmCustomId,
                userId: 'away-user',
                client
            });
            await competitiveRatedQueue.handleInteraction(confirmInteraction);

            expect(confirmInteraction.editReply).not.toHaveBeenCalled();
            expect(confirmInteraction.deleteReply).toHaveBeenCalled();
            expect(confirmMessage.delete).toHaveBeenCalled();
            const confirmedPayload = findThreadPayload(thread, payload => payload.content?.includes('WINS GAME 1'));
            expect(confirmedPayload.content).toContain('<@home-user>');
            expect(confirmedPayload.content).toContain('Result:');
            expect(confirmedPayload.content).not.toContain('confirmed the loss.');
            expect(threadHasImagePayload(thread, 'g2.png')).toBe(true);
            expectFileImmediatelyBefore(thread, 'sep.png', 'g2.png');
            expectFileNotImmediatelyAfter(thread, 'g2.png', 'sep.png');
            expect(findThreadPayload(thread, payload =>
                getButtonComponents(payload).some(component => component.label === 'GAME WIN')
            )).toBeDefined();
            expect(threadHasPublicSelectionButtons(thread)).toBe(false);

            await flushRuntimeLogs();
            const msblLogs = getLogContents(logThreads, RATED_LOG_THREAD_IDS.MSBL_1V1).join('\n');
            expect(msblLogs).toContain('game.win.reported');
            expect(msblLogs).toContain('game.awaiting_loss_confirm');
            expect(msblLogs).toContain('game.loss_confirmed');
            expect(msblLogs).toContain('game.result.posted');
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('rejects GAME WIN clicks from admin users who are not match participants', async () => {
        const { client } = createMatchClientMock();
        const match = createMatchFixture({
            stage: 'awaiting_winner'
        });
        competitiveRatedQueue.__seedStateForTests({ activeMatches: [match] });

        const interaction = createButtonInteractionMock({
            customId: 'rated:competitive:match:winner:match-1',
            userId: 'admin-user',
            roleIds: [ADMIN_ROLE_ID],
            client
        });
        await competitiveRatedQueue.handleInteraction(interaction);

        expect(match.score).toEqual({ team1: 0, team2: 0 });
        expect(match.stage).toBe('awaiting_winner');
        expect(match.pendingResult).toBeUndefined();
        expect(mockRatedMatchDao.recordGame).not.toHaveBeenCalled();
        expect(mockRatedMatchDao.completeMatch).not.toHaveBeenCalled();
        expect(interaction.editReply.mock.calls.at(-1)[0].content)
            .toContain('Only a player in this match may report a win.');
    });

    it('rejects Confirm Game Loss clicks from admin users who are not the losing participant', async () => {
        const { client } = createMatchClientMock();
        const pendingResult = {
            gameNumber: 1,
            winnerTeamIndex: 1,
            winnerMention: '<@home-user>',
            loserTeamIndex: 2,
            loserRepMention: '<@away-user>',
            reporterDiscordId: 'home-user',
            homeTeamNumber: 1,
            stadiumCode: 'bowser',
            captainCode: 'mario'
        };
        const match = createMatchFixture({
            stage: 'awaiting_loser_confirmation',
            score: { team1: 1, team2: 0 },
            pendingResult,
            pendingResultGameNumber: 1,
            loserTeamIndex: 2,
            loserRepMention: '<@away-user>',
            selectedStadium: { code: 'bowser', description: 'Bowser Stadium' },
            selectedCaptain: { code: 'mario', description: 'Mario' }
        });
        competitiveRatedQueue.__seedStateForTests({ activeMatches: [match] });

        const interaction = createButtonInteractionMock({
            customId: 'rated:competitive:match:loser_confirm:match-1:1',
            userId: 'admin-user',
            roleIds: [ADMIN_ROLE_ID],
            client
        });
        await competitiveRatedQueue.handleInteraction(interaction);

        expect(match.score).toEqual({ team1: 1, team2: 0 });
        expect(match.stage).toBe('awaiting_loser_confirmation');
        expect(match.pendingResult).toEqual(pendingResult);
        expect(mockRatedMatchDao.recordGame).not.toHaveBeenCalled();
        expect(mockRatedMatchDao.completeMatch).not.toHaveBeenCalled();
        expect(interaction.editReply.mock.calls.at(-1)[0].content)
            .toContain('Only the losing player may confirm the game result.');
    });

    it('waits for MSBL Confirm Game Loss before completing a final game', async () => {
        const { client, thread } = createMatchClientMock();
        const match = createMatchFixture({
            firstTo: 1,
            gameType: 'MSBL',
            stage: 'awaiting_winner'
        });
        competitiveRatedQueue.__seedStateForTests({ activeMatches: [match] });

        const winInteraction = createButtonInteractionMock({
            customId: 'rated:competitive:match:winner:match-1',
            userId: 'home-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(winInteraction);

        expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
        expect(findThreadPayload(thread, payload => payload.content?.includes('WINS THE MATCH'))).toBeUndefined();
        expect(threadHasImagePayload(thread, 'g2.png')).toBe(false);
        const confirmPayload = findThreadPayload(thread, payload =>
            getButtonComponents(payload).some(component => component.label === 'Confirm Game Loss')
        );
        expect(confirmPayload).toBeDefined();

        const confirmInteraction = createButtonInteractionMock({
            customId: getButtonCustomIdByLabel(confirmPayload, 'Confirm Game Loss'),
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(confirmInteraction);

        expect(findThreadPayload(thread, payload => payload.content?.includes('WINS THE MATCH'))).toBeDefined();
        expect(threadHasImagePayload(thread, 'g2.png')).toBe(false);
        expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(0);
    });

    it('completes an MSBL final game on Confirm Game Loss timeout without posting another game image', async () => {
        const { client, thread } = createMatchClientMock();
        const match = createMatchFixture({
            firstTo: 1,
            gameType: 'MSBL',
            score: { team1: 1, team2: 0 },
            stage: 'awaiting_loser_confirmation',
            loserTeamIndex: 2,
            loserRepMention: '<@away-user>',
            pendingResult: {
                gameNumber: 1,
                winnerTeamIndex: 1,
                winnerMention: '<@home-user>',
                loserTeamIndex: 2
            },
            pendingResultGameNumber: 1,
            timeoutPhase: 'loser_confirmation',
            timeoutDeadlineAt: Date.now() - 1000
        });
        competitiveRatedQueue.__seedStateForTests({ activeMatches: [match] });

        await competitiveRatedQueue.__tickForTests(client);

        expect(mockRatedMatchDao.recordGame).toHaveBeenCalledTimes(1);
        expect(findThreadPayload(thread, payload => payload.content?.includes('WINS THE MATCH'))).toBeDefined();
        expect(threadHasImagePayload(thread, 'g2.png')).toBe(false);
        expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(0);
    });

    it('processes simultaneous Stadium and Captain picks once and advances to one winner control', async () => {
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9);
        try {
            competitiveRatedQueue.__seedStateForTests({
                cachedOptionsByGameType: {
                    MSC: createMatchOptions()
                }
            });
            const { channel, client, thread } = createMatchClientMock();
            const searches = [
                createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
                createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2 })
            ];

            await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSC' },
                searches,
                client,
                { skipReconcile: true }
            );

            const setupPayload = findThreadPayload(thread, payload =>
                payload.components?.[0]?.toJSON().components[0].custom_id.includes(':match:start:')
            );
            const startCustomId = getFirstButtonCustomId(setupPayload);
            const homeStart = createButtonInteractionMock({ customId: startCustomId, userId: 'home-user', client });
            const awayStart = createButtonInteractionMock({ customId: startCustomId, userId: 'away-user', client });
            await Promise.all([
                competitiveRatedQueue.handleInteraction(homeStart),
                competitiveRatedQueue.handleInteraction(awayStart)
            ]);

            const stadiumCustomId = getButtonCustomIds(homeStart.editReply.mock.calls.at(-1)[0])[0];
            const captainCustomId = getButtonCustomIds(awayStart.editReply.mock.calls.at(-1)[0])[0];
            await Promise.all([
                competitiveRatedQueue.handleInteraction(createButtonInteractionMock({ customId: stadiumCustomId, userId: 'home-user', client })),
                competitiveRatedQueue.handleInteraction(createButtonInteractionMock({ customId: captainCustomId, userId: 'away-user', client }))
            ]);

            expect(countThreadPayloads(thread, payload => payload.content?.includes('chose'))).toBe(1);
            expect(countThreadPayloads(thread, payload => threadPayloadHasFile(payload, 'g1.png'))).toBe(1);
            expect(countThreadPayloads(thread, payload =>
                getButtonComponents(payload).some(component => component.label === 'GAME WIN')
            )).toBe(1);
        } finally {
            randomSpy.mockRestore();
            competitiveRatedQueue.__resetState();
        }
    });

    it('keeps MSC Game Win and Confirm Game Loss in one public control and delays result until next setup picks', async () => {
        const { client, thread } = createMatchClientMock();
        const match = createMatchFixture({
            stage: 'awaiting_winner'
        });
        const initialControl = await thread.send({
            content: 'winner control',
            components: competitiveRatedQueue.buildMatchComponents(match, createMatchOptions())
        });
        match.controlMessageId = initialControl.id;
        competitiveRatedQueue.__seedStateForTests({
            activeMatches: [match],
            cachedOptionsByGameType: { MSC: createMatchOptions() }
        });

        const initialLabels = getButtonComponents(initialControl.payload).map(component => component.label);
        expect(initialLabels).toEqual(['GAME WIN', 'Confirm Game Loss']);

        const earlyConfirm = createButtonInteractionMock({
            customId: getButtonCustomIdByLabel(initialControl.payload, 'Confirm Game Loss'),
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(earlyConfirm);
        expect(match.score.team1).toBe(0);
        expect(match.stage).toBe('awaiting_winner');
        expect(earlyConfirm.deleteReply).toHaveBeenCalled();

        const winInteraction = createButtonInteractionMock({
            customId: getButtonCustomIdByLabel(initialControl.payload, 'GAME WIN'),
            userId: 'home-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(winInteraction);

        expect(match.score.team1).toBe(1);
        expect(match.stage).toBe('awaiting_loser_confirmation');
        expect(initialControl.edit).toHaveBeenCalled();
        expect(initialControl.payload.content).toContain('Confirm Game Loss');
        expect(winInteraction.editReply.mock.calls.at(-1)[0].content)
            .toContain('Waiting for your opponent to confirm the game result');
        const editedComponents = getButtonComponents(initialControl.payload);
        expect(editedComponents.find(component => component.label === 'GAME WIN').disabled).toBe(true);
        expect(editedComponents.find(component => component.label === 'Confirm Game Loss').disabled).not.toBe(true);
        expect(countThreadPayloads(thread, payload => payload.content?.includes('wins **Game 1**'))).toBe(0);
        expect(threadHasImagePayload(thread, 'g2.png')).toBe(false);

        const confirmInteraction = createButtonInteractionMock({
            customId: getButtonCustomIdByLabel(initialControl.payload, 'Confirm Game Loss'),
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(confirmInteraction);

        expect(findThreadPayload(thread, payload => payload.content?.includes('wins **Game 1**'))).toBeUndefined();
        expect(threadHasImagePayload(thread, 'g2.png')).toBe(false);
        expect(winInteraction.editReply.mock.calls.at(-1)[0].content)
            .toContain('Waiting for your opponent to choose the next-game advantage');
        expect(winInteraction.deleteReply).not.toHaveBeenCalled();

        const chooseHomeCustomId = getButtonCustomIdByLabel(confirmInteraction.editReply.mock.calls.at(-1)[0], 'Choose Home');
        const loserAdvantageInteraction = createButtonInteractionMock({
            customId: chooseHomeCustomId,
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(loserAdvantageInteraction);

        const stadiumCustomId = getButtonCustomIds(loserAdvantageInteraction.editReply.mock.calls.at(-1)[0])[0];
        const captainCustomId = getButtonCustomIds(winInteraction.editReply.mock.calls.at(-1)[0])[0];
        await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
            customId: stadiumCustomId,
            userId: 'away-user',
            client
        }));
        await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
            customId: captainCustomId,
            userId: 'home-user',
            client
        }));

        const resultIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('wins **Game 1**'));
        const gameImageIndex = findThreadPayloadIndex(thread, payload => threadPayloadHasFile(payload, 'g2.png'));
        const selectionsIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('chose'));
        expect(resultIndex).toBeGreaterThanOrEqual(0);
        expect(gameImageIndex).toBeGreaterThan(resultIndex);
        expect(selectionsIndex).toBeGreaterThan(gameImageIndex);
        expectFileImmediatelyBefore(thread, 'sep.png', 'g2.png');
    });

    it('keeps SMS Game Win confirm-gated and delays the result until next setup picks', async () => {
        const { client, thread } = createMatchClientMock();
        const match = createMatchFixture({
            gameType: 'SMS',
            stage: 'awaiting_winner'
        });
        competitiveRatedQueue.__seedStateForTests({
            activeMatches: [match],
            cachedOptionsByGameType: { SMS: createMatchOptions() }
        });

        const winInteraction = createButtonInteractionMock({
            customId: 'rated:competitive:match:winner:match-1:1',
            userId: 'home-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(winInteraction);

        expect(match.stage).toBe('awaiting_loser_confirmation');
        expect(threadHasImagePayload(thread, 'g2.png')).toBe(false);
        expect(findThreadPayload(thread, payload => payload.content?.includes('wins **Game 1**'))).toBeUndefined();
        const confirmPayload = findThreadPayload(thread, payload =>
            getButtonComponents(payload).some(component => component.label === 'Confirm Game Loss')
        );

        const confirmInteraction = createButtonInteractionMock({
            customId: getButtonCustomIdByLabel(confirmPayload, 'Confirm Game Loss'),
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(confirmInteraction);

        const resultIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('wins **Game 1**'));
        const gameImageIndex = findThreadPayloadIndex(thread, payload => threadPayloadHasFile(payload, 'g2.png'));
        expect(resultIndex).toBe(-1);
        expect(gameImageIndex).toBe(-1);

        const chooseHomeCustomId = getButtonCustomIdByLabel(confirmInteraction.editReply.mock.calls.at(-1)[0], 'Choose Home');
        const loserAdvantageInteraction = createButtonInteractionMock({
            customId: chooseHomeCustomId,
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(loserAdvantageInteraction);
        await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
            customId: getButtonCustomIds(loserAdvantageInteraction.editReply.mock.calls.at(-1)[0])[0],
            userId: 'away-user',
            client
        }));
        await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
            customId: getButtonCustomIds(winInteraction.editReply.mock.calls.at(-1)[0])[0],
            userId: 'home-user',
            client
        }));

        const delayedResultIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('wins **Game 1**'));
        const delayedGameImageIndex = findThreadPayloadIndex(thread, payload => threadPayloadHasFile(payload, 'g2.png'));
        const delayedSelectionsIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('chose'));
        expect(delayedResultIndex).toBeGreaterThanOrEqual(0);
        expect(delayedGameImageIndex).toBeGreaterThan(delayedResultIndex);
        expect(delayedSelectionsIndex).toBeGreaterThan(delayedGameImageIndex);
        expectFileImmediatelyBefore(thread, 'sep.png', 'g2.png');
    });

    it('auto-selects a random stadium for HOME when the 2-minute selection timer fires', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

        try {
            competitiveRatedQueue.__seedStateForTests({
                cachedOptionsByGameType: { MSC: createMatchOptions() }
            });
            const { channel, client, thread } = createMatchClientMock();
            const searches = [
                createCompetitiveRatedSearch({ id: 'search-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
                createCompetitiveRatedSearch({ id: 'search-2', userId: 'away-user', username: 'Away', createdAt: 2 })
            ];

            await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSC' },
                searches,
                client,
                { skipReconcile: true }
            );

            const setupPayload = findThreadPayload(thread, payload =>
                payload.components?.[0]?.toJSON().components[0].custom_id.includes(':match:start:')
            );
            const startCustomId = getFirstButtonCustomId(setupPayload);
            await competitiveRatedQueue.handleInteraction(
                createButtonInteractionMock({ customId: startCustomId, userId: 'home-user', client })
            );
            await competitiveRatedQueue.handleInteraction(
                createButtonInteractionMock({ customId: startCustomId, userId: 'away-user', client })
            );

            jest.advanceTimersByTime(2 * 60_000);
            await flushAsyncTasks();
            await flushAsyncTasks();

            // Both players auto-selected → combined confirmation message appears
            const confPayload = findThreadPayload(thread, payload => payload.content?.includes('chose'));
            expect(confPayload).toBeDefined();
            expect(confPayload.content).toContain('<@home-user>');
            expect(confPayload.content).toContain('<@away-user>');
            expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
        } finally {
            randomSpy.mockRestore();
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('serializes timer and click selection races so setup advances exactly once', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

        try {
            competitiveRatedQueue.__seedStateForTests({
                cachedOptionsByGameType: { MSC: createMatchOptions() }
            });
            const { channel, client, thread } = createMatchClientMock();
            const searches = [
                createCompetitiveRatedSearch({ id: 'search-race-1', userId: 'home-user', username: 'Home', createdAt: 1 }),
                createCompetitiveRatedSearch({ id: 'search-race-2', userId: 'away-user', username: 'Away', createdAt: 2 })
            ];

            const match = await competitiveRatedQueue.__createCompetitiveRatedMatchForTests(
                { channelId: channel.id, gameType: 'MSC' },
                searches,
                client,
                { skipReconcile: true }
            );

            const setupPayload = findThreadPayload(thread, payload =>
                payload.components?.[0]?.toJSON().components[0].custom_id.includes(':match:start:')
            );
            const startCustomId = getFirstButtonCustomId(setupPayload);
            const homeStart = createButtonInteractionMock({ customId: startCustomId, userId: 'home-user', client });
            const awayStart = createButtonInteractionMock({ customId: startCustomId, userId: 'away-user', client });
            await Promise.all([
                competitiveRatedQueue.handleInteraction(homeStart),
                competitiveRatedQueue.handleInteraction(awayStart)
            ]);

            const stadiumCustomId = getButtonCustomIds(homeStart.editReply.mock.calls.at(-1)[0])[0];
            const stadiumPick = createButtonInteractionMock({
                customId: stadiumCustomId,
                userId: 'home-user',
                client
            });
            const pickPromise = competitiveRatedQueue.handleInteraction(stadiumPick);

            jest.advanceTimersByTime(2 * 60_000);
            await Promise.all([pickPromise, flushAsyncTasks()]);

            expect(match.selectedStadium).not.toBeNull();
            expect(match.selectedCaptain).not.toBeNull();
            expect(match.stage).toBe('awaiting_winner');
            expect(countThreadPayloads(thread, payload => payload.content?.includes('chose'))).toBe(1);
            expect(countThreadPayloads(thread, payload =>
                getButtonComponents(payload).some(component => component.label === 'GAME WIN')
            )).toBe(1);
            expect(threadHasPublicSelectionButtons(thread)).toBe(false);
        } finally {
            randomSpy.mockRestore();
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('randomly resolves loser choice and continues when the 2-minute timeout fires', async () => {
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.6);
        const { client, thread } = createMatchClientMock();
        const now = Date.now();
        const match = createMatchFixture({
            score: { team1: 1, team2: 0 },
            stage: 'awaiting_loser_confirmation',
            loserTeamIndex: 2,
            loserRepMention: '<@away-user>',
            pendingResultGameNumber: 1,
            timeoutPhase: 'loser_confirmation',
            timeoutDeadlineAt: now - 1000
        });

        competitiveRatedQueue.__seedStateForTests({
            activeMatches: [match],
            cachedOptionsByGameType: { MSC: createMatchOptions() }
        });

        await competitiveRatedQueue.__tickForTests(client);

        const resultIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('wins **Game 1**'));
        const gameImageIndex = findThreadPayloadIndex(thread, payload => threadPayloadHasFile(payload, 'g2.png'));
        const selectionsIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('chose'));
        expect(resultIndex).toBeGreaterThanOrEqual(0);
        expect(gameImageIndex).toBeGreaterThan(resultIndex);
        expect(selectionsIndex).toBeGreaterThan(gameImageIndex);
        expectFileImmediatelyBefore(thread, 'sep.png', 'g2.png');
        expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
        expect(match.selectedStadium).not.toBeNull();
        expect(match.selectedCaptain).not.toBeNull();
        expect(match.stage).toBe('awaiting_winner');

        randomSpy.mockRestore();
    });

    it('shows private Stadium buttons to the loser and private Captain buttons to the winner after Choose Home', async () => {
        const { client, thread } = createMatchClientMock();
        const { winnerInteraction, chooseHomeCustomId } = await prepareLoserAdvantagePrompt(client);

        expect(threadHasImagePayload(thread, 'g2.png')).toBe(false);

        const loserAdvantageInteraction = createButtonInteractionMock({
            customId: chooseHomeCustomId,
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(loserAdvantageInteraction);

        const loserPayload = loserAdvantageInteraction.editReply.mock.calls.at(-1)[0];
        const winnerPayload = winnerInteraction.editReply.mock.calls.at(-1)[0];
        const loserCustomIds = getButtonCustomIds(loserPayload);
        const winnerCustomIds = getButtonCustomIds(winnerPayload);

        expect(loserPayload.content).toContain('STADIUM');
        expect(loserPayload.content.startsWith('>')).toBe(false);
        expect(loserCustomIds.length).toBeGreaterThan(0);
        expect(loserCustomIds.every(customId => customId.includes(':match:stadium:'))).toBe(true);
        expect(winnerPayload.content).toContain('CAPTAIN');
        expect(winnerPayload.content.startsWith('>')).toBe(false);
        expect(winnerCustomIds.length).toBeGreaterThan(0);
        expect(winnerCustomIds.every(customId => customId.includes(':match:captain:'))).toBe(true);
        expect(threadHasPublicSelectionButtons(thread)).toBe(false);
        expect(threadHasImagePayload(thread, 'g2.png')).toBe(false);

        await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
            customId: loserCustomIds[0],
            userId: 'away-user',
            client
        }));
        expect(threadHasImagePayload(thread, 'g2.png')).toBe(false);

        await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
            customId: winnerCustomIds[0],
            userId: 'home-user',
            client
        }));

        const gameImageIndex = findThreadPayloadIndex(thread, payload => threadPayloadHasFile(payload, 'g2.png'));
        const resultIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('wins **Game 1**'));
        const selectionsIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('chose'));
        const gameWinIndices = thread.send.mock.calls
            .map(([payload], index) =>
                getButtonComponents(payload).some(component => component.label === 'GAME WIN') ? index : -1
            )
            .filter(index => index >= 0);
        expect(resultIndex).toBeGreaterThanOrEqual(0);
        expect(gameImageIndex).toBeGreaterThan(resultIndex);
        expect(selectionsIndex).toBeGreaterThan(gameImageIndex);
        expect(gameImageIndex).toBeGreaterThanOrEqual(0);
        expect(gameWinIndices.at(-1)).toBeGreaterThan(selectionsIndex);
        expectFileImmediatelyBefore(thread, 'sep.png', 'g2.png');
        expect(threadHasPublicSelectionButtons(thread)).toBe(false);
    });

    it('falls back to a new private follow-up when the loser private setup edit cannot reuse the old ephemeral message', async () => {
        const { client, thread } = createMatchClientMock();
        const { winnerInteraction, chooseHomeCustomId } = await prepareLoserAdvantagePrompt(client);
        const loserAdvantageInteraction = createButtonInteractionMock({
            customId: chooseHomeCustomId,
            userId: 'away-user',
            client
        });
        loserAdvantageInteraction.editReply.mockRejectedValueOnce(new Error('The reply to this interaction has not been sent or deferred.'));

        await competitiveRatedQueue.handleInteraction(loserAdvantageInteraction);

        expect(loserAdvantageInteraction.followUp).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('STADIUM'),
            flags: MessageFlags.Ephemeral
        }));
        expect(winnerInteraction.editReply.mock.calls.at(-1)[0].content).toContain('CAPTAIN');
        expect(findThreadPayload(thread, payload =>
            payload.content?.includes('MATCH CANCELLED DUE TO SETUP ERROR')
        )).toBeUndefined();
        expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
    });

    it('posts the next game image after Confirm Game Loss and delays the game result until selections', async () => {
        const { client, thread } = createMatchClientMock();
        const match = createMatchFixture({
            stage: 'awaiting_winner'
        });
        competitiveRatedQueue.__seedStateForTests({
            activeMatches: [match],
            cachedOptionsByGameType: { MSC: createMatchOptions() }
        });

        const winInteraction = createButtonInteractionMock({
            customId: 'rated:competitive:match:winner:match-1',
            userId: 'home-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(winInteraction);

        const confirmLossIndex = findThreadPayloadIndex(thread, payload =>
            getButtonComponents(payload).some(component => component.label === 'Confirm Game Loss')
        );
        expect(threadHasImagePayload(thread, 'g2.png')).toBe(false);
        expect(confirmLossIndex).toBeGreaterThanOrEqual(0);
        expect(threadHasPublicSelectionButtons(thread)).toBe(false);

        const confirmPayload = thread.send.mock.calls[confirmLossIndex][0];
        const confirmInteraction = createButtonInteractionMock({
            customId: getButtonCustomIdByLabel(confirmPayload, 'Confirm Game Loss'),
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(confirmInteraction);

        const resultIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('wins **Game 1**'));
        const gameImageIndex = findThreadPayloadIndex(thread, payload => threadPayloadHasFile(payload, 'g2.png'));
        expect(resultIndex).toBe(-1);
        expect(gameImageIndex).toBe(-1);

        const loserAdvantageInteraction = createButtonInteractionMock({
            customId: getButtonCustomIdByLabel(confirmInteraction.editReply.mock.calls.at(-1)[0], 'Choose Home'),
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(loserAdvantageInteraction);
        await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
            customId: getButtonCustomIds(loserAdvantageInteraction.editReply.mock.calls.at(-1)[0])[0],
            userId: 'away-user',
            client
        }));
        await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
            customId: getButtonCustomIds(winInteraction.editReply.mock.calls.at(-1)[0])[0],
            userId: 'home-user',
            client
        }));

        const delayedResultIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('wins **Game 1**'));
        const selectionsIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('chose'));
        const delayedGameImageIndex = findThreadPayloadIndex(thread, payload => threadPayloadHasFile(payload, 'g2.png'));
        expect(delayedResultIndex).toBeGreaterThan(confirmLossIndex);
        expect(delayedGameImageIndex).toBeGreaterThan(delayedResultIndex);
        expect(selectionsIndex).toBeGreaterThan(delayedGameImageIndex);
        expectFileImmediatelyBefore(thread, 'sep.png', 'g2.png');
    });

    it('silently ignores duplicate Game Win clicks for the same game', async () => {
        const { client, thread } = createMatchClientMock();
        const match = createMatchFixture({
            stage: 'awaiting_winner'
        });
        competitiveRatedQueue.__seedStateForTests({
            activeMatches: [match],
            cachedOptionsByGameType: { MSC: createMatchOptions() }
        });

        const firstWin = createButtonInteractionMock({
            customId: 'rated:competitive:match:winner:match-1:1',
            userId: 'home-user',
            client
        });
        const duplicateWin = createButtonInteractionMock({
            customId: 'rated:competitive:match:winner:match-1:1',
            userId: 'home-user',
            client
        });

        await Promise.all([
            competitiveRatedQueue.handleInteraction(firstWin),
            competitiveRatedQueue.handleInteraction(duplicateWin)
        ]);

        expect(match.score.team1).toBe(1);
        expect(match.score.team2).toBe(0);
        expect(match.stage).toBe('awaiting_loser_confirmation');
        expect(countThreadPayloads(thread, payload => payload.content?.includes('wins **Game 1**'))).toBe(0);
        expect(countThreadPayloads(thread, payload => threadPayloadHasFile(payload, 'g2.png'))).toBe(0);
        expect(countThreadPayloads(thread, payload =>
            getButtonComponents(payload).some(component => component.label === 'Confirm Game Loss')
        )).toBe(1);
        expect(duplicateWin.deleteReply).toHaveBeenCalled();
    });

    it('processes winner clicks in different match threads independently', async () => {
        const firstMock = createMatchClientMock();
        const secondMock = createMatchClientMock();
        secondMock.thread.id = 'thread-2';
        secondMock.thread.name = '1v1 #2 | Alpha VS Beta';
        const client = {
            user: firstMock.client.user,
            channels: {
                cache: firstMock.client.channels.cache,
                fetch: jest.fn(async channelId => {
                    if (channelId === firstMock.thread.id) return firstMock.thread;
                    if (channelId === secondMock.thread.id) return secondMock.thread;
                    return firstMock.channel;
                })
            }
        };
        const firstMatch = createMatchFixture({
            id: 'match-1',
            threadId: firstMock.thread.id,
            stage: 'awaiting_winner'
        });
        const secondMatch = createMatchFixture({
            id: 'match-2',
            threadId: secondMock.thread.id,
            threadName: '1v1 #2 | Alpha VS Beta',
            stage: 'awaiting_winner'
        });

        competitiveRatedQueue.__seedStateForTests({
            activeMatches: [firstMatch, secondMatch],
            cachedOptionsByGameType: { MSC: createMatchOptions() }
        });

        await Promise.all([
            competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
                customId: 'rated:competitive:match:winner:match-1:1',
                userId: 'home-user',
                client
            })),
            competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
                customId: 'rated:competitive:match:winner:match-2:1',
                userId: 'home-user',
                client
            }))
        ]);

        expect(firstMatch.score.team1).toBe(1);
        expect(secondMatch.score.team1).toBe(1);
        expect(threadHasImagePayload(firstMock.thread, 'g2.png')).toBe(false);
        expect(threadHasImagePayload(secondMock.thread, 'g2.png')).toBe(false);
        expect(findThreadPayload(firstMock.thread, payload =>
            getButtonComponents(payload).some(component => component.label === 'Confirm Game Loss')
        )).toBeDefined();
        expect(findThreadPayload(secondMock.thread, payload =>
            getButtonComponents(payload).some(component => component.label === 'Confirm Game Loss')
        )).toBeDefined();
    });

    it('silently ignores duplicate Confirm Game Loss clicks after the private advantage prompt is shown', async () => {
        const { client, thread } = createMatchClientMock();
        const match = createMatchFixture({
            score: { team1: 1, team2: 0 },
            stage: 'awaiting_loser_confirmation',
            loserTeamIndex: 2,
            loserRepMention: '<@away-user>',
            pendingResultGameNumber: 1
        });
        competitiveRatedQueue.__seedStateForTests({
            activeMatches: [match],
            cachedOptionsByGameType: { MSC: createMatchOptions() }
        });

        await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
            customId: 'rated:competitive:match:loser_confirm:match-1:1',
            userId: 'away-user',
            client
        }));
        const duplicateConfirm = createButtonInteractionMock({
            customId: 'rated:competitive:match:loser_confirm:match-1:1',
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(duplicateConfirm);

        expect(match.loserAdvantagePromptShown).toBe(true);
        expect(duplicateConfirm.editReply).not.toHaveBeenCalled();
        expect(duplicateConfirm.deleteReply).toHaveBeenCalled();
        expect(countThreadPayloads(thread, payload =>
            getButtonComponents(payload).some(component => component.label === 'Confirm Game Loss')
        )).toBe(0);
    });

    it.each(['MSC', 'SMS'])('does not record the same %s game again when the loser advantage prompt times out', async (gameType) => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

        try {
            const { client, thread } = createMatchClientMock();
            const match = createMatchFixture({
                gameType,
                stage: 'awaiting_winner'
            });
            competitiveRatedQueue.__seedStateForTests({
                activeMatches: [match],
                cachedOptionsByGameType: { [gameType]: createMatchOptions() }
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

            expect(mockRatedMatchDao.recordGame).toHaveBeenCalledTimes(1);
            expect(match.timeoutPhase).toBe('loser_advantage');
            expect(match.loserAdvantagePromptShown).toBe(true);

            jest.advanceTimersByTime(2 * 60_000 + 1);
            await flushAsyncTasks();
            await flushAsyncTasks();

            expect(mockRatedMatchDao.recordGame).toHaveBeenCalledTimes(1);
            expect(match.stage).toBe('awaiting_winner');
            expect(match.timeoutPhase).toBe('game');
            expect(countThreadPayloads(thread, payload =>
                payload.content?.includes('Competitive game write failed')
            )).toBe(0);
            expect(findThreadPayload(thread, payload => payload.content?.includes('wins **Game 1**'))).toBeDefined();
            expect(findThreadPayload(thread, payload =>
                getButtonComponents(payload).some(component => component.label === 'GAME WIN')
            )).toBeDefined();
        } finally {
            randomSpy.mockRestore();
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('routes loser advantage timeouts through tick without cancelling the match or duplicating the saved game', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

        try {
            const { client, thread } = createMatchClientMock();
            const match = createMatchFixture({
                gameType: 'SMS',
                stage: 'awaiting_winner'
            });
            competitiveRatedQueue.__seedStateForTests({
                activeMatches: [match],
                cachedOptionsByGameType: { SMS: createMatchOptions() }
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

            expect(mockRatedMatchDao.recordGame).toHaveBeenCalledTimes(1);
            expect(match.timeoutPhase).toBe('loser_advantage');
            clearTimeout(match.timeoutTimer);
            match.timeoutTimer = null;

            jest.advanceTimersByTime(2 * 60_000 + 1);
            await competitiveRatedQueue.__tickForTests(client);

            expect(mockRatedMatchDao.recordGame).toHaveBeenCalledTimes(1);
            expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
            expect(match.stage).toBe('awaiting_winner');
            expect(match.timeoutPhase).toBe('game');
            expect(findThreadPayload(thread, payload =>
                payload.content?.includes('MATCH CANCELLED DUE TO INACTIVITY')
            )).toBeUndefined();
            expect(findThreadPayload(thread, payload =>
                payload.content?.includes('Competitive game write failed')
            )).toBeUndefined();
        } finally {
            randomSpy.mockRestore();
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('falls back to a new private follow-up when the loser advantage prompt cannot reuse the old ephemeral message', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { client, thread } = createMatchClientMock();
            const match = createMatchFixture({
                score: { team1: 1, team2: 0 },
                stage: 'awaiting_loser_confirmation',
                loserTeamIndex: 2,
                loserRepMention: '<@away-user>',
                pendingResultGameNumber: 1
            });
            competitiveRatedQueue.__seedStateForTests({
                activeMatches: [match],
                cachedOptionsByGameType: { MSC: createMatchOptions() }
            });

            const confirmInteraction = createButtonInteractionMock({
                customId: 'rated:competitive:match:loser_confirm:match-1:1',
                userId: 'away-user',
                client
            });
            confirmInteraction.editReply.mockRejectedValueOnce(new Error('expired interaction token'));

            await competitiveRatedQueue.handleInteraction(confirmInteraction);

            expect(confirmInteraction.followUp).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('Choose your advantage for the next game:'),
                flags: MessageFlags.Ephemeral
            }));
            expect(confirmInteraction.followUp.mock.calls.at(-1)[0].content).toContain('Time remaining:');
            expect(match.loserAdvantagePromptShown).toBe(true);
            expect(findThreadPayload(thread, payload =>
                payload.content?.includes('MATCH CANCELLED DUE TO SETUP ERROR')
            )).toBeUndefined();
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('posts the game three image with a separator when the series reaches game three', async () => {
        const { client, thread } = createMatchClientMock();
        const match = createMatchFixture({
            firstTo: 3,
            score: { team1: 1, team2: 1 },
            stage: 'awaiting_winner'
        });
        competitiveRatedQueue.__seedStateForTests({
            activeMatches: [match],
            cachedOptionsByGameType: { MSC: createMatchOptions() }
        });

        const winInteraction = createButtonInteractionMock({
            customId: 'rated:competitive:match:winner:match-1',
            userId: 'home-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(winInteraction);

        expect(threadHasImagePayload(thread, 'g3.png')).toBe(false);
        const confirmPayload = findThreadPayload(thread, payload =>
            getButtonComponents(payload).some(component => component.label === 'Confirm Game Loss')
        );
        const confirmInteraction = createButtonInteractionMock({
            customId: getButtonCustomIdByLabel(confirmPayload, 'Confirm Game Loss'),
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(confirmInteraction);

        expect(threadHasImagePayload(thread, 'g3.png')).toBe(false);

        const chooseHomeInteraction = createButtonInteractionMock({
            customId: getButtonCustomIdByLabel(confirmInteraction.editReply.mock.calls.at(-1)[0], 'Choose Home'),
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(chooseHomeInteraction);

        const stadiumCustomId = getButtonCustomIds(chooseHomeInteraction.editReply.mock.calls.at(-1)[0])[0];
        await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
            customId: stadiumCustomId,
            userId: 'away-user',
            client
        }));
        const winnerInteraction = createButtonInteractionMock({
            customId: getButtonCustomIds(winInteraction.editReply.mock.calls.at(-1)[0])[0],
            userId: 'home-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(winnerInteraction);

        expect(threadHasImagePayload(thread, 'g3.png')).toBe(true);
        const resultIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('wins **Game 3**'));
        const gameImageIndex = findThreadPayloadIndex(thread, payload => threadPayloadHasFile(payload, 'g3.png'));
        const selectionsIndex = findThreadPayloadIndex(thread, payload => payload.content?.includes('chose'));
        expect(resultIndex).toBeGreaterThanOrEqual(0);
        expect(gameImageIndex).toBeGreaterThan(resultIndex);
        expect(selectionsIndex).toBeGreaterThan(gameImageIndex);
        expectFileImmediatelyBefore(thread, 'sep.png', 'g3.png');
        expectFileNotImmediatelyAfter(thread, 'g3.png', 'sep.png');
        expect(threadHasPublicSelectionButtons(thread)).toBe(false);
        expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
    });

    it('shows private Captain buttons to the loser and private Stadium buttons to the winner after Choose Captain First', async () => {
        const { client, thread } = createMatchClientMock();
        const { winnerInteraction, chooseCaptainCustomId } = await prepareLoserAdvantagePrompt(client);

        const loserAdvantageInteraction = createButtonInteractionMock({
            customId: chooseCaptainCustomId,
            userId: 'away-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(loserAdvantageInteraction);

        const loserPayload = loserAdvantageInteraction.editReply.mock.calls.at(-1)[0];
        const winnerPayload = winnerInteraction.editReply.mock.calls.at(-1)[0];
        const loserCustomIds = getButtonCustomIds(loserPayload);
        const winnerCustomIds = getButtonCustomIds(winnerPayload);

        expect(loserPayload.content).toContain('CAPTAIN');
        expect(loserPayload.content.startsWith('>')).toBe(false);
        expect(loserCustomIds.length).toBeGreaterThan(0);
        expect(loserCustomIds.every(customId => customId.includes(':match:captain:'))).toBe(true);
        expect(winnerPayload.content).toContain('STADIUM');
        expect(winnerPayload.content.startsWith('>')).toBe(false);
        expect(winnerCustomIds.length).toBeGreaterThan(0);
        expect(winnerCustomIds.every(customId => customId.includes(':match:stadium:'))).toBe(true);
        expect(threadHasPublicSelectionButtons(thread)).toBe(false);
        expect(threadHasImagePayload(thread, 'g2.png')).toBe(false);
    });

    it('falls back to a new private follow-up when the winner private setup edit cannot reuse the old ephemeral message', async () => {
        const { client, thread } = createMatchClientMock();
        const { winnerInteraction, chooseHomeCustomId } = await prepareLoserAdvantagePrompt(client);
        winnerInteraction.editReply.mockRejectedValueOnce(new Error('expired interaction token'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const loserAdvantageInteraction = createButtonInteractionMock({
                customId: chooseHomeCustomId,
                userId: 'away-user',
                client
            });
            await competitiveRatedQueue.handleInteraction(loserAdvantageInteraction);

            expect(winnerInteraction.followUp).toHaveBeenCalledWith(expect.objectContaining({
                content: expect.stringContaining('CAPTAIN'),
                flags: MessageFlags.Ephemeral
            }));
            expect(findThreadPayload(thread, payload =>
                payload.content?.includes('MATCH CANCELLED DUE TO SETUP ERROR')
            )).toBeUndefined();
            expect(threadHasPublicSelectionButtons(thread)).toBe(false);
            expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('reopens Start Match instead of cancelling when the winner private controls cannot be delivered by edit or follow-up', async () => {
        const { client, thread } = createMatchClientMock();
        const { winnerInteraction, chooseHomeCustomId } = await prepareLoserAdvantagePrompt(client);
        winnerInteraction.editReply.mockRejectedValueOnce(new Error('expired interaction token'));
        winnerInteraction.followUp.mockRejectedValueOnce(new Error('Unknown interaction'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const loserAdvantageInteraction = createButtonInteractionMock({
                customId: chooseHomeCustomId,
                userId: 'away-user',
                client
            });
            await competitiveRatedQueue.handleInteraction(loserAdvantageInteraction);

            const cancelPayload = findThreadPayload(thread, payload =>
                payload.content?.includes('MATCH CANCELLED DUE TO SETUP ERROR')
            );
            expect(cancelPayload).toBeUndefined();
            expect(threadHasPublicSelectionButtons(thread)).toBe(false);
            expect(findThreadPayload(thread, payload =>
                getButtonComponents(payload).some(component => component.label === 'Start Match')
            )).toBeDefined();
            expect(thread.setName).not.toHaveBeenCalledWith('🚫 1v1 #1 | Home VS Away');
            expect(thread.setLocked).not.toHaveBeenCalled();
            expect(thread.setArchived).not.toHaveBeenCalled();
            expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(1);
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('clears match timers when a winner completes the match', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);
        let timeoutFired = false;

        try {
            const { client, thread } = createMatchClientMock();
            const match = createMatchFixture({
                firstTo: 1,
                stage: 'awaiting_winner',
                timeoutPhase: 'game',
                timeoutDeadlineAt: 1_120_000
            });
            match.timeoutTimer = setTimeout(() => {
                timeoutFired = true;
            }, 120_000);
            competitiveRatedQueue.__seedStateForTests({ activeMatches: [match] });

            const winnerInteraction = createButtonInteractionMock({
                customId: 'rated:competitive:match:winner:match-1',
                userId: 'home-user',
                client
            });
            await competitiveRatedQueue.handleInteraction(winnerInteraction);
            const confirmPayload = findThreadPayload(thread, payload =>
                getButtonComponents(payload).some(component => component.label === 'Confirm Game Loss')
            );
            await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
                customId: getButtonCustomIdByLabel(confirmPayload, 'Confirm Game Loss'),
                userId: 'away-user',
                client
            }));

            expect(competitiveRatedQueue.__getStateSnapshot().activeMatchCount).toBe(0);
            expect(competitiveRatedQueue.__getStateSnapshot().completedThreadCloseTimerCount).toBe(1);
            expect(winnerInteraction.deleteReply).toHaveBeenCalled();
            expect(thread.setLocked).not.toHaveBeenCalled();
            expect(thread.setArchived).not.toHaveBeenCalled();
            expect(thread.setName).not.toHaveBeenCalled();

            jest.advanceTimersByTime(10 * 60_000);
            await flushAsyncTasks();
            expect(thread.setLocked).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(thread.setArchived).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(thread.setName).toHaveBeenCalledWith('✅ 1v1 #1 | Home VS Away');
            expectThreadRenameBeforeClose(thread);
            await flushAsyncTasks();
            expect(mockRatedMatchDao.markThreadFinalizationSucceeded).toHaveBeenCalledWith({ ratedMatchId: 5000 });
            expect(competitiveRatedQueue.__getStateSnapshot().completedThreadCloseTimerCount).toBe(0);
            expect(competitiveRatedQueue.__getStateSnapshot().pendingCompletedThreadFinalizationCount).toBe(0);
            expect(timeoutFired).toBe(false);
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('retries completed thread finalization when archive fails once', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);

        try {
            const { client, thread, logThreads } = createMatchClientMock();
            thread.setArchived = jest.fn()
                .mockRejectedValueOnce(new Error('transient archive failure'))
                .mockResolvedValue(thread);
            const match = createMatchFixture({
                firstTo: 1,
                stage: 'awaiting_winner'
            });
            competitiveRatedQueue.__seedStateForTests({
                activeMatches: [match],
                cachedOptionsByGameType: { MSC: createMatchOptions() }
            });

            await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
                customId: 'rated:competitive:match:winner:match-1',
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

            jest.advanceTimersByTime(10 * 60_000);
            await flushAsyncTasks();
            await competitiveRatedQueue.__tickForTests(client);
            await flushAsyncTasks();
            await flushRuntimeLogs();

            expect(thread.setArchived.mock.calls.length).toBeGreaterThanOrEqual(2);
            expect(thread.setArchived).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(thread.setLocked).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(thread.setName).toHaveBeenCalledWith('✅ 1v1 #1 | Home VS Away');
            expect(mockRatedMatchDao.markThreadFinalizationSucceeded).toHaveBeenCalledWith({ ratedMatchId: 5000 });
            expect(competitiveRatedQueue.__getStateSnapshot().pendingCompletedThreadFinalizationCount).toBe(0);

            const mscLogs = getLogContents(logThreads, RATED_LOG_THREAD_IDS.MSC_1V1);
            expect(mscLogs.some(line => line.includes('| thread.closed |'))).toBe(true);
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('keeps failed completed finalization pending and recovers via tick fallback without false thread.closed logs', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);

        try {
            const { client, thread, logThreads } = createMatchClientMock();
            thread.setArchived = jest.fn(async () => {
                throw new Error('archive hard failure');
            });
            thread.setLocked = jest.fn(async () => {
                throw new Error('lock hard failure');
            });
            thread.setName = jest.fn(async () => {
                throw new Error('rename hard failure');
            });
            const match = createMatchFixture({
                firstTo: 1,
                stage: 'awaiting_winner'
            });
            competitiveRatedQueue.__seedStateForTests({
                activeMatches: [match],
                cachedOptionsByGameType: { MSC: createMatchOptions() }
            });

            await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
                customId: 'rated:competitive:match:winner:match-1',
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

            jest.advanceTimersByTime(10 * 60_000);
            await flushAsyncTasks();
            await competitiveRatedQueue.__tickForTests(client);
            await flushAsyncTasks();
            await flushRuntimeLogs();

            expect(competitiveRatedQueue.__getStateSnapshot().pendingCompletedThreadFinalizationCount).toBe(1);
            expect(mockRatedMatchDao.markThreadFinalizationFailed).toHaveBeenCalledWith(expect.objectContaining({
                ratedMatchId: 5000,
                error: expect.stringContaining('archive')
            }));
            let mscLogs = getLogContents(logThreads, RATED_LOG_THREAD_IDS.MSC_1V1);
            expect(mscLogs.some(line => line.includes('| thread.closed |'))).toBe(false);
            expect(mscLogs.some(line => line.includes('| thread.finalize_failed |'))).toBe(true);

            thread.setArchived = jest.fn(async () => thread);
            thread.setLocked = jest.fn(async () => thread);
            thread.setName = jest.fn(async nextName => {
                thread.name = nextName;
                return thread;
            });

            await competitiveRatedQueue.__tickForTests(client);
            await flushAsyncTasks();
            await flushRuntimeLogs();

            expect(thread.setArchived).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(thread.setLocked).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(thread.setName).toHaveBeenCalledWith('✅ 1v1 #1 | Home VS Away');
            expect(mockRatedMatchDao.markThreadFinalizationSucceeded).toHaveBeenCalledWith({ ratedMatchId: 5000 });
            expect(competitiveRatedQueue.__getStateSnapshot().pendingCompletedThreadFinalizationCount).toBe(0);

            mscLogs = getLogContents(logThreads, RATED_LOG_THREAD_IDS.MSC_1V1);
            expect(mscLogs.some(line => line.includes('| thread.closed |'))).toBe(true);
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('recovers overdue completed thread finalizations from the database on startup', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);

        try {
            const { client, thread } = createMatchClientMock();
            mockRatedMatchDao.getPendingCompletedThreadFinalizations
                .mockResolvedValueOnce([{
                    Id: 9001,
                    MatchCode: 'db-match-1',
                    GameType: 'MSC',
                    ModeCode: '1v1',
                    MatchNumber: 1,
                    SeasonMatchNumber: 1,
                    ThreadId: 'thread-1',
                    ThreadUrl: 'https://discord.com/channels/guild-1/thread-1',
                    Team1Score: 2,
                    Team2Score: 0,
                    CompletedAtUtc: new Date(1_000_000 - 10 * 60_000 - 1_000)
                }])
                .mockResolvedValue([]);

            await competitiveRatedQueue.ensureCompetitiveRatedQueue(client);
            await flushAsyncTasks();

            expect(thread.setName).toHaveBeenCalledWith('✅ 1v1 #1 | Home VS Away');
            expect(thread.setLocked).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(thread.setArchived).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(mockRatedMatchDao.markThreadFinalizationSucceeded).toHaveBeenCalledWith({ ratedMatchId: 9001 });
            expect(competitiveRatedQueue.__getStateSnapshot().pendingCompletedThreadFinalizationCount).toBe(0);
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('restores the remaining close delay for recent completed matches after startup', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);

        try {
            const { client, thread } = createMatchClientMock();
            mockRatedMatchDao.getPendingCompletedThreadFinalizations
                .mockResolvedValueOnce([{
                    Id: 9002,
                    MatchCode: 'db-match-2',
                    GameType: 'MSC',
                    ModeCode: '1v1',
                    MatchNumber: 2,
                    SeasonMatchNumber: 2,
                    ThreadId: 'thread-1',
                    ThreadUrl: 'https://discord.com/channels/guild-1/thread-1',
                    Team1Score: 2,
                    Team2Score: 1,
                    CompletedAtUtc: new Date(1_000_000 - 9 * 60_000)
                }])
                .mockResolvedValue([]);

            await competitiveRatedQueue.ensureCompetitiveRatedQueue(client);
            await flushAsyncTasks();

            expect(competitiveRatedQueue.__getStateSnapshot().completedThreadCloseTimerCount).toBe(1);
            expect(thread.setLocked).not.toHaveBeenCalled();
            expect(thread.setArchived).not.toHaveBeenCalled();

            jest.advanceTimersByTime(59_999);
            await flushAsyncTasks();
            expect(thread.setLocked).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1);
            await flushAsyncTasks();
            await competitiveRatedQueue.__tickForTests(client);
            await flushAsyncTasks();
            expect(thread.setLocked).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(thread.setArchived).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(mockRatedMatchDao.markThreadFinalizationSucceeded).toHaveBeenCalledWith({ ratedMatchId: 9002 });
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('records failed database-recovered finalization attempts for retry', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);

        try {
            const { client, thread } = createMatchClientMock();
            thread.setName = jest.fn(async () => {
                throw new Error('rename failed');
            });
            thread.setLocked = jest.fn(async () => {
                throw new Error('lock failed');
            });
            thread.setArchived = jest.fn(async () => {
                throw new Error('archive failed');
            });
            mockRatedMatchDao.getPendingCompletedThreadFinalizations.mockResolvedValue([{
                Id: 9003,
                MatchCode: 'db-match-3',
                GameType: 'MSC',
                ModeCode: '1v1',
                MatchNumber: 3,
                SeasonMatchNumber: 3,
                ThreadId: 'thread-1',
                ThreadUrl: 'https://discord.com/channels/guild-1/thread-1',
                Team1Score: 2,
                Team2Score: 0,
                CompletedAtUtc: new Date(1_000_000 - 10 * 60_000 - 1_000)
            }]);

            await competitiveRatedQueue.__tickForTests(client);
            await flushAsyncTasks();

            expect(mockRatedMatchDao.markThreadFinalizationFailed).toHaveBeenCalledWith(expect.objectContaining({
                ratedMatchId: 9003,
                error: expect.stringContaining('archive')
            }));
            expect(competitiveRatedQueue.__getStateSnapshot().pendingCompletedThreadFinalizationCount).toBe(1);
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('marks an already locked and archived completed thread as finalized without extra Discord mutations', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);

        try {
            const { client, thread } = createMatchClientMock();
            thread.name = '✅ 1v1 #1 | Home VS Away';
            thread.locked = true;
            thread.archived = true;
            mockRatedMatchDao.getPendingCompletedThreadFinalizations.mockResolvedValue([{
                Id: 9004,
                MatchCode: 'db-match-4',
                GameType: 'MSC',
                ModeCode: '1v1',
                MatchNumber: 4,
                SeasonMatchNumber: 4,
                ThreadId: 'thread-1',
                ThreadUrl: 'https://discord.com/channels/guild-1/thread-1',
                Team1Score: 2,
                Team2Score: 0,
                CompletedAtUtc: new Date(1_000_000 - 10 * 60_000 - 1_000)
            }]);

            await competitiveRatedQueue.__tickForTests(client);
            await flushAsyncTasks();

            expect(thread.setName).not.toHaveBeenCalled();
            expect(thread.setLocked).not.toHaveBeenCalled();
            expect(thread.setArchived).not.toHaveBeenCalled();
            expect(mockRatedMatchDao.markThreadFinalizationSucceeded).toHaveBeenCalledWith({ ratedMatchId: 9004 });
            expect(competitiveRatedQueue.__getStateSnapshot().pendingCompletedThreadFinalizationCount).toBe(0);
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('adds a Report Issue button after match completion and creates one private support thread for players', async () => {
        const { client, issueSupportChannel, thread } = createMatchClientMock();
        const match = createMatchFixture({
            firstTo: 1,
            stage: 'awaiting_winner'
        });
        competitiveRatedQueue.__seedStateForTests({
            activeMatches: [match],
            cachedOptionsByGameType: { MSC: createMatchOptions() }
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

        const reportPayload = findThreadPayload(thread, payload =>
            getButtonComponents(payload).some(component => component.label === 'Report Issue')
        );
        const winnerPayload = findThreadPayload(thread, payload =>
            payload.content?.includes('WINS THE MATCH!')
        );
        const ratingPayload = findThreadPayload(thread, payload =>
            payload.content?.includes('<@home-user> +24 <:arrow:1501606527188865114>')
        );
        const ratingPayloadIndex = findThreadPayloadIndex(thread, payload =>
            payload.content?.includes('<@home-user> +24 <:arrow:1501606527188865114>')
        );
        const separatorPayloadIndex = findThreadPayloadIndex(thread, payload =>
            threadPayloadHasFile(payload, 'sep.png')
        );
        const reportCustomId = getButtonCustomIdByLabel(reportPayload, 'Report Issue');
        const finalButtonLabels = getButtonComponents(reportPayload).map(component => component.label);
        expect(finalButtonLabels).toEqual(['Rematch', 'Report Issue']);
        expect(reportCustomId).toBe('rated:competitive:match:report_issue:match-1');
        expect(winnerPayload.content).toContain('WINS THE MATCH');
        expect(winnerPayload.content).toContain('Result:');
        expect(separatorPayloadIndex).toBeGreaterThanOrEqual(0);
        expect(ratingPayloadIndex).toBeGreaterThan(separatorPayloadIndex);
        expect(ratingPayload.content).toContain('<@home-user> +24 <:arrow:1501606527188865114> <:cr_unranked:1504559021670137906> **1024**');
        expect(ratingPayload.content).toContain('<@away-user> -24 <:arrow:1501606527188865114> <:cr_unranked:1504559021670137906> **976**');
        expect(ratingPayload.content).not.toContain('Competitive Rating');
        expect(reportPayload.content).toContain('**MATCH COMPLETE!** Thanks for playing.');
        expect(thread.setName).not.toHaveBeenCalled();
        expect(competitiveRatedQueue.__getStateSnapshot().reportableMatchCount).toBe(1);

        const reportInteraction = createButtonInteractionMock({
            customId: reportCustomId,
            userId: 'home-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(reportInteraction);

        expect(issueSupportChannel.threads.create).toHaveBeenCalledTimes(1);
        const threadPayload = issueSupportChannel.threads.create.mock.calls[0][0];
        expect(threadPayload.name).toBe('✅ 1v1 #1 | Home VS Away');
        expect(threadPayload.type).toBe(ChannelType.PrivateThread);
        expect(threadPayload.invitable).toBe(false);
        const createdIssueThread = await issueSupportChannel.threads.create.mock.results[0].value;
        expect(createdIssueThread.members.add).toHaveBeenCalledWith('home-user');
        expect(createdIssueThread.members.add).toHaveBeenCalledWith('away-user');
        expect(createdIssueThread.send).toHaveBeenCalledTimes(1);
        const postPayload = createdIssueThread.send.mock.calls[0][0];
        expect(postPayload.content).toContain('Match: **✅ 1v1 #1 | Home VS Away**');
        expect(postPayload.content).toContain('Match Thread: https://discord.com/channels/guild-1/thread-1');
        expect(postPayload.content).toContain('<@&1070908166725967942>');
        expect(postPayload.content).toContain('<@&790896138827333652>');
        expect(postPayload.content).toContain('<@home-user> <@away-user>');
        expect(postPayload.allowedMentions.roles).toEqual(['1070908166725967942', '790896138827333652']);
        expect(postPayload.allowedMentions.users).toEqual(['home-user', 'away-user']);
        expect(reportInteraction.editReply.mock.calls.at(-1)[0].content).toContain('Issue report created: https://discord.com/channels/guild-1/issue-thread-1');

        const duplicateReportInteraction = createButtonInteractionMock({
            customId: reportCustomId,
            userId: 'home-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(duplicateReportInteraction);
        expect(issueSupportChannel.threads.create).toHaveBeenCalledTimes(1);
        expect(duplicateReportInteraction.editReply).not.toHaveBeenCalled();
        expect(duplicateReportInteraction.deleteReply).toHaveBeenCalled();
    });

    it('keeps completed threads open for 10 minutes and closes after an unconfirmed rematch timeout', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);

        try {
            const { channel, client, thread } = createMatchClientMock();
            const match = createMatchFixture({
                firstTo: 1,
                stage: 'awaiting_winner'
            });
            competitiveRatedQueue.__seedStateForTests({
                activeMatches: [match],
                cachedOptionsByGameType: { MSC: createMatchOptions() }
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

            const finalPayload = findThreadPayload(thread, payload =>
                getButtonComponents(payload).some(component => component.label === 'Rematch')
            );
            const rematchCustomId = getButtonCustomIdByLabel(finalPayload, 'Rematch');
            expect(competitiveRatedQueue.__getStateSnapshot().completedThreadCloseTimerCount).toBe(1);

            const rematchRequest = createButtonInteractionMock({
                customId: rematchCustomId,
                userId: 'home-user',
                client
            });
            await competitiveRatedQueue.handleInteraction(rematchRequest);

            expect(competitiveRatedQueue.__getStateSnapshot()).toEqual(expect.objectContaining({
                pendingRematchCount: 1,
                rematchInitiatorCount: 1,
                rematchTimerCount: 1,
                completedThreadCloseTimerCount: 0
            }));
            expect(competitiveRatedQueue.getCompetitiveRatedBusyReason('home-user'))
                .toBe('You are waiting for a rematch confirmation.');
            expect(findThreadPayload(thread, payload => payload.content?.includes('requested a rematch')).content)
                .toContain('<@away-user>, press **Rematch**');

            jest.advanceTimersByTime(5 * 60_000);
            await flushAsyncTasks();
            await flushAsyncTasks();

            expect(channel.threads.create).not.toHaveBeenCalled();
            expect(thread.setName).toHaveBeenCalledWith('✅ 1v1 #1 | Home VS Away');
            expect(thread.setLocked).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(thread.setArchived).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(competitiveRatedQueue.__getStateSnapshot()).toEqual(expect.objectContaining({
                pendingRematchCount: 0,
                rematchInitiatorCount: 0,
                rematchTimerCount: 0,
                pendingCompletedThreadFinalizationCount: 0
            }));
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('starts a 1v1 rematch with the same first-to and closes the completed thread immediately', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);

        try {
            const { channel, client, thread } = createMatchClientMock();
            const rematchThread = createThreadMock('thread-rematch', '1v1 #2 | Home VS Away');
            channel.threads.create.mockResolvedValueOnce(rematchThread);
            const match = createMatchFixture({
                firstTo: 1,
                stage: 'awaiting_winner'
            });
            competitiveRatedQueue.__seedStateForTests({
                activeMatches: [match],
                cachedOptionsByGameType: { MSC: createMatchOptions() }
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
            const finalPayload = findThreadPayload(thread, payload =>
                getButtonComponents(payload).some(component => component.label === 'Rematch')
            );
            const rematchCustomId = getButtonCustomIdByLabel(finalPayload, 'Rematch');

            await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
                customId: rematchCustomId,
                userId: 'home-user',
                client
            }));
            const confirmRematch = createButtonInteractionMock({
                customId: rematchCustomId,
                userId: 'away-user',
                client
            });
            await competitiveRatedQueue.handleInteraction(confirmRematch);

            expect(channel.threads.create).toHaveBeenCalledWith(expect.objectContaining({
                type: ChannelType.PublicThread,
                reason: 'MSC Competitive Rated match'
            }));
            expect(mockRatedMatchDao.createMatchHeader).toHaveBeenCalledWith(expect.objectContaining({
                firstTo: 1,
                modeCode: '1v1'
            }));
            expect(rematchThread.members.add).toHaveBeenCalledWith('home-user');
            expect(rematchThread.members.add).toHaveBeenCalledWith('away-user');
            expect(thread.setLocked).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(thread.setArchived).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(confirmRematch.editReply.mock.calls.at(-1)[0].content)
                .toContain('https://discord.com/channels/guild-1/thread-rematch');
            expect(competitiveRatedQueue.__getStateSnapshot()).toEqual(expect.objectContaining({
                pendingRematchCount: 0,
                rematchInitiatorCount: 0,
                rematchTimerCount: 0
            }));
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('rejects rematch clicks from nonparticipants even when they are admins', async () => {
        const { client } = createMatchClientMock();
        competitiveRatedQueue.__seedStateForTests({
            reportableMatches: [{
                id: 'match-1',
                ratedMatchId: 5000,
                mode: '1v1',
                gameType: 'MSC',
                channelId: '1501486517464600657',
                threadId: 'thread-1',
                threadName: '✅ 1v1 #1 | Home VS Away',
                threadUrl: 'https://discord.com/channels/guild-1/thread-1',
                firstTo: 1,
                completedAtMs: Date.now(),
                threadFinalizedAt: null,
                participants: [
                    { id: 'home-user', mention: '<@home-user>', username: 'Home', teamNumber: 1, isRepresentative: true },
                    { id: 'away-user', mention: '<@away-user>', username: 'Away', teamNumber: 2, isRepresentative: true }
                ],
                participantIds: ['home-user', 'away-user']
            }]
        });

        const interaction = createButtonInteractionMock({
            customId: 'rated:competitive:match:rematch:match-1',
            userId: 'admin-user',
            roleIds: [ADMIN_ROLE_ID],
            client
        });
        await competitiveRatedQueue.handleInteraction(interaction);

        expect(interaction.editReply.mock.calls.at(-1)[0].content)
            .toBe('Only players from this match can request a rematch.');
        expect(competitiveRatedQueue.__getStateSnapshot().pendingRematchCount).toBe(0);
    });

    it('rejects stale rematch clicks after thread finalization', async () => {
        const { client } = createMatchClientMock();
        competitiveRatedQueue.__seedStateForTests({
            reportableMatches: [{
                id: 'match-1',
                ratedMatchId: 5000,
                mode: '1v1',
                gameType: 'MSC',
                channelId: '1501486517464600657',
                threadId: 'thread-1',
                threadName: '✅ 1v1 #1 | Home VS Away',
                threadUrl: 'https://discord.com/channels/guild-1/thread-1',
                firstTo: 1,
                completedAtMs: Date.now(),
                threadFinalizedAt: new Date().toISOString(),
                participants: [
                    { id: 'home-user', mention: '<@home-user>', username: 'Home', teamNumber: 1, isRepresentative: true },
                    { id: 'away-user', mention: '<@away-user>', username: 'Away', teamNumber: 2, isRepresentative: true }
                ],
                participantIds: ['home-user', 'away-user']
            }]
        });

        const interaction = createButtonInteractionMock({
            customId: 'rated:competitive:match:rematch:match-1',
            userId: 'home-user',
            client
        });
        await competitiveRatedQueue.handleInteraction(interaction);

        expect(interaction.editReply.mock.calls.at(-1)[0].content)
            .toBe('Rematch is no longer available for this match.');
        expect(competitiveRatedQueue.__getStateSnapshot().pendingRematchCount).toBe(0);
    });

    it('allows only original 2v2 representatives to start a same-team rematch', async () => {
        jest.useFakeTimers({ doNotFake: ['performance'] });
        jest.setSystemTime(1_000_000);

        try {
            const { channel, client, thread } = createMatchClientMock();
            const rematchThread = createThreadMock('thread-rematch-2v2', '2v2 #2 | Home Rep + Home Mate VS Away Rep + Away Mate');
            channel.threads.create.mockResolvedValueOnce(rematchThread);
            const snapshot = {
                id: 'match-2v2',
                ratedMatchId: 6000,
                mode: '2v2',
                gameType: 'MSC',
                channelId: '1501486517464600657',
                threadId: 'thread-1',
                threadName: '✅ 2v2 #1 | Home Rep + Home Mate VS Away Rep + Away Mate',
                threadUrl: 'https://discord.com/channels/guild-1/thread-1',
                firstTo: 2,
                completedAtMs: Date.now(),
                threadFinalizedAt: null,
                participants: [
                    { id: 'home-rep', mention: '<@home-rep>', username: 'Home Rep', teamNumber: 1, isRepresentative: true },
                    { id: 'home-mate', mention: '<@home-mate>', username: 'Home Mate', teamNumber: 1, isRepresentative: false },
                    { id: 'away-rep', mention: '<@away-rep>', username: 'Away Rep', teamNumber: 2, isRepresentative: true },
                    { id: 'away-mate', mention: '<@away-mate>', username: 'Away Mate', teamNumber: 2, isRepresentative: false }
                ],
                participantIds: ['home-rep', 'home-mate', 'away-rep', 'away-mate']
            };
            competitiveRatedQueue.__seedStateForTests({
                reportableMatches: [snapshot],
                pendingCompletedThreadFinalizations: [{
                    id: 'match-2v2',
                    ratedMatchId: 6000,
                    threadId: 'thread-1',
                    threadName: snapshot.threadName,
                    gameType: 'MSC',
                    mode: '2v2',
                    stage: 'complete',
                    finalizeAfterAt: Date.now() + 10 * 60_000
                }]
            });

            const nonRep = createButtonInteractionMock({
                customId: 'rated:competitive:match:rematch:match-2v2',
                userId: 'home-mate',
                client
            });
            await competitiveRatedQueue.handleInteraction(nonRep);
            expect(nonRep.editReply.mock.calls.at(-1)[0].content)
                .toBe('Only the team representatives from this match can request a 2v2 rematch.');

            await competitiveRatedQueue.handleInteraction(createButtonInteractionMock({
                customId: 'rated:competitive:match:rematch:match-2v2',
                userId: 'home-rep',
                client
            }));
            const awayRepConfirm = createButtonInteractionMock({
                customId: 'rated:competitive:match:rematch:match-2v2',
                userId: 'away-rep',
                client
            });
            await competitiveRatedQueue.handleInteraction(awayRepConfirm);

            expect(mockRatedMatchDao.createMatchHeader).toHaveBeenCalledWith(expect.objectContaining({
                firstTo: 2,
                modeCode: '2v2'
            }));
            const participants = mockRatedMatchDao.activateMatch.mock.calls.at(-1)[0].participants;
            expect(participants).toEqual([
                expect.objectContaining({ discordId: 'home-rep', teamNumber: 1, isRepresentative: true }),
                expect.objectContaining({ discordId: 'home-mate', teamNumber: 1, isRepresentative: false }),
                expect.objectContaining({ discordId: 'away-rep', teamNumber: 2, isRepresentative: true }),
                expect.objectContaining({ discordId: 'away-mate', teamNumber: 2, isRepresentative: false })
            ]);
            expect(rematchThread.members.add).toHaveBeenCalledWith('home-rep');
            expect(rematchThread.members.add).toHaveBeenCalledWith('home-mate');
            expect(rematchThread.members.add).toHaveBeenCalledWith('away-rep');
            expect(rematchThread.members.add).toHaveBeenCalledWith('away-mate');
            expect(thread.setLocked).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(thread.setArchived).toHaveBeenCalledWith(true, 'MSC competitive completed match close delay');
            expect(awayRepConfirm.editReply.mock.calls.at(-1)[0].content)
                .toContain('https://discord.com/channels/guild-1/thread-rematch-2v2');
        } finally {
            competitiveRatedQueue.__resetState();
            jest.useRealTimers();
        }
    });

    it('rebuilds report issue snapshots from the database after restart', async () => {
        const { client, issueSupportChannel } = createMatchClientMock();
        mockRatedMatchDao.getReportableMatchSnapshot.mockResolvedValueOnce({
            id: 'db-match-1',
            mode: '1v1',
            gameType: 'MSC',
            threadId: 'thread-db',
            threadName: '✅ 1v1 #42 | Db Home VS Db Away',
            threadUrl: 'https://discord.com/channels/guild-1/thread-db',
            finalMessageId: null,
            participants: [
                { id: 'home-user', mention: '<@home-user>', username: 'Db Home' },
                { id: 'away-user', mention: '<@away-user>', username: 'Db Away' }
            ],
            participantIds: ['home-user', 'away-user'],
            issueThreadId: null,
            issueThreadUrl: null
        });

        const reportInteraction = createButtonInteractionMock({
            customId: 'rated:competitive:match:report_issue:db-match-1',
            userId: 'home-user',
            client
        });

        await competitiveRatedQueue.handleInteraction(reportInteraction);

        expect(mockRatedMatchDao.getReportableMatchSnapshot).toHaveBeenCalledWith('db-match-1');
        expect(issueSupportChannel.threads.create).toHaveBeenCalledTimes(1);
        const threadPayload = issueSupportChannel.threads.create.mock.calls[0][0];
        expect(threadPayload.name).toBe('✅ 1v1 #42 | Db Home VS Db Away');
        expect(threadPayload.type).toBe(ChannelType.PrivateThread);
        expect(threadPayload.invitable).toBe(false);
        const createdIssueThread = await issueSupportChannel.threads.create.mock.results[0].value;
        expect(createdIssueThread.members.add).toHaveBeenCalledWith('home-user');
        expect(createdIssueThread.members.add).toHaveBeenCalledWith('away-user');
        expect(createdIssueThread.send).toHaveBeenCalledTimes(1);
        const postPayload = createdIssueThread.send.mock.calls[0][0];
        expect(postPayload.content).toContain('Match: **✅ 1v1 #42 | Db Home VS Db Away**');
        expect(postPayload.content).toContain('Match Thread: https://discord.com/channels/guild-1/thread-db');
        expect(postPayload.content).toContain('<@home-user> <@away-user>');
        expect(postPayload.allowedMentions.roles).toEqual(['1070908166725967942', '790896138827333652']);
        expect(postPayload.allowedMentions.users).toEqual(['home-user', 'away-user']);
        expect(reportInteraction.editReply.mock.calls.at(-1)[0].content).toContain('Issue report created: https://discord.com/channels/guild-1/issue-thread-1');
    });

    it('reports users with an active competitive search as busy', () => {
        competitiveRatedQueue.__seedStateForTests({ activeSearchUserIds: ['user-1'] });

        expect(competitiveRatedQueue.getCompetitiveRatedBusyReason('user-1'))
            .toBe('You already have an active pool entry.');
    });

    it('requires overlapping best-of ranges and only configured thresholds for singles', () => {
        const left = createSinglesSearch({ minBestOf: 3, maxBestOf: 5, threshold: 150, elo: 1100 });
        const right = createSinglesSearch({ minBestOf: 5, maxBestOf: 7, threshold: 150, elo: 1200 });
        const mismatch = createSinglesSearch({ minBestOf: 7, maxBestOf: 7, threshold: 50, elo: 1400 });
        const unrestricted = createSinglesSearch({ minBestOf: 3, maxBestOf: 5, threshold: null, elo: 3000 });

        expect(competitiveRatedQueue.areSinglesSearchesCompatible(left, right)).toBe(true);
        expect(competitiveRatedQueue.areSinglesSearchesCompatible(left, mismatch)).toBe(false);
        expect(competitiveRatedQueue.areSinglesSearchesCompatible(unrestricted, unrestricted)).toBe(true);
    });

    it('computes first-to from the tightest overlapping best-of', () => {
        expect(competitiveRatedQueue.computeFirstTo(3, 5, 5, 7)).toBe(3);
        expect(competitiveRatedQueue.computeFirstTo(null, 5, 5, 7)).toBe(2);
    });

    it('applies loser choice by swapping home or away correctly', () => {
        expect(competitiveRatedQueue.applyLoserChoice(1, 2, 'home')).toEqual({
            homeTeamIndex: 2,
            awayTeamIndex: 1
        });
        expect(competitiveRatedQueue.applyLoserChoice(1, 2, 'captain')).toEqual({
            homeTeamIndex: 1,
            awayTeamIndex: 2
        });
    });

    it('keeps duplicate-club players on the same doubles team', () => {
        const searches = [
            createDoublesSearch({ id: 'a', playerId: 1, ratingTs: 1400, clubId: 10 }),
            createDoublesSearch({ id: 'b', playerId: 2, ratingTs: 1200, clubId: 10 }),
            createDoublesSearch({ id: 'c', playerId: 3, ratingTs: 1300, clubId: 20 }),
            createDoublesSearch({ id: 'd', playerId: 4, ratingTs: 1100, clubId: 30 })
        ];

        const [teamOne, teamTwo] = competitiveRatedQueue.buildBalancedDoublesTeams(searches);
        const pairedIds = new Set(teamOne.map(search => search.id));

        expect(
            pairedIds.has('a') && pairedIds.has('b')
            || new Set(teamTwo.map(search => search.id)).has('a') && new Set(teamTwo.map(search => search.id)).has('b')
        ).toBe(true);
    });

    it('balances doubles teams by the closest competitive rating sums without club duplicates', () => {
        const searches = [
            createDoublesSearch({ id: 'top', playerId: 1, ratingTs: 1600, clubId: 10 }),
            createDoublesSearch({ id: 'second', playerId: 2, ratingTs: 1500, clubId: 20 }),
            createDoublesSearch({ id: 'third', playerId: 3, ratingTs: 1200, clubId: 30 }),
            createDoublesSearch({ id: 'bottom', playerId: 4, ratingTs: 1100, clubId: 40 })
        ];

        const [teamOne, teamTwo] = competitiveRatedQueue.buildBalancedDoublesTeams(searches);

        expect(teamOne.map(search => search.id)).toEqual(['top', 'bottom']);
        expect(teamTwo.map(search => search.id)).toEqual(['second', 'third']);
    });

    it('does not pair the two highest rated doubles players unless club priority applies', () => {
        const searches = [
            createDoublesSearch({ id: 'top', playerId: 1, ratingTs: 1600, clubId: 10 }),
            createDoublesSearch({ id: 'second', playerId: 2, ratingTs: 1590, clubId: 20 }),
            createDoublesSearch({ id: 'third', playerId: 3, ratingTs: 1000, clubId: 30 }),
            createDoublesSearch({ id: 'bottom', playerId: 4, ratingTs: 990, clubId: 40 })
        ];

        const [teamOne, teamTwo] = competitiveRatedQueue.buildBalancedDoublesTeams(searches);
        const pairedIds = [teamOne, teamTwo].map(team => new Set(team.map(search => search.id)));

        expect(pairedIds.some(team => team.has('top') && team.has('second'))).toBe(false);
    });

    it('uses deterministic tie-breaking for equally fair doubles splits', () => {
        const searches = [
            createDoublesSearch({ id: 'top', playerId: 1, ratingTs: 1500, clubId: 10 }),
            createDoublesSearch({ id: 'second', playerId: 2, ratingTs: 1500, clubId: 20 }),
            createDoublesSearch({ id: 'third', playerId: 3, ratingTs: 1200, clubId: 30 }),
            createDoublesSearch({ id: 'bottom', playerId: 4, ratingTs: 1100, clubId: 40 })
        ];

        const [teamOne, teamTwo] = competitiveRatedQueue.buildBalancedDoublesTeams(searches);

        expect(teamOne.map(search => search.id)).toEqual(['top', 'bottom']);
        expect(teamTwo.map(search => search.id)).toEqual(['second', 'third']);
    });

    it('keeps club priority even when it pairs the two highest rated doubles players', () => {
        const searches = [
            createDoublesSearch({ id: 'top', playerId: 1, ratingTs: 1600, clubId: 10 }),
            createDoublesSearch({ id: 'second', playerId: 2, ratingTs: 1500, clubId: 10 }),
            createDoublesSearch({ id: 'third', playerId: 3, ratingTs: 1400, clubId: 30 }),
            createDoublesSearch({ id: 'bottom', playerId: 4, ratingTs: 1300, clubId: 40 })
        ];

        const [teamOne, teamTwo] = competitiveRatedQueue.buildBalancedDoublesTeams(searches);
        const pairedIds = [teamOne, teamTwo].map(team => new Set(team.map(search => search.id)));

        expect(pairedIds.some(team => team.has('top') && team.has('second'))).toBe(true);
    });

    it('builds the initial game stack as welcome-rules and start only', () => {
        const match = createMatchFixture({
            timeoutDeadlineAt: 1_300_000
        });
        const defaultRating = { Elo: 500, RankNumber: 0, PlacementPlayed: 0 };
        const payloads = competitiveRatedQueue.buildInitialGameSetupPayloads(match, true, defaultRating, defaultRating);

        expect(payloads.map(item => item.type)).toEqual(['welcome-rules', 'start']);
        expect(payloads[0].payload.content)
            .toBe('>>> Welcome to a rated match between <@home-user> <:cr_unranked:1504559021670137906> **500** and <@away-user> <:cr_unranked:1504559021670137906> **500**! <@home-user> has been selected as HOME!');
        expect(payloads[0].payload.files[0].name).toBe('rules-msc.png');
        expect(payloads[1].payload.content)
            .toBe(`> Click **Start Match**.\n> <:bltime:986232783569551360> Time remaining: ${relativeTimestamp(1_300_000)}.`);
        expect(payloads[1].payload.components[0].toJSON().components[0].label).toBe('Start Match');
    });

    it('start message shows the time warning and Start Match button', () => {
        const match = createMatchFixture({
            timeoutDeadlineAt: 1_300_000
        });

        const start = competitiveRatedQueue.buildStartPayload(match);
        expect(start.content)
            .toBe(`> Click **Start Match**.\n> <:bltime:986232783569551360> Time remaining: ${relativeTimestamp(1_300_000)}.`);
        expect(start.components).toHaveLength(1);
        expect(start.components[0].toJSON().components[0].label).toBe('Start Match');
    });

    it('renders the captain confirmation with emoji and exposes one GAME WIN button', () => {
        const options = createMatchOptions();
        const match = createMatchFixture({
            stage: 'awaiting_winner',
            selectedStadium: options.stadiums[0],
            selectedCaptain: options.captains[0]
        });

        const awayPayload = competitiveRatedQueue.buildCaptainSelectionConfirmationPayload(match);
        const winnerRows = competitiveRatedQueue.buildMatchComponents(match, options);
        const winnerButton = winnerRows[0].toJSON().components[0];

        expect(awayPayload.content).toBe('> <:arrow:1501606527188865114> <@away-user> chose <:mscmario:672091823774367754> **Mario**');
        expect(awayPayload.components).toEqual([]);
        expect(winnerRows).toHaveLength(1);
        expect(winnerButton.label).toBe('GAME WIN');
    });

    it('renders Diddy as Diddy Kong in captain confirmations', () => {
        const match = createMatchFixture({
            selectedCaptain: {
                value: 99,
                code: 'diddy',
                description: 'Diddy'
            }
        });

        const awayPayload = competitiveRatedQueue.buildCaptainSelectionConfirmationPayload(match);

        expect(awayPayload.content).toContain('**Diddy Kong**');
        expect(awayPayload.content).toContain('<:mscdiddy:672092066041298963>');
    });

    it('uses the correct game images for game two and game three', () => {
        expect(competitiveRatedQueue.getGameImagePath(2).replace(/\\/g, '/')).toContain('/rated-matches/g2.png');
        expect(competitiveRatedQueue.getGameImagePath(3).replace(/\\/g, '/')).toContain('/rated-matches/g3.png');
    });

    it('renders game and final match result messages', async () => {
        const gameMatch = createMatchFixture({
            score: {
                team1: 1,
                team2: 0
            }
        });
        const finalMatch = createMatchFixture({
            score: {
                team1: 2,
                team2: 1
            }
        });

        expect(competitiveRatedQueue.renderGameResultMessage('<@home-user>', 1, gameMatch))
            .toBe('>>> <@home-user> wins **Game 1**.\nResult: <:rm1:1501918592017371167> **-** <:rm0:1501918549877325944>');
        await expect(competitiveRatedQueue.renderFinalMatchResultMessage('<@home-user>', finalMatch))
            .resolves.toBe('>>> <:blcup:1502374071050960967> **<@home-user> WINS THE MATCH!**\nResult: <:rm2:1501918611177214082> **-** <:rm1:1501918592017371167>');
    });

    it('renders saved competitive rating deltas in final messages', async () => {
        const highRatedWinMatch = createMatchFixture({
            score: {
                team1: 2,
                team2: 0
            },
            teams: [
                {
                    repUserId: 'home-user',
                    repMention: '<@home-user>',
                    memberIds: ['home-user'],
                    members: [
                        {
                            id: 'home-user',
                            mention: '<@home-user>',
                            username: 'Home',
                            ratingProfile: {
                                elo: 2500,
                                doublesElo: 2500
                            }
                        }
                    ]
                },
                {
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
            ]
        });
        const competitiveResult = {
            seasonName: 'Burst Season 2026',
            changes: [
                {
                    discordId: 'home-user',
                    teamNumber: 1,
                    outcome: 'win',
                    eloDelta: 0,
                    eloAfter: 2500,
                    rankAfter: 19,
                    placementGamesLeft: 0
                },
                {
                    discordId: 'away-user',
                    teamNumber: 2,
                    outcome: 'loss',
                    eloDelta: 0,
                    eloAfter: 1000,
                    rankAfter: 0,
                    placementGamesLeft: 4
                }
            ]
        };

        const finalMessage = await competitiveRatedQueue.renderFinalMatchResultMessage('<@home-user>', highRatedWinMatch, competitiveResult);

        expect(finalMessage).toContain('WINS THE MATCH');
        expect(finalMessage).toContain('Result:');
        expect(finalMessage).not.toContain('Competitive Rating');
        expect(finalMessage).not.toContain('<:arrow:1501606527188865114>');
        expect(finalMessage).not.toContain('MATCH COMPLETED');
    });

    it('renders four saved competitive rating lines for doubles finals', async () => {
        const doublesFinalMatch = createMatchFixture({
            mode: '2v2',
            score: {
                team1: 2,
                team2: 0
            },
            teams: [
                {
                    repUserId: 'team1-a',
                    repMention: '<@team1-a>',
                    memberIds: ['team1-a', 'team1-b'],
                    members: [
                        {
                            id: 'team1-a',
                            mention: '<@team1-a>',
                            username: 'Team1A',
                            ratingProfile: {
                                elo: 1100,
                                doublesElo: 1100
                            }
                        },
                        {
                            id: 'team1-b',
                            mention: '<@team1-b>',
                            username: 'Team1B',
                            ratingProfile: {
                                elo: 1200,
                                doublesElo: 1200
                            }
                        }
                    ]
                },
                {
                    repUserId: 'team2-a',
                    repMention: '<@team2-a>',
                    memberIds: ['team2-a', 'team2-b'],
                    members: [
                        {
                            id: 'team2-a',
                            mention: '<@team2-a>',
                            username: 'Team2A',
                            ratingProfile: {
                                elo: 1300,
                                doublesElo: 1300
                            }
                        },
                        {
                            id: 'team2-b',
                            mention: '<@team2-b>',
                            username: 'Team2B',
                            ratingProfile: {
                                elo: 1400,
                                doublesElo: 1400
                            }
                        }
                    ]
                }
            ]
        });
        const competitiveResult = {
            seasonName: 'Burst Season 2026',
            changes: [
                { discordId: 'team1-a', teamNumber: 1, outcome: 'win', eloDelta: 24, eloAfter: 1124, rankAfter: 0, placementGamesLeft: 4 },
                { discordId: 'team1-b', teamNumber: 1, outcome: 'win', eloDelta: 24, eloAfter: 1224, rankAfter: 0, placementGamesLeft: 4 },
                { discordId: 'team2-a', teamNumber: 2, outcome: 'loss', eloDelta: -24, eloAfter: 1276, rankAfter: 0, placementGamesLeft: 4 },
                { discordId: 'team2-b', teamNumber: 2, outcome: 'loss', eloDelta: -24, eloAfter: 1376, rankAfter: 0, placementGamesLeft: 4 }
            ]
        };

        const finalMessage = await competitiveRatedQueue.renderFinalMatchResultMessage('<@team1-a>', doublesFinalMatch, competitiveResult);

        expect(finalMessage).toContain('WINS THE MATCH');
        expect(finalMessage).toContain('Result:');
        expect(finalMessage).not.toContain('<:arrow:1501606527188865114>');
        expect(finalMessage).not.toContain('MATCH COMPLETED');
        expect(finalMessage).not.toContain('Competitive Rating');
    });

    it('privately warns about expiry and offers a 15 minute reset button', async () => {
        const { client, channel } = createMatchClientMock();
        const now = Date.now();
        const search = createCompetitiveRatedSearch({
            id: 'search-warning',
            userId: 'warn-user',
            username: 'Warn',
            createdAt: 1
        });
        search.mode = '2v2';
        search.warningAt = now - 1000;
        search.expiresAt = now + 60_000;

        competitiveRatedQueue.__seedStateForTests({ activeSearches: [search] });

        await competitiveRatedQueue.__tickForTests(client);

        const warningCall = search.notificationInteraction.followUp.mock.calls.find(([payload]) => payload.content?.startsWith('Your 2vs2 pool entry is still active.'));
        const publicWarningCall = channel.send.mock.calls.find(([payload]) => payload.content?.startsWith('Your 2vs2 pool entry is still active.'));
        expect(warningCall).toBeDefined();
        expect(publicWarningCall).toBeUndefined();
        expect(warningCall[0].content)
            .toBe(`Your 2vs2 pool entry is still active.\n<:bltime:986232783569551360> Time remaining: ${relativeTimestamp(search.expiresAt)}.`);
        expect(warningCall[0].flags).toBe(MessageFlags.Ephemeral);
        expect(warningCall[0].components[0].toJSON().components.map(component => component.label))
            .toEqual(['Extend 15 min']);
    });

    it('extends a pool warning once and silently ignores the stale duplicate extend button', async () => {
        const { client } = createMatchClientMock();
        const search = createCompetitiveRatedSearch({
            id: 'search-repeat',
            userId: 'repeat-user',
            username: 'Repeat',
            createdAt: 1
        });
        search.hasWarnedExpiry = true;
        search.warningMessage = {
            edit: jest.fn(async () => {})
        };
        search.warningMessageId = 'warning-message';
        search.warningToken = 'warning-token';
        competitiveRatedQueue.__seedStateForTests({ activeSearches: [search] });

        const nowSpy = jest.spyOn(Date, 'now');
        try {
            nowSpy.mockReturnValueOnce(1_000_000);
            const firstInteraction = createButtonInteractionMock({
                customId: 'rated:competitive:search:extend:search-repeat:15:warning-token',
                userId: 'repeat-user',
                client
            });
            await competitiveRatedQueue.handleInteraction(firstInteraction);

            expect(search.durationMinutes).toBe(15);
            expect(search.expiresAt).toBe(1_000_000 + 15 * 60000);
            expect(search.warningAt).toBe(1_000_000 + 13 * 60000);
            expect(search.hasWarnedExpiry).toBe(false);
            expect(firstInteraction.followUp.mock.calls.at(-1)[0].content)
                .toBe(`Your 1vs1 pool entry was extended.\n<:bltime:986232783569551360> Time remaining: ${relativeTimestamp(search.expiresAt)}.`);

            nowSpy.mockReturnValueOnce(2_000_000);
            const secondInteraction = createButtonInteractionMock({
                customId: 'rated:competitive:search:extend:search-repeat:15:warning-token',
                userId: 'repeat-user',
                client
            });
            await competitiveRatedQueue.handleInteraction(secondInteraction);

            expect(search.expiresAt).toBe(1_000_000 + 15 * 60000);
            expect(search.warningAt).toBe(1_000_000 + 13 * 60000);
            expect(search.hasWarnedExpiry).toBe(false);
            expect(secondInteraction.followUp).not.toHaveBeenCalled();
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('privately notifies users when their pool entry expires and removes them from the pool', async () => {
        const { client, channel } = createMatchClientMock();
        const now = Date.now();
        const search = createCompetitiveRatedSearch({
            id: 'search-expired',
            userId: 'expired-user',
            username: 'Expired',
            createdAt: 1
        });
        search.warningAt = now - 10_000;
        search.expiresAt = now - 1000;

        competitiveRatedQueue.__seedStateForTests({ activeSearches: [search] });

        await competitiveRatedQueue.__tickForTests(client);

        const expiredCall = search.notificationInteraction.followUp.mock.calls.find(([payload]) => payload.content?.includes('pool entry **expired**.'));
        const publicExpiredCall = channel.send.mock.calls.find(([payload]) => payload.content?.includes('pool entry **expired**.'));
        expect(expiredCall).toBeDefined();
        expect(expiredCall[0].content).toBe('<:blx:1502366790116708382> Your 1vs1 pool entry **expired**. You were removed from the pool!');
        expect(expiredCall[0].flags).toBe(MessageFlags.Ephemeral);
        expect(publicExpiredCall).toBeUndefined();
        expect(competitiveRatedQueue.__getStateSnapshot().activeSearchCount).toBe(0);
    });
});
