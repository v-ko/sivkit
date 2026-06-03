import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
        '^sivkit/(.*)$': '<rootDir>/src/$1',
    },
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            useESM: true,
            tsconfig: 'tsconfig.json',
        }],
    },
    testMatch: ['**/*.test.ts'],
};

export default config;
