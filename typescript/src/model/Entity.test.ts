import { DummyNote } from 'sivkit/storage/test-utils';
import { dumpToDict, loadFromDict, transformedEntity } from './Entity';
import { Change } from './Change';


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

test.each(['value', null])('Entity diff and application preserve absence versus %s', value => {
    const before = loadFromDict({ id: 'e', parent_id: '', type_name: 'DummyNote' });
    const after = loadFromDict({ ...dumpToDict(before), testProp: value });
    const added = before.changeFrom(after);
    expect(added.reverseComponent).toEqual({});
    expect(added.forwardComponent).toEqual({ testProp: value });
    const removed = after.changeFrom(before);
    expect(removed.reverseComponent).toEqual({ testProp: value });
    expect(removed.forwardComponent).toEqual({});
    expect(dumpToDict(transformedEntity(after, removed))).toEqual(dumpToDict(before));
    expect(dumpToDict(transformedEntity(before, added))).toEqual(dumpToDict(after));
});

test('Entity application removes fields while updating others without mutating the source', () => {
    const entity = new DummyNote({ id: 'e', parent_id: 'parent', testProp: 'old' });
    const changed = transformedEntity(entity, new Change(['e', { testProp: 'old', parent_id: 'parent' }, { parent_id: 'next' }]));
    expect(dumpToDict(changed)).toEqual({ id: 'e', parent_id: 'next', type_name: 'DummyNote' });
    expect(entity.testProp).toBe('old');
});
