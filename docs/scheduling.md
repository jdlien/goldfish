# Scheduling

Goldfish can run tasks on a schedule — proactive Slack messages, nightly maintenance, whatever you need. Everything is defined in one `schedule.yaml` file and driven by a single cron entry.

## How it Works

```
cron (every minute) → goldfish schedule run → reads schedule.yaml → fires matching tasks
```

Each minute, Goldfish loads `schedule.yaml`, checks which tasks are due, and runs them. Lock files prevent overlapping runs of the same task.

## Setup

### 1. Create `schedule.yaml`

Copy the example and edit it:

```bash
cp schedule.example.yaml schedule.yaml
```

### 2. Add one cron entry

```bash
crontab -e
```

```
* * * * * cd /path/to/goldfish && node dist/index.js schedule run >> /tmp/goldfish-schedule.log 2>&1
```

That's it. One cron entry runs everything.

## Task Types

### Initiate Tasks (Post to Slack)

These spawn a Claude session and post the result to a Slack channel.

| Type          | What it does                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------- |
| `morning`     | Morning briefing — reads FOCUS.md, checks email/calendar, suggests priorities                |
| `weekly`      | Weekly review — bigger-picture look at progress and upcoming work                            |
| `heartbeat`   | Silent urgency check — only posts if something needs attention (email, calendar, deadlines). |
| `exploration` | Agent picks a topic and writes a long-form deep dive (800-2000 words)                        |

### Maintenance Tasks (No Slack Posts)

These run system operations. No channel needed.

| Type              | What it does                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `daily-synthesis` | Consolidates the day's session transcripts into a narrative daily log (`memory/YYYY-MM-DD.md`) |
| `index-memory`    | Rebuilds the FTS5 full-text search index (`memory/search.sqlite`)                              |

## Configuration Reference

### Minimal Example

If `GOLDFISH_DM_CHANNEL_ID` is set in your `.env`, tasks don't need an explicit channel:

```yaml
tasks:
  - type: morning
    at: "8:30am"

  - type: heartbeat
    every: hour
    between: "10am-5pm"
    days: weekdays

  - type: daily-synthesis
    at: "1:00am"

  - type: index-memory
    at: "1:15am"
```

### Full Example

```yaml
tasks:
  - name: morning-general # name defaults to type if omitted
    type: morning
    at: "8:30am"
    channel: C0ABC123DEF # required for initiate tasks (unless GOLDFISH_DM_CHANNEL_ID is set)

  - name: morning-ops # use name to distinguish multiple tasks of the same type
    type: morning
    at: "9:00am"
    channel: C0DEF456GHI
    context: "Focus on ops issues today" # extra context passed to the Claude prompt

  - type: heartbeat
    every: 2 hours
    between: "9am-6pm"
    days: mon,wed,fri
    channel: C0ABC123DEF

  - type: exploration
    at: "6pm"
    channel: C0XYZ789JKL
    enabled: false # disable without deleting

  - type: weekly
    at: "9am"
    days: sunday
    channel: C0ABC123DEF

  - type: daily-synthesis
    at: "1:00am"
    model: claude-opus-4-6 # model override (default: claude-sonnet-4-6)

  - type: index-memory
    at: "1:15am"
```

### Field Reference

#### Required Fields

| Field    | Description                                     |
| -------- | ----------------------------------------------- |
| `type`   | Task type — see [Task types](#task-types) above |
| (timing) | At least one of `at`, `every`, or `cron`        |

#### Timing Fields

| Field     | Examples                                                 | Description                           |
| --------- | -------------------------------------------------------- | ------------------------------------- |
| `at`      | `"8:30"`, `"8:30am"`, `"6pm"`, `"18:00"`                 | Run once a day at this time           |
| `every`   | `"hour"`, `"2 hours"`, `"4 hours"`                       | Repeating interval                    |
| `between` | `"10am-5pm"`, `"10:00-17:00"`                            | Constrains `every` to a time window   |
| `days`    | `daily`, `weekdays`, `weekends`, `monday`, `mon,wed,fri` | Which days to run (default: `daily`)  |
| `cron`    | `"0 10-17 * * 1-5"`                                      | Raw cron expression (overides others) |

Time formats: both 12-hour (`8:30am`, `6pm`) and 24-hour (`18:00`) are accepted, case-insensitive.

Day formats: full names (`monday`), abbreviations (`mon`), keywords (`weekdays`, `weekends`, `daily`), or comma-separated lists (`mon,wed,fri`).

#### Optional Fields

| Field     | Default                          | Description                                                                                                                  |
| --------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `name`    | Same as `type`                   | Task identifier — used for lock files and log output. Only needed when you have multiple tasks of the same type.             |
| `channel` | `GOLDFISH_DM_CHANNEL_ID` env var | Slack channel ID to post to. Required for initiate tasks unless the env var is set. Ignored for maintenance tasks.           |
| `model`   | (varies by task)                 | Claude model override. Daily synthesis defaults to `claude-sonnet-4-6`. Initiate tasks use whatever Claude Code defaults to. |
| `context` | (none)                           | Extra text appended to the task prompt. Useful for steering a briefing toward specific topics.                               |
| `enabled` | `true`                           | Set to `false` to disable a task without removing it from the file.                                                          |

## Commands

```bash
goldfish schedule list               # Show all tasks with their cron expressions
goldfish schedule run                # Run any tasks due right now
goldfish schedule run --dry-run      # Preview what would run without executing
goldfish schedule run --config <path>  # Use an alternate schedule file
```

To trigger a task type manually (outside the schedule):

```bash
goldfish initiate -t morning                        # Morning briefing
goldfish initiate -t heartbeat                      # Silent urgency check
goldfish initiate -t exploration                    # Deep dive
goldfish initiate --reminder "Call back about X"    # One-off reminder
```

## How Locking Works

Each running task creates a lock file in `.schedule-locks/`. If the scheduler fires again while a task is still running, that task is skipped. Lock files are considered stale after 20 minutes and are automatically cleaned up.

The daily synthesis task has a 15-minute execution timeout. The stale lock timeout intentionally exceeds this so a slow-but-running task won't get duplicated.

## Timezone

All times are in the **system timezone** of the machine running the cron entry. There's no timezone field in `schedule.yaml` — if you need UTC, set your system timezone or use raw `cron` expressions.

## Input Limits

Daily synthesis truncates session logs larger than 200KB (roughly 50-60K tokens) to avoid prompt size and timeout issues. It keeps the most recent content. This is configurable via the `GOLDFISH_SYNTHESIS_MAX_KB` environment variable.
