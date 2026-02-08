import {
  listStartableTasks,
  listProjects,
  listProjectRepos,
  type Database,
  type StartableTask,
} from '@conductor/shared';

export interface StartWorkData {
  tasks: StartableTask[];
  projects: { id: string; name: string }[];
  repos: { id: string; fullName: string; projectId: string }[];
  labels: string[];
  hasStaleRepos: boolean;
}

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

export function fetchStartWorkData(
  db: Database,
  userId: string,
  projectId?: string,
  repoId?: string,
): StartWorkData {
  const tasks = listStartableTasks(db, userId, { projectId, repoId });

  // Derive unique projects and repos from tasks
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

  // Check staleness across user's repos
  const now = Date.now();
  let hasStaleRepos = false;
  const userProjects = listProjects(db, { userId });

  for (const project of userProjects) {
    if (projectId !== undefined && project.projectId !== projectId) continue;
    const repos = listProjectRepos(db, project.projectId, { status: 'active' });
    for (const repo of repos) {
      if (repo.lastFetchedAt === undefined) {
        hasStaleRepos = true;
        break;
      }
      const fetchedAt = new Date(repo.lastFetchedAt).getTime();
      if (now - fetchedAt > STALE_THRESHOLD_MS) {
        hasStaleRepos = true;
        break;
      }
    }
    if (hasStaleRepos) break;
  }

  return {
    tasks,
    projects: Array.from(projectMap.entries()).map(([id, name]) => ({ id, name })),
    repos: Array.from(repoMap.entries()).map(([id, { fullName, projectId: pid }]) => ({
      id,
      fullName,
      projectId: pid,
    })),
    labels: Array.from(labelSet).sort(),
    hasStaleRepos,
  };
}
