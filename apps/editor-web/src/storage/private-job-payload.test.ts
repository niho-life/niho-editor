import { describe, expect, it } from "vitest";
import { createPrivateJobPayloadCipher, type PrivateJobBinding } from "./private-job-payload";

const key = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const binding: PrivateJobBinding = {
  owner: "synthetic-owner",
  proposalId: "00000000-0000-4000-8000-000000000001",
  purpose: "managed-translation",
  expiresAt: "2030-01-02T03:04:05.000Z",
};

describe("private job payload cipher", () => {
  it("round-trips an envelope and binds owner, proposal, purpose and exact expiry as AAD", () => {
    const cipher = createPrivateJobPayloadCipher({ EDITOR_PRIVATE_JOBS_KEY_RING: JSON.stringify({ active: "v2", keys: { v1: key(1), v2: key(2) } }) })!;
    const payload = { title: "合成の原文", fields: [{ path: "title", text: "Synthetic English" }] };
    const encrypted = cipher.encrypt(payload, binding);
    expect(encrypted.keyId).toBe("v2");
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.tag).toHaveLength(16);
    expect(cipher.decrypt(encrypted, binding)).toEqual(payload);
    for (const changed of [
      { ...binding, owner: "other-owner" },
      { ...binding, proposalId: "00000000-0000-4000-8000-000000000002" },
      { ...binding, expiresAt: "2030-01-02T03:04:06.000Z" },
    ]) expect(() => cipher.decrypt(encrypted, changed)).toThrow("private job payload is unavailable");
  });

  it("keeps an old key readable during rotation and rejects tampering without exposing payload", () => {
    const old = createPrivateJobPayloadCipher({ EDITOR_PRIVATE_JOBS_KEY_RING: JSON.stringify({ active: "v1", keys: { v1: key(1) } }) })!;
    const encrypted = old.encrypt({ secret: "synthetic-private-text" }, binding);
    const rotated = createPrivateJobPayloadCipher({ EDITOR_PRIVATE_JOBS_KEY_RING: JSON.stringify({ active: "v2", keys: { v1: key(1), v2: key(2) } }) })!;
    expect(rotated.decrypt(encrypted, binding)).toEqual({ secret: "synthetic-private-text" });
    const changed = { ...encrypted, ciphertext: encrypted.ciphertext.slice() };
    changed.ciphertext[0] = changed.ciphertext[0]! ^ 1;
    let visible = "";
    try { rotated.decrypt(changed, binding); } catch (error) { visible = String(error); }
    expect(visible).toContain("private job payload is unavailable");
    expect(visible).not.toContain("synthetic-private-text");
  });

  it("fails closed for missing, weak, ambiguous or malformed keyrings", () => {
    const invalid: Array<string | undefined> = [
      undefined,
      "",
      "not-json",
      JSON.stringify({ active: "v1", keys: {} }),
      JSON.stringify({ active: "v2", keys: { v1: key(1) } }),
      JSON.stringify({ active: "v1", keys: { v1: Buffer.alloc(31, 1).toString("base64") } }),
      JSON.stringify({ active: "v1", keys: { v1: key(1) }, extra: true }),
      JSON.stringify({ active: "v1", keys: { v1: key(1), "bad id": key(2) } }),
    ];
    for (const value of invalid) expect(createPrivateJobPayloadCipher({ EDITOR_PRIVATE_JOBS_KEY_RING: value }), value).toBeNull();
  });
});
