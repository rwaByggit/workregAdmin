// app/login/page.tsx
'use client';

import { useState, FormEvent, useEffect } from 'react';
import { signIn, signOut, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import ForgotPasswordModal from '../components/ForgotPasswordModal';
import VersionTag from '../components/VersionTag';

export default function LoginPage() {
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [showEnv, setShowEnv] = useState<boolean>(false);
  const [dbUrl, setDbUrl] = useState<string>('');
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [appVersion, setAppVersion] = useState<string>('');
  const router = useRouter();
  const { data: session, status } = useSession();
  const [redirectUrl, setRedirectUrl] = useState<string>('');
  const [showForgotPassword, setShowForgotPassword] = useState<boolean>(false);

  // Always show the login form when this route is opened directly.
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const redirect = searchParams.get('redirect');
    if (redirect) {
      setRedirectUrl(redirect);
    }

    if (status === 'authenticated') {
      signOut({ redirect: false });
      return;
    }
    
    console.log('useeffect loading');
    loadVersion();
  }, [status]);


  const loadVersion = async () => {
    try {
      const res = await fetch('/api/debug/env');
      console.log('fetching .env:', res);
      const json = await res.json();
      setAppVersion(json.appVer || '0.1');
    } catch (err) {
        setAppVersion('0.2e'); // fallback
    }
  };


  const checkAdmin = async (email: string) => {
    try {
      const res = await fetch('/api/debug/check-admin', {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });

      const data = await res.json();
      setIsAdmin(data.isAdmin);
    } catch (err) {
      setIsAdmin(false);
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false
      });

      if (result?.error) {
        setError(result.error);
      } else {
        // Redirect to the stored URL or default to dashboard
        router.push(redirectUrl || '/dashboard');
      }
    } catch (err) {
      setError('An unexpected error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  const loadDbUrl = async () => {
    try {
      const res = await fetch('/api/debug/env');
      const json = await res.json();
      setDbUrl(json.DATABASE_URL);
      console.log('json db:', dbUrl, 'appver:', json.appVer);
    } catch (err) {
      setDbUrl('Error loading DATABASE_URL');
    }
  };

  // Capture NEXT_PUBLIC environment variables
  const clientEnv = Object.entries(process.env).filter(([key]) =>
    key.startsWith('NEXT_PUBLIC')
  );

  // Show loading state while clearing previous session
  if (status === 'loading' ) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background-alt">
        <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent mx-auto mb-4"></div>
            <p className="text-gray-600">Loading session...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background-alt">
      <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">

        <h2 className="text-2xl font-heading font-bold text-center mb-6 text-accent">
          Login to dashboard 
        </h2>

        {error && (
          <div className="alert alert-warning mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="form-label">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => {
                const v = e.target.value;
                setEmail(v);
                checkAdmin(v);
              }}
              className="form-input"
              required
            />
          </div>

          <div>
            <div className="flex justify-between items-center">
              <label htmlFor="password" className="form-label">Password</label>
              <button
                type="button"
                onClick={() => setShowForgotPassword(true)}
                className="text-sm text-blue-600 hover:text-blue-500"
              >
                Forgot password?
              </button>
            </div>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="form-input"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className={`btn btn-primary w-full ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        {/* DEBUG PANEL (visible only for SYS_ADMIN_USER) */}
        {isAdmin && (
          <div className="mt-6">
            <button
              onClick={() => {
                const newVal = !showEnv;
                setShowEnv(newVal);
                if (newVal) loadDbUrl();
              }}
              className="text-xs text-blue-600 underline"
            >
              {showEnv ? 'Hide Environment Debug Info' : 'Show Environment Debug Info'}
            </button>

            {showEnv && (
              <div className="mt-2 p-3 bg-gray-100 text-xs rounded border">
                <h4 className="font-bold mb-2">Environment Variables (Client)</h4>

                {clientEnv.length === 0 && (
                  <p>No NEXT_PUBLIC_* environment variables found.</p>
                )}

                {clientEnv.map(([key, value]) => (
                  <div key={key} className="mb-1">
                    <span className="font-semibold">{key}:</span>{' '}
                    <span className="font-mono break-all">{value || '(empty)'}</span>
                  </div>
                ))}

                {/* Sanitized DB URL */}
                <div className="mt-4">
                  <h4 className="font-bold mb-2">Sanitized DATABASE_URL</h4>
                  <div className="font-mono text-xs break-all bg-gray-200 p-2 rounded">
                    {dbUrl || '(loading...)'}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 text-center">
          <a href="/register" className="nav-link text-sm">
            Don&apos;t have an account? Sign up
          </a>
        </div>

        <div className="mt-2 text-center">
          <a href="/newsubscription" className="nav-link text-sm">
            Wanna know more on available features?
          </a>
        </div>

      </div>

      <ForgotPasswordModal
        isOpen={showForgotPassword}
        onClose={() => setShowForgotPassword(false)}
      />
      <VersionTag version="12.5.2026 - dev" />
    </div>
  );
}
