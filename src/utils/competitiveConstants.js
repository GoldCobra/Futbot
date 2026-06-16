const PLACEMENT_GAMES_REQUIRED = 5;
const SOFT_RESET_FACTOR = 0.70;
const ELO_DIVISOR = 400;
const COMPETITIVE_DB_SCHEMA = process.env.COMPETITIVE_DB_SCHEMA ?? 'rocci121_toby';

// K-factor thresholds aligned with rank tier boundaries
const K_PLACEMENT = 100;
const K_BRONZE_SILVER_GOLD = 64;    // < 1250 ELO
const K_PLATINUM_DIAMOND = 52;       // 1250–1549
const K_MASTER = 40;                 // 1550–1749
const K_TITAN = 32;                  // 1750+

function getKFactor(elo, isPlacement) {
    if (isPlacement) return K_PLACEMENT;
    if (elo < 1250) return K_BRONZE_SILVER_GOLD;
    if (elo < 1550) return K_PLATINUM_DIAMOND;
    if (elo < 1750) return K_MASTER;
    return K_TITAN;
}

function quoteSqlIdentifier(identifier) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error(`Invalid SQL identifier: ${identifier}`);
    }
    return `[${identifier}]`;
}

function competitiveTable(tableName) {
    return `${quoteSqlIdentifier(COMPETITIVE_DB_SCHEMA)}.${quoteSqlIdentifier(tableName)}`;
}

// Rank names indexed by rank number (0 = Unranked, 1–19 = Bronze I → Strikers Titan)
const COMP_RANK_NAMES = [
    'Unranked',
    'Bronze I',
    'Bronze II',
    'Bronze III',
    'Silver I',
    'Silver II',
    'Silver III',
    'Gold I',
    'Gold II',
    'Gold III',
    'Platinum I',
    'Platinum II',
    'Platinum III',
    'Diamond I',
    'Diamond II',
    'Diamond III',
    'Master I',
    'Master II',
    'Master III',
    'Strikers Titan',
];

// Discord emoji strings indexed by rank number (0 = Unranked, 1–19 = Bronze I → Strikers Titan)
const COMP_RANK_EMOJIS = [
    '<:cr_unranked:1504559021670137906>',
    '<:cr_bronze1:1504559196924809226>',
    '<:cr_bronze2:1504559233792737340>',
    '<:cr_bronze3:1504559271222968541>',
    '<:cr_silver1:1504559351166271498>',
    '<:cr_silver2:1504559430534959385>',
    '<:cr_silver3:1504559473690415335>',
    '<:cr_gold1:1504559576660312105>',
    '<:cr_gold2:1504559632369057903>',
    '<:cr_gold3:1504559690506305598>',
    '<:cr_platinum1:1504559901232599120>',
    '<:cr_platinum2:1504559991229775914>',
    '<:cr_platinum3:1504560138659430532>',
    '<:cr_diamond1:1504588753816125591>',
    '<:cr_diamond2:1504588839250038846>',
    '<:cr_diamond3:1504588890789384353>',
    '<:cr_master1:1504588965624283447>',
    '<:cr_master2:1504589018451677204>',
    '<:cr_master3:1504589078031765645>',
    '<:cr_titan:1504589218251407522>',
];

module.exports = {
    PLACEMENT_GAMES_REQUIRED,
    SOFT_RESET_FACTOR,
    ELO_DIVISOR,
    COMPETITIVE_DB_SCHEMA,
    competitiveTable,
    getKFactor,
    COMP_RANK_EMOJIS,
    COMP_RANK_NAMES
};
