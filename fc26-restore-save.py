#!/usr/bin/env python3
"""Restore FC26 career save from known-good backups (fix s13w00 corrupt)."""
import os
import shutil
from datetime import datetime

SETTINGS = os.path.join(os.environ["LOCALAPPDATA"], "EA SPORTS FC 26", "settings")
TS = datetime.now().strftime("%Y%m%d_%H%M%S")


def backup(path: str) -> None:
    if os.path.isfile(path):
        shutil.copy2(path, f"{path}.broken_{TS}")


def restore_file(target: str, source: str) -> bool:
    tgt = os.path.join(SETTINGS, target)
    src = os.path.join(SETTINGS, source)
    if not os.path.isfile(src):
        print(f"  MISSING source: {source}")
        return False
    backup(tgt)
    shutil.copy2(src, tgt)
    print(f"  OK: {target} <- {source}")
    return True


def main():
    print("FC26 full save restore")
    print("Dir:", SETTINGS)

    if not os.path.isdir(SETTINGS):
        print("ERROR: settings folder not found")
        return 1

    ok = 0

    print("\n[1] Settings (fix s13w00 chunk corruption)")
    # Newest Settings was corrupted (0xff garbage). Use last good copy.
    if restore_file("Settings20260706001116569", "Settings20260705210645054"):
        ok += 1

    print("\n[2] CmPlr career — restore loadable + Son Heung Min")
    # pre_neymar_backup == working Son for slot 03025405949
    if restore_file("CmPlr20260703025405949", "CmPlr20260703025405949.pre_neymar_backup"):
        ok += 1

    # Latest slot: use file from before our edits (loadable). Then apply Son names only.
    if restore_file("CmPlr20260705211049575", "CmPlr20260705211049575.before_son_fix_20260706_001221"):
        ok += 1
        # Re-apply Son names (safe — surrounding bytes identical to pre_neymar)
        path = os.path.join(SETTINGS, "CmPlr20260705211049575")
        data = bytearray(open(path, "rb").read())
        son, ney = b"Son Heung Min", b"Neymar"
        for off in (250, 1274, 1339, 942465):
            if bytes(data[off : off + 13]).startswith(ney):
                data[off : off + 13] = son
        open(path, "wb").write(data)
        print("  OK: applied Son Heung Min names on latest CmPlr")

    print("\n[3] Archive corrupted Settings variants")
    for name in os.listdir(SETTINGS):
        if name.startswith("Settings20260706001116569") and name != "Settings20260706001116569":
            if "broken_" in name or "corrupt" in name or "before_son" in name:
                continue
            src = os.path.join(SETTINGS, name)
            if os.path.isfile(src):
                dst = src + f".archived_{TS}"
                shutil.move(src, dst)
                print(f"  archived: {name}")

    print(f"\nDone. Restored {ok} core file(s).")
    print("Launch FC26 and load career save.")
    print("Latest progress: CmPlr20260705211049575 (Son Heung Min)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())