const { BL_TIME_EMOJI, THREAD_NAME_MAX_LENGTH } = require('./constants');

function truncateDiscordName(name, maxLength = 100) {
    if (name.length <= maxLength) {
        return name;
    }

    return name.slice(0, maxLength - 3).trimEnd() + '...';
}

function stripThreadTerminalPrefix(name) {
    let normalized = String(name ?? '').trim();
    let changed = true;
    while (changed) {
        const before = normalized;
        normalized = normalized
            .replace(/^(?:✅|🚫|↩️)\s*/u, '')
            .replace(/^CANCELLED\s*\|\s*/i, '')
            .trim();
        changed = normalized !== before;
    }

    return normalized || 'Match';
}

function buildTerminalThreadName(match, prefix) {
    const baseName = stripThreadTerminalPrefix(match.threadName ?? 'Match');
    return truncateDiscordName(`${prefix} ${baseName}`, THREAD_NAME_MAX_LENGTH);
}

async function setTerminalThreadName(thread, match, prefix) {
    const terminalName = buildTerminalThreadName(match, prefix);
    if (!thread?.setName) {
        return terminalName;
    }

    await thread.setName(terminalName).catch(() => {});
    return terminalName;
}

function truncateButtonLabel(label) {
    const normalized = String(label);
    return truncateDiscordName(normalized, 80);
}

function formatRelativeTimestampFromMs(deadlineMs) {
    if (!Number.isFinite(deadlineMs)) {
        return null;
    }

    return `<t:${Math.ceil(deadlineMs / 1000)}:R>`;
}

function renderCountdownLine(deadlineMs, fallbackText) {
    return `${BL_TIME_EMOJI} Time remaining: ${formatRelativeTimestampFromMs(deadlineMs) ?? fallbackText}.`;
}

function renderTimedMessage(mainText, deadlineMs, fallbackText) {
    return `${mainText}\n${renderCountdownLine(deadlineMs, fallbackText)}`;
}

function stripExistingQuoteMarkup(line) {
    return String(line ?? '').replace(/^>>>\s?/, '').replace(/^>\s?/, '');
}

function quoteThreadLines(content) {
    return String(content ?? '')
        .split('\n')
        .map(line => line === '' ? '>' : `> ${stripExistingQuoteMarkup(line)}`)
        .join('\n');
}

function quoteThreadBlock(content) {
    const normalized = String(content ?? '').replace(/^>>>\s?/, '');
    return `>>> ${normalized}`;
}

function isQuotedThreadContent(content) {
    return String(content ?? '').trimStart().startsWith('>');
}

function quoteThreadContent(content, style = 'line') {
    if (isQuotedThreadContent(content)) {
        return content;
    }

    return style === 'block'
        ? quoteThreadBlock(content)
        : quoteThreadLines(content);
}

function quoteThreadPayload(payload, style = 'line') {
    if (!payload?.content) {
        return payload;
    }

    return {
        ...payload,
        content: quoteThreadContent(payload.content, style)
    };
}

function buildThreadTextPayload(content, style = 'line', extra = {}) {
    return {
        ...extra,
        content: quoteThreadContent(content, style)
    };
}

function buildThreadUrl(guildId, threadId) {
    return `https://discord.com/channels/${guildId}/${threadId}`;
}

module.exports = {
    buildTerminalThreadName,
    buildThreadTextPayload,
    buildThreadUrl,
    formatRelativeTimestampFromMs,
    quoteThreadBlock,
    quoteThreadContent,
    quoteThreadLines,
    quoteThreadPayload,
    renderCountdownLine,
    renderTimedMessage,
    setTerminalThreadName,
    stripThreadTerminalPrefix,
    truncateButtonLabel,
    truncateDiscordName
};
