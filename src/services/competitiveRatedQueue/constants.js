const path = require('node:path');

const CONSTANTS = require('../../utils/constants');

const CONFIG = CONSTANTS.COMPETITIVE_RATED_QUEUE;
const CONTROL_EXPIRY_MESSAGE = 'This control expired.';
const PANEL_BYPASS_ROLES = new Set([
    CONSTANTS.ROLES.ADMIN,
    CONSTANTS.ROLES.DEVELOPER,
    CONSTANTS.ROLES.MSL_STAFF,
    CONSTANTS.ROLES.MSL_STAFF_MSC,
    CONSTANTS.ROLES.MSL_STAFF_SMS,
    CONSTANTS.ROLES.MSL_STAFF_MSBL
]);
const MSC_STADIUM_BUTTON_ORDER = [
    'Bowser Stadium',
    'The Classroom',
    'Crystal Canyon',
    'Lava Pit'
];
const MSC_CAPTAIN_BUTTON_ORDER = [
    { aliases: ['Mario'], emoji: { name: 'mscmario', id: '672091823774367754' } },
    { aliases: ['Peach'], emoji: { name: 'mscpeach', id: '672091844041244723' } },
    { aliases: ['DK', 'Donkey Kong'], emoji: { name: 'mscdk', id: '672091861388623902' } },
    { aliases: ['Waluigi'], emoji: { name: 'mscwaluigi', id: '672091883127832586' } },
    { aliases: ['Luigi'], emoji: { name: 'mscluigi', id: '672091897149259778' } },
    { aliases: ['Wario'], emoji: { name: 'mscwario', id: '672091915352539156' } },
    { aliases: ['Bowser'], emoji: { name: 'mscbowser', id: '672091933119873025' } },
    { aliases: ['Yoshi'], emoji: { name: 'mscyoshi', id: '672091973611421706' } },
    { aliases: ['Daisy'], emoji: { name: 'mscdaisy', id: '672092026568704000' } },
    { aliases: ['Bowser Jr.', 'Bowser Jr', 'Bowser Junior'], emoji: { name: 'mscbowserjr', id: '672092050371510282' } },
    { aliases: ['Diddy Kong', 'Diddy'], emoji: { name: 'mscdiddy', id: '672092066041298963' } },
    { aliases: ['Petey', 'Petey Piranha'], emoji: { name: 'mscpetey', id: '672092080293675019' } }
];
const SMS_STADIUM_BUTTON_ORDER = [
    'The Battle Dome',
    'Bowser Stadium',
    'Crater Field',
    'Konga Coliseum',
    'The Palace',
    'Pipeline Central',
    'The Underground'
];
const SMS_CAPTAIN_BUTTON_ORDER = [
    { aliases: ['Mario'],             emoji: { name: 'smsmario',   id: '862644869717295115' } },
    { aliases: ['Peach'],             emoji: { name: 'smspeach',   id: '862644927342575637' } },
    { aliases: ['DK', 'Donkey Kong'], emoji: { name: 'smsdk',      id: '862645254401032212' } },
    { aliases: ['Waluigi'],           emoji: { name: 'smswaluigi', id: '862645008434987049' } },
    { aliases: ['Luigi'],             emoji: { name: 'smsluigi',   id: '862644885962358784' } },
    { aliases: ['Wario'],             emoji: { name: 'smswario',   id: '862644995223846912' } },
    { aliases: ['Yoshi'],             emoji: { name: 'smsyoshi',   id: '862645273200689152' } },
    { aliases: ['Daisy'],             emoji: { name: 'smsdaisy',   id: '862644977284022282' } }
];
const CAPTAIN_BUTTON_ORDER_BY_GAME_TYPE = {
    MSC: MSC_CAPTAIN_BUTTON_ORDER,
    SMS: SMS_CAPTAIN_BUTTON_ORDER
};
const STADIUM_BUTTON_ORDER_BY_GAME_TYPE = {
    MSC: MSC_STADIUM_BUTTON_ORDER,
    SMS: SMS_STADIUM_BUTTON_ORDER
};
const RATED_MATCH_IMAGE_DIR = path.resolve(__dirname, '..', '..', 'img', 'rated-matches');
const PANEL_IMAGE_PATHS_BY_GAME_TYPE = {
    MSC: path.resolve(RATED_MATCH_IMAGE_DIR, 'rm-msc.png'),
    SMS: path.resolve(RATED_MATCH_IMAGE_DIR, 'rm-sms.png'),
    MSBL: path.resolve(RATED_MATCH_IMAGE_DIR, 'rm-msbl.png')
};
const RULES_IMAGE_PATHS_BY_GAME_TYPE = {
    MSC: path.join(RATED_MATCH_IMAGE_DIR, 'rules-msc.png'),
    SMS: path.join(RATED_MATCH_IMAGE_DIR, 'rules-sms.png'),
    MSBL: path.join(RATED_MATCH_IMAGE_DIR, 'rules-msbl.png')
};
const SEPARATOR_IMAGE_PATH = path.join(RATED_MATCH_IMAGE_DIR, 'sep.png');
const ARROW_EMOJI = '<:arrow:1501606527188865114>';
const BL_CHECK_EMOJI = '<:blcheck:1502370767906803893>';
const BL_CUP_EMOJI = '<:blcup:1502374071050960967>';
const BL_TIME_EMOJI = '<:bltime:986232783569551360>';
const BL_X_EMOJI = '<:blx:1502366790116708382>';
const PLAYER_COUNT_EMOJI = '👤';
const COMPLETED_THREAD_PREFIX = '✅';
const CANCELLED_THREAD_PREFIX = '🚫';
const ROLLED_BACK_THREAD_PREFIX = '↩️';
const THREAD_NAME_MAX_LENGTH = 100;
const MSC_RATED_ISSUE_FORUM_CHANNEL_ID = '1503756820391395348';
const SMS_RATED_ISSUE_FORUM_CHANNEL_ID = '1503812475953479710';
const MSBL_RATED_ISSUE_FORUM_CHANNEL_ID = '1503825002804547755';
const RATED_ISSUE_FORUM_BY_GAME_TYPE = {
    MSC: MSC_RATED_ISSUE_FORUM_CHANNEL_ID,
    SMS: SMS_RATED_ISSUE_FORUM_CHANNEL_ID,
    MSBL: MSBL_RATED_ISSUE_FORUM_CHANNEL_ID
};
const RATED_RUNTIME_LOG_THREADS = {
    SMS: {
        '1v1': '1503758084550426766',
        '2v2': '1503758128678965250'
    },
    MSC: {
        '1v1': '1503758199638196255',
        '2v2': '1503758261008994427'
    },
    MSBL: {
        '1v1': '1503758336439357541',
        '2v2': '1503758435450355782'
    }
};
const RATED_RUNTIME_LOG_INFO_FLUSH_MS = 1500;
const RATED_RUNTIME_LOG_CLEANUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const RATED_RUNTIME_LOG_MAX_MESSAGE_LENGTH = 1900;
const RATED_RUNTIME_LOG_CLEANUP_FETCH_LIMIT = 100;
const COMPLETED_THREAD_CLOSE_DELAY_MS = 3 * 60_000;
const DEFAULT_POOL_DURATION_MINUTES = 15;
const SCORE_EMOJIS = {
    0: '<:rm0:1501918549877325944>',
    1: '<:rm1:1501918592017371167>',
    2: '<:rm2:1501918611177214082>'
};
const MATCH_TIMEOUT_PHASES = new Set(['start', 'game', 'loser_confirmation']);
const LOSER_CHOICE_TIMEOUT_MINUTES = 2;
const SELECTION_TIMEOUT_MINUTES = 2;
const STADIUM_DISPLAY_OVERRIDES = { 'Lava Pit': 'The Lava Pit' };
const CAPTAIN_DISPLAY_OVERRIDES = { Diddy: 'Diddy Kong' };

module.exports = {
    ARROW_EMOJI,
    BL_CHECK_EMOJI,
    BL_CUP_EMOJI,
    BL_TIME_EMOJI,
    BL_X_EMOJI,
    CANCELLED_THREAD_PREFIX,
    CAPTAIN_DISPLAY_OVERRIDES,
    CAPTAIN_BUTTON_ORDER_BY_GAME_TYPE,
    COMPLETED_THREAD_CLOSE_DELAY_MS,
    COMPLETED_THREAD_PREFIX,
    CONFIG,
    CONSTANTS,
    CONTROL_EXPIRY_MESSAGE,
    DEFAULT_POOL_DURATION_MINUTES,
    LOSER_CHOICE_TIMEOUT_MINUTES,
    MATCH_TIMEOUT_PHASES,
    MSBL_RATED_ISSUE_FORUM_CHANNEL_ID,
    MSC_CAPTAIN_BUTTON_ORDER,
    PANEL_BYPASS_ROLES,
    PANEL_IMAGE_PATHS_BY_GAME_TYPE,
    PLAYER_COUNT_EMOJI,
    ROLLED_BACK_THREAD_PREFIX,
    RATED_ISSUE_FORUM_BY_GAME_TYPE,
    RATED_RUNTIME_LOG_CLEANUP_FETCH_LIMIT,
    RATED_RUNTIME_LOG_CLEANUP_INTERVAL_MS,
    RATED_RUNTIME_LOG_INFO_FLUSH_MS,
    RATED_RUNTIME_LOG_MAX_MESSAGE_LENGTH,
    RATED_RUNTIME_LOG_THREADS,
    RATED_MATCH_IMAGE_DIR,
    RULES_IMAGE_PATHS_BY_GAME_TYPE,
    SCORE_EMOJIS,
    SELECTION_TIMEOUT_MINUTES,
    SEPARATOR_IMAGE_PATH,
    STADIUM_BUTTON_ORDER_BY_GAME_TYPE,
    STADIUM_DISPLAY_OVERRIDES,
    THREAD_NAME_MAX_LENGTH
};
