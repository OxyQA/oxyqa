// The shape of a generated QA plan. generateObject() constrains the model to
// this schema, so the worker always gets valid, typed data — never a blob of
// text to parse. Field descriptions double as instructions to the model.
import { z } from "zod";

export const testCaseSchema = z.object({
  title: z.string().describe("A short, specific name for the test, e.g. 'Rejects login with expired token'."),
  description: z.string().describe("One or two sentences on what this test verifies and why it matters for this change."),
  priority: z
    .enum(["low", "medium", "high", "critical"])
    .describe("How important this test is, based on user impact and risk of the changed code."),
  steps: z.array(z.string()).min(1).describe("Ordered, concrete steps a tester follows to run this case."),
  expected: z.string().describe("The observable expected result if the code is correct."),
});

export const testPlanSchema = z.object({
  summary: z.string().describe("One-line summary of what this PR changes, from a QA perspective."),
  testCases: z
    .array(testCaseSchema)
    .min(1)
    .max(15)
    .describe("Focused set of test cases covering the changed behavior — quality over quantity."),
});

export type TestCase = z.infer<typeof testCaseSchema>;
export type TestPlan = z.infer<typeof testPlanSchema>;
