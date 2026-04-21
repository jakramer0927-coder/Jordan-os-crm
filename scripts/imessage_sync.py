#!/usr/bin/env python3
"""
imessage_sync.py — Sync iMessage 1:1 conversations into Jordan OS CRM.

Requirements: pip install -r scripts/requirements.txt
Permissions:  Terminal (or whichever shell runs this) needs Full Disk Access.
              System Settings → Privacy & Security → Full Disk Access → add Terminal.app

Usage:
    python scripts/imessage_sync.py               # last 30 days, live
    python scripts/imessage_sync.py --days 90     # last 90 days
    python scripts/imessage_sync.py --dry-run     # preview, no writes
"""

import argparse
import glob
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import phonenumbers
from phonenumbers import PhoneNumberFormat
from rapidfuzz import fuzz
from rapidfuzz import process as rf_process
from supabase import create_client
from dotenv import load_dotenv

# ── Paths & constants ─────────────────────────────────────────────────────────

CHAT_DB = Path.home() / "Library/Messages/chat.db"
AB_GLOB = str(Path.home() / "Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb")

# macOS Core Data epoch is 2001-01-01 UTC; timestamps are in nanoseconds
MAC_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)

FUZZY_THRESHOLD = 88
SOURCE = "imessage_sync"


# ── Helpers ───────────────────────────────────────────────────────────────────

def mac_ts_to_dt(ns: int) -> datetime:
    """Convert macOS nanosecond timestamp to UTC datetime."""
    return MAC_EPOCH + timedelta(seconds=ns / 1e9)


def normalize_phone(raw: str, region: str = "US") -> str | None:
    """Return E.164 string or None if unparseable / invalid."""
    try:
        parsed = phonenumbers.parse(raw, region)
        if phonenumbers.is_valid_number(parsed):
            return phonenumbers.format_number(parsed, PhoneNumberFormat.E164)
    except phonenumbers.NumberParseException:
        pass
    return None


def is_email_handle(s: str) -> bool:
    return "@" in s and "." in s.split("@")[-1]


def open_copy(path: Path) -> tuple[sqlite3.Connection, str]:
    """
    Copy a SQLite DB to a temp file and open it read-only.
    The copy sidesteps the WAL lock on chat.db and works even if the
    file is open by Messages. Raises SystemExit if permission is denied
    (Full Disk Access not granted).
    """
    try:
        tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        tmp.close()
        shutil.copy2(str(path), tmp.name)
        return sqlite3.connect(f"file:{tmp.name}?mode=ro", uri=True), tmp.name
    except PermissionError:
        print(f"\nERROR: Cannot read {path}")
        print("Grant Full Disk Access to Terminal:")
        print("  System Settings → Privacy & Security → Full Disk Access → add Terminal.app")
        sys.exit(1)
    except FileNotFoundError:
        print(f"\nERROR: {path} not found.")
        sys.exit(1)


# ── Address Book ──────────────────────────────────────────────────────────────

def load_address_book() -> dict[str, str]:
    """
    Returns {normalized_phone_or_email: display_name} from macOS Contacts.
    Falls back to empty dict if AddressBook can't be read.
    """
    result: dict[str, str] = {}
    paths = glob.glob(AB_GLOB)
    if not paths:
        print("  Address Book not accessible — skipping fuzzy name matching")
        return result

    for ab_path in paths:
        try:
            con, tmp = open_copy(Path(ab_path))
            cur = con.cursor()

            # Build pk → display_name map
            names: dict[int, str] = {}
            cur.execute(
                "SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION "
                "FROM ZABCDRECORD"
            )
            for pk, first, last, nick, org in cur.fetchall():
                parts = [p for p in [first, last] if p]
                name = " ".join(parts) or nick or org or ""
                if name.strip():
                    names[pk] = name.strip()

            # Phone → name
            cur.execute(
                "SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL"
            )
            for owner, phone in cur.fetchall():
                if owner in names:
                    norm = normalize_phone(phone)
                    if norm:
                        result[norm] = names[owner]

            # Email → name
            cur.execute(
                "SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL"
            )
            for owner, email in cur.fetchall():
                if owner in names and email:
                    result[email.lower().strip()] = names[owner]

            con.close()
            os.unlink(tmp)

        except Exception as e:
            print(f"  Warning: could not read {ab_path}: {e}")

    return result


# ── Contact matching ──────────────────────────────────────────────────────────

class ContactMatcher:
    """
    Lazily loads CRM contacts and matches iMessage handles against them.
    Priority: E.164 phone → email → fuzzy display_name (via Address Book name).
    """

    def __init__(self, sb, user_id: str) -> None:
        self._sb = sb
        self._uid = user_id
        self._phone: dict[str, str] = {}   # e164 → contact_id
        self._email: dict[str, str] = {}   # lower email → contact_id
        self._names: dict[str, str] = {}   # display_name → contact_id
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        res = (
            self._sb.table("contacts")
            .select("id, display_name, phone, email")
            .eq("user_id", self._uid)
            .execute()
        )
        for c in res.data or []:
            cid = c["id"]
            if c.get("phone"):
                norm = normalize_phone(c["phone"])
                if norm:
                    self._phone[norm] = cid
            if c.get("email"):
                self._email[c["email"].lower().strip()] = cid
            if c.get("display_name"):
                self._names[c["display_name"].strip()] = cid
        self._loaded = True

    def match(self, handle_id: str, ab_name: str | None) -> str | None:
        self._load()

        # 1. Phone (E.164)
        if not is_email_handle(handle_id):
            norm = normalize_phone(handle_id)
            if norm and norm in self._phone:
                return self._phone[norm]

        # 2. Email
        if is_email_handle(handle_id):
            if handle_id.lower() in self._email:
                return self._email[handle_id.lower()]

        # 3. Fuzzy display_name via Address Book name
        if ab_name and self._names:
            hit = rf_process.extractOne(ab_name, self._names.keys(), scorer=fuzz.WRatio)
            if hit and hit[1] >= FUZZY_THRESHOLD:
                return self._names[hit[0]]

        return None


# ── Core sync ─────────────────────────────────────────────────────────────────

def sync(days: int, dry_run: bool) -> None:
    # Load env — try project .env.local first, then plain .env
    for env_file in [
        Path(__file__).parent.parent / ".env.local",
        Path(__file__).parent.parent / "jordan-os-crm" / ".env.local",
        Path(__file__).parent.parent / ".env",
    ]:
        if env_file.exists():
            load_dotenv(env_file)
            break

    url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    user_id = os.environ.get("JORDAN_OS_USER_ID")

    missing = [k for k, v in [("SUPABASE_URL", url), ("SUPABASE_KEY", key), ("JORDAN_OS_USER_ID", user_id)] if not v]
    if missing:
        print(f"ERROR: Missing env vars: {', '.join(missing)}")
        print("Add them to .env.local at the project root.")
        sys.exit(1)

    sb = create_client(url, key)  # type: ignore[arg-type]
    matcher = ContactMatcher(sb, user_id)  # type: ignore[arg-type]

    print(f"{'[DRY RUN] ' if dry_run else ''}iMessage sync — last {days} day(s)")
    print()

    print("Loading macOS Address Book...")
    ab: dict[str, str] = load_address_book()
    print(f"  {len(ab)} phone/email entries loaded")

    print("Opening chat.db...")
    con, tmp_chat = open_copy(CHAT_DB)
    cur = con.cursor()

    cutoff_dt = datetime.now(timezone.utc) - timedelta(days=days)
    cutoff_mac = int((cutoff_dt - MAC_EPOCH).total_seconds() * 1e9)

    # Identify 1:1 chats (skip group chats — they have >1 handle or a display_name)
    cur.execute(
        "SELECT rowid, chat_identifier FROM chat "
        "WHERE (display_name IS NULL OR display_name = '') AND room_name IS NULL"
    )
    candidate_chats = cur.fetchall()

    one_on_one: list[tuple[int, str]] = []
    for chat_id, chat_ident in candidate_chats:
        cur.execute(
            "SELECT h.id FROM handle h "
            "JOIN chat_handle_join chj ON chj.handle_id = h.rowid "
            "WHERE chj.chat_id = ?",
            (chat_id,),
        )
        handles = cur.fetchall()
        if len(handles) == 1:
            one_on_one.append((chat_id, handles[0][0]))

    print(f"  {len(one_on_one)} 1:1 chats found (group chats skipped)")

    # Pre-load already-synced source_message_ids from touches + text_messages
    synced: set[str] = set()
    for table in ("touches", "text_messages"):
        try:
            res = (
                sb.table(table)
                .select("source_message_id")
                .eq("user_id", user_id)
                .eq("source", SOURCE)
                .execute()
            )
            for r in res.data or []:
                if r.get("source_message_id"):
                    synced.add(r["source_message_id"])
        except Exception:
            pass  # column may not exist yet on text_messages — fine

    print(f"  {len(synced)} message GUIDs already synced")
    print()

    stats = {"threads": 0, "messages": 0, "touches": 0, "unmatched": 0, "skipped": 0}

    for chat_id, handle_id in one_on_one:
        # Fetch messages in window with non-empty body
        cur.execute(
            "SELECT m.guid, m.text, m.date, m.is_from_me "
            "FROM message m "
            "JOIN chat_message_join cmj ON cmj.message_id = m.rowid "
            "WHERE cmj.chat_id = ? AND m.date >= ? "
            "  AND m.text IS NOT NULL AND m.text != '' "
            "ORDER BY m.date ASC",
            (chat_id, cutoff_mac),
        )
        all_msgs = cur.fetchall()

        if not all_msgs:
            stats["skipped"] += 1
            continue

        new_msgs = [(g, t, d, f) for g, t, d, f in all_msgs if g not in synced]
        if not new_msgs:
            stats["skipped"] += 1
            continue

        # Resolve Address Book name for this handle
        if is_email_handle(handle_id):
            ab_name = ab.get(handle_id.lower())
        else:
            norm = normalize_phone(handle_id)
            ab_name = ab.get(norm) if norm else None

        contact_id = matcher.match(handle_id, ab_name)

        # ── No match → unmatched_recipients ──────────────────────────────────
        if not contact_id:
            last_guid, last_text, last_date, _ = all_msgs[-1]
            if not dry_run:
                try:
                    sb.table("unmatched_recipients").upsert(
                        {
                            "user_id": user_id,
                            "email": handle_id,
                            "first_seen_at": mac_ts_to_dt(all_msgs[0][2]).isoformat(),
                            "last_seen_at": mac_ts_to_dt(last_date).isoformat(),
                            "seen_count": len(all_msgs),
                            "last_snippet": (last_text or "")[:200],
                            "status": "pending",
                        },
                        count="exact",
                    ).execute()
                except Exception as e:
                    print(f"  Warning: unmatched upsert failed for {handle_id}: {e}")
            print(f"  [unmatched]  {handle_id}  ({len(all_msgs)} msgs)")
            stats["unmatched"] += 1
            continue

        display = ab_name or handle_id

        # ── text_thread: upsert by (user_id, contact_id, source) ─────────────
        raw_text = "\n".join(
            f"[{mac_ts_to_dt(d).strftime('%Y-%m-%d %H:%M')}] "
            f"{'Me' if frm else handle_id}: {txt}"
            for _, txt, d, frm in all_msgs
            if txt
        )

        thread_id: str | None = None
        if not dry_run:
            # Check for existing thread first
            existing = (
                sb.table("text_threads")
                .select("id")
                .eq("user_id", user_id)
                .eq("contact_id", contact_id)
                .eq("source", SOURCE)
                .limit(1)
                .execute()
            )
            if existing.data:
                thread_id = existing.data[0]["id"]
                # Update raw_text with latest content
                sb.table("text_threads").update({"raw_text": raw_text}).eq("id", thread_id).execute()
            else:
                ins = (
                    sb.table("text_threads")
                    .insert({
                        "user_id": user_id,
                        "contact_id": contact_id,
                        "title": display,
                        "source": SOURCE,
                        "raw_text": raw_text,
                    })
                    .execute()
                )
                thread_id = ins.data[0]["id"] if ins.data else None

        stats["threads"] += 1

        # ── text_messages: one row per new message ────────────────────────────
        for guid, text, mac_date, is_from_me in new_msgs:
            if not dry_run and thread_id:
                try:
                    sb.table("text_messages").upsert(
                        {
                            "user_id": user_id,
                            "thread_id": thread_id,
                            "contact_id": contact_id,
                            "direction": "outbound" if is_from_me else "inbound",
                            "occurred_at": mac_ts_to_dt(mac_date).isoformat(),
                            "body": text or "",
                            "sender": "me" if is_from_me else handle_id,
                            "source": SOURCE,
                            "source_message_id": guid,
                        },
                        on_conflict="source_message_id",
                    ).execute()
                except Exception as e:
                    print(f"  Warning: text_message insert failed ({guid[:8]}): {e}")
            stats["messages"] += 1

        # ── touch: one per thread, keyed to the most recent outbound message ──
        # Prefer most recent outbound; fall back to most recent message overall
        touch_candidates = [(g, t, d, f) for g, t, d, f in new_msgs if f] or new_msgs
        t_guid, t_text, t_date, t_from_me = touch_candidates[-1]

        if not dry_run:
            try:
                sb.table("touches").upsert(
                    {
                        "user_id": user_id,
                        "contact_id": contact_id,
                        "channel": "text",
                        "direction": "outbound" if t_from_me else "inbound",
                        "occurred_at": mac_ts_to_dt(t_date).isoformat(),
                        "summary": (t_text or "")[:200],
                        "source": SOURCE,
                        "source_message_id": t_guid,
                    },
                    on_conflict="source_message_id",
                ).execute()
            except Exception as e:
                print(f"  Warning: touch upsert failed for {display}: {e}")

        stats["touches"] += 1
        print(f"  [synced]     {display:<35}  +{len(new_msgs)} msg(s)")

    con.close()
    os.unlink(tmp_chat)

    prefix = "[DRY RUN] " if dry_run else ""
    print()
    print(f"{prefix}Sync complete.")
    print(f"  Threads processed : {stats['threads']}")
    print(f"  New messages       : {stats['messages']}")
    print(f"  Touch records      : {stats['touches']}")
    print(f"  Unmatched handles  : {stats['unmatched']}")
    print(f"  Skipped (no new)   : {stats['skipped']}")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Sync iMessage 1:1 conversations into Jordan OS CRM"
    )
    parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="How many days back to sync (default: 30)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be synced without writing to Supabase",
    )
    args = parser.parse_args()
    sync(args.days, args.dry_run)
