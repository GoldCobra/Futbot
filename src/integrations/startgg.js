require('dotenv').config();

const { GraphQLClient } = require('graphql-request');
const helpers = require('../utils/helpers');

const START_GG_TOKEN = process.env.START_GG_TOKEN;
const START_GG_ENDPOINT = process.env.START_GG_ENDPOINT;
let graphQlClient = null;

function getClient() {
    if (!START_GG_TOKEN || !START_GG_ENDPOINT) {
        throw new Error('START_GG_TOKEN and START_GG_ENDPOINT must be configured to update start.gg sets.');
    }
    if (!graphQlClient) {
        graphQlClient = new GraphQLClient(START_GG_ENDPOINT, {
            headers: {
                authorization: `Bearer ${START_GG_TOKEN}`
            },
            method: 'POST',
            jsonSerializer: {
                parse: JSON.parse,
                stringify: JSON.stringify
            }
        });
    }
    return graphQlClient;
}

function getEventUrl(tournamentSlug, eventSlug) {
    return `https://www.start.gg/tournament/${tournamentSlug}/event/${eventSlug}`.toLowerCase();
}

function getSetUrlFromSlug(tournamentSlug, eventSlug, setId) {
    return `${getEventUrl(tournamentSlug, eventSlug)}/set/${setId}/report`.toLowerCase();
}

class ParsedStartGgUrl {
    constructor(startggurl) {
        const urlPatterns = [
            {
                regexPattern: /^https:\/\/www\.start\.gg\/tournament\/([^/]+)\/event\/([^/]+)\/set\/(\d+)/,
                parseLogic: { 1: 'tournamentSlug', 2: 'eventSlug', 3: 'setId' },
                parseType: 'set'
            },
            {
                regexPattern: /^https:\/\/www\.start\.gg\/tournament\/([^/]+)\/events?\/([^/]+)\/brackets\/(\d+)\/(\d+)$/,
                parseLogic: { 1: 'tournamentSlug', 2: 'eventSlug', 3: 'phaseId', 4: 'phaseGroupId' },
                parseType: 'phaseGroup'
            },
            {
                regexPattern: /^https:\/\/www\.start\.gg\/tournament\/([^/]+)\/events?\/([^/]+)\/brackets\/(\d+)$/,
                parseLogic: { 1: 'tournamentSlug', 2: 'eventSlug', 3: 'phaseId' },
                parseType: 'phase'
            },
            {
                regexPattern: /tournament\/([^/]+)\/events?\/([^/]+)/,
                parseLogic: { 1: 'tournamentSlug', 2: 'eventSlug' },
                parseType: 'event'
            }
        ];

        let result = null;
        let parseType = null;
        urlPatterns.some(urlPattern => {
            const matchResult = String(startggurl ?? '').match(urlPattern.regexPattern);
            if (!matchResult || matchResult.length !== Object.keys(urlPattern.parseLogic).length + 1) {
                return false;
            }
            result = {};
            parseType = urlPattern.parseType;
            for (const [key, value] of Object.entries(urlPattern.parseLogic)) {
                result[value] = matchResult[key].toString();
            }
            return true;
        });

        if (!result) {
            throw new Error('Must provide a valid start.gg set URL.');
        }

        this.url = startggurl;
        this.tournamentSlug = result.tournamentSlug;
        this.eventSlug = result.eventSlug;
        this.phaseId = result.phaseId ?? null;
        this.phaseGroupId = result.phaseGroupId ?? null;
        this.parseType = parseType;
        this.setId = result.setId ?? null;
    }
}

function getStandardizeSetUrl(startggurlForSet) {
    const parsedStartGgUrl = new ParsedStartGgUrl(startggurlForSet);
    if (parsedStartGgUrl.parseType !== 'set') {
        throw new Error(`Must provide start.gg set URL. Got: '${parsedStartGgUrl.parseType}'.`);
    }
    return getSetUrlFromSlug(parsedStartGgUrl.tournamentSlug, parsedStartGgUrl.eventSlug, parsedStartGgUrl.setId);
}

class SetEntrantsQuery {
    constructor(startggurl) {
        const parsedStartGgUrl = new ParsedStartGgUrl(startggurl);
        if (parsedStartGgUrl.parseType !== 'set') {
            throw new Error(`Must provide start.gg set URL. Got: '${parsedStartGgUrl.parseType}'.`);
        }
        this.query = `
          query SetEntrants($setId: ID!) {
            set(id: $setId) {
              id
              slots {
                entrant {
                  id
                  participants {
                    gamerTag
                    requiredConnections {
                      type
                      externalId
                    }
                  }
                }
              }
            }
          }`;
        this.variables = {
            setId: parsedStartGgUrl.setId
        };
    }

    async execute() {
        const data = await getClient().request(this.query, this.variables);
        const players = [];
        for (const slot of data.set.slots) {
            const entrantId = slot.entrant.id;
            for (const participant of slot.entrant.participants) {
                const discordConnection = participant.requiredConnections.find(connection => connection.type === 'DISCORD');
                players.push({
                    name: participant.gamerTag,
                    discordId: discordConnection ? discordConnection.externalId : null,
                    entrantId
                });
            }
        }

        const discordToEntrants = {};
        for (const player of players) {
            discordToEntrants[player.discordId] = {
                name: player.name,
                id: player.entrantId
            };
        }
        return {
            id: data.set.id,
            discordToEntrants
        };
    }
}

class ReportSetQuery {
    constructor(startggurl, winnerId, gameData) {
        const parsedStartGgUrl = new ParsedStartGgUrl(startggurl);
        this.url = startggurl;
        this.query = `
          mutation reportSet($setId: ID!, $winnerId: ID!, $gameData: [BracketSetGameDataInput]) {
            reportBracketSet(setId: $setId, winnerId: $winnerId, gameData: $gameData) {
              id
              state
            }
          }`;
        this.variables = {
            setId: parsedStartGgUrl.setId,
            winnerId,
            gameData
        };
    }

    async execute() {
        const data = await getClient().request(this.query, this.variables);
        data.url = this.url;
        return data;
    }
}

function getGameDataFromWinOrder(winorder, setEntrants) {
    let gameNum = 1;
    return winorder.map(winnerDiscordId => {
        if (!setEntrants.discordToEntrants[winnerDiscordId]) {
            throw new Error(`Could not find Discord ID ${winnerDiscordId} in this start.gg set.`);
        }
        const result = {
            winnerId: setEntrants.discordToEntrants[winnerDiscordId].id,
            gameNum
        };
        gameNum += 1;
        return result;
    });
}

async function updateSetResult(startggurl, winnerId, gameData) {
    return new ReportSetQuery(startggurl, winnerId, gameData).execute();
}

async function getSetEntrants(startggurl) {
    return new SetEntrantsQuery(startggurl).execute();
}

async function updateSet(seturi, winorder, p1DiscordId, p2DiscordId, approvedsubmitter) {
    const entrants = await getSetEntrants(seturi);
    const winorderSet = new Set(winorder);
    const p1AndP2 = new Set([p1DiscordId, p2DiscordId]);
    if (!helpers.isSubset(winorderSet, p1AndP2)) {
        throw new Error('Code bug: expected only p1 and p2 to be in winorder.');
    }

    const p1EntrantId = entrants.discordToEntrants[p1DiscordId]?.id ?? null;
    const p2EntrantId = entrants.discordToEntrants[p2DiscordId]?.id ?? null;
    if (!approvedsubmitter && (!p1EntrantId || !p2EntrantId)) {
        throw new Error('You must be one of the entrants in the match OR staff to report this set');
    }

    const counts = {};
    for (const winnerDiscordId of winorder) {
        counts[winnerDiscordId] = (counts[winnerDiscordId] ?? 0) + 1;
    }

    let winnerDiscordId = null;
    let wins = -1;
    for (const [discordId, count] of Object.entries(counts)) {
        if (count > wins) {
            wins = count;
            winnerDiscordId = discordId;
        }
    }

    const gameData = getGameDataFromWinOrder(winorder, entrants);
    return updateSetResult(seturi, entrants.discordToEntrants[winnerDiscordId].id, gameData);
}

module.exports = {
    getStandardizeSetUrl,
    updateSet
};
