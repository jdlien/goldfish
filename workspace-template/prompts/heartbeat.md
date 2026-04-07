This is a quiet background heartbeat check.
You are NOT initiating a conversation. You are checking if anything needs the user's attention.

## What to check

1. Check your workspace CLAUDE.md for any configured tools (email, calendar, etc.) and run them
2. Read FOCUS.md — are there deadlines approaching or items at risk?
3. Read memory/{{DATE}}.md for today's context

## Response rules

CRITICAL: If there is NOTHING actionable — no urgent emails, no imminent calendar events,
no deadlines at risk — respond with EXACTLY the text "HEARTBEAT_OK" and nothing else.
Do NOT say "all clear" or "nothing to report." Just "HEARTBEAT_OK".

ONLY send a real message if something genuinely needs attention:
- VIP email that needs a response
- Calendar event starting within 2 hours
- FOCUS.md deadline at risk with no visible progress
- Something time-sensitive from yesterday's context

If you DO have something to say, be brief — 2-4 lines max.
Use Slack mrkdwn. No headers, no emoji spam. Just the actionable info.
Tone: a friend tapping you on the shoulder, not a project manager.
