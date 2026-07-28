import { describe, it, expect } from "vitest";
import {
  DEFAULT_MODEL,
  resolveDefaultModel,
  mapModelName,
} from "../src/config.js";

describe("config", () => {
  describe("DEFAULT_MODEL", () => {
    it("has the expected constant value", () => {
      expect(DEFAULT_MODEL).toBe("deepseek-v4-flash");
    });
  });

  describe("resolveDefaultModel", () => {
    it("returns the fallback constant when env is undefined", () => {
      expect(resolveDefaultModel(undefined)).toBe(DEFAULT_MODEL);
    });

    it("returns the env.DEFAULT_MODEL value when present", () => {
      const env = { DEFAULT_MODEL: "claude-sonnet-4-20250514" };
      expect(resolveDefaultModel(env)).toBe("claude-sonnet-4-20250514");
    });

    it("falls back when env.DEFAULT_MODEL is empty string", () => {
      const env = { DEFAULT_MODEL: "" };
      expect(resolveDefaultModel(env)).toBe(DEFAULT_MODEL);
    });
  });

  describe("mapModelName", () => {
    it("returns default model when model is null", () => {
      expect(mapModelName(null, {})).toBe(DEFAULT_MODEL);
    });

    it("returns default model when model is undefined", () => {
      expect(mapModelName(undefined, {})).toBe(DEFAULT_MODEL);
    });

    it.each(["go", "go_proxy", "default", "auto"])(
      'maps known provider "%s" to the default model',
      (provider) => {
        expect(mapModelName(provider, {})).toBe(DEFAULT_MODEL);
      },
    );

    it("maps known provider names case-insensitively", () => {
      expect(mapModelName("GO", {})).toBe(DEFAULT_MODEL);
      expect(mapModelName("Go_Proxy", {})).toBe(DEFAULT_MODEL);
      expect(mapModelName("Default", {})).toBe(DEFAULT_MODEL);
    });

    describe("MODEL_MAP env", () => {
      it("returns mapped value on hit (valid JSON)", () => {
        const env = { MODEL_MAP: '{"my-custom-model":"gpt-4o-mini"}' };
        expect(mapModelName("my-custom-model", env)).toBe("gpt-4o-mini");
      });


      it("falls back to default on miss (valid JSON, key not in map)", () => {
        const env = {
          MODEL_MAP: '{"known-model":"some-model"}',
          DEFAULT_MODEL: "fallback-model",
        };
        expect(mapModelName("unknown-model", env)).toBe("fallback-model");
      });

      it("ignores invalid JSON and falls back to default", () => {
        const env = {
          MODEL_MAP: "not-json-at-all",
          DEFAULT_MODEL: "fallback-model",
        };
        expect(mapModelName("whatever", env)).toBe("fallback-model");
      });
    });

    it("returns default model for any unrecognized name", () => {
      const env = { DEFAULT_MODEL: "custom-default" };
      expect(mapModelName("totally-unknown-name", env)).toBe("custom-default");
    });
  });
});
