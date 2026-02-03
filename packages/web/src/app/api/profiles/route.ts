/**
 * Profiles API
 *
 * List available repository profiles.
 */

import { NextResponse } from 'next/server';
import { listProfiles } from '@conductor/shared';

/**
 * GET /api/profiles
 *
 * List all available profiles.
 */
export function GET(): NextResponse {
  const profiles = listProfiles();

  return NextResponse.json({
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      language: p.language,
      packageManager: p.packageManager,
      framework: p.framework,
      testCommand: p.testCommand,
      buildCommand: p.buildCommand,
      devCommand: p.devCommand,
    })),
  });
}
