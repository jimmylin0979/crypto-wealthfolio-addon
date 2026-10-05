import { describe, expect, it } from "vitest";

import { hmacSha256Base64, hmacSha256Hex } from "./signing";

describe("hmacSha256Hex", () => {
  it("matches RFC 4231 test case 1", () => {
    // key = 0x0b repeated 20 times, data = "Hi There"
    expect(hmacSha256Hex("Hi There", "\x0b".repeat(20))).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("matches RFC 4231 test case 2", () => {
    expect(hmacSha256Hex("what do ya want for nothing?", "Jefe")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

describe("hmacSha256Base64", () => {
  it("matches the base64 encoding of RFC 4231 test case 1", () => {
    expect(hmacSha256Base64("\x0b".repeat(20), "Hi There")).toBe(
      "sDRMYdjbOFNcqK/OrwvxK4gdwgDJgz2nJuk3bC4yz/c=",
    );
  });

  it("matches the base64 encoding of RFC 4231 test case 2", () => {
    expect(hmacSha256Base64("Jefe", "what do ya want for nothing?")).toBe(
      "W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=",
    );
  });
});
