import { describe, it, expect } from "vitest";
import {
  normaliseLongitude,
  formatCoordinate,
  getCompactDisplayLongitudes,
  getNearestEquivalentLongitude,
  isValidCoordinate,
} from "../utils/gpsUtils";

describe("gpsUtils", () => {
  describe("normaliseLongitude", () => {
    it("normalises 0 to 0", () => {
      expect(normaliseLongitude(0)).toBe(0);
    });

    it("handles boundary values 180 and -180", () => {
      expect(normaliseLongitude(180)).toBe(-180);
      expect(normaliseLongitude(-180)).toBe(-180);
    });

    it("normalises 181 to -179 and -181 to 179", () => {
      expect(normaliseLongitude(181)).toBe(-179);
      expect(normaliseLongitude(-181)).toBe(179);
    });

    it("handles multiple world copies (540, -540)", () => {
      expect(normaliseLongitude(540)).toBe(-180);
      expect(normaliseLongitude(-540)).toBe(-180);
      expect(normaliseLongitude(720)).toBe(0);
      expect(normaliseLongitude(-720)).toBe(0);
    });

    it("avoids returning -0", () => {
      const result = normaliseLongitude(-360);
      expect(result).toBe(0);
      expect(Object.is(result, -0)).toBe(false);
    });

    it("ensures result lies in [-180, 180)", () => {
      const values = [
        -720, -540.5, -360, -180.1, -180, -90, 0, 90, 180, 180.1, 360, 540.5,
        720,
      ];
      for (const val of values) {
        const normalised = normaliseLongitude(val);
        expect(normalised).toBeGreaterThanOrEqual(-180);
        expect(normalised).toBeLessThan(180);
      }
    });
  });

  describe("formatCoordinate", () => {
    it("formats with 7 decimal precision", () => {
      expect(formatCoordinate(51.50742234)).toBe("51.5074223");
    });

    it("removes trailing zeros", () => {
      expect(formatCoordinate(51.5)).toBe("51.5");
      expect(formatCoordinate(0.0)).toBe("0");
    });

    it("avoids -0", () => {
      const result = formatCoordinate(-0.0);
      expect(result).toBe("0");
      expect(result).not.toBe("-0");
    });

    it("handles zero correctly", () => {
      expect(formatCoordinate(0)).toBe("0");
    });
  });

  describe("getNearestEquivalentLongitude", () => {
    it("calculates the closest longitude copy to center", () => {
      expect(getNearestEquivalentLongitude(-179, 0)).toBe(-179);
      expect(getNearestEquivalentLongitude(-179, 540)).toBe(541);
      expect(getNearestEquivalentLongitude(-179, 360)).toBe(181);
    });
  });

  describe("getCompactDisplayLongitudes", () => {
    it("keeps nearby positive longitudes in the same world copy", () => {
      expect(getCompactDisplayLongitudes([0.1, 0.2])).toEqual([0.1, 0.2]);
    });

    it("uses adjacent world copies for coordinates across the date line", () => {
      expect(getCompactDisplayLongitudes([179, -179])).toEqual([179, 181]);
    });
  });

  describe("isValidCoordinate", () => {
    it("returns true for valid finite coordinates", () => {
      expect(isValidCoordinate(0, 0)).toBe(true);
      expect(isValidCoordinate(-90, -180)).toBe(true);
      expect(isValidCoordinate(90, 180)).toBe(true);
      expect(isValidCoordinate(51.5, 541.0004)).toBe(true);
    });

    it("returns false for non-finite or out-of-range latitude", () => {
      expect(isValidCoordinate(91, 0)).toBe(false);
      expect(isValidCoordinate(-91, 0)).toBe(false);
      expect(isValidCoordinate(NaN, 0)).toBe(false);
      expect(isValidCoordinate(Infinity, 0)).toBe(false);
      expect(isValidCoordinate(0, NaN)).toBe(false);
      expect(isValidCoordinate(0, -Infinity)).toBe(false);
    });

    it("returns false for null or undefined", () => {
      expect(isValidCoordinate(null, 0)).toBe(false);
      expect(isValidCoordinate(0, undefined)).toBe(false);
    });
  });
});
