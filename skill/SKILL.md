---
name: dashboard
description: Push rich content to the Agent Dashboard. Use when output exceeds chat platform limits or when content is better viewed in a browser (reports, tables, HTML, markdown).
user-invocable: true
---

# Dashboard Skill

## Trigger

Keywords: "push to dashboard", "send to dashboard", "post report", or when content exceeds chat platform character limits.

## Usage

Push content via the included helper script:

```bash
# HTML content
bash skill/scripts/push.sh --slug my-report --title "Daily Report" --body "<h1>Hello</h1>"

# Markdown file
bash skill/scripts/push.sh --slug my-report --title "Daily Report" --file report.md

# Pipe from stdin
echo "<h1>Hello</h1>" | bash skill/scripts/push.sh --slug my-report --title "Daily Report"
```

### Options

| Flag | Description |
|------|-------------|
| `--slug` | URL slug (required) |
| `--title` | Page title (required) |
| `--body` | Inline HTML/markdown content |
| `--file` | Read content from file (auto-detects .md as markdown) |
| `--format` | `html` or `markdown` (default: html) |
| `--agent` | Agent name tag |
| `--category` | Category tag |
| `--tags` | Comma-separated tags |
| `--ttl` | Seconds until auto-delete |
| `--pinned` | Pin to top of index |

### Configuration

Set these environment variables or edit the script defaults:

| Variable | Description |
|----------|-------------|
| `DASHBOARD_URL` | Dashboard base URL (default: `http://localhost:5858`) |
| `DASHBOARD_TOKEN` | Bearer token for API auth |

## Examples

- Agent generates a long portfolio report → push to dashboard, send link to chat
- Nightly skills inventory scan → push HTML page, pin it
- Debugging output too long for Telegram → push with 1h TTL
