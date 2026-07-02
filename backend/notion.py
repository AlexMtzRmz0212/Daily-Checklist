"""
Notion API helpers
===================
Ported and adapted from the standalone `Notion_Tasks_Tree` Streamlit script into the
AI Task Sorter backend. All functions take the integration token, API version, database
id, and a property-name map as arguments — there are no module-level env reads, so each
user's Notion credentials and schema can differ.

The property map decouples the app's internal field names from the (configurable) column
names in the user's Notion database. Keys used here:
    title, parent, status, description, hierarchy, priority
"""

from typing import Any, Dict, Iterable, List, Optional, Set

import httpx

NOTION_BASE = "https://api.notion.com/v1"
DEFAULT_VERSION = "2022-06-28"

# Defaults mirror the original Streamlit script's Notion column names.
DEFAULT_PROP_MAP: Dict[str, str] = {
    "title":       "Goal",
    "parent":      "Parent item",
    "status":      "1. Status",
    "description": "Description",
    "hierarchy":   "Hierarchy",
    "priority":    "Priority",
}


def _headers(token: str, version: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": version or DEFAULT_VERSION,
        "Content-Type": "application/json",
    }


async def _request(
    method: str,
    path: str,
    token: str,
    version: str,
    payload: Optional[dict] = None,
) -> dict:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.request(
            method,
            f"{NOTION_BASE}{path}",
            headers=_headers(token, version),
            json=payload,
        )
    resp.raise_for_status()
    return resp.json()


async def fetch_all_pages(token: str, version: str, database_id: str) -> List[dict]:
    """Paginate through every page in a Notion database."""
    results: List[dict] = []
    cursor: Optional[str] = None
    while True:
        payload: dict = {}
        if cursor:
            payload["start_cursor"] = cursor
        data = await _request(
            "POST", f"/databases/{database_id}/query", token, version, payload
        )
        results.extend(data.get("results", []))
        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")
    return results


async def update_page_properties(
    token: str,
    version: str,
    page_id: str,
    prop_map: Dict[str, str],
    hierarchy: Optional[int],
    priority: Optional[int],
) -> None:
    """Write Hierarchy and Priority numbers back to a Notion page."""
    props: Dict[str, Any] = {}
    if hierarchy is not None:
        props[prop_map.get("hierarchy", "Hierarchy")] = {"number": hierarchy}
    if priority is not None:
        props[prop_map.get("priority", "Priority")] = {"number": priority}
    if not props:
        return
    await _request(
        "PATCH", f"/pages/{page_id}", token, version, {"properties": props}
    )


# ── Property extractors ──────────────────────────────────────────────────────

def _rich_text(props: dict, key: str) -> str:
    blocks = props.get(key, {}).get("rich_text", [])
    return "".join(b.get("plain_text", "") for b in blocks)


def _title_text(props: dict, key: str) -> str:
    blocks = props.get(key, {}).get("title", [])
    return "".join(b.get("plain_text", "") for b in blocks) or "(Untitled)"


def _select(props: dict, key: str) -> Optional[str]:
    sel = props.get(key, {}).get("select")
    return sel.get("name") if isinstance(sel, dict) else None


def _number(props: dict, key: str) -> Optional[float]:
    return props.get(key, {}).get("number")


def _relation_ids(props: dict, key: str) -> List[str]:
    return [r["id"] for r in props.get(key, {}).get("relation", [])]


def parse_page(page: dict, prop_map: Dict[str, str]) -> Dict[str, Any]:
    """Normalize a raw Notion page into the fields the app cares about."""
    props = page.get("properties", {})
    pm = {**DEFAULT_PROP_MAP, **(prop_map or {})}
    return {
        "notion_id":   page["id"],
        "title":       _title_text(props, pm["title"]),
        "status":      _select(props, pm["status"]) or "",
        "description": _rich_text(props, pm["description"]),
        "parent_ids":  _relation_ids(props, pm["parent"]),
        "hierarchy":   _number(props, pm["hierarchy"]),
        "priority":    _number(props, pm["priority"]),
    }


# ── Tree classification ──────────────────────────────────────────────────────
# The Notion database is a tree of pages linked by the "parent" relation. Layers:
#   root parents      → major categories
#   intermediate      → labels / groupings
#   last parent       → the actual TASK (a node that has leaf children)
#   leaves            → the SUBTASKS of that task
# Two special root parents act as archives: "Done" and "Forget".

def classify_tree(
    parsed: List[Dict[str, Any]],
    done_titles: Iterable[str] = ("done",),
    forget_titles: Iterable[str] = ("forget", "forgotten"),
) -> Dict[str, Dict[str, Any]]:
    """Classify every parsed page as ``category``, ``task``, or ``subtask``.

    Returns a map ``notion_id -> {"role", "archive"}`` where:
      * ``role``    is ``"subtask"`` (leaf), ``"task"`` (has a leaf child, i.e. the
                    last parent, or a parentless leaf), or ``"category"`` (has
                    children but none are leaves).
      * ``archive`` is ``"done"`` / ``"forget"`` / ``None`` based on the title of the
                    node's ROOT ancestor.
    """
    by_id: Dict[str, Dict[str, Any]] = {p["notion_id"]: p for p in parsed}
    done_set = {t.strip().lower() for t in done_titles}
    forget_set = {t.strip().lower() for t in forget_titles}

    def parents_in_db(nid: str) -> List[str]:
        return [pid for pid in by_id[nid]["parent_ids"] if pid in by_id]

    # A page is a leaf if no other in-DB page names it as a parent.
    has_child: Set[str] = set()
    for nid in by_id:
        for pid in parents_in_db(nid):
            has_child.add(pid)

    def is_leaf(nid: str) -> bool:
        return nid not in has_child

    def root_of(nid: str) -> str:
        seen: Set[str] = set()
        cur = nid
        while True:
            parents = parents_in_db(cur)
            if not parents or cur in seen:
                return cur
            seen.add(cur)
            cur = parents[0]

    result: Dict[str, Dict[str, Any]] = {}
    for nid in by_id:
        if is_leaf(nid):
            # A leaf with a parent is a subtask; a lone leaf is a standalone task.
            role = "subtask" if parents_in_db(nid) else "task"
        elif any(is_leaf(cid) for cid in _children_of(nid, by_id)):
            role = "task"       # last parent: has at least one leaf child
        else:
            role = "category"   # only non-leaf children → structural node

        root_title = by_id[root_of(nid)]["title"].strip().lower()
        archive = "done" if root_title in done_set else "forget" if root_title in forget_set else None
        result[nid] = {"role": role, "archive": archive}

    return result


def _children_of(nid: str, by_id: Dict[str, Dict[str, Any]]) -> List[str]:
    return [cid for cid, p in by_id.items() if nid in p["parent_ids"] and cid in by_id]
