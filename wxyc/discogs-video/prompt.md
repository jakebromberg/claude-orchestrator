# Discogs Video ETL — Issue #{{ISSUE_NUMBER}}: {{SLUG}}

## Task

{{DESCRIPTION}}

## Upstream Context

{{UPSTREAM_CONTEXT}}

## Implementation Requirements

- Follow TDD: write failing tests first, then implement, then refactor
- Follow existing code patterns exactly (check CLAUDE.md in the repo)
- Write unit tests, integration tests, and E2E tests where applicable
- Use WXYC example data for test fixtures (see CLAUDE.md for canonical examples)
- Do not break existing tests

## Discogs XML Video Structure

The Discogs XML data dump contains videos on releases:

```xml
<videos>
  <video src="https://www.youtube.com/watch?v=afMHNll9EVM" duration="325" embed="true">
    <title>The Persuader - Gamla Stan</title>
    <description>https://www.discogs.com/The-Persuader-Stockholm/release/1</description>
  </video>
  <video src="https://www.youtube.com/watch?v=XExCZfMCXdo" duration="175" embed="true">
    <title>The Persuader - Kungsholmen</title>
    <description></description>
  </video>
</videos>
```

Video attributes: `src` (URL, required), `duration` (seconds), `embed` (boolean).
Video child elements: `<title>` (text), `<description>` (text).
Videos may be self-closing: `<video src="..." duration="100" embed="true" />`

## CSV Format (agreed across all issues)

`release_video.csv` columns: `release_id, sequence, src, title, duration, embed`

## Database Schema (agreed across all issues)

```sql
CREATE TABLE release_video (
    release_id integer NOT NULL REFERENCES release(id) ON DELETE CASCADE,
    sequence   integer NOT NULL,
    src        text NOT NULL,
    title      text,
    duration   integer,
    embed      boolean DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_release_video_release_id ON release_video(release_id);
```

## HANDOFF.md

When you complete your work, write a HANDOFF.md file in the worktree root summarizing:
1. What you changed
2. The CSV column format (if Issue #1)
3. The database schema (if Issue #2)
4. Any caveats or decisions the next issue should know about
