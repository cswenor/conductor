'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loading } from '@/components/ui/loading';
import { Github, AlertCircle, Loader2 } from 'lucide-react';

const ERROR_MESSAGES: Record<string, string> = {
  oauth_denied: 'You denied the authorization request.',
  missing_code: 'Authorization code was missing.',
  token_error: 'Failed to exchange authorization code.',
  user_fetch_error: 'Failed to fetch your GitHub profile.',
  config_error: 'GitHub OAuth is not configured.',
  server_error: 'An unexpected error occurred.',
};

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errorCode = searchParams.get('error');
  const redirectTo = searchParams.get('redirect') ?? '/';

  useEffect(() => {
    // Check if already logged in
    async function checkSession() {
      try {
        const response = await fetch('/api/auth/session');
        if (response.ok) {
          const data = await response.json() as { user: unknown };
          if (data.user !== null) {
            // Already logged in, redirect
            router.push(redirectTo as Parameters<typeof router.push>[0]);
            return;
          }
        }
      } catch {
        // Ignore errors, just show login page
      } finally {
        setLoading(false);
      }
    }

    void checkSession();
  }, [router, redirectTo]);

  useEffect(() => {
    if (errorCode !== null) {
      setError(ERROR_MESSAGES[errorCode] ?? 'An error occurred during login.');
    }
  }, [errorCode]);

  const handleLogin = () => {
    setRedirecting(true);
    setError(null);
    // Redirect to GitHub OAuth with the intended destination
    const loginUrl = `/api/auth/github?redirect=${encodeURIComponent(redirectTo)}`;
    window.location.href = loginUrl;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loading size="lg" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Welcome to Conductor Core</CardTitle>
          <CardDescription>
            Sign in with your GitHub account to continue
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error !== null && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button
            className="w-full"
            size="lg"
            onClick={handleLogin}
            disabled={redirecting}
          >
            {redirecting ? (
              <>
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                Redirecting to GitHub...
              </>
            ) : (
              <>
                <Github className="h-5 w-5 mr-2" />
                Sign in with GitHub
              </>
            )}
          </Button>

          <p className="text-xs text-center text-muted-foreground">
            By signing in, you agree to allow Conductor Core to access your GitHub profile information.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function LoginFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Loading size="lg" />
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginContent />
    </Suspense>
  );
}
