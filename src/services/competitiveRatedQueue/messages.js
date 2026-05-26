const fs = require('node:fs');
const path = require('node:path');
const { AttachmentBuilder } = require('discord.js');

const {
    PANEL_IMAGE_PATHS_BY_GAME_TYPE,
    RATED_MATCH_IMAGE_DIR,
    SEPARATOR_IMAGE_PATH
} = require('./constants');

function getPanelImagePath(panelConfig) {
    return PANEL_IMAGE_PATHS_BY_GAME_TYPE[panelConfig?.gameType] ?? null;
}

function buildImageMessage(imagePath) {
    if (!imagePath || !fs.existsSync(imagePath)) {
        return null;
    }

    return {
        files: [
            new AttachmentBuilder(imagePath, {
                name: path.basename(imagePath)
            })
        ]
    };
}

function buildPanelImageMessage(panelConfig) {
    return buildImageMessage(getPanelImagePath(panelConfig));
}

function getGameImagePath(gameNumber) {
    const imageNumber = Math.min(Math.max(Number(gameNumber) || 1, 1), 3);
    return path.join(RATED_MATCH_IMAGE_DIR, `g${imageNumber}.png`);
}

function buildGameImageMessage(gameNumber) {
    return buildImageMessage(getGameImagePath(gameNumber));
}

function buildSeparatorImageMessage() {
    return buildImageMessage(SEPARATOR_IMAGE_PATH);
}

module.exports = {
    buildGameImageMessage,
    buildImageMessage,
    buildPanelImageMessage,
    buildSeparatorImageMessage,
    getGameImagePath,
    getPanelImagePath
};
