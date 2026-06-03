import { addChannel, clearChannels, HandlerFunction } from './Channel';

// Helper to flush the microtask queue (Channel uses queueMicrotask)
const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('Channel (local backend)', () => {
  afterEach(() => {
    clearChannels();
    jest.clearAllMocks();
  });

  test('delivers to a subscribed handler', async () => {
    const ch = addChannel('test-basic');
    const h: jest.MockedFunction<HandlerFunction> = jest.fn();

    ch.subscribe(h);
    ch.push('hello');

    await flushMicrotasks();
    expect(h).toHaveBeenCalledWith('hello');
    expect(h).toHaveBeenCalledTimes(1);
  });

  test('subchannelClassifier (set after creation) prevents delivery', async () => {
    const ch = addChannel('test-filter-late');
    const h: jest.MockedFunction<HandlerFunction> = jest.fn();

    ch.subchannelClassifier = () => false; // reject everything
    ch.subscribe(h);
    ch.push('blocked');

    await flushMicrotasks();
    expect(h).not.toHaveBeenCalled();
  });

  test('subchannelClassifier (provided at creation) gates messages', async () => {
    const ch = addChannel('test-filter-init', { subchannelClassifier: (m: any) => m?.pass === true });
    const h: jest.MockedFunction<HandlerFunction> = jest.fn();

    ch.subscribe(h);

    ch.push({ pass: false, msg: 'nope' });
    await flushMicrotasks();
    expect(h).not.toHaveBeenCalled();

    ch.push({ pass: true, msg: 'ok' });
    await flushMicrotasks();
    expect(h).toHaveBeenCalledTimes(1);
    expect(h).toHaveBeenCalledWith({ pass: true, msg: 'ok' });
  });

  test('indexed subscriptions receive only matching messages', async () => {
    const ch = addChannel('test-indexed', { subchannel: (m: any) => m?.index ?? null });

    const h1: jest.MockedFunction<HandlerFunction> = jest.fn();
    const h2: jest.MockedFunction<HandlerFunction> = jest.fn();

    ch.subscribe(h1, 'index1');
    ch.subscribe(h2, 'index2');

    ch.push({ index: 'index1', payload: 1 });
    await flushMicrotasks();
    expect(h1).toHaveBeenCalledWith({ index: 'index1', payload: 1 });
    expect(h2).not.toHaveBeenCalled();

    ch.push({ index: 'index2', payload: 2 });
    await flushMicrotasks();
    expect(h2).toHaveBeenCalledWith({ index: 'index2', payload: 2 });

    // non-indexed message (indexKey returns null) should not hit indexed subs
    ch.push({ payload: 3 });
    await flushMicrotasks();
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  test('unsubscribe stops further deliveries', async () => {
    const ch = addChannel('test-unsub');
    const h: jest.MockedFunction<HandlerFunction> = jest.fn();

    const sub = ch.subscribe(h);
    ch.push('once');
    await flushMicrotasks();
    expect(h).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
    ch.push('twice');
    await flushMicrotasks();
    expect(h).toHaveBeenCalledTimes(1);
  });
});
