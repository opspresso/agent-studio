import { describe, expect, it } from "vitest";
import { traceSampled } from "@/application/run/traceLifecycle";
import type { TraceRepository } from "@/domain/trace/repository";

const traces = {} as TraceRepository;

describe("traceSampled", () => {
  it("never samples without a trace repository", () => {
    expect(traceSampled({ traceSampleRate: 1, sample: () => 0 })).toBe(false);
  });

  it("treats an unset rate as zero", () => {
    expect(traceSampled({ traces, sample: () => 0 })).toBe(false);
  });

  it("samples when the draw falls below the rate", () => {
    expect(traceSampled({ traces, traceSampleRate: 0.5, sample: () => 0.49 })).toBe(true);
  });

  it("does not sample when the draw reaches the rate", () => {
    // The boundary the two former copies disagreed on: `< rate` vs `>= rate`.
    expect(traceSampled({ traces, traceSampleRate: 0.5, sample: () => 0.5 })).toBe(false);
  });

  it("rate 1 always samples and rate 0 never does", () => {
    expect(traceSampled({ traces, traceSampleRate: 1, sample: () => 0.999999 })).toBe(true);
    expect(traceSampled({ traces, traceSampleRate: 0, sample: () => 0 })).toBe(false);
  });
});
