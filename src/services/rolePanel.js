const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const EMOJIS = require('../utils/emoji');

function buildRolePanelRows() {
    return [
        new ActionRowBuilder()
            .addComponents([
                new ButtonBuilder()
                    .setCustomId('msbl')
                    .setLabel('Mario Strikers: Battle League')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji(EMOJIS.msblball),
                new ButtonBuilder()
                    .setCustomId('msc')
                    .setLabel('Mario Strikers Charged')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji(EMOJIS.mscball2),
                new ButtonBuilder()
                    .setCustomId('sms')
                    .setLabel('Super Mario Strikers')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji(EMOJIS.smsball),
                new ButtonBuilder()
                    .setCustomId('tournaments')
                    .setLabel('🏆 Tournaments')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('modding')
                    .setLabel('🧩 Modding')
                    .setStyle(ButtonStyle.Primary)
            ]),
        new ActionRowBuilder()
            .addComponents([
                new ButtonBuilder()
                    .setCustomId('msbllfg')
                    .setLabel('MSBL LFG')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('msclfg')
                    .setLabel('MSC LFG')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('mscrankedlfg')
                    .setLabel('MSC Ranked LFG')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('smslfg')
                    .setLabel('SMS LFG')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('smslfg2')
                    .setLabel('SMS LFG - Switch 2')
                    .setStyle(ButtonStyle.Secondary)
            ]),
        new ActionRowBuilder()
            .addComponents([
                new ButtonBuilder()
                    .setCustomId('msl')
                    .setLabel('MSL Announcements')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('msblspectator')
                    .setLabel('MSBL Spectator')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('mscspectator')
                    .setLabel('MSC Spectator')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('smsspectator')
                    .setLabel('SMS Spectator')
                    .setStyle(ButtonStyle.Secondary)
            ]),
        new ActionRowBuilder()
            .addComponents([
                new ButtonBuilder()
                    .setCustomId('blvoice')
                    .setLabel('MSBL Commentator')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('mscvoice')
                    .setLabel('MSC Commentator')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('smsvoice')
                    .setLabel('SMS Commentator')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('mscstream')
                    .setLabel('MSC Dolphin Streamer')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('smsstream')
                    .setLabel('SMS Streamer')
                    .setStyle(ButtonStyle.Success)
            ])
    ];
}

function buildRolePanelMessages() {
    const rows = buildRolePanelRows();
    return [
        {
            content: '**If you wish to access more areas of the server, push the dedicated buttons below.**',
            components: [rows[0]]
        },
        {
            content: '**If you are looking for games and would like to notify/be notified for searching for opponents, select your specific game(s).**',
            components: [rows[1]]
        },
        {
            content: '**Would you like to receive any of these notifications or announcements?**',
            components: [rows[2]]
        },
        {
            content: '**Would you like to be pinged when we need a streamer or commentator?**',
            components: [rows[3]]
        }
    ];
}

module.exports = {
    buildRolePanelMessages,
    buildRolePanelRows
};
