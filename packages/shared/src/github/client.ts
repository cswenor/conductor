/**
 * GitHub API Client
 *
 * High-level wrapper around Octokit for common GitHub operations.
 * Includes rate limiting, error handling, and typed responses.
 */

import { getInstallationOctokit, getRateLimitStatus, type Octokit } from './index';
import { createLogger } from '../logger/index';

const log = createLogger({ name: 'conductor:github-client' });

// =============================================================================
// Types
// =============================================================================

export interface GitHubRepository {
  nodeId: string;
  id: number;
  name: string;
  fullName: string;
  owner: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
}

export interface GitHubIssue {
  nodeId: string;
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  htmlUrl: string;
  user: {
    id: number;
    login: string;
  };
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPullRequest {
  nodeId: string;
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  htmlUrl: string;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
  };
  user: {
    id: number;
    login: string;
  };
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
}

export interface GitHubComment {
  nodeId: string;
  id: number;
  body: string;
  htmlUrl: string;
  user: {
    id: number;
    login: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CreateCommentInput {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}

export interface CreatePullRequestInput {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface CreateBranchInput {
  owner: string;
  repo: string;
  branchName: string;
  fromSha: string;
}

// =============================================================================
// GitHub Client Class
// =============================================================================

/**
 * GitHub API client for a specific installation
 */
export class GitHubClient {
  private installationId: number;
  private octokit: Octokit | null = null;

  constructor(installationId: number) {
    this.installationId = installationId;
  }

  /**
   * Get the Octokit instance (lazy initialization)
   */
  private async getOctokit(): Promise<Octokit> {
    this.octokit ??= await getInstallationOctokit(this.installationId);
    return this.octokit;
  }

  /**
   * Check rate limit status
   */
  async checkRateLimit(): Promise<{
    remaining: number;
    limit: number;
    resetAt: Date;
  }> {
    const status = await getRateLimitStatus(this.installationId);
    return {
      remaining: status.remaining,
      limit: status.limit,
      resetAt: status.reset,
    };
  }

  // ===========================================================================
  // Repository Operations
  // ===========================================================================

  /**
   * Get repository information
   */
  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    const octokit = await this.getOctokit();
    const { data } = await octokit.request('GET /repos/{owner}/{repo}', {
      owner,
      repo,
    });

    return {
      nodeId: data.node_id,
      id: data.id,
      name: data.name,
      fullName: data.full_name,
      owner: data.owner.login,
      defaultBranch: data.default_branch,
      private: data.private,
      htmlUrl: data.html_url,
      cloneUrl: data.clone_url,
    };
  }

  /**
   * Get the default branch SHA
   */
  async getDefaultBranchSha(owner: string, repo: string): Promise<string> {
    const repository = await this.getRepository(owner, repo);
    const octokit = await this.getOctokit();

    const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
      owner,
      repo,
      ref: `heads/${repository.defaultBranch}`,
    });

    return data.object.sha;
  }

  // ===========================================================================
  // Issue Operations
  // ===========================================================================

  /**
   * List issues for a repository (excludes PRs).
   * Supports incremental fetching via `since` and pagination (up to 5 pages).
   */
  async listIssues(
    owner: string,
    repo: string,
    options?: {
      state?: 'open' | 'closed' | 'all';
      perPage?: number;
      since?: string;
    }
  ): Promise<GitHubIssue[]> {
    const octokit = await this.getOctokit();
    const perPage = options?.perPage ?? 100;
    const state = options?.state ?? 'open';
    const maxPages = 5;
    const allIssues: GitHubIssue[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const params: Record<string, unknown> = {
        owner,
        repo,
        state,
        per_page: perPage,
        page,
        sort: 'updated',
        direction: 'desc',
      };
      if (options?.since !== undefined && options.since !== null) {
        params['since'] = options.since;
      }

      const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues', params as {
        owner: string;
        repo: string;
        state?: 'open' | 'closed' | 'all';
        per_page?: number;
        page?: number;
        sort?: 'created' | 'updated' | 'comments';
        direction?: 'asc' | 'desc';
        since?: string;
      });

      for (const item of data) {
        // GitHub issues API includes PRs — filter them out
        if ('pull_request' in item && item.pull_request) continue;

        allIssues.push({
          nodeId: item.node_id,
          id: item.id,
          number: item.number,
          title: item.title,
          body: item.body ?? null,
          state: item.state as 'open' | 'closed',
          htmlUrl: item.html_url,
          user: {
            id: item.user?.id ?? 0,
            login: item.user?.login ?? 'unknown',
          },
          labels: item.labels
            .filter((l): l is { name: string } => typeof l === 'object' && l !== null && 'name' in l)
            .map((l) => ({ name: l.name })),
          assignees: (item.assignees ?? []).map((a) => ({ login: a.login })),
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        });
      }

      // If we got fewer items than perPage, no more pages
      if (data.length < perPage) break;
    }

    log.info({ owner, repo, count: allIssues.length }, 'Listed issues');
    return allIssues;
  }

  /**
   * Get an issue by number
   */
  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue> {
    const octokit = await this.getOctokit();
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
      owner,
      repo,
      issue_number: issueNumber,
    });

    return {
      nodeId: data.node_id,
      id: data.id,
      number: data.number,
      title: data.title,
      body: data.body ?? null,
      state: data.state as 'open' | 'closed',
      htmlUrl: data.html_url,
      user: {
        id: data.user?.id ?? 0,
        login: data.user?.login ?? 'unknown',
      },
      labels: data.labels
        .filter((l): l is { name: string } => typeof l === 'object' && l !== null && 'name' in l)
        .map((l) => ({ name: l.name })),
      assignees: (data.assignees ?? []).map((a) => ({ login: a.login })),
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  /**
   * Create a comment on an issue or PR
   */
  async createComment(input: CreateCommentInput): Promise<GitHubComment> {
    const octokit = await this.getOctokit();

    log.info(
      { owner: input.owner, repo: input.repo, issueNumber: input.issueNumber },
      'Creating comment'
    );

    const { data } = await octokit.request(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      {
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
        body: input.body,
      }
    );

    return {
      nodeId: data.node_id,
      id: data.id,
      body: data.body ?? '',
      htmlUrl: data.html_url,
      user: {
        id: data.user?.id ?? 0,
        login: data.user?.login ?? 'unknown',
      },
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  // ===========================================================================
  // Pull Request Operations
  // ===========================================================================

  /**
   * Get a pull request by number
   */
  async getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<GitHubPullRequest> {
    const octokit = await this.getOctokit();
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: pullNumber,
    });

    return {
      nodeId: data.node_id,
      id: data.id,
      number: data.number,
      title: data.title,
      body: data.body ?? null,
      state: data.state,
      merged: data.merged,
      htmlUrl: data.html_url,
      head: {
        ref: data.head.ref,
        sha: data.head.sha,
      },
      base: {
        ref: data.base.ref,
      },
      user: {
        id: data.user?.id ?? 0,
        login: data.user?.login ?? 'unknown',
      },
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      mergedAt: data.merged_at,
    };
  }

  /**
   * Create a pull request
   */
  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    const octokit = await this.getOctokit();

    log.info(
      { owner: input.owner, repo: input.repo, head: input.head, base: input.base },
      'Creating pull request'
    );

    const { data } = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
      owner: input.owner,
      repo: input.repo,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: input.draft ?? false,
    });

    return {
      nodeId: data.node_id,
      id: data.id,
      number: data.number,
      title: data.title,
      body: data.body ?? null,
      state: data.state,
      merged: data.merged,
      htmlUrl: data.html_url,
      head: {
        ref: data.head.ref,
        sha: data.head.sha,
      },
      base: {
        ref: data.base.ref,
      },
      user: {
        id: data.user?.id ?? 0,
        login: data.user?.login ?? 'unknown',
      },
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      mergedAt: data.merged_at,
    };
  }

  // ===========================================================================
  // Branch Operations
  // ===========================================================================

  /**
   * Create a new branch
   */
  async createBranch(input: CreateBranchInput): Promise<{ ref: string; sha: string }> {
    const octokit = await this.getOctokit();

    log.info(
      { owner: input.owner, repo: input.repo, branch: input.branchName },
      'Creating branch'
    );

    const { data } = await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
      owner: input.owner,
      repo: input.repo,
      ref: `refs/heads/${input.branchName}`,
      sha: input.fromSha,
    });

    return {
      ref: data.ref,
      sha: data.object.sha,
    };
  }

  /**
   * Delete a branch
   */
  async deleteBranch(owner: string, repo: string, branchName: string): Promise<void> {
    const octokit = await this.getOctokit();

    log.info({ owner, repo, branch: branchName }, 'Deleting branch');

    await octokit.request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', {
      owner,
      repo,
      ref: `heads/${branchName}`,
    });
  }

  // ===========================================================================
  // Check Run Operations
  // ===========================================================================

  /**
   * Create a check run
   */
  async createCheckRun(
    owner: string,
    repo: string,
    input: {
      name: string;
      headSha: string;
      status?: 'queued' | 'in_progress' | 'completed';
      conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out';
      title?: string;
      summary?: string;
      detailsUrl?: string;
    }
  ): Promise<{ id: number; nodeId: string; htmlUrl: string }> {
    const octokit = await this.getOctokit();

    log.info({ owner, repo, name: input.name, sha: input.headSha }, 'Creating check run');

    const { data } = await octokit.request('POST /repos/{owner}/{repo}/check-runs', {
      owner,
      repo,
      name: input.name,
      head_sha: input.headSha,
      status: input.status,
      conclusion: input.conclusion,
      output: input.title !== undefined
        ? {
            title: input.title,
            summary: input.summary ?? '',
          }
        : undefined,
      details_url: input.detailsUrl,
    });

    return {
      id: data.id,
      nodeId: data.node_id,
      htmlUrl: data.html_url ?? '',
    };
  }

  /**
   * Update a check run
   */
  async updateCheckRun(
    owner: string,
    repo: string,
    checkRunId: number,
    input: {
      status?: 'queued' | 'in_progress' | 'completed';
      conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out';
      title?: string;
      summary?: string;
    }
  ): Promise<void> {
    const octokit = await this.getOctokit();

    log.info({ owner, repo, checkRunId }, 'Updating check run');

    await octokit.request('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}', {
      owner,
      repo,
      check_run_id: checkRunId,
      status: input.status,
      conclusion: input.conclusion,
      output: input.title !== undefined
        ? {
            title: input.title,
            summary: input.summary ?? '',
          }
        : undefined,
    });
  }
}

/**
 * Create a GitHub client for an installation
 */
export function createGitHubClient(installationId: number): GitHubClient {
  return new GitHubClient(installationId);
}
