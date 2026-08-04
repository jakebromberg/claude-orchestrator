import { describe, it, expect } from "vitest";
import {
  API_CREDENTIAL_ENV_VARS,
  USE_API_KEY_ENV_VAR,
  claudeSessionEnv,
  usesApiKeyBilling,
} from "../src/claude-env.js";

describe("usesApiKeyBilling", () => {
  it("is false when the opt-in var is absent", () => {
    expect(usesApiKeyBilling({})).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes"])(
    "is true for truthy value %s",
    (value) => {
      expect(usesApiKeyBilling({ [USE_API_KEY_ENV_VAR]: value })).toBe(true);
    },
  );

  it.each(["", "0", "false", "FALSE"])(
    "is false for falsy value %j",
    (value) => {
      expect(usesApiKeyBilling({ [USE_API_KEY_ENV_VAR]: value })).toBe(false);
    },
  );
});

describe("claudeSessionEnv", () => {
  it.each(API_CREDENTIAL_ENV_VARS)("strips %s by default", (key) => {
    const result = claudeSessionEnv({ PATH: "/usr/bin", [key]: "secret" });
    expect(result[key]).toBeUndefined();
    expect(result.PATH).toBe("/usr/bin");
  });

  it("strips every CLAUDE-prefixed var so the child is not seen as nested", () => {
    const result = claudeSessionEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_ANYTHING_ELSE: "x",
      HOME: "/Users/test",
    });
    expect(Object.keys(result).filter((k) => k.startsWith("CLAUDE"))).toEqual([]);
    expect(result.HOME).toBe("/Users/test");
  });

  it("keeps API credentials when the opt-in env var is set", () => {
    const result = claudeSessionEnv({
      ANTHROPIC_API_KEY: "secret",
      ANTHROPIC_AUTH_TOKEN: "token",
      [USE_API_KEY_ENV_VAR]: "1",
    });
    expect(result.ANTHROPIC_API_KEY).toBe("secret");
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe("token");
  });

  it("keeps API credentials when useApiKey is passed explicitly", () => {
    const result = claudeSessionEnv(
      { ANTHROPIC_API_KEY: "secret" },
      { useApiKey: true },
    );
    expect(result.ANTHROPIC_API_KEY).toBe("secret");
  });

  it("explicit useApiKey: false overrides the opt-in env var", () => {
    const result = claudeSessionEnv(
      { ANTHROPIC_API_KEY: "secret", [USE_API_KEY_ENV_VAR]: "1" },
      { useApiKey: false },
    );
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("leaves unrelated ANTHROPIC_* configuration alone", () => {
    const result = claudeSessionEnv({
      ANTHROPIC_MODEL: "opus",
      ANTHROPIC_BASE_URL: "https://proxy.internal",
    });
    expect(result.ANTHROPIC_MODEL).toBe("opus");
    expect(result.ANTHROPIC_BASE_URL).toBe("https://proxy.internal");
  });

  it("does not mutate the source environment", () => {
    const source = { ANTHROPIC_API_KEY: "secret", CLAUDECODE: "1" };
    claudeSessionEnv(source);
    expect(source.ANTHROPIC_API_KEY).toBe("secret");
    expect(source.CLAUDECODE).toBe("1");
  });
});
