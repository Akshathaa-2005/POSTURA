import { describe, expect, it } from "vitest";
import { splitList, validateProfile } from "./validate";

const ok = { goal: "lose_fat", level: "beginner", sex: "male", age: 30, height: 175, weight: 80, days_per_week: 3 } as const;

describe("validateProfile", () => {
  it("accepts a complete profile", () => expect(validateProfile({ ...ok })).toEqual({}));
  it("requires the core fields", () => expect(Object.keys(validateProfile({})).sort()).toEqual(["age", "days_per_week", "goal", "height", "level", "sex", "weight"]));
  it("blocks minors and out-of-range numbers", () => {
    expect(validateProfile({ ...ok, age: 16 }).age).toMatch(/18/);
    expect(validateProfile({ ...ok, height: 20 }).height).toMatch(/cm/);
  });
  it("uses imperial ranges", () => {
    expect(validateProfile({ ...ok, units: "imperial", height: 70, weight: 180 })).toEqual({});
    expect(validateProfile({ ...ok, units: "imperial", height: 175 }).height).toMatch(/in/);
  });
  it("rejects pregnancy", () => expect(validateProfile({ ...ok, pregnant: true }).pregnant).toBeTruthy());
});

describe("splitList", () => {
  it("splits on commas and newlines", () => expect(splitList(" peanuts, soy\n\n shellfish ,")).toEqual(["peanuts", "soy", "shellfish"]));
});
