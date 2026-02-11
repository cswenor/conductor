'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Key, ExternalLink, Trash2, Shield, AlertCircle } from 'lucide-react';

interface ProviderData {
  id: string;
  name: string;
  keyPrefix: string | null;
  docUrl: string;
  configured: boolean;
  lastFour: string | null;
  updatedAt: string | null;
}

interface ApiKeysResponse {
  providers: ProviderData[];
  encryptionEnabled: boolean;
}

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  anthropic: 'Powers Claude-based planning, implementation, and review.',
  openai: 'Alternative AI provider for GPT-based models.',
  google: 'Alternative AI provider for Gemini models.',
  mistral: 'Alternative AI provider for Mistral models.',
};

function timeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function ApiKeyManagement() {
  const [providers, setProviders] = useState<ProviderData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [encryptionEnabled, setEncryptionEnabled] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null);

  async function fetchKeys() {
    try {
      setError(null);
      const res = await fetch('/api/user/api-keys');
      if (!res.ok) {
        throw new Error('Failed to fetch API keys');
      }
      const data = await res.json() as ApiKeysResponse;
      setProviders(data.providers);
      setEncryptionEnabled(data.encryptionEnabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchKeys();
  }, []);

  function handleEdit(providerId: string) {
    setEditingProvider(providerId);
    setKeyInput('');
    setFormError(null);
  }

  function handleCancel() {
    setEditingProvider(null);
    setKeyInput('');
    setFormError(null);
  }

  async function handleSave(providerId: string) {
    setSaving(true);
    setFormError(null);

    try {
      const res = await fetch('/api/user/api-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, apiKey: keyInput }),
      });

      const data = await res.json() as { success?: boolean; error?: string };

      if (!res.ok) {
        setFormError(data.error ?? 'Failed to save API key');
        return;
      }

      setKeyInput('');
      setEditingProvider(null);
      toast.success('API key saved');
      await fetchKeys();
    } catch {
      setFormError('Failed to save API key');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(providerId: string) {
    try {
      const res = await fetch(`/api/user/api-keys?provider=${providerId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        toast.error('Failed to remove API key');
        return;
      }

      setDeletingProvider(null);
      toast.success('API key removed');
      await fetchKeys();
    } catch {
      toast.error('Failed to remove API key');
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            AI Provider Keys
          </CardTitle>
          <CardDescription>
            Configure API keys for AI providers used by agent runs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error !== null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            AI Provider Keys
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between">
              <span>{error}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setLoading(true); void fetchKeys(); }}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const deletingProviderData = providers.find((p) => p.id === deletingProvider);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            AI Provider Keys
          </CardTitle>
          <CardDescription>
            Configure API keys for AI providers used by agent runs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <Shield className="h-4 w-4" />
            <AlertDescription>
              {encryptionEnabled
                ? 'Keys are encrypted at rest and never displayed after storage. '
                : 'Server encryption is not enabled. Keys are stored but not encrypted. Set DATABASE_ENCRYPTION_KEY to enable encryption. '}
              Only the last 4 characters are shown for verification.
            </AlertDescription>
          </Alert>

          {providers.map((provider, index) => (
            <div key={provider.id}>
              {index > 0 && <Separator className="mb-4" />}

              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{provider.name}</span>
                    {provider.configured ? (
                      <Badge variant="success">Configured</Badge>
                    ) : (
                      <Badge variant="secondary">Not Configured</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {PROVIDER_DESCRIPTIONS[provider.id] ?? ''}
                  </p>
                </div>
                <Button variant="outline" size="sm" asChild className="shrink-0">
                  <a
                    href={provider.docUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    Get Key
                  </a>
                </Button>
              </div>

              {editingProvider === provider.id ? (
                <div className="mt-3 space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor={`key-${provider.id}`}>API Key</Label>
                    <Input
                      id={`key-${provider.id}`}
                      type="password"
                      autoComplete="new-password"
                      placeholder={provider.keyPrefix !== null ? `${provider.keyPrefix}...` : 'Enter API key'}
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                    />
                    {provider.keyPrefix !== null && (
                      <p className="text-xs text-muted-foreground">
                        Should start with &quot;{provider.keyPrefix}&quot;
                      </p>
                    )}
                    {formError !== null && (
                      <p className="text-sm text-destructive">{formError}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => void handleSave(provider.id)}
                      disabled={saving || keyInput.length === 0}
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCancel}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : provider.configured ? (
                <div className="mt-3 flex items-center gap-3">
                  <span className="font-mono text-sm text-muted-foreground">
                    ····{provider.lastFour}
                  </span>
                  {provider.updatedAt !== null && provider.updatedAt !== '' && (
                    <span className="text-xs text-muted-foreground">
                      Updated {timeAgo(provider.updatedAt)}
                    </span>
                  )}
                  <div className="flex gap-2 ml-auto">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEdit(provider.id)}
                    >
                      Update Key
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Remove ${provider.name} API key`}
                      onClick={() => setDeletingProvider(provider.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleEdit(provider.id)}
                  >
                    Set Key
                  </Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={deletingProvider !== null} onOpenChange={(open) => { if (!open) setDeletingProvider(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {deletingProviderData?.name ?? ''} API Key?</DialogTitle>
            <DialogDescription>
              Runs requiring this provider will fail until a new key is configured.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingProvider(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => { if (deletingProvider !== null) void handleDelete(deletingProvider); }}
            >
              Remove Key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
