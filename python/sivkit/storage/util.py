from sivkit.libs.model import Entity, dump_to_dict


def envelope(**kwargs) -> dict:
    """Wrap the data in an envelope"""

    # Traverse and serialize entities
    def traverse(obj):
        if isinstance(obj, dict):
            for key, val in obj.items():
                obj[key] = traverse(val)
        elif isinstance(obj, list):
            for i, val in enumerate(obj):
                obj[i] = traverse(val)
        elif isinstance(obj, Entity):
            obj = dump_to_dict(obj)
        return obj

    return traverse(kwargs)
