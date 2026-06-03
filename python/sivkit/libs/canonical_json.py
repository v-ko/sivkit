"""RFC 8785 JSON Canonicalization Scheme (JCS) implementation.

Produces deterministic JSON output matching JavaScript's JSON.stringify
with sorted keys and compact separators. The key difference from Python's
json.dumps is number formatting: whole-number floats drop the '.0' suffix,
and exponential notation thresholds match ECMAScript's Number.toString().

Number formatting based on ES6/V8 specification (vendored from
https://github.com/nicolo-ribaudo/jcs — Apache 2.0 license).
"""

from __future__ import annotations

from typing import Any


def _number_to_es6(value: int | float) -> str:
    """Format a number the same way as ECMAScript Number.toString().

    Key differences from Python's float.__repr__:
    - 40.0 → '40' (not '40.0')
    - 1e20 → '100000000000000000000' (not '1e+20')
    - -0.0 → '0' (not '-0.0')
    """
    fvalue = float(value)

    # Zero (including -0) is a special case
    if fvalue == 0:
        return "0"

    py_str = str(fvalue)

    # Reject NaN and Infinity
    if "n" in py_str:  # catches "nan" and "inf"
        raise ValueError(f"Invalid JSON number: {py_str}")

    # Separate sign
    sign = ""
    if py_str[0] == "-":
        sign = "-"
        py_str = py_str[1:]

    # Separate exponent
    exp_str = ""
    exp_val = 0
    e_pos = py_str.find("e")
    if e_pos > 0:
        exp_str = py_str[e_pos:]
        # Suppress leading zero in exponent (e.g. e+07 → e+7)
        if len(exp_str) > 2 and exp_str[2] == "0":
            exp_str = exp_str[:2] + exp_str[3:]
        py_str = py_str[:e_pos]
        exp_val = int(exp_str[1:])

    # Split into integer + fractional parts
    first = py_str
    dot = ""
    last = ""
    dot_pos = py_str.find(".")
    if dot_pos > 0:
        dot = "."
        first = py_str[:dot_pos]
        last = py_str[dot_pos + 1 :]

    # Remove trailing .0
    if last == "0":
        dot = ""
        last = ""

    # Expand positive exponents < 21 to integer form
    if 0 < exp_val < 21:
        first += last
        last = ""
        dot = ""
        exp_str = ""
        pad = exp_val - len(first) + 1
        if pad > 0:
            first += "0" * pad

    # Expand small negative exponents > -7 to 0.000... form
    elif -7 < exp_val < 0:
        last = first + last
        first = "0"
        dot = "."
        exp_str = ""
        last = "0" * (-exp_val - 1) + last

    return sign + first + dot + last + exp_str


def canonical_json(obj: Any) -> str:
    """Serialize a Python object to JCS-compliant canonical JSON.

    - Dict keys are sorted by Unicode code point
    - Compact separators (no whitespace)
    - Numbers formatted per ES6 Number.toString()
    - Non-ASCII characters passed through as UTF-8 (not escaped)
    """
    if obj is None:
        return "null"
    if obj is True:
        return "true"
    if obj is False:
        return "false"
    if isinstance(obj, str):
        # Use the standard json string escaping but without ensure_ascii
        import json

        return json.dumps(obj, ensure_ascii=False)
    if isinstance(obj, int) and not isinstance(obj, bool):
        return _number_to_es6(obj)
    if isinstance(obj, float):
        return _number_to_es6(obj)
    if isinstance(obj, (list, tuple)):
        items = ",".join(canonical_json(v) for v in obj)
        return "[" + items + "]"
    if isinstance(obj, dict):
        parts = []
        for key in sorted(obj.keys()):
            val = obj[key]
            parts.append(canonical_json(key) + ":" + canonical_json(val))
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")
