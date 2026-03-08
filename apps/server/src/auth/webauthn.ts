import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";

import type { UserId } from "@love-chat/shared";

import { config } from "../config";
import { UsersService } from "../services/usersService";

function toBuffer(base64Url: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64Url.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

function userIdBytes(userId: string): Uint8Array {
  const encoded = new TextEncoder().encode(userId);
  const arrayBuffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  return new Uint8Array(arrayBuffer);
}

function fromBuffer(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export class WebAuthnService {
  private registrationChallenges = new Map<UserId, string>();

  private loginChallenges = new Map<UserId, string>();

  constructor(private readonly usersService: UsersService) {}

  async createRegistrationChallenge(userId: UserId) {
    const user = await this.usersService.getUser(userId);
    const options = await generateRegistrationOptions({
      rpName: config.webauthn.rpName,
      rpID: config.webauthn.rpID,
      userID: userIdBytes(user.id) as any,
      userName: user.id,
      userDisplayName: user.displayName,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred"
      },
      excludeCredentials: user.webauthnCredentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports as any
      }))
    });

    this.registrationChallenges.set(userId, options.challenge);
    return options;
  }

  async verifyRegistration(userId: UserId, response: unknown) {
    const expectedChallenge = this.registrationChallenges.get(userId);
    if (!expectedChallenge) {
      throw new Error("No registration challenge was issued");
    }

    const verification = await verifyRegistrationResponse({
      response: response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge,
      expectedOrigin: config.webauthn.origin,
      expectedRPID: config.webauthn.rpID,
      requireUserVerification: false
    });

    if (verification.verified && verification.registrationInfo) {
      const credential = verification.registrationInfo.credential;
      await this.usersService.upsertCredential(userId, {
        id: credential.id,
        publicKey: fromBuffer(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports,
        credentialDeviceType: verification.registrationInfo.credentialDeviceType,
        credentialBackedUp: verification.registrationInfo.credentialBackedUp
      });
    }

    this.registrationChallenges.delete(userId);
    return verification;
  }

  async createLoginChallenge(userId: UserId) {
    const user = await this.usersService.getUser(userId);

    const options = await generateAuthenticationOptions({
      rpID: config.webauthn.rpID,
      userVerification: "preferred",
      allowCredentials: user.webauthnCredentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports as any
      }))
    });

    this.loginChallenges.set(userId, options.challenge);
    return options;
  }

  async verifyLogin(userId: UserId, response: unknown) {
    const expectedChallenge = this.loginChallenges.get(userId);
    if (!expectedChallenge) {
      throw new Error("No login challenge was issued");
    }

    const user = await this.usersService.getUser(userId);
    const responseCredentialId = (response as { id?: string })?.id;
    const credential = user.webauthnCredentials.find((entry) => entry.id === responseCredentialId);

    if (!credential) {
      throw new Error("Credential not found");
    }

    const verification = await verifyAuthenticationResponse({
      response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge,
      expectedOrigin: config.webauthn.origin,
      expectedRPID: config.webauthn.rpID,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(toBuffer(credential.publicKey)),
        counter: credential.counter,
        transports: credential.transports as any
      },
      requireUserVerification: false
    });

    if (verification.verified) {
      await this.usersService.updateCredentialCounter(
        userId,
        credential.id,
        verification.authenticationInfo.newCounter
      );
    }

    this.loginChallenges.delete(userId);
    return verification;
  }
}
