#!/usr/bin/env python3
"""Send push notifications for tasks that have come due.

Run by .github/workflows/reminders.yml every few minutes. GitHub Pages can't run anything on a
schedule, and Cloud Functions need billing, so a GitHub Actions cron does it instead.

For every user with a registered device (users/{uid}/devices/{id} = {token, timeZone}), each open
task whose due time has passed (within the last MAX_LATE) and hasn't been reminded about yet gets
one notification per device, sent through the FCM HTTP v1 API. The task then gets
remindedDue = due, so it isn't sent again; changing the due date re-arms it.

Standard library only. Needs ACCESS_TOKEN (OAuth token with the cloud-platform scope, for the
reminders@ service account in CI; `gcloud auth print-access-token` works locally too).
DRY_RUN=1 lists what would be sent without sending or marking anything.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

PROJECT = "notes-e2b6c3"
DB = f"projects/{PROJECT}/databases/(default)/documents"
FIRESTORE = f"https://firestore.googleapis.com/v1/{DB}"
FCM = f"https://fcm.googleapis.com/v1/projects/{PROJECT}/messages:send"
# Tasks overdue by more than this are skipped (e.g. when reminders are first turned on, or the
# cron stopped for a while), so nobody gets a pile of stale notifications at once.
MAX_LATE = timedelta(hours=12)
# GitHub's cron usually starts late, so send a little early rather than always late.
EARLY = timedelta(minutes=2)
# A push the phone can't receive within this long (offline) is dropped.
TTL_SECONDS = 6 * 3600

TOKEN = os.environ["ACCESS_TOKEN"]
DRY_RUN = os.environ.get("DRY_RUN") == "1"


def call(method, url, body=None):
    headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    if os.environ.get("QUOTA_PROJECT"):  # needed when using a personal gcloud login
        headers["x-goog-user-project"] = os.environ["QUOTA_PROJECT"]
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read() or b"{}")
        except json.JSONDecodeError:
            return err.code, {}


def value(field):
    """Firestore REST value -> Python."""
    if field is None:
        return None
    for kind in ("stringValue", "booleanValue", "timestampValue"):
        if kind in field:
            v = field[kind]
            return datetime.fromisoformat(v.replace("Z", "+00:00")) if kind == "timestampValue" else v
    return None  # nullValue or a type we don't use here


def run_query(parent, query):
    status, rows = call("POST", f"https://firestore.googleapis.com/v1/{parent}:runQuery", {"structuredQuery": query})
    if status != 200:
        sys.exit(f"query failed ({status}): {rows}")
    return [r["document"] for r in rows if "document" in r]


def devices_by_user():
    docs = run_query(DB, {"from": [{"collectionId": "devices", "allDescendants": True}]})
    users = {}
    for d in docs:
        # name = projects/.../documents/users/{uid}/devices/{id}
        user_path = d["name"].split("/devices/")[0]
        f = d.get("fields", {})
        token = value(f.get("token"))
        if token:
            users.setdefault(user_path, []).append({"name": d["name"], "token": token, "tz": value(f.get("timeZone"))})
    return users


def due_tasks(user_path, now):
    docs = run_query(user_path, {
        "from": [{"collectionId": "notes"}],
        "where": {"fieldFilter": {"field": {"fieldPath": "type"}, "op": "EQUAL", "value": {"stringValue": "task"}}},
        "select": {"fields": [{"fieldPath": p} for p in ("text", "due", "done", "remindedDue")]},
    })
    tasks = []
    for d in docs:
        f = d.get("fields", {})
        due = value(f.get("due"))
        if not due or value(f.get("done")):
            continue
        if not (now - MAX_LATE < due <= now + EARLY):
            continue
        if value(f.get("remindedDue")) == due:
            continue
        tasks.append({"name": d["name"], "id": d["name"].rsplit("/", 1)[1], "text": value(f.get("text")) or "Task", "due": due,
                      "dueRaw": f["due"]["timestampValue"]})
    return tasks


def describe(task, tz_name, now):
    try:
        tz = ZoneInfo(tz_name) if tz_name else timezone.utc
    except Exception:
        tz = timezone.utc
    local = task["due"].astimezone(tz)
    when = local.strftime("%-I:%M %p").lower()
    if local.date() != now.astimezone(tz).date():
        when = local.strftime("%a %-d %b, ") + when
    late = now - task["due"]
    body = f"Due {when}"
    if late > timedelta(minutes=15):
        hours, mins = divmod(int(late.total_seconds() // 60), 60)
        body += f" ({f'{hours} h ' if hours else ''}{mins} min ago)"
    title = task["text"].strip().splitlines()[0][:120]
    return title, body


def send(device, task, now):
    title, body = describe(task, device["tz"], now)
    message = {
        "token": device["token"],
        # Data only: the page's service worker (sw.js) shows it, so it looks the same whether or
        # not the app is open. FCM data values must be strings.
        "data": {"title": title, "body": body, "tag": task["id"], "url": "./#tasks"},
        "webpush": {"headers": {"Urgency": "high", "TTL": str(TTL_SECONDS)}},
    }
    if DRY_RUN:
        print(f"  would send to {device['name'].rsplit('/', 1)[1]}: {title} — {body}")
        return "ok"
    status, resp = call("POST", FCM, {"message": message})
    if status == 200:
        return "ok"
    err = resp.get("error", {})
    codes = {d.get("errorCode") for d in err.get("details", []) if isinstance(d, dict)}
    # The browser unsubscribed, or the token is malformed: forget the device.
    if status == 404 or "UNREGISTERED" in codes or (status == 400 and "INVALID_ARGUMENT" in codes):
        return "gone"
    print(f"  FCM error {status}: {err.get('message')}", file=sys.stderr)
    return "error"


def main():
    now = datetime.now(timezone.utc)
    users = devices_by_user()
    print(f"{len(users)} user(s) with reminders on, {sum(map(len, users.values()))} device(s)")
    failed = False
    for user_path, devices in users.items():
        tasks = due_tasks(user_path, now)
        print(f"{user_path.rsplit('/', 1)[1]}: {len(tasks)} task(s) to remind")
        gone = set()
        for task in tasks:
            results = []
            for device in devices:
                if device["name"] in gone:
                    continue
                result = send(device, task, now)
                results.append(result)
                if result == "gone":
                    gone.add(device["name"])
            if "error" in results:
                failed = True  # try again next run
                continue
            if not DRY_RUN:
                status, resp = call("PATCH", f"https://firestore.googleapis.com/v1/{task['name']}"
                                    "?updateMask.fieldPaths=remindedDue&currentDocument.exists=true",
                                    {"fields": {"remindedDue": {"timestampValue": task["dueRaw"]}}})
                if status != 200:
                    print(f"  couldn't mark {task['id']} reminded ({status}): {resp}", file=sys.stderr)
                    failed = True
        for name in gone:
            print(f"  removing unsubscribed device {name.rsplit('/', 1)[1]}")
            if not DRY_RUN:
                call("DELETE", f"https://firestore.googleapis.com/v1/{name}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
