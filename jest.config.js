module.exports = {
    roots: ['<rootDir>'],
    testRegex: '(/tests/.*|(\\.|/)(test|spec))\\.js?$',
    testPathIgnorePatterns: ['/node_modules/', '/tests/setup/', '/tests/fixtures/', '/tests/helpers/'],
    moduleFileExtensions: ['js', 'json', 'node'],
    setupFiles: ['<rootDir>/tests/setup/isolate.js'],
};
