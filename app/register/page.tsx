"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// Register — create an email+password account. Client-side validation mirrors
// the server's zod rules for instant feedback; the server stays the authority.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
}

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (!name.trim()) next.name = "Enter your name.";
    if (!email.trim()) next.email = "Enter your email.";
    else if (!EMAIL_RE.test(email.trim())) next.email = "That doesn't look like an email.";
    if (!password) next.password = "Choose a password.";
    else if (password.length < 8) next.password = "At least 8 characters.";
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
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password }),
      });
      if (res.ok) {
        router.push("/");
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 409) {
        setErrors({ email: "That email is already registered." });
      } else {
        setFormError(data.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setFormError("Network error. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <h1>Create your account</h1>
        <p className="auth-sub">
          Save your practice history and track progress across every round.
        </p>

        <form className="auth-form" onSubmit={onSubmit} noValidate>
          {formError && (
            <p className="error" role="alert">
              {formError}
            </p>
          )}

          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={errors.name ? "true" : undefined}
              aria-describedby={errors.name ? "name-err" : undefined}
            />
            {errors.name && (
              <span className="error" id="name-err">
                {errors.name}
              </span>
            )}
          </div>

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
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={errors.password ? "true" : undefined}
              aria-describedby={errors.password ? "password-err" : "password-hint"}
            />
            {errors.password ? (
              <span className="error" id="password-err">
                {errors.password}
              </span>
            ) : (
              <span className="hint" id="password-hint">
                At least 8 characters.
              </span>
            )}
          </div>

          <button className="btn block lg" type="submit" disabled={submitting}>
            {submitting ? "Creating account…" : "Create account"}
          </button>
        </form>

        <Link href="/" className="btn ghost block auth-guest">
          Continue as guest
        </Link>
      </div>

      <p className="auth-foot">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </main>
  );
}
