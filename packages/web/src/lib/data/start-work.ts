import {
  listStartableTasks,
  listProjects,
  listProjectRepos,
  getProject,
  upsertTaskFromIssue,
  createGitHubClient,
  createLogger,
  type Database,
  type StartableTask,
  type Repo,
} from '@conductor/shared';
import { ensureGitHubApp } from '@/lib/github-init';

const log = createLogger({ name: 'conductor:data:start-work' });

/** Auto-sync TTL: repos staler than this are refreshed from GitHub */
const SYNC_TTL_MS = 2 * 60 * 1000; // 2 minutes

/** Max repos to sync concurrently */
const CONCURRENCY = 3;

export interface StartWorkData {
  tasks: StartableTask[];
  projects: { id: string; name: string }[];
  repos: { id: string; fullName: string; projectId: string }[];
  labels: string[];
  lastSyncedAt?: string;
  syncErrors?: string[];
  githubNotConfigured: boolean;
  truncatedRepos?: string[];
}

interface RepoToSync {
  repo: Repo;
  installationId: number;
}

function isStale(repo: Repo): boolean {
  if (repo.lastFetchedAt === undefined) return true;
  return Date.now() - new Date(repo.lastFetchedAt).getTime() > SYNC_TTL_MS;
}

async function syncOneRepo(
  db: Database,
  repo: Repo,
  installationId: number,
): Promise<{ repoId: string; truncated: boolean }> {
  const client = createGitHubClient(installationId);
  const issues = await client.listIssues(repo.githubOwner, repo.githubName, {
    state: 'all',
    since: repo.lastFetchedAt,
  });

  for (const issue of issues) {
    upsertTaskFromIssue(db, {
      projectId: repo.projectId,
      repoId: repo.repoId,
      githubNodeId: issue.nodeId,
      githubIssueNumber: issue.number,
      githubType: 'issue',
      githubTitle: issue.title,
      githubBody: issue.body ?? '',
      githubState: issue.state,
      githubLabelsJson: JSON.stringify(issue.labels.map((l) => l.name)),
    });
  }

  // Update last_fetched_at only on success
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE repos SET last_fetched_at = ?, updated_at = ? WHERE repo_id = ?',
  ).run(now, now, repo.repoId);

  // 500 is the max (5 pages * 100 per page) — if we hit it, data may be truncated
  const truncated = issues.length >= 500;

  return { repoId: repo.repoId, truncated };
}

async function autoSyncRepos(
  db: Database,
  staleRepos: RepoToSync[],
): Promise<{
  syncErrors: string[];
  truncatedRepos: string[];
}> {
  const syncErrors: string[] = [];
  const truncatedRepos: string[] = [];

  for (let i = 0; i < staleRepos.length; i += CONCURRENCY) {
    const batch = staleRepos.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(({ repo, installationId }) =>
        syncOneRepo(db, repo, installationId),
      ),
    );

    results.forEach((result, j) => {
      const entry = batch[j];
      if (!entry) return;
      const { repo } = entry;
      if (result.status === 'fulfilled') {
        if (result.value.truncated) {
          truncatedRepos.push(repo.githubFullName);
        }
      } else {
        const errMsg =
          result.reason instanceof Error
            ? result.reason.message
            : 'Unknown error';
        log.error(
          { repoId: repo.repoId, error: errMsg },
          'Failed to auto-sync repo',
        );
        syncErrors.push(`${repo.githubFullName}: ${errMsg}`);
      }
    });
  }

  return { syncErrors, truncatedRepos };
}

function deriveFilters(tasks: StartableTask[]) {
  const projectMap = new Map<string, string>();
  const repoMap = new Map<string, { fullName: string; projectId: string }>();
  const labelSet = new Set<string>();

  for (const task of tasks) {
    projectMap.set(task.projectId, task.projectName);
    repoMap.set(task.repoId, {
      fullName: task.repoFullName,
      projectId: task.projectId,
    });
    try {
      const labels = JSON.parse(task.githubLabelsJson) as string[];
      for (const label of labels) {
        labelSet.add(label);
      }
    } catch {
      // ignore malformed JSON
    }
  }

  return {
    projects: Array.from(projectMap.entries()).map(([id, name]) => ({
      id,
      name,
    })),
    repos: Array.from(repoMap.entries()).map(([id, { fullName, projectId }]) => ({
      id,
      fullName,
      projectId,
    })),
    labels: Array.from(labelSet).sort(),
  };
}

function getMaxLastFetchedAt(
  db: Database,
  userId: string,
  projectId?: string,
): string | undefined {
  const projectSummaries = listProjects(db, { userId });
  let maxDate: Date | undefined;

  for (const summary of projectSummaries) {
    if (projectId !== undefined && summary.projectId !== projectId) continue;
    const repos = listProjectRepos(db, summary.projectId, { status: 'active' });
    for (const repo of repos) {
      if (repo.lastFetchedAt !== undefined) {
        const d = new Date(repo.lastFetchedAt);
        if (maxDate === undefined || d > maxDate) {
          maxDate = d;
        }
      }
    }
  }

  return maxDate?.toISOString();
}

export async function fetchStartWorkData(
  db: Database,
  userId: string,
  projectId?: string,
  repoId?: string,
): Promise<StartWorkData> {
  // 1. Determine GitHub App availability
  const githubConfigured = ensureGitHubApp();

  // 2. Gather stale repos for auto-sync
  let syncErrors: string[] = [];
  let truncatedRepos: string[] = [];

  if (githubConfigured) {
    const projectSummaries = listProjects(db, { userId });
    const staleRepos: RepoToSync[] = [];

    for (const summary of projectSummaries) {
      if (projectId !== undefined && summary.projectId !== projectId) continue;
      const project = getProject(db, summary.projectId);
      if (project === null) continue;

      const repos = listProjectRepos(db, project.projectId, {
        status: 'active',
      });
      for (const repo of repos) {
        if (repoId !== undefined && repo.repoId !== repoId) continue;
        if (isStale(repo)) {
          staleRepos.push({
            repo,
            installationId: project.githubInstallationId,
          });
        }
      }
    }

    if (staleRepos.length > 0) {
      const result = await autoSyncRepos(db, staleRepos);
      syncErrors = result.syncErrors;
      truncatedRepos = result.truncatedRepos;
    }
  }

  // 3. Query tasks from DB (always, post-sync)
  const tasks = listStartableTasks(db, userId, { projectId, repoId });

  // 4. Derive filter options
  const { projects, repos, labels } = deriveFilters(tasks);

  // 5. Get freshness indicator
  const lastSyncedAt = getMaxLastFetchedAt(db, userId, projectId);

  return {
    tasks,
    projects,
    repos,
    labels,
    lastSyncedAt,
    syncErrors: syncErrors.length > 0 ? syncErrors : undefined,
    githubNotConfigured: !githubConfigured,
    truncatedRepos: truncatedRepos.length > 0 ? truncatedRepos : undefined,
  };
}

/**
 * Auto-sync and fetch backlog for a single project.
 * Used by the project detail BacklogTab.
 */
export async function syncAndFetchBacklog(
  db: Database,
  project: { projectId: string; githubInstallationId: number },
  userId: string,
): Promise<{
  tasks: StartableTask[];
  lastSyncedAt?: string;
  syncErrors?: string[];
  githubNotConfigured: boolean;
  truncatedRepos?: string[];
}> {
  const githubConfigured = ensureGitHubApp();

  let syncErrors: string[] = [];
  let truncatedRepos: string[] = [];

  if (githubConfigured) {
    const repos = listProjectRepos(db, project.projectId, { status: 'active' });
    const staleRepos: RepoToSync[] = [];

    for (const repo of repos) {
      if (isStale(repo)) {
        staleRepos.push({
          repo,
          installationId: project.githubInstallationId,
        });
      }
    }

    if (staleRepos.length > 0) {
      const result = await autoSyncRepos(db, staleRepos);
      syncErrors = result.syncErrors;
      truncatedRepos = result.truncatedRepos;
    }
  }

  const tasks = listStartableTasks(db, userId, {
    projectId: project.projectId,
  });

  const lastSyncedAt = getMaxLastFetchedAt(db, userId, project.projectId);

  return {
    tasks,
    lastSyncedAt,
    syncErrors: syncErrors.length > 0 ? syncErrors : undefined,
    githubNotConfigured: !githubConfigured,
    truncatedRepos: truncatedRepos.length > 0 ? truncatedRepos : undefined,
  };
}
