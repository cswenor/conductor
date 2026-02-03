# Conductor - Claude Code Instructions

## Validation

After completing any task that modifies code, run the validation command to confirm everything passes:

```bash
pnpm validate
```

This runs `typecheck`, `lint`, and `test` in sequence.

## Project Structure

- `packages/shared` - Shared utilities, types, and services
- `packages/web` - Next.js web application
- `packages/worker` - BullMQ job worker

## Key Patterns

- **Outbox pattern** - Persist writes before executing (crash-safe)
- **Webhook-first** - Persist webhooks before processing
- **Event normalization** - Convert GitHub webhooks to internal events
