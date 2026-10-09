# Delta Protocol

Python and TypeScript use the same delta format and rules.

## Reading a Delta

A delta says what changed and keeps enough information to undo it. This one renames a page:

```json
{"page": ["page", {"name": "First"}, {"name": "Second"}]}
```

Each entry is `[entity_id, reverse, forward]`: the entity being changed, its affected fields before the change, and those fields afterward. For ordinary changes, the entry key is the entity id too.

| Kind | Reverse | Forward |
| --- | --- | --- |
| CREATE | `{}` | Complete entity data with matching `id` |
| DELETE | Complete entity data with matching `id` | `{}` |
| UPDATE | Previous affected fields | Next affected fields |
| EMPTY | `{}` | `{}` |

Complete entity data includes `id`, `parent_id`, and `type_name`. A root entity has `parent_id: ""`.

An update includes only changed fields, not `id` or unchanged values. It cannot change the entity's identity. An empty component does not by itself mean CREATE or DELETE: adding or removing a single field also leaves one side empty.

## Applying Changes

For an update, set the fields in forward and remove any fields that appear only in reverse. Leave everything else alone. Objects and arrays are replaced as whole values, not edited at nested paths.

| Reverse | Forward | Effect |
| --- | --- | --- |
| `{}` | `{"home":"page-a"}` | Add a missing field |
| `{"home":"page-a"}` | `{}` | Remove the field |
| `{}` | `{"home":null}` | Add a field whose value is null |
| `{"home":null}` | `{}` | Remove a null-valued field |

`null` is a value; a missing key is absence. TypeScript drops `undefined` properties when serializing to JSON, so a field removal must keep its old value in reverse.

CREATE inserts the complete entity data, DELETE removes the entity, and EMPTY does nothing.

## Combining and Undoing

Combining changes must give the same result as applying them in order. Keep the earliest before-state in reverse and the final after-state in forward, including whether each field exists at all. If the endpoints match, the change cancels. Combining with EMPTY leaves the other change unchanged.

| Sequence | Net result |
| --- | --- |
| `page-a -> page-b -> absent` | `page-a -> absent` |
| `absent -> page-a -> absent` | EMPTY |
| `page-a -> absent -> page-b` | `page-a -> page-b` |
| CREATE with a field, then remove it | CREATE without that field |
| Add a field, then DELETE | DELETE with the field absent in reverse |
| CREATE then DELETE | EMPTY |
| DELETE then CREATE | UPDATE of differing fields, or EMPTY if identical |

Undo swaps reverse and forward. It must restore both the original values and the original missing fields. Undoing combined changes must agree with undoing the individual changes in reverse order.

Impossible sequences, such as creating the same entity twice without deleting it, raise errors.

## Custom Operations (Proposal)

Custom entries would use `entity_id@operation`, with application-defined payloads in the usual `[entity_id, reverse, forward]` triplet. For example, this proposed entry appends to the `text` field of the entity whose id is `message`:

```json
{"message@text_append": ["message", {}, {"chunk": " world"}]}
```

Here `"message"` identifies the entity, `{}` provides no inverse payload, and `{"chunk": " world"}` is the append instruction, not the complete text:

```text
message.text before: "Hello"
message.text after:  "Hello world"
```

Applying it twice would append twice. Neither swapping the components nor copying the chunk into reverse implements undo. Under this proposal, custom-operation dispatch would precede ordinary change classification; the empty reverse side would not make this an entity CREATE.

The syntax, dispatch, composition, reversal, and conflict-resolution rules remain proposals, not implemented protocol guarantees.

**Proposed stream completion:** keep chunks transient and record a regular keyframe update from pre-stream to final state, such as `{"message": ["message", {"text": "Hello"}, {"text": "Hello world"}]}`. History would contain the keyframe, not both it and the chunks. Whether keyframes are mandatory, and how cancellation, failure, and missed chunks work, remain open; extensions with their own inverses or live-only data may use another approach. This proposal does not yet establish general custom-operation support for history or undo.

## Replay

Starting from the same stored entity data and applying the same sequence of deltas in either language should produce the same stored entity data, including field absence and explicit null values.
