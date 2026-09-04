"""Dump every documentation URL Python produces, as the ground truth for the port.

`docs-url.test.ts` runs this against a sibling checkout of the idfkit repository
and compares the result byte for byte. It is the whole point of the port: the two
libraries have to address the same page for the same object, and the only way to
know that is to ask Python rather than to reimplement its rules twice.

    uv run python packages/core/src/docs-url/python-ground-truth.py > truth.json

Each key is `<call>|<version>|<argument>` and each value is
`[url, doc_set, version, label]`, or null where Python declines to build a URL.
"""

from __future__ import annotations

import json
import sys

from idfkit.docs import (
    _get_doc_locations,  # noqa: PLC2701
    docs_url_for_object,
    engineering_reference_url,
    io_reference_url,
    search_url,
)
from idfkit.schema import get_schema
from idfkit.versions import ENERGYPLUS_VERSIONS

# Versions with no documentation. 9.0.0 is the trap worth keeping: 9.0.1 is
# supported and a nearest-match rule would wrongly accept it.
UNSUPPORTED = [(9, 0, 0), (10, 0, 0), (26, 1, 1), (0, 0, 0), (99, 0, 0)]


def record(result) -> list[str] | None:  # noqa: ANN001
    return None if result is None else [result.url, result.doc_set, result.version, result.label]


def main() -> None:
    locations = _get_doc_locations()
    out: dict[str, list[str] | None] = {}

    for version in list(ENERGYPLUS_VERSIONS) + UNSUPPORTED:
        tag = "{}.{}.{}".format(*version)
        out[f"eng|{tag}|"] = record(engineering_reference_url(version))
        out[f"search|{tag}|chiller"] = record(search_url("chiller", version))
        out[f"search|{tag}|"] = record(search_url("", version))

        for obj_type in locations:
            out[f"io|{tag}|{obj_type}"] = record(io_reference_url(obj_type, version))

        for obj_type in ("Zone", "NotAnObjectType", "zone"):
            out[f"obj|{tag}|{obj_type}"] = record(docs_url_for_object(obj_type, version))

        if version in ENERGYPLUS_VERSIONS:
            schema = get_schema(version)
            # Types the schema knows and the bundled mapping does not: the only
            # inputs that reach the group-slug fallback.
            for obj_type in schema._properties:  # noqa: SLF001
                if obj_type not in locations:
                    out[f"fallback|{tag}|{obj_type}"] = record(
                        io_reference_url(obj_type, version, schema)
                    )
            for obj_type in ("NotAnObjectType", "zone"):
                out[f"fallback|{tag}|{obj_type}"] = record(
                    io_reference_url(obj_type, version, schema)
                )

    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
