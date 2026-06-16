const { normalizeDiscordId } = require('../../src/services/competitiveRatedQueue/service');

describe('normalizeDiscordId', () => {
    const SNOWFLAKE = '189095395320659969';

    it('returns a clean snowflake unchanged', () => {
        expect(normalizeDiscordId(SNOWFLAKE)).toBe(SNOWFLAKE);
    });

    it('strips mention wrappers <@id>, <@!id>, <@&id>', () => {
        expect(normalizeDiscordId(`<@${SNOWFLAKE}>`)).toBe(SNOWFLAKE);
        expect(normalizeDiscordId(`<@!${SNOWFLAKE}>`)).toBe(SNOWFLAKE);
        expect(normalizeDiscordId(`<@&${SNOWFLAKE}>`)).toBe(SNOWFLAKE);
    });

    it('strips legacy & and x- prefixes', () => {
        expect(normalizeDiscordId(`&${SNOWFLAKE}`)).toBe(SNOWFLAKE);
        expect(normalizeDiscordId(`x-${SNOWFLAKE}`)).toBe(SNOWFLAKE);
    });

    it('trims surrounding whitespace', () => {
        expect(normalizeDiscordId(`  ${SNOWFLAKE}  `)).toBe(SNOWFLAKE);
    });

    it('leaves non-snowflake input (usernames) untouched rather than corrupting it', () => {
        expect(normalizeDiscordId('buddyalexis')).toBe('buddyalexis');
        expect(normalizeDiscordId('Gstone525')).toBe('Gstone525');
    });

    it('handles empty/nullish input safely', () => {
        expect(normalizeDiscordId('')).toBe('');
        expect(normalizeDiscordId(null)).toBe('');
        expect(normalizeDiscordId(undefined)).toBe('');
    });
});
