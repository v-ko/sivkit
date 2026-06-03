import { DummyNote } from 'sivkit/storage/test-utils';
import { dumpToDict, loadFromDict } from './Entity'


test('Entity replace', () => {
    let e = new DummyNote({ id: '456', parent_id: '', testProp: 'test' });
    e.replace({ testProp: 'test2' });

    let outDict = e.data();

    expect(outDict).toEqual({ id: '456', parent_id: '', testProp: 'test2' });
});

test('Entity copy', () => {
    let e = new DummyNote({ id: '123', parent_id: '', testProp: 'test' });
    let e2 = e.copy();

    e2.testProp = 'changed';

    expect(e.testProp).toBe('test');
    expect(e2.testProp).toBe('changed');
});

test('Entity serialization and deserialization', () => {
    let e = new DummyNote({ id: '123', parent_id: '', testProp: 'test' });
    let eDict = dumpToDict(e);
    let e2 = loadFromDict(eDict) as DummyNote;

    expect(e2._data).toEqual(e._data);
});
