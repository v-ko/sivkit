import { toUriFriendlyFileName } from './base';

test('toUriFriendlyFileName returns portable names', () => {
    expect(toUriFriendlyFileName('con', 100)).toBe('con_');
    expect(toUriFriendlyFileName('???', 100)).toBe('_');
    expect(toUriFriendlyFileName('conifer', 3)).toBe('co_');
    expect(toUriFriendlyFileName('My Photo', 100)).toBe('My-Photo');
});
