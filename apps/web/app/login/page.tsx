"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type { UserId } from "@love-chat/shared";

import { fetchSession, loginWithPasskey, registerPasskey, updateIdentityPublicKey } from "../../lib/auth";
import { ensureIdentityKey } from "../../lib/cryptoSession";

const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;
const PHONE_PATTERN = /^\+?[0-9]{8,15}$/;

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Waiting for action");

  const normalizedUsername = useMemo(() => normalizeUsername(username), [username]);
  const normalizedPhone = useMemo(() => normalizePhone(phoneNumber), [phoneNumber]);

  useEffect(() => {
    fetchSession()
      .then(() => {
        router.replace("/chat");
      })
      .catch(() => {
        // Not signed in.
      });
  }, [router]);

  const usernameValid = USERNAME_PATTERN.test(normalizedUsername);
  const phoneValid = PHONE_PATTERN.test(normalizedPhone);

  async function runPasskeyFlow(action: "register" | "login") {
    if (!usernameValid) {
      setStatus("Username must be 3-24 chars: lowercase letters, digits, underscore.");
      return;
    }

    if (action === "register" && !phoneValid) {
      setStatus("Phone number must be 8-15 digits (optional + prefix).");
      return;
    }

    setBusy(true);
    try {
      const userId = normalizedUsername as UserId;
      const identity = await ensureIdentityKey(userId);
      if (action === "register") {
        await registerPasskey(userId, normalizedPhone, identity.publicKey);
        setStatus("Registration complete");
      } else {
        const session = await loginWithPasskey(userId);
        if (!session.selfIdentityPublicKey) {
          await updateIdentityPublicKey(identity.publicKey);
        }
        setStatus("Login complete");
      }
      router.push("/chat");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell" style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <section className="panel" style={{ width: "min(560px, 100%)", padding: "1.5rem" }}>
        <p style={{ letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--muted)", marginTop: 0 }}>
          LoveChat
        </p>
        <h1 style={{ marginTop: 0 }}>Login / Register</h1>
        <p className="muted" style={{ marginBottom: "1rem" }}>
          Up to 5 users can register. Register with username + phone once, then login with passkey.
        </p>

        <label htmlFor="username" style={{ display: "block", marginBottom: "0.4rem" }}>
          Username
        </label>
        <input
          id="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="harshal"
          autoComplete="username"
          disabled={busy}
        />
        <small className="muted">Lowercase letters, digits, underscore. Example: `harshal_1`</small>

        <label htmlFor="phone" style={{ display: "block", marginTop: "0.9rem", marginBottom: "0.4rem" }}>
          Phone Number (for register)
        </label>
        <input
          id="phone"
          value={phoneNumber}
          onChange={(event) => setPhoneNumber(event.target.value)}
          placeholder="+919876543210"
          autoComplete="tel"
          disabled={busy}
        />

        <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem", flexWrap: "wrap" }}>
          <button onClick={() => void runPasskeyFlow("register")} disabled={busy}>
            Register Passkey
          </button>
          <button className="secondary" onClick={() => void runPasskeyFlow("login")} disabled={busy}>
            Login
          </button>
        </div>

        <p style={{ marginTop: "1rem", marginBottom: 0 }}>{status}</p>
      </section>
    </main>
  );
}
