const express = require('express');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3457;
const DEFAULT_OWNER = process.env.GITHUB_OWNER || '';
const DEFAULT_REPO = process.env.GITHUB_REPO || '';

// Load credentials from local .env
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const match = line.match(/^([A-Z_]+)=(.*)$/);
        if (match && !process.env[match[1]]) {
            process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
        }
    }
}
loadEnv();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API = 'https://api.github.com';

if (!GITHUB_TOKEN) {
    console.error('Missing GITHUB_TOKEN in .env');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// GitHub API helper with retry
// ---------------------------------------------------------------------------

async function githubFetch(urlPath, options = {}, retries = 5) {
    const url = urlPath.startsWith('http') ? urlPath : `${GITHUB_API}${urlPath}`;
    const opts = {
        ...options,
        headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            ...options.headers,
        },
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
        const res = await fetch(url, opts);

        // Retry on rate limit (403) or server errors (5xx)
        if ((res.status === 403 || res.status >= 500) && attempt < retries) {
            const retryAfter = res.headers.get('retry-after');
            const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.min(1000 * Math.pow(2, attempt - 1), 30000);
            console.error(`GitHub API returned ${res.status} on attempt ${attempt}/${retries} for ${opts.method || 'GET'} ${urlPath} — retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            continue;
        }

        return res;
    }
}

// ---------------------------------------------------------------------------
// Resolve owner/repo from request or defaults
// ---------------------------------------------------------------------------

function resolveRepo(req) {
    const owner = req.params.owner || req.query.owner || DEFAULT_OWNER;
    const repo = req.params.repo || req.query.repo || DEFAULT_REPO;
    if (!owner || !repo) {
        return { error: 'owner and repo are required (via URL params, query params, or GITHUB_OWNER/GITHUB_REPO env vars)' };
    }
    return { owner, repo };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
    res.json({ ok: true, github: GITHUB_API, defaultOwner: DEFAULT_OWNER, defaultRepo: DEFAULT_REPO });
});

// ---------------------------------------------------------------------------
// ISSUES
// ---------------------------------------------------------------------------

// POST /repos/:owner/:repo/issues — Create issue
app.post('/repos/:owner/:repo/issues', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { title, body, labels, assignees, milestone } = req.body;
        if (!title) return res.status(400).json({ error: 'title is required' });

        const payload = { title, body, labels, assignees, milestone };
        const ghRes = await githubFetch(`/repos/${owner}/${repo}/issues`, {
            method: 'POST',
            body: JSON.stringify(payload),
        });

        if (ghRes.status !== 201) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: 'Failed to create issue', detail });
        }

        const data = await ghRes.json();
        res.status(201).json({
            number: data.number,
            url: data.html_url,
            title: data.title,
            state: data.state,
            labels: data.labels?.map(l => l.name),
        });
    } catch (err) {
        console.error('POST /issues error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /repos/:owner/:repo/issues — List issues
app.get('/repos/:owner/:repo/issues', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { state = 'open', labels, assignee, sort, direction, per_page = '30', page = '1' } = req.query;
        const params = new URLSearchParams({ state, per_page, page });
        if (labels) params.set('labels', labels);
        if (assignee) params.set('assignee', assignee);
        if (sort) params.set('sort', sort);
        if (direction) params.set('direction', direction);

        const ghRes = await githubFetch(`/repos/${owner}/${repo}/issues?${params}`);
        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: 'Failed to list issues', detail });
        }

        const data = await ghRes.json();
        const issues = data.map(i => ({
            number: i.number,
            url: i.html_url,
            title: i.title,
            state: i.state,
            user: i.user?.login,
            labels: i.labels?.map(l => l.name),
            assignees: i.assignees?.map(a => a.login),
            created_at: i.created_at,
            updated_at: i.updated_at,
            pull_request: !!i.pull_request,
        }));

        res.json({ total: issues.length, issues });
    } catch (err) {
        console.error('GET /issues error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /repos/:owner/:repo/issues/:number — Get issue details
app.get('/repos/:owner/:repo/issues/:number', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { number } = req.params;
        const ghRes = await githubFetch(`/repos/${owner}/${repo}/issues/${number}`);
        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to get issue #${number}`, detail });
        }

        const data = await ghRes.json();
        res.json({
            number: data.number,
            url: data.html_url,
            title: data.title,
            state: data.state,
            body: data.body,
            user: data.user?.login,
            labels: data.labels?.map(l => l.name),
            assignees: data.assignees?.map(a => a.login),
            milestone: data.milestone?.title,
            created_at: data.created_at,
            updated_at: data.updated_at,
            closed_at: data.closed_at,
            comments: data.comments,
        });
    } catch (err) {
        console.error(`GET /issues/${req.params.number} error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// PATCH /repos/:owner/:repo/issues/:number — Update issue
app.patch('/repos/:owner/:repo/issues/:number', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { number } = req.params;
        const { title, body, state, labels, assignees, milestone } = req.body;
        const payload = {};
        if (title !== undefined) payload.title = title;
        if (body !== undefined) payload.body = body;
        if (state !== undefined) payload.state = state;
        if (labels !== undefined) payload.labels = labels;
        if (assignees !== undefined) payload.assignees = assignees;
        if (milestone !== undefined) payload.milestone = milestone;

        const ghRes = await githubFetch(`/repos/${owner}/${repo}/issues/${number}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        });

        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to update issue #${number}`, detail });
        }

        const data = await ghRes.json();
        res.json({
            number: data.number,
            url: data.html_url,
            title: data.title,
            state: data.state,
            labels: data.labels?.map(l => l.name),
        });
    } catch (err) {
        console.error(`PATCH /issues/${req.params.number} error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// ISSUE COMMENTS
// ---------------------------------------------------------------------------

// GET /repos/:owner/:repo/issues/:number/comments — List comments
app.get('/repos/:owner/:repo/issues/:number/comments', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { number } = req.params;
        const { per_page = '30', page = '1' } = req.query;
        const params = new URLSearchParams({ per_page, page });

        const ghRes = await githubFetch(`/repos/${owner}/${repo}/issues/${number}/comments?${params}`);
        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to get comments for #${number}`, detail });
        }

        const data = await ghRes.json();
        const comments = data.map(c => ({
            id: c.id,
            body: c.body,
            user: c.user?.login,
            created_at: c.created_at,
            updated_at: c.updated_at,
        }));

        res.json({ total: comments.length, comments });
    } catch (err) {
        console.error(`GET /issues/${req.params.number}/comments error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// POST /repos/:owner/:repo/issues/:number/comments — Add comment
app.post('/repos/:owner/:repo/issues/:number/comments', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { number } = req.params;
        const { body: commentBody } = req.body;
        if (!commentBody) return res.status(400).json({ error: 'body is required' });

        const ghRes = await githubFetch(`/repos/${owner}/${repo}/issues/${number}/comments`, {
            method: 'POST',
            body: JSON.stringify({ body: commentBody }),
        });

        if (ghRes.status !== 201) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to add comment to #${number}`, detail });
        }

        const data = await ghRes.json();
        res.status(201).json({
            id: data.id,
            body: data.body,
            user: data.user?.login,
            created_at: data.created_at,
        });
    } catch (err) {
        console.error(`POST /issues/${req.params.number}/comments error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// PULL REQUESTS
// ---------------------------------------------------------------------------

// GET /repos/:owner/:repo/pulls — List PRs
app.get('/repos/:owner/:repo/pulls', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { state = 'open', head, base, sort, direction, per_page = '30', page = '1' } = req.query;
        const params = new URLSearchParams({ state, per_page, page });
        if (head) params.set('head', head);
        if (base) params.set('base', base);
        if (sort) params.set('sort', sort);
        if (direction) params.set('direction', direction);

        const ghRes = await githubFetch(`/repos/${owner}/${repo}/pulls?${params}`);
        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: 'Failed to list PRs', detail });
        }

        const data = await ghRes.json();
        const pulls = data.map(p => ({
            number: p.number,
            url: p.html_url,
            title: p.title,
            state: p.state,
            user: p.user?.login,
            head: p.head?.ref,
            base: p.base?.ref,
            draft: p.draft,
            merged: p.merged_at !== null,
            created_at: p.created_at,
            updated_at: p.updated_at,
        }));

        res.json({ total: pulls.length, pulls });
    } catch (err) {
        console.error('GET /pulls error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /repos/:owner/:repo/pulls/:number — Get PR details
app.get('/repos/:owner/:repo/pulls/:number', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { number } = req.params;
        const ghRes = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}`);
        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to get PR #${number}`, detail });
        }

        const data = await ghRes.json();
        res.json({
            number: data.number,
            url: data.html_url,
            title: data.title,
            body: data.body,
            state: data.state,
            user: data.user?.login,
            head: { ref: data.head?.ref, sha: data.head?.sha },
            base: { ref: data.base?.ref },
            draft: data.draft,
            mergeable: data.mergeable,
            merged: data.merged,
            labels: data.labels?.map(l => l.name),
            assignees: data.assignees?.map(a => a.login),
            reviewers: data.requested_reviewers?.map(r => r.login),
            additions: data.additions,
            deletions: data.deletions,
            changed_files: data.changed_files,
            created_at: data.created_at,
            updated_at: data.updated_at,
            merged_at: data.merged_at,
            closed_at: data.closed_at,
        });
    } catch (err) {
        console.error(`GET /pulls/${req.params.number} error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// POST /repos/:owner/:repo/pulls — Create PR
app.post('/repos/:owner/:repo/pulls', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { title, head, base, body, draft } = req.body;
        if (!title || !head || !base) {
            return res.status(400).json({ error: 'title, head, and base are required' });
        }

        const payload = { title, head, base, body, draft };
        const ghRes = await githubFetch(`/repos/${owner}/${repo}/pulls`, {
            method: 'POST',
            body: JSON.stringify(payload),
        });

        if (ghRes.status !== 201) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: 'Failed to create PR', detail });
        }

        const data = await ghRes.json();
        res.status(201).json({
            number: data.number,
            url: data.html_url,
            title: data.title,
            state: data.state,
            head: data.head?.ref,
            base: data.base?.ref,
            draft: data.draft,
        });
    } catch (err) {
        console.error('POST /pulls error:', err);
        res.status(500).json({ error: err.message });
    }
});

// PATCH /repos/:owner/:repo/pulls/:number — Update PR
app.patch('/repos/:owner/:repo/pulls/:number', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { number } = req.params;
        const { title, body, state, base } = req.body;
        const payload = {};
        if (title !== undefined) payload.title = title;
        if (body !== undefined) payload.body = body;
        if (state !== undefined) payload.state = state;
        if (base !== undefined) payload.base = base;

        const ghRes = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        });

        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to update PR #${number}`, detail });
        }

        const data = await ghRes.json();
        res.json({
            number: data.number,
            url: data.html_url,
            title: data.title,
            state: data.state,
        });
    } catch (err) {
        console.error(`PATCH /pulls/${req.params.number} error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /repos/:owner/:repo/pulls/:number/merge — Merge PR
app.put('/repos/:owner/:repo/pulls/:number/merge', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { number } = req.params;
        const { commit_title, commit_message, merge_method = 'merge', sha } = req.body;
        const payload = { merge_method };
        if (commit_title) payload.commit_title = commit_title;
        if (commit_message) payload.commit_message = commit_message;
        if (sha) payload.sha = sha;

        const ghRes = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}/merge`, {
            method: 'PUT',
            body: JSON.stringify(payload),
        });

        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to merge PR #${number}`, detail });
        }

        const data = await ghRes.json();
        res.json({
            merged: data.merged,
            message: data.message,
            sha: data.sha,
        });
    } catch (err) {
        console.error(`PUT /pulls/${req.params.number}/merge error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// GET /repos/:owner/:repo/pulls/:number/files — List PR files
app.get('/repos/:owner/:repo/pulls/:number/files', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { number } = req.params;
        const { per_page = '100', page = '1' } = req.query;
        const params = new URLSearchParams({ per_page, page });

        const ghRes = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}/files?${params}`);
        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to get files for PR #${number}`, detail });
        }

        const data = await ghRes.json();
        const files = data.map(f => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            patch: f.patch,
        }));

        res.json({ total: files.length, files });
    } catch (err) {
        console.error(`GET /pulls/${req.params.number}/files error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// PR REVIEWS
// ---------------------------------------------------------------------------

// GET /repos/:owner/:repo/pulls/:number/reviews — List reviews + inline comments
app.get('/repos/:owner/:repo/pulls/:number/reviews', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { number } = req.params;

        // Fetch reviews and inline comments in parallel
        const [reviewsRes, commentsRes] = await Promise.all([
            githubFetch(`/repos/${owner}/${repo}/pulls/${number}/reviews`),
            githubFetch(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`),
        ]);

        if (!reviewsRes.ok) {
            const detail = await reviewsRes.text();
            return res.status(reviewsRes.status).json({ error: `Failed to get reviews for PR #${number}`, detail });
        }
        if (!commentsRes.ok) {
            const detail = await commentsRes.text();
            return res.status(commentsRes.status).json({ error: `Failed to get review comments for PR #${number}`, detail });
        }

        const [reviewsData, commentsData] = await Promise.all([
            reviewsRes.json(),
            commentsRes.json(),
        ]);

        const reviews = reviewsData.map(r => ({
            id: r.id,
            user: r.user?.login,
            state: r.state,
            body: r.body,
            submitted_at: r.submitted_at,
        }));

        const comments = commentsData.map(c => ({
            id: c.id,
            body: c.body,
            user: c.user?.login,
            path: c.path,
            line: c.line,
            side: c.side,
            start_line: c.start_line,
            in_reply_to_id: c.in_reply_to_id,
            created_at: c.created_at,
            updated_at: c.updated_at,
        }));

        res.json({ reviews, comments });
    } catch (err) {
        console.error(`GET /pulls/${req.params.number}/reviews error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// POST /repos/:owner/:repo/pulls/:number/comments/:comment_id/replies — Reply to an inline review comment
app.post('/repos/:owner/:repo/pulls/:number/comments/:comment_id/replies', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { number, comment_id } = req.params;
        const { body } = req.body;
        if (!body) return res.status(400).json({ error: 'body is required' });

        const ghRes = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}/comments/${comment_id}/replies`, {
            method: 'POST',
            body: JSON.stringify({ body }),
        });

        if (ghRes.status !== 201) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to reply to comment ${comment_id} on PR #${number}`, detail });
        }

        const data = await ghRes.json();
        res.status(201).json({
            id: data.id,
            body: data.body,
            user: data.user?.login,
            path: data.path,
            line: data.line,
            in_reply_to_id: data.in_reply_to_id,
            created_at: data.created_at,
        });
    } catch (err) {
        console.error(`POST /pulls/${req.params.number}/comments/${req.params.comment_id}/replies error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// POST /repos/:owner/:repo/pulls/:number/reviews — Submit review
app.post('/repos/:owner/:repo/pulls/:number/reviews', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { number } = req.params;
        const { body: reviewBody, event, comments } = req.body;

        if (!event) {
            return res.status(400).json({ error: 'event is required (APPROVE, REQUEST_CHANGES, or COMMENT)' });
        }

        const payload = { event };
        if (reviewBody) payload.body = reviewBody;
        if (comments) payload.comments = comments;

        const ghRes = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}/reviews`, {
            method: 'POST',
            body: JSON.stringify(payload),
        });

        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to submit review for PR #${number}`, detail });
        }

        const data = await ghRes.json();
        res.status(201).json({
            id: data.id,
            user: data.user?.login,
            state: data.state,
            body: data.body,
        });
    } catch (err) {
        console.error(`POST /pulls/${req.params.number}/reviews error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// LABELS
// ---------------------------------------------------------------------------

// GET /repos/:owner/:repo/labels — List labels
app.get('/repos/:owner/:repo/labels', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { per_page = '100', page = '1' } = req.query;
        const params = new URLSearchParams({ per_page, page });

        const ghRes = await githubFetch(`/repos/${owner}/${repo}/labels?${params}`);
        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: 'Failed to list labels', detail });
        }

        const data = await ghRes.json();
        const labels = data.map(l => ({
            name: l.name,
            color: l.color,
            description: l.description,
        }));

        res.json({ total: labels.length, labels });
    } catch (err) {
        console.error('GET /labels error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// SEARCH
// ---------------------------------------------------------------------------

// GET /search/issues — Search issues and PRs
app.get('/search/issues', async (req, res) => {
    try {
        const { q, sort, order, per_page = '30', page = '1' } = req.query;
        if (!q) return res.status(400).json({ error: 'q query parameter is required' });

        const params = new URLSearchParams({ q, per_page, page });
        if (sort) params.set('sort', sort);
        if (order) params.set('order', order);

        const ghRes = await githubFetch(`/search/issues?${params}`);
        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: 'Search failed', detail });
        }

        const data = await ghRes.json();
        const items = (data.items || []).map(i => ({
            number: i.number,
            url: i.html_url,
            title: i.title,
            state: i.state,
            user: i.user?.login,
            labels: i.labels?.map(l => l.name),
            pull_request: !!i.pull_request,
            created_at: i.created_at,
            updated_at: i.updated_at,
        }));

        res.json({
            total_count: data.total_count,
            incomplete_results: data.incomplete_results,
            items,
        });
    } catch (err) {
        console.error('GET /search/issues error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// REPO INFO
// ---------------------------------------------------------------------------

// GET /repos/:owner/:repo — Get repo info
app.get('/repos/:owner/:repo', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const ghRes = await githubFetch(`/repos/${owner}/${repo}`);
        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to get repo ${owner}/${repo}`, detail });
        }

        const data = await ghRes.json();
        res.json({
            full_name: data.full_name,
            url: data.html_url,
            description: data.description,
            private: data.private,
            default_branch: data.default_branch,
            language: data.language,
            open_issues_count: data.open_issues_count,
            forks_count: data.forks_count,
            stargazers_count: data.stargazers_count,
            created_at: data.created_at,
            updated_at: data.updated_at,
        });
    } catch (err) {
        console.error(`GET /repos error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// BRANCHES
// ---------------------------------------------------------------------------

// GET /repos/:owner/:repo/branches — List branches
app.get('/repos/:owner/:repo/branches', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { per_page = '30', page = '1' } = req.query;
        const params = new URLSearchParams({ per_page, page });

        const ghRes = await githubFetch(`/repos/${owner}/${repo}/branches?${params}`);
        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: 'Failed to list branches', detail });
        }

        const data = await ghRes.json();
        const branches = data.map(b => ({
            name: b.name,
            sha: b.commit?.sha,
            protected: b.protected,
        }));

        res.json({ total: branches.length, branches });
    } catch (err) {
        console.error('GET /branches error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// COMMIT STATUS / CHECKS
// ---------------------------------------------------------------------------

// GET /repos/:owner/:repo/commits/:ref/status — Get combined status for a ref
app.get('/repos/:owner/:repo/commits/:ref/status', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { ref } = req.params;
        const ghRes = await githubFetch(`/repos/${owner}/${repo}/commits/${ref}/status`);
        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to get status for ${ref}`, detail });
        }

        const data = await ghRes.json();
        res.json({
            state: data.state,
            total_count: data.total_count,
            statuses: (data.statuses || []).map(s => ({
                context: s.context,
                state: s.state,
                description: s.description,
                target_url: s.target_url,
            })),
        });
    } catch (err) {
        console.error(`GET /commits/${req.params.ref}/status error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// GET /repos/:owner/:repo/commits/:ref/check-runs — Get check runs for a ref
app.get('/repos/:owner/:repo/commits/:ref/check-runs', async (req, res) => {
    try {
        const { owner, repo, error } = resolveRepo(req);
        if (error) return res.status(400).json({ error });

        const { ref } = req.params;
        const ghRes = await githubFetch(`/repos/${owner}/${repo}/commits/${ref}/check-runs`);
        if (!ghRes.ok) {
            const detail = await ghRes.text();
            return res.status(ghRes.status).json({ error: `Failed to get check runs for ${ref}`, detail });
        }

        const data = await ghRes.json();
        const check_runs = (data.check_runs || []).map(c => ({
            id: c.id,
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
            started_at: c.started_at,
            completed_at: c.completed_at,
            html_url: c.html_url,
        }));

        res.json({ total_count: data.total_count, check_runs });
    } catch (err) {
        console.error(`GET /commits/${req.params.ref}/check-runs error:`, err);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Start server — bind to localhost only
// ---------------------------------------------------------------------------
app.listen(PORT, '127.0.0.1', () => {
    console.log(`GitHub proxy server running on http://127.0.0.1:${PORT}`);
    console.log(`Default repo: ${DEFAULT_OWNER}/${DEFAULT_REPO || '(not set)'}`);
});
