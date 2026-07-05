#!/usr/bin/env python3
"""Fix FC26 career CmPlr only: Neymar -> Son Heung Min (do NOT patch Settings)."""
import os
import shutil
from datetime import datetime

SETTINGS = os.path.join(os.environ["LOCALAPPDATA"], "EA SPORTS FC 26", "settings")
SON = b"Son Heung Min"
NEYMAR = b"Neymar"
NAME_OFFSETS = (250, 1274, 1339, 942465)


def patch_cmplr(path: str) -> bool:
    with open(path, "rb") as f:
        data = bytearray(f.read())

    patched = []
    for off in NAME_OFFSETS:
        slot = bytes(data[off : off + len(SON)])
        if slot.startswith(NEYMAR):
            data[off : off + len(SON)] = SON
            patched.append(off)

    if not patched:
        print(f"  OK: {os.path.basename(path)}")
        return False

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    shutil.copy2(path, f"{path}.before_son_fix_{ts}")
    with open(path, "wb") as f:
        f.write(data)

    print(f"  FIXED: {os.path.basename(path)} slots {patched}")
    return True


def restore_settings():
    """Restore latest Settings if our earlier patch broke s13w00 chunk."""
    candidates = sorted(
        (f for f in os.listdir(SETTINGS) if f.startswith("Settings") and "before_son_fix" in f),
        reverse=True,
    )
    if not candidates:
        return False

    backup = os.path.join(SETTINGS, candidates[0])
    target = os.path.join(SETTINGS, candidates[0].split(".before_son_fix")[0])
    if not os.path.isfile(target):
        return False

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    shutil.copy2(target, f"{target}.corrupt_keep_{ts}")
    shutil.copy2(backup, target)
    print(f"  RESTORED Settings: {os.path.basename(target)}")
    print(f"  from: {candidates[0]}")
    return True


def main():
    print("FC26 fix v3 — restore Settings + patch CmPlr only")
    fixed = 0

    print("\n[1] Restore Settings (fix s13w00 corrupt)")
    restore_settings()

    print("\n[2] Patch CmPlr career saves")
    for name in sorted(os.listdir(SETTINGS)):
        if not name.startswith("CmPlr"):
            continue
        if any(x in name for x in ("backup", "attempt", "before_son", "corrupt", "pre_")):
            continue
        path = os.path.join(SETTINGS, name)
        if os.path.isfile(path) and patch_cmplr(path):
            fixed += 1

    print(f"\nDone. CmPlr patched: {fixed}")
    print("Settings는 건드리지 않음 → s13w00 손상 방지")
    print("이름은 CmPlr 세이브에서만 손흥민으로 표시됩니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())