import {
  pendingInteractionUserAnswerSchema,
  pendingInteractionUserQuestionQuestionSchema,
  type JsonValue,
} from "@bb/domain";
import { z } from "zod";

const interactionPayloadSchema = z.object({
  questions: z.array(pendingInteractionUserQuestionQuestionSchema).min(1),
});
const interactionResponseSchema = z.object({
  answers: z.record(z.string().min(1), pendingInteractionUserAnswerSchema),
});

export function buildUnclaimedAnswerMessage(
  payload: JsonValue,
  value: JsonValue,
): string | null {
  const parsedPayload = interactionPayloadSchema.safeParse(payload);
  const parsedResponse = interactionResponseSchema.safeParse(value);
  if (!parsedPayload.success || !parsedResponse.success) return null;

  const lines = parsedPayload.data.questions.flatMap((question) => {
    const answer = parsedResponse.data.answers[question.id];
    if (!answer) return [];
    const selected = answer.selected.map((selectedValue) => {
      const option = question.options?.find(
        (candidate) => candidate.value === selectedValue,
      );
      return option?.label ?? selectedValue;
    });
    const values =
      answer.freeText === undefined ? selected : [...selected, answer.freeText];
    return values.length === 0
      ? []
      : [`${question.prompt} — ${values.join(", ")}`];
  });
  if (lines.length === 0) return null;
  return [
    "I answered the question you asked after it timed out on your side. My answers:",
    ...lines.map((line) => `- ${line}`),
    "Continue from these.",
  ].join("\n");
}
