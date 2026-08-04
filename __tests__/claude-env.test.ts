import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  API_CREDENTIAL_ENV_VARS,
  USE_API_KEY_ENV_VAR,
  authBanner,
  claudeExecOptions,
  claudeSessionEnv,
  usesApiKeyBilling,
} from "../src/claude-env.js";

describe("usesApiKeyBilling", () => {
  it("is false when the opt-in var is absent", () => {
    expect(usesApiKeyBilling({})).toBe(false);
  });

  it.each(["1", "true", "TRUE", " yes ", "on"])(
    "is true for opt-in value %j",
    (value) => {
      expect(usesApiKeyBilling({ [USE_API_KEY_ENV_VAR]: value })).toBe(true);
    },
  );

  it.each(["", "0", "false", "FALSE", "no", "off"])(
    "is false for opt-out value %j",
    (value) => {
      expect(usesApiKeyBilling({ [USE_API_KEY_ENV_VAR]: value })).toBe(false);
    },
  );

  // Fail safe: this flag exists to prevent accidental spend, so anything we
  // don't positively recognise as "on" must read as "off".
  it.each(["disabled", "none", "n", "unset", "maybe"])(
    "is false for unrecognised value %j",
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

  // `claude setup-token` mints this for headless/CI use of a Claude
  // subscription. It is a credential, not a nested-session marker, so the
  // CLAUDE-prefix sweep must not take it — it is the login sessions fall back to.
  it("preserves CLAUDE_CODE_OAUTH_TOKEN through the CLAUDE-prefix strip", () => {
    const result = claudeSessionEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      CLAUDECODE: "1",
      ANTHROPIC_API_KEY: "secret",
    });
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
    expect(result.CLAUDECODE).toBeUndefined();
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("strips every other CLAUDE-prefixed var so the child is not seen as nested", () => {
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

  it("defaults to the current process environment", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "secret";
    try {
      const result = claudeSessionEnv();
      expect(result.ANTHROPIC_API_KEY).toBeUndefined();
      expect(result.PATH).toBe(process.env.PATH);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("claudeExecOptions", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "secret";
  });
  afterEach(() => {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it("carries the scrubbed session env", () => {
    expect(claudeExecOptions().env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claudeExecOptions().encoding).toBe("utf-8");
  });

  it("passes cwd and input through", () => {
    const opts = claudeExecOptions({ cwd: "/tmp/wt", input: "stdin body" });
    expect(opts.cwd).toBe("/tmp/wt");
    expect(opts.input).toBe("stdin body");
  });

  it("omits cwd and input when not supplied", () => {
    const opts = claudeExecOptions();
    expect("cwd" in opts).toBe(false);
    expect("input" in opts).toBe(false);
  });
});

describe("authBanner", () => {
  it("warns, and names the opt-in, when API-key billing is on", () => {
    const banner = authBanner({
      [USE_API_KEY_ENV_VAR]: "1",
      ANTHROPIC_API_KEY: "secret",
    });
    expect(banner.level).toBe("warn");
    expect(banner.message).toContain(USE_API_KEY_ENV_VAR);
    expect(banner.message).toMatch(/API credits/);
  });

  // The banner must not claim an auth mode it hasn't checked for. When a
  // credential was present and dropped, say so — otherwise a session that
  // fails to authenticate looks inexplicable.
  it.each(API_CREDENTIAL_ENV_VARS)(
    "reports that %s was ignored rather than implying it was never there",
    (key) => {
      const banner = authBanner({ [key]: "secret" });
      expect(banner.level).toBe("info");
      expect(banner.message).toContain(key);
      expect(banner.message).toContain(USE_API_KEY_ENV_VAR);
    },
  );

  it("states the plain subscription case when no credential is present", () => {
    const banner = authBanner({ PATH: "/usr/bin" });
    expect(banner.level).toBe("info");
    expect(banner.message).toContain("Claude Code login");
    expect(banner.message).not.toContain(USE_API_KEY_ENV_VAR);
  });
});
