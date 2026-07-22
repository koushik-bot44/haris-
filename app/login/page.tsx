"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// Login — email+password sign-in. The server answers one generic message for
// any bad credential, so we never tell the user which field was wrong.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  email?: string;
  password?: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (!email.trim()) next.email = "Enter your email.";
    else if (!EMAIL_RE.test(email.trim())) next.email = "That doesn't look like an email.";
    if (!password) next.password = "Enter your password.";
    return next;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (res.ok) {
        router.push("/");
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setFormError(data.error ?? "Invalid email or password.");
    } catch {
      setFormError("Network error. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <h1>Welcome back</h1>
        <p className="auth-sub">Sign in to pick up your practice history and progress.</p>

        <form className="auth-form" onSubmit={onSubmit} noValidate>
          {formError && (
            <p className="error" role="alert">
              {formError}
            </p>
          )}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={errors.email ? "true" : undefined}
              aria-describedby={errors.email ? "email-err" : undefined}
            />
            {errors.email && (
              <span className="error" id="email-err">
                {errors.email}
              </span>
            )}
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={errors.password ? "true" : undefined}
              aria-describedby={errors.password ? "password-err" : undefined}
            />
            {errors.password && (
              <span className="error" id="password-err">
                {errors.password}
              </span>
            )}
          </div>

          <button className="btn block lg" type="submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <Link href="/" className="btn ghost block auth-guest">
          Continue as guest
        </Link>
      </div>

      <p className="auth-foot">
        New here? <Link href="/register">Create an account</Link>
      </p>
    </main>
  );
}
