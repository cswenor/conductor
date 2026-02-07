'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, FileText, Brain, ThumbsUp, Code, TestTube, GitPullRequest, CheckCircle } from 'lucide-react';

interface PipelineStep {
  id: string;
  label: string;
  phase: string;
  type: 'automatic' | 'gate' | 'terminal';
  icon: React.ReactNode;
  description: string;
  config: Array<{ label: string; value: string }>;
}

const PIPELINE_STEPS: PipelineStep[] = [
  {
    id: 'issue',
    label: 'Issue',
    phase: 'pending',
    type: 'automatic',
    icon: <FileText className="h-5 w-5" />,
    description: 'A GitHub issue or task is selected from the backlog. A run is created and the worktree environment is set up.',
    config: [
      { label: 'Trigger', value: 'Manual or automatic from backlog' },
      { label: 'Environment', value: 'Isolated git worktree' },
      { label: 'Checkpoint', value: 'environment_ready' },
    ],
  },
  {
    id: 'plan',
    label: 'Plan',
    phase: 'planning',
    type: 'automatic',
    icon: <Brain className="h-5 w-5" />,
    description: 'The AI agent analyzes the issue and creates a detailed implementation plan with step-by-step approach.',
    config: [
      { label: 'Agent', value: 'Planner (Claude)' },
      { label: 'Output', value: 'Plan artifact (Markdown)' },
      { label: 'Max revisions', value: '3' },
      { label: 'Checkpoint', value: 'planning_complete' },
    ],
  },
  {
    id: 'approval',
    label: 'Approval',
    phase: 'awaiting_plan_approval',
    type: 'gate',
    icon: <ThumbsUp className="h-5 w-5" />,
    description: 'The plan is presented for human review. The operator can approve, request revisions, or reject.',
    config: [
      { label: 'Gate type', value: 'Human approval' },
      { label: 'Actions', value: 'Approve, Revise, Reject' },
      { label: 'On revise', value: 'Returns to Plan step' },
      { label: 'Checkpoint', value: 'plan_approved' },
    ],
  },
  {
    id: 'implement',
    label: 'Implement',
    phase: 'executing',
    type: 'automatic',
    icon: <Code className="h-5 w-5" />,
    description: 'The AI agent implements the approved plan by writing code, creating files, and committing changes.',
    config: [
      { label: 'Agent', value: 'Executor (Claude)' },
      { label: 'Tools', value: 'Filesystem, test runner, git' },
      { label: 'Policy', value: 'Worktree boundary enforced' },
      { label: 'Checkpoint', value: 'implementation_complete' },
    ],
  },
  {
    id: 'tests',
    label: 'Tests',
    phase: 'executing',
    type: 'automatic',
    icon: <TestTube className="h-5 w-5" />,
    description: 'Automated tests are run against the implementation. Failures trigger a fix cycle back to implementation.',
    config: [
      { label: 'Runner', value: 'Project test command' },
      { label: 'Max fix attempts', value: '3' },
      { label: 'On failure', value: 'Returns to Implement' },
      { label: 'Checkpoint', value: 'tests_passed' },
    ],
  },
  {
    id: 'pr',
    label: 'PR',
    phase: 'awaiting_review',
    type: 'gate',
    icon: <GitPullRequest className="h-5 w-5" />,
    description: 'A pull request is created on GitHub for human code review. The PR includes the plan and all changes.',
    config: [
      { label: 'Gate type', value: 'PR review' },
      { label: 'Target', value: 'Default base branch' },
      { label: 'Auto-merge', value: 'Off (requires approval)' },
      { label: 'Checkpoint', value: 'pr_created' },
    ],
  },
  {
    id: 'complete',
    label: 'Complete',
    phase: 'completed',
    type: 'terminal',
    icon: <CheckCircle className="h-5 w-5" />,
    description: 'The PR is merged and the worktree is cleaned up. The run is marked as completed with success.',
    config: [
      { label: 'Cleanup', value: 'Worktree removed' },
      { label: 'Result', value: 'success or failure' },
      { label: 'Branch', value: 'Deleted after merge' },
    ],
  },
];

type StepType = PipelineStep['type'];

const TYPE_STYLES: Record<StepType, { bg: string; border: string; text: string; badge: 'default' | 'secondary' | 'outline' }> = {
  automatic: { bg: 'bg-background', border: 'border-border', text: 'text-foreground', badge: 'secondary' },
  gate:      { bg: 'bg-amber-50 dark:bg-amber-950/20', border: 'border-amber-200 dark:border-amber-800', text: 'text-amber-700 dark:text-amber-300', badge: 'outline' },
  terminal:  { bg: 'bg-green-50 dark:bg-green-950/20', border: 'border-green-200 dark:border-green-800', text: 'text-green-700 dark:text-green-300', badge: 'default' },
};

function StepCard({ step, isSelected, onClick }: {
  step: PipelineStep;
  isSelected: boolean;
  onClick: () => void;
}) {
  const styles = TYPE_STYLES[step.type];
  return (
    <button
      onClick={onClick}
      className={`
        flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all min-w-[100px]
        ${styles.bg} ${isSelected ? 'border-primary ring-2 ring-primary/20' : styles.border}
        hover:border-primary/50 cursor-pointer
      `}
    >
      <div className={styles.text}>
        {step.icon}
      </div>
      <span className="text-sm font-medium">{step.label}</span>
      <Badge variant={styles.badge} className="text-[10px] h-4 px-1">
        {step.type === 'gate' ? 'Gate' : step.type === 'terminal' ? 'End' : 'Auto'}
      </Badge>
    </button>
  );
}

function StepDetail({ step }: { step: PipelineStep }) {
  const styles = TYPE_STYLES[step.type];
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${styles.bg} ${styles.text} border ${styles.border}`}>
            {step.icon}
          </div>
          <div>
            <CardTitle className="text-base">{step.label}</CardTitle>
            <CardDescription className="text-xs">
              Phase: <code className="font-mono">{step.phase}</code>
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{step.description}</p>
        <div className="space-y-2">
          {step.config.map((item) => (
            <div key={item.label} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{item.label}</span>
              <span className="font-medium">{item.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function ProjectWorkflowTab() {
  const [selectedStepId, setSelectedStepId] = useState<string>('issue');

  const selectedStep = PIPELINE_STEPS.find((s) => s.id === selectedStepId) ?? PIPELINE_STEPS[0];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold">Run Lifecycle Pipeline</h3>
        <p className="text-sm text-muted-foreground">
          Default workflow for orchestration runs. Click a step to see its configuration.
        </p>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded border border-border bg-background" />
          <span>Automatic</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20" />
          <span>Human Gate</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/20" />
          <span>Terminal</span>
        </div>
      </div>

      {/* Pipeline visualization */}
      <div className="flex items-center gap-1 overflow-x-auto pb-2">
        {PIPELINE_STEPS.map((step, i) => (
          <div key={step.id} className="flex items-center">
            <StepCard
              step={step}
              isSelected={step.id === selectedStepId}
              onClick={() => setSelectedStepId(step.id)}
            />
            {i < PIPELINE_STEPS.length - 1 && (
              <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0 mx-1" />
            )}
          </div>
        ))}
      </div>

      {/* Step detail panel */}
      {selectedStep !== undefined && <StepDetail step={selectedStep} />}
    </div>
  );
}
