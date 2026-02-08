/**
 * @conductor/shared - Repo Profiles
 *
 * Profile detection and management for repositories.
 * Profiles define the tech stack, test commands, and build configuration.
 */

import { createLogger } from '../logger/index.ts';

const log = createLogger({ name: 'conductor:profiles' });

/**
 * Available profile types
 */
export type ProfileId =
  | 'node-pnpm'
  | 'node-npm'
  | 'node-yarn'
  | 'python-pytest'
  | 'python-pip'
  | 'go-standard'
  | 'rust-cargo'
  | 'nextjs'
  | 'docs-only'
  | 'default';

/**
 * Profile definition
 */
export interface Profile {
  id: ProfileId;
  name: string;
  description: string;
  language: string;
  packageManager?: string;
  framework?: string;
  testCommand?: string;
  buildCommand?: string;
  devCommand?: string;
}

/**
 * Profile definitions
 */
export const PROFILES: Record<ProfileId, Profile> = {
  'node-pnpm': {
    id: 'node-pnpm',
    name: 'Node.js (pnpm)',
    description: 'Node.js project using pnpm package manager',
    language: 'javascript',
    packageManager: 'pnpm',
    testCommand: 'pnpm test',
    buildCommand: 'pnpm build',
    devCommand: 'pnpm dev',
  },
  'node-npm': {
    id: 'node-npm',
    name: 'Node.js (npm)',
    description: 'Node.js project using npm package manager',
    language: 'javascript',
    packageManager: 'npm',
    testCommand: 'npm test',
    buildCommand: 'npm run build',
    devCommand: 'npm run dev',
  },
  'node-yarn': {
    id: 'node-yarn',
    name: 'Node.js (Yarn)',
    description: 'Node.js project using Yarn package manager',
    language: 'javascript',
    packageManager: 'yarn',
    testCommand: 'yarn test',
    buildCommand: 'yarn build',
    devCommand: 'yarn dev',
  },
  nextjs: {
    id: 'nextjs',
    name: 'Next.js',
    description: 'Next.js React framework application',
    language: 'javascript',
    packageManager: 'pnpm',
    framework: 'nextjs',
    testCommand: 'pnpm test',
    buildCommand: 'pnpm build',
    devCommand: 'pnpm dev',
  },
  'python-pytest': {
    id: 'python-pytest',
    name: 'Python (pytest)',
    description: 'Python project with pytest testing',
    language: 'python',
    packageManager: 'pip',
    testCommand: 'pytest',
    buildCommand: 'pip install -e .',
  },
  'python-pip': {
    id: 'python-pip',
    name: 'Python',
    description: 'Python project with pip',
    language: 'python',
    packageManager: 'pip',
    testCommand: 'python -m pytest',
    buildCommand: 'pip install -e .',
  },
  'go-standard': {
    id: 'go-standard',
    name: 'Go',
    description: 'Go project with standard tooling',
    language: 'go',
    testCommand: 'go test ./...',
    buildCommand: 'go build ./...',
  },
  'rust-cargo': {
    id: 'rust-cargo',
    name: 'Rust (Cargo)',
    description: 'Rust project with Cargo',
    language: 'rust',
    packageManager: 'cargo',
    testCommand: 'cargo test',
    buildCommand: 'cargo build',
  },
  'docs-only': {
    id: 'docs-only',
    name: 'Documentation Only',
    description: 'Documentation-only repository',
    language: 'markdown',
  },
  default: {
    id: 'default',
    name: 'Default',
    description: 'Default profile with no specific configuration',
    language: 'unknown',
  },
};

/**
 * File patterns used for profile detection
 */
interface DetectionPattern {
  file: string;
  profileId: ProfileId;
  priority: number;
  condition?: (content?: string) => boolean;
}

/**
 * Detection patterns ordered by priority (higher = more specific)
 */
const DETECTION_PATTERNS: DetectionPattern[] = [
  // Next.js detection (highest priority for JS frameworks)
  { file: 'next.config.js', profileId: 'nextjs', priority: 100 },
  { file: 'next.config.mjs', profileId: 'nextjs', priority: 100 },
  { file: 'next.config.ts', profileId: 'nextjs', priority: 100 },

  // Node.js package managers
  { file: 'pnpm-lock.yaml', profileId: 'node-pnpm', priority: 90 },
  { file: 'yarn.lock', profileId: 'node-yarn', priority: 90 },
  { file: 'package-lock.json', profileId: 'node-npm', priority: 80 },
  { file: 'package.json', profileId: 'node-npm', priority: 70 },

  // Go
  { file: 'go.mod', profileId: 'go-standard', priority: 85 },

  // Rust
  { file: 'Cargo.toml', profileId: 'rust-cargo', priority: 85 },

  // Python
  { file: 'pyproject.toml', profileId: 'python-pytest', priority: 85 },
  { file: 'pytest.ini', profileId: 'python-pytest', priority: 90 },
  { file: 'setup.py', profileId: 'python-pip', priority: 75 },
  { file: 'requirements.txt', profileId: 'python-pip', priority: 70 },

  // Documentation
  { file: 'mkdocs.yml', profileId: 'docs-only', priority: 60 },
  { file: 'docs/index.md', profileId: 'docs-only', priority: 50 },
];

/**
 * Result of profile detection
 */
export interface ProfileDetectionResult {
  profileId: ProfileId;
  profile: Profile;
  confidence: 'high' | 'medium' | 'low';
  detectedFiles: string[];
  reason: string;
}

/**
 * Detect the profile for a repository based on its files.
 *
 * @param files - Array of file paths in the repository
 * @returns Detection result with profile and confidence
 */
export function detectProfile(files: string[]): ProfileDetectionResult {
  const fileSet = new Set(files.map((f) => f.toLowerCase()));
  const detectedFiles: string[] = [];
  let bestMatch: { pattern: DetectionPattern; score: number } | null = null;

  // Check each pattern
  for (const pattern of DETECTION_PATTERNS) {
    const matchingFile = files.find(
      (f) => f.toLowerCase() === pattern.file.toLowerCase() || f.toLowerCase().endsWith(`/${pattern.file.toLowerCase()}`)
    );

    if (matchingFile !== undefined) {
      detectedFiles.push(matchingFile);

      if (bestMatch === null || pattern.priority > bestMatch.score) {
        bestMatch = { pattern, score: pattern.priority };
      }
    }
  }

  // Determine result
  if (bestMatch !== null) {
    const profile = PROFILES[bestMatch.pattern.profileId];
    const confidence =
      bestMatch.score >= 90 ? 'high' : bestMatch.score >= 70 ? 'medium' : 'low';

    log.debug(
      { profileId: profile.id, confidence, detectedFiles },
      'Profile detected'
    );

    return {
      profileId: profile.id,
      profile,
      confidence,
      detectedFiles,
      reason: `Detected ${profile.name} based on ${bestMatch.pattern.file}`,
    };
  }

  // Check for documentation-only repo
  const hasMarkdown = files.some(
    (f) => f.toLowerCase().endsWith('.md') || f.toLowerCase().endsWith('.mdx')
  );
  const hasReadme = fileSet.has('readme.md') || fileSet.has('readme');

  if (hasMarkdown && hasReadme && files.length < 20) {
    return {
      profileId: 'docs-only',
      profile: PROFILES['docs-only'],
      confidence: 'low',
      detectedFiles: files.filter(
        (f) => f.toLowerCase().endsWith('.md') || f.toLowerCase().endsWith('.mdx')
      ),
      reason: 'Small repository with primarily markdown files',
    };
  }

  // Default profile
  return {
    profileId: 'default',
    profile: PROFILES.default,
    confidence: 'low',
    detectedFiles: [],
    reason: 'No recognizable project files detected',
  };
}

/**
 * Get a profile by ID
 */
export function getProfile(profileId: string): Profile | undefined {
  return PROFILES[profileId as ProfileId];
}

/**
 * List all available profiles
 */
export function listProfiles(): Profile[] {
  return Object.values(PROFILES);
}
