"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type { UserId } from "@love-chat/shared";

import { fetchSession, loginWithPasskey, registerPasskey, updateIdentityPublicKey } from "../../lib/auth";
import { ensureIdentityKey } from "../../lib/cryptoSession";

const USERS: UserId[] = ["userA", "userB"];

export default function LoginPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<UserId>("userA");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Waiting for action");

  const title = useMemo(() => `Sign in as ${userId}`, [userId]);

  useEffect(() => {
    fetchSession()
      .then(() => {
        router.replace("/chat");
      })
      .catch(() => {
        // Not signed in.
      });
  }, [router]);

  useEffect(() => {
    ensureIdentityKey(userId)
      .then(() => {
        setStatus("Identity key ready");
      })
      .catch((error) => {
        setStatus(String(error));
      });
  }, [userId]);

  async function runPasskeyFlow(action: "register" | "login") {
    setBusy(true);
    try {
      const identity = await ensureIdentityKey(userId);
      if (action === "register") {
        await registerPasskey(userId, identity.publicKey);
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
        <h1 style={{ marginTop: 0 }}>{title}</h1>
        <p className="muted">Two fixed users only. Use passkey registration once, then login with biometrics.</p>

        <label htmlFor="user" style={{ display: "block", marginTop: "1rem", marginBottom: "0.5rem" }}>
          Account
        </label>
        <select
          id="user"
          value={userId}
          onChange={(event) => {
            setUserId(event.target.value as UserId);
          }}
          disabled={busy}
        >
          {USERS.map((entry) => (
            <option value={entry} key={entry}>
              {entry}
            </option>
          ))}
        </select>

        <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem", flexWrap: "wrap" }}>
          <button onClick={() => runPasskeyFlow("register")} disabled={busy}>
            Register Passkey
          </button>
          <button className="secondary" onClick={() => runPasskeyFlow("login")} disabled={busy}>
            Login
          </button>
        </div>

        <p style={{ marginTop: "1rem", marginBottom: 0 }}>{status}</p>
      </section>
    </main>
  );
}