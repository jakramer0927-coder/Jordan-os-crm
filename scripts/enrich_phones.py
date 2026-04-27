#!/usr/bin/env python3
"""
enrich_phones.py — One-time pass to back-fill phone numbers on CRM contacts
by fuzzy-matching display_names against macOS Address Book names.

Usage:
    python scripts/enrich_phones.py           # preview matches (default)
    python scripts/enrich_phones.py --write   # apply changes to Supabase
    python scripts/enrich_phones.py --threshold 80  # loosen match threshold
"""

from __future__ import annotations

import argparse
import glob
import os
import sqlite3
import sys
from pathlib import Path

import phonenumbers
from phonenumbers import PhoneNumberFormat
from rapidfuzz import fuzz
from rapidfuzz import process as rf_process
from supabase import create_client
from dotenv import load_dotenv

AB_GLOB = str(Path.home() / "Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb")
DEFAULT_THRESHOLD = 85


def normalize_phone(raw: str, region: str = "US") -> str | None:
    try:
        parsed = phonenumbers.parse(raw, region)
        if phonenumbers.is_valid_number(parsed):
            return phonenumbers.format_number(parsed, PhoneNumberFormat.E164)
    except phonenumbers.NumberParseException:
        pass
    return None


def load_ab_name_to_phones() -> dict[str, list[str]]:
    """Returns {display_name: [e164_phone, ...]} from macOS Contacts."""
    result: dict[str, list[str]] = {}
    paths = glob.glob(AB_GLOB)
    if not paths:
        print("  Address Book not accessible.")
        return result

    for ab_path in paths:
        try:
            con = sqlite3.connect(f"file:{ab_path}?immutable=1", uri=True)
            con.execute("SELECT 1")
            cur = con.cursor()

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

            cur.execute(
                "SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL"
            )
            for owner, phone in cur.fetchall():
                if owner in names:
                    norm = normalize_phone(phone)
                    if norm:
                        entry = result.setdefault(names[owner], [])
                        if norm not in entry:
                            entry.append(norm)

            con.close()
        except Exception as e:
            print(f"  Warning: could not read {ab_path}: {e}")

    return result


def main(write: bool, threshold: int) -> None:
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
        sys.exit(1)

    sb = create_client(url, key)  # type: ignore[arg-type]

    print("Loading macOS Address Book...")
    ab = load_ab_name_to_phones()
    ab_names = list(ab.keys())
    print(f"  {len(ab_names)} named contacts with phone numbers")

    if not ab_names:
        print("No Address Book data — nothing to do.")
        return

    print("Loading CRM contacts without phone numbers...")
    res = (
        sb.table("contacts")
        .select("id, display_name, phone")
        .eq("user_id", user_id)
        .execute()
    )
    contacts_no_phone = [
        c for c in (res.data or [])
        if not (c.get("phone") or "").strip() and (c.get("display_name") or "").strip()
    ]
    print(f"  {len(contacts_no_phone)} contacts missing phone")
    print()

    matches: list[tuple[str, str, str, str, float]] = []  # (id, crm_name, ab_name, phone, score)

    for contact in contacts_no_phone:
        name = contact["display_name"].strip()
        hit = rf_process.extractOne(name, ab_names, scorer=fuzz.WRatio)
        if hit and hit[1] >= threshold:
            ab_name, score, _ = hit
            matches.append((contact["id"], name, ab_name, ab[ab_name][0], score))

    if not matches:
        print(f"No matches found at threshold {threshold}. Try --threshold 80.")
        return

    label = "Applying" if write else "Preview —"
    print(f"{label} {len(matches)} matches (threshold={threshold}):")
    print()
    print(f"  {'CRM name':<35}  {'Address Book name':<35}  {'Phone':<16}  Score")
    print(f"  {'-'*35}  {'-'*35}  {'-'*16}  -----")

    updated = 0
    for cid, crm_name, ab_name, phone, score in matches:
        print(f"  {crm_name:<35}  {ab_name:<35}  {phone:<16}  {score:.0f}")
        if write:
            try:
                sb.table("contacts").update({"phone": phone}).eq("id", cid).execute()
                updated += 1
            except Exception as e:
                print(f"    ERROR: {e}")

    print()
    if write:
        print(f"Done. Updated {updated} of {len(matches)} contacts.")
    else:
        print("Run with --write to apply these changes to Supabase.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Enrich CRM contacts with phones from macOS Address Book"
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Apply changes to Supabase (default: preview only)",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=DEFAULT_THRESHOLD,
        help=f"Fuzzy match threshold 0-100 (default: {DEFAULT_THRESHOLD})",
    )
    args = parser.parse_args()
    main(args.write, args.threshold)
