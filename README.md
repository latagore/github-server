# github-server

GitHub proxy server that lets AI agents interact with GitHub without direct access to credentials.

## Setup

```bash
npm install
npm start  # Starts on http://127.0.0.1:3457
```

Credentials are loaded from `~/.env` (`GITHUB_TOKEN`). Optional defaults: `GITHUB_OWNER`, `GITHUB_REPO`.

## Endpoints

### Repo Info

- `GET /repos/:owner/:repo` — Get repo details
- `GET /repos/:owner/:repo/branches` — List branches
- `GET /repos/:owner/:repo/labels` — List labels

### Issues

- `GET /repos/:owner/:repo/issues` — List issues
- `GET /repos/:owner/:repo/issues/:number` — Get issue details
- `POST /repos/:owner/:repo/issues` — Create issue
- `PATCH /repos/:owner/:repo/issues/:number` — Update issue

### Issue Comments

- `GET /repos/:owner/:repo/issues/:number/comments` — List comments
- `POST /repos/:owner/:repo/issues/:number/comments` — Add comment

### Pull Requests

- `GET /repos/:owner/:repo/pulls` — List PRs
- `GET /repos/:owner/:repo/pulls/:number` — Get PR details
- `POST /repos/:owner/:repo/pulls` — Create PR
- `PATCH /repos/:owner/:repo/pulls/:number` — Update PR
- `GET /repos/:owner/:repo/pulls/:number/files` — List PR changed files

### PR Reviews

- `GET /repos/:owner/:repo/pulls/:number/reviews` — List reviews
- `POST /repos/:owner/:repo/pulls/:number/reviews` — Submit review

### CI Status

- `GET /repos/:owner/:repo/commits/:ref/status` — Combined commit status
- `GET /repos/:owner/:repo/commits/:ref/check-runs` — Check runs for a ref

### Search

- `GET /search/issues?q=...` — Search issues and PRs

### Health

- `GET /health` — Health check

## Examples

```bash
# Get repo info
curl http://127.0.0.1:3457/repos/octocat/hello-world

# List open issues
curl http://127.0.0.1:3457/repos/octocat/hello-world/issues

# Create issue
curl -X POST http://127.0.0.1:3457/repos/octocat/hello-world/issues \
  -H 'Content-Type: application/json' \
  -d '{"title":"Fix login bug","body":"Login fails on Safari","labels":["bug"]}'

# Update issue
curl -X PATCH http://127.0.0.1:3457/repos/octocat/hello-world/issues/42 \
  -H 'Content-Type: application/json' \
  -d '{"state":"closed"}'

# Add comment
curl -X POST http://127.0.0.1:3457/repos/octocat/hello-world/issues/42/comments \
  -H 'Content-Type: application/json' \
  -d '{"body":"Fixed in latest commit"}'

# List PRs
curl http://127.0.0.1:3457/repos/octocat/hello-world/pulls

# Create PR
curl -X POST http://127.0.0.1:3457/repos/octocat/hello-world/pulls \
  -H 'Content-Type: application/json' \
  -d '{"title":"Add feature X","head":"feature-x","base":"main","body":"Implements feature X"}'

# Get PR files
curl http://127.0.0.1:3457/repos/octocat/hello-world/pulls/99/files

# Submit review
curl -X POST http://127.0.0.1:3457/repos/octocat/hello-world/pulls/99/reviews \
  -H 'Content-Type: application/json' \
  -d '{"event":"APPROVE","body":"Looks good!"}'

# Check CI status
curl http://127.0.0.1:3457/repos/octocat/hello-world/commits/abc123/check-runs

# Search
curl 'http://127.0.0.1:3457/search/issues?q=repo:octocat/hello-world+is:open+label:bug'
```

## Create Issue Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Issue title |
| `body` | string | no | Issue body (Markdown) |
| `labels` | string[] | no | Label names |
| `assignees` | string[] | no | GitHub usernames |
| `milestone` | number | no | Milestone number |

## Create PR Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | PR title |
| `head` | string | yes | Branch containing changes |
| `base` | string | yes | Branch to merge into |
| `body` | string | no | PR description (Markdown) |
| `draft` | boolean | no | Create as draft PR |

## Submit Review Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event` | string | yes | `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` |
| `body` | string | no | Review comment |
| `comments` | object[] | no | Inline review comments |

## What's NOT Exposed

These are intentionally excluded as they're admin-level, not contributor-level:

- Deleting repos, branches, or releases
- Managing repo settings, permissions, or webhooks
- Managing teams or org membership
- Force-pushing or direct ref manipulation
- Managing deploy keys or secrets

## Retry Logic

GitHub API calls retry up to 5 times with exponential backoff (1s to 30s) on rate-limit (403) and server error (5xx) responses. Respects `Retry-After` headers.
