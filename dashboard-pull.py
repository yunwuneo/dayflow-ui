#!/usr/bin/env python3
"""Distilled Dayflow pull for Neo's personal dashboard.

Runs ON the Shanghai server: reads READ_API_TOKEN from .env.production
locally (token never leaves the server), calls the read-only MCP at
127.0.0.1:4310, and prints ONE JSON object with only aggregate fields:
today/yesterday category totals, activity count, longest single block,
device sync status, yesterday's daily-report highlights. No activity
summaries, no screenshots.
Usage: dashboard-pull.py [YYYY-MM-DD]   (default: today, Asia/Shanghai)
"""
import json, sys, urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

env = {}
for line in open("/srv/dayflow-ui/.env.production"):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        env[k] = v
token = env["READ_API_TOKEN"]

def mcp(tool, args, rid):
    body = json.dumps({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                       "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request("http://127.0.0.1:4310/mcp", data=body, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    out = []
    for c in data.get("result", {}).get("content", []):
        if c.get("type") == "text":
            try:
                out.append(json.loads(c["text"]))
            except Exception:
                out.append(None)
    return out[0] if out else None

tz = ZoneInfo("Asia/Shanghai")
today = datetime.now(tz).date()
if len(sys.argv) > 1:
    today = datetime.strptime(sys.argv[1], "%Y-%m-%d").date()
yday = today - timedelta(days=1)

ov = mcp("get_overview", {"date": today.isoformat()}, 1) or {}
totals = [t for t in (ov.get("totals") or []) if t.get("category") != "Idle"]
total_active = sum(t["minutes"] for t in totals)
count = sum(t["count"] for t in totals)
cats = {c["name"]: c.get("color_hex") for c in (ov.get("categories") or [])}
segments = [{"name": t["category"], "minutes": t["minutes"],
             "share": round(t["minutes"] * 100 / total_active) if total_active else 0,
             "color": cats.get(t["category"])}
            for t in sorted(totals, key=lambda x: -x["minutes"])]

acts = mcp("search_activities", {"date": today.isoformat(), "limit": 50, "page": 1}, 2) or {}
items = acts.get("activities") or []
longest = {"title": None, "minutes": 0}
for it in items:
    m = it.get("duration_minutes") or 0
    if m > longest["minutes"]:
        longest = {"title": it.get("title"), "minutes": m}

yov = mcp("get_overview", {"date": yday.isoformat()}, 3) or {}
ytotals = [t for t in (yov.get("totals") or []) if t.get("category") != "Idle"]
ydaily = yov.get("daily") or {}

dev = (ov.get("devices") or [{}])[0]
status = dev.get("status") or {}

def fmt_total(mins):
    h, m = divmod(int(mins), 60)
    return f"{h}小时{m}分" if h else f"{m}分钟"

print(json.dumps({
    "date": today.isoformat(),
    "totalMinutes": total_active,
    "totalText": fmt_total(total_active),
    "count": count,
    "segments": segments,
    "longest": longest,
    "yesterday": {
        "date": yday.isoformat(),
        "totalMinutes": sum(t["minutes"] for t in ytotals),
        "totals": ytotals,
        "highlights": ydaily.get("highlights") or [],
    },
    "lastCaptureAt": status.get("last_capture_at"),
    "failedBatches": status.get("failed_batches"),
    "pendingBatches": status.get("pending_batches"),
}, ensure_ascii=False))
